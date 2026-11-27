import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM_MAX_AGE_MS, claimTick, pruneClaims, tryClaim } from "../src/claims.js";
import { CronScheduler } from "../src/scheduler.js";
import type { CronJob } from "../src/types.js";

// Claims resolve their directory from PI_CODING_AGENT_DIR, so point it at a
// temp dir per test (same approach as storage.test.ts).
let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "pi-schedule-claims-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "0 0 9 * * *",
    prompt: "do the thing",
    enabled: true,
    type: "cron",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("claimTick", () => {
  it("floors cron ticks to the minute so all sessions in a tick share a key", () => {
    const j = job({ type: "cron" });
    const t1 = claimTick(j, Date.UTC(2026, 10, 24, 15, 0, 0, 123));
    const t2 = claimTick(j, Date.UTC(2026, 10, 24, 15, 0, 59, 999));
    expect(t1).toBe(t2);
    expect(claimTick(j, Date.UTC(2026, 10, 24, 15, 1, 0, 0))).not.toBe(t1);
  });

  it("uses the target date for once jobs and the interval bucket for interval jobs", () => {
    expect(claimTick(job({ type: "once", schedule: "2026-12-01T10:00:00.000Z" }))).toBe(
      "2026-12-01T10:00:00.000Z",
    );
    const j = job({ type: "interval", schedule: "5m", intervalMs: 300_000 });
    expect(claimTick(j, Date.UTC(2026, 10, 24, 15, 3, 10, 0))).toBe(
      new Date(Date.UTC(2026, 10, 24, 15, 0, 0, 0)).toISOString(),
    );
  });
});

describe("tryClaim / pruneClaims", () => {
  it("lets exactly one of two claimants win the same tick", () => {
    const j = job();
    const now = Date.UTC(2026, 10, 24, 15, 0, 5, 0);
    const first = tryClaim("/proj", j, "session-A", now);
    const second = tryClaim("/proj", j, "session-B", now);
    expect(first).not.toBeNull();
    expect(first!.sessionId).toBe("session-A");
    expect(second).toBeNull();
    // A different tick is a different claim — both can win.
    const nextTick = tryClaim("/proj", j, "session-B", now + 60_000);
    expect(nextTick).not.toBeNull();
  });

  it("pruneClaims removes only stale claim files", () => {
    const j = job();
    const now = Date.now();
    tryClaim("/proj", j, "session-A", now);
    tryClaim("/proj", j, "session-A", now + 60_000);
    const dir = join(agentDir, "schedule-prompts", "claims");
    const projDir = readdirSync(dir)[0];
    const files = readdirSync(join(dir, projDir));
    expect(files).toHaveLength(2);
    // Age the first claim file beyond the max age.
    const stale = new Date(now - CLAIM_MAX_AGE_MS - 1000);
    utimesSync(join(dir, projDir, files[0]), stale, stale);
    pruneClaims("/proj", now);
    expect(readdirSync(join(dir, projDir))).toHaveLength(1);
    // And the whole claims tree is gone after pruning everything.
    for (const f of readdirSync(join(dir, projDir))) {
      utimesSync(join(dir, projDir, f), stale, stale);
    }
    pruneClaims("/proj", now);
    expect(readdirSync(join(dir, projDir))).toHaveLength(0);
    expect(existsSync(join(dir, projDir))).toBe(true);
  });
});

// Two schedulers sharing one cwd + agentDir simulate two pi sessions in the
// same workdir. They share one in-memory job map (standing in for the shared
// project store file) but use the real on-disk claim dir under the temp
// PI_CODING_AGENT_DIR, so the O_EXCL claim race is genuinely exercised.
describe("CronScheduler singleton fire-once", () => {
  function makeSharedStorage(seed: CronJob[]) {
    const jobs = new Map<string, CronJob>(seed.map((j) => [j.id, { ...j }]));
    const watchers = new Set<() => void>();
    const notify = () => {
      for (const cb of [...watchers]) cb();
    };
    return {
      hasJobWithName: (name: string) => Array.from(jobs.values()).some((j) => j.name === name),
      addJob: (j: CronJob) => {
        jobs.set(j.id, { ...j });
        notify();
      },
      removeJob: (id: string) => {
        const removed = jobs.delete(id);
        if (removed) notify();
        return removed;
      },
      updateJob: (id: string, partial: Partial<CronJob>) => {
        const j = jobs.get(id);
        if (!j) return false;
        Object.assign(j, partial);
        notify();
        return true;
      },
      watch: (cb: () => void) => {
        watchers.add(cb);
        return () => watchers.delete(cb);
      },
      getJob: (id: string) => {
        const j = jobs.get(id);
        return j ? { ...j } : undefined;
      },
      getAllJobs: () => Array.from(jobs.values()).map((j) => ({ ...j })),
      getStorePath: () => ":memory:",
    } as any;
  }

  function makePi() {
    return {
      sendMessage: (..._a: unknown[]) => {},
      sendUserMessage: (..._a: unknown[]) => {},
      events: { emit: () => {}, on: () => {} },
    } as any;
  }

  function makeCtx(sessionId: string, cwd: string, mode = "print", leafTimestamp?: string) {
    return {
      cwd,
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
      sessionManager: {
        getSessionId: () => sessionId,
        getLeafEntry: () => (leafTimestamp ? { timestamp: leafTimestamp } : undefined),
      },
      ui: undefined,
    } as any;
  }

  it("only one of two sessions in the same cwd fires a singleton job per tick", async () => {
    const cwd = "/proj-singleton";
    try {
      const j = job({ singleton: true });
      const shared = makeSharedStorage([j]);
      const storageA = shared;
      const storageB = shared;
      const piA = makePi();
      const piB = makePi();
      const sentA: string[] = [];
      const sentB: string[] = [];
      piA.sendUserMessage = (p: string) => sentA.push(p);
      piB.sendUserMessage = (p: string) => sentB.push(p);

      const schedA = new CronScheduler(storageA, piA, makeCtx("session-A", cwd));
      const schedB = new CronScheduler(storageB, piB, makeCtx("session-B", cwd));

      vi.useFakeTimers();
      try {
        const runA = (schedA as any).executeJob(j) as Promise<void>;
        const runB = (schedB as any).executeJob(j) as Promise<void>;
        await vi.advanceTimersByTimeAsync(1_500);
        await Promise.all([runA, runB]);
      } finally {
        vi.useRealTimers();
      }

      expect(sentA.length + sentB.length).toBe(1);
      // The winner recorded itself as lastClaimBy.
      const stored = storageA.getJob(j.id);
      expect(stored!.lastClaimBy).toBe(sentA.length === 1 ? "session-A" : "session-B");
      expect(stored!.runCount).toBe(1);

    } finally {
      // claims live under the temp agentDir, cleaned in afterEach
    }
  });

  it("arms an externally added workdir one-shot without reload or a widget", async () => {
    const cwd = "/proj-watch-external-add";
    const storage = makeSharedStorage([]);
    const sentTui: string[] = [];
    const sentHeadless: string[] = [];
    const piTui = makePi();
    const piHeadless = makePi();
    piTui.sendUserMessage = (p: string) => sentTui.push(p);
    piHeadless.sendUserMessage = (p: string) => sentHeadless.push(p);
    const headless = new CronScheduler(storage, piHeadless, makeCtx("headless", cwd, "rpc"));
    const tui = new CronScheduler(storage, piTui, makeCtx("tui", cwd, "tui"));
    const j = job({
      id: "watch-external-once",
      type: "once",
      schedule: "2026-11-26T20:35:00.000Z",
      singleton: true,
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-26T20:34:50.000Z"));
      headless.start();
      tui.start();
      // Another session's tool save notifies both schedulers. No CronWidget
      // exists in this test, and both started with zero jobs.
      storage.addJob(j);
      expect((headless as any).jobs.has(j.id)).toBe(true);
      expect((tui as any).jobs.has(j.id)).toBe(true);

      await vi.advanceTimersByTimeAsync(11_500);
      expect(sentTui).toHaveLength(1);
      expect(sentHeadless).toHaveLength(0);
      expect(storage.getJob(j.id)).toMatchObject({ enabled: false, lastClaimBy: "tui", runCount: 1 });
    } finally {
      await headless.stop();
      await tui.stop();
      vi.useRealTimers();
    }
  });

  it("reschedules an externally edited one-shot and disarms an external disable", async () => {
    const cwd = "/proj-watch-external-edit";
    const j = job({
      id: "watch-edit-once",
      type: "once",
      schedule: "2026-11-26T20:35:00.000Z",
      singleton: true,
    });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("tui", cwd, "tui"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-26T20:34:50.000Z"));
      scheduler.start();
      storage.updateJob(j.id, { schedule: "2026-11-26T20:34:56.000Z" });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(sent).toHaveLength(1);
      await scheduler.stop();

      const disabled = job({ id: "watch-disabled", schedule: "2026-11-26T20:36:00.000Z", type: "once" });
      storage.addJob(disabled);
      scheduler.start();
      storage.updateJob(disabled.id, { enabled: false });
      expect(scheduler.getNextRun(disabled.id)).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toHaveLength(1);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("keeps the timer on a prompt-only edit but fires the new prompt", async () => {
    const cwd = "/proj-watch-prompt-edit";
    const j = job({
      id: "watch-prompt-once",
      type: "once",
      schedule: "2026-11-26T20:35:00.000Z",
      prompt: "old prompt",
    });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("tui", cwd, "tui"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-26T20:34:50.000Z"));
      scheduler.start();
      const cronBefore = (scheduler as any).jobs.get(j.id);
      storage.updateJob(j.id, { prompt: "new prompt" });
      expect((scheduler as any).jobs.get(j.id)).toBe(cronBefore);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual(["new prompt"]);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("does not fire a job disabled during the headless grace delay", async () => {
    const cwd = "/proj-disabled-during-grace";
    const j = job({ singleton: true });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("headless", cwd, "rpc"));

    vi.useFakeTimers();
    try {
      const run = (scheduler as any).executeJob(j) as Promise<void>;
      storage.updateJob(j.id, { enabled: false });
      await vi.advanceTimersByTimeAsync(1_500);
      await run;
      expect(sent).toHaveLength(0);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("job-level singletonPreferTui=false lets the first headless claimant win immediately", async () => {
    const cwd = "/proj-no-tui-preference";
    const j = job({ singleton: true, singletonPreferTui: false });
    const storage = makeSharedStorage([j]);
    const sentTui: string[] = [];
    const sentHeadless: string[] = [];
    const piTui = makePi();
    const piHeadless = makePi();
    piTui.sendUserMessage = (p: string) => sentTui.push(p);
    piHeadless.sendUserMessage = (p: string) => sentHeadless.push(p);
    const headless = new CronScheduler(storage, piHeadless, makeCtx("headless", cwd, "rpc"));
    const tui = new CronScheduler(storage, piTui, makeCtx("tui", cwd, "tui"));

    vi.useFakeTimers();
    const runHeadless = (headless as any).executeJob(j) as Promise<void>;
    const runTui = (tui as any).executeJob(j) as Promise<void>;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sentHeadless).toHaveLength(1);
      expect(sentTui).toHaveLength(0);
      await Promise.all([runHeadless, runTui]);
    } finally {
      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.all([runHeadless, runTui]);
      await headless.stop();
      await tui.stop();
      vi.useRealTimers();
    }
  });

  it("headless delay keeps the original interval tick key", async () => {
    const cwd = "/proj-headless-interval-tick";
    const j = job({ type: "interval", schedule: "1s", intervalMs: 1_000, singleton: true });
    const storage = makeSharedStorage([j]);
    const sentA: string[] = [];
    const sentB: string[] = [];
    const piA = makePi();
    const piB = makePi();
    piA.sendUserMessage = (p: string) => sentA.push(p);
    piB.sendUserMessage = (p: string) => sentB.push(p);
    const schedA = new CronScheduler(storage, piA, makeCtx("session-A", cwd));
    const schedB = new CronScheduler(storage, piB, makeCtx("session-B", cwd));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(400);
      const runA = (schedA as any).executeJob(j) as Promise<void>;
      await vi.advanceTimersByTimeAsync(200);
      const runB = (schedB as any).executeJob(j) as Promise<void>;
      // A's grace expires at 1900ms; B's at 2100ms (the next interval bucket).
      await vi.advanceTimersByTimeAsync(1_300);
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([runA, runB]);
    } finally {
      vi.useRealTimers();
    }

    expect(sentA.length + sentB.length).toBe(1);
  });

  it("lets a reloaded TUI win a singleton one-shot armed earlier by headless", async () => {
    const cwd = "/proj-once-headless-first";
    const j = job({
      id: "once-race",
      type: "once",
      schedule: "2026-11-26T20:35:00.000Z",
      singleton: true,
    });
    const storage = makeSharedStorage([j]);
    const sentTui: string[] = [];
    const sentHeadless: string[] = [];
    const piTui = makePi();
    const piHeadless = makePi();
    piTui.sendUserMessage = (p: string) => sentTui.push(p);
    piHeadless.sendUserMessage = (p: string) => sentHeadless.push(p);
    const headless = new CronScheduler(storage, piHeadless, makeCtx("headless", cwd, "rpc"));
    const tui = new CronScheduler(storage, piTui, makeCtx("tui", cwd, "tui"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-26T20:34:50.000Z"));
      // The background session learns the job first; /reload arms it in the
      // TUI second. The earlier timer must not disable the job for the TUI.
      headless.start();
      tui.start();
      await vi.advanceTimersByTimeAsync(11_500);

      expect(sentTui).toHaveLength(1);
      expect(sentHeadless).toHaveLength(0);
      expect(storage.getJob(j.id)).toMatchObject({
        enabled: false,
        lastClaimBy: "tui",
        runCount: 1,
      });
    } finally {
      await headless.stop();
      await tui.stop();
      vi.useRealTimers();
    }
  });

  it("claims immediately in the first TUI while RPC waits for the grace period", async () => {
    const cwd = "/proj-scheduler-prefers-tui";
    const j = job({ singleton: true });
    const storage = makeSharedStorage([j]);
    const piTui = makePi();
    const piRpc = makePi();
    const sentTui: string[] = [];
    const sentRpc: string[] = [];
    piTui.sendUserMessage = (p: string) => sentTui.push(p);
    piRpc.sendUserMessage = (p: string) => sentRpc.push(p);
    const tui = new CronScheduler(
      storage,
      piTui,
      makeCtx("tui", cwd, "tui", "2026-11-24T15:00:00.000Z"),
    );
    const rpc = new CronScheduler(
      storage,
      piRpc,
      makeCtx("rpc", cwd, "rpc", "2026-11-24T16:00:00.000Z"),
    );

    vi.useFakeTimers();
    const runTui = (tui as any).executeJob(j) as Promise<void>;
    const runRpc = (rpc as any).executeJob(j) as Promise<void>;
    try {
      await vi.advanceTimersByTimeAsync(0);
      // TUI does not wait for the headless grace period.
      expect(sentTui).toHaveLength(1);
      expect(sentRpc).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.all([runTui, runRpc]);
    } finally {
      await vi.advanceTimersByTimeAsync(1_500);
      await Promise.all([runTui, runRpc]);
      vi.useRealTimers();
    }

    expect(sentTui).toHaveLength(1);
    expect(sentRpc).toHaveLength(0);
    expect(storage.getJob(j.id)!.lastClaimBy).toBe("tui");
  });

  it("does not create session presence files", async () => {
    const cwd = "/proj-no-presence-files";
    const scheduler = new CronScheduler(
      makeSharedStorage([job({ singleton: true, enabled: false })]),
      makePi(),
      makeCtx("tui", cwd, "tui"),
    );
    try {
      scheduler.start();
      expect(existsSync(join(agentDir, "schedule-prompts", "sessions"))).toBe(false);
    } finally {
      await scheduler.stop();
    }
  });

  it("non-singleton workdir jobs still fire in every session (back-compat)", async () => {
    const cwd = "/proj-shared";
    try {
      const j = job({ singleton: undefined });
      const shared = makeSharedStorage([j]);
      const storageA = shared;
      const storageB = shared;
      const piA = makePi();
      const piB = makePi();
      const sentA: string[] = [];
      const sentB: string[] = [];
      piA.sendUserMessage = (p: string) => sentA.push(p);
      piB.sendUserMessage = (p: string) => sentB.push(p);

      const schedA = new CronScheduler(storageA, piA, makeCtx("session-A", cwd));
      const schedB = new CronScheduler(storageB, piB, makeCtx("session-B", cwd));

      await (schedA as any).executeJob(j);
      await (schedB as any).executeJob(j);

      expect(sentA).toHaveLength(1);
      expect(sentB).toHaveLength(1);
    } finally {
      // claims live under the temp agentDir, cleaned in afterEach
    }
  });

  it("singleton flag is ignored for session-bound jobs", async () => {
    const cwd = "/proj-bound";
    try {
      const j = job({ singleton: true, session: "session-A" });
      const storage = makeSharedStorage([j]);
      const piA = makePi();
      const piB = makePi();
      const sentA: string[] = [];
      const sentB: string[] = [];
      piA.sendUserMessage = (p: string) => sentA.push(p);
      piB.sendUserMessage = (p: string) => sentB.push(p);
      const schedA = new CronScheduler(storage, piA, makeCtx("session-A", cwd));
      const schedB = new CronScheduler(storage, piB, makeCtx("session-B", cwd));

      vi.useFakeTimers();
      try {
        const runA = (schedA as any).executeJob(j) as Promise<void>;
        const runB = (schedB as any).executeJob(j) as Promise<void>; // foreign session
        await vi.advanceTimersByTimeAsync(1_500);
        await Promise.all([runA, runB]);
      } finally {
        vi.useRealTimers();
      }

      expect(sentA).toHaveLength(1);
      expect(sentB).toHaveLength(0);
    } finally {
      // claims live under the temp agentDir, cleaned in afterEach
    }
  });
});
