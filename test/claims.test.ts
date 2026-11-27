import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM_MAX_AGE_MS, claimTick, pruneClaims, tryClaim } from "../src/claims.js";
import { CronScheduler } from "../src/scheduler.js";
import { projectKey } from "../src/storage.js";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function claimFiles(dir = join(agentDir, "schedule-prompts", "claims")): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? claimFiles(full) : [full];
  });
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return pid;
}

describe("claimTick", () => {
  it("preserves distinct second-resolution cron occurrences", () => {
    const j = job({ type: "cron" });
    const first = Date.UTC(2026, 10, 24, 15, 0, 1);
    const second = Date.UTC(2026, 10, 24, 15, 0, 2);
    expect(claimTick(j, first)).toBe("2026-11-24T15:00:01.000Z");
    expect(claimTick(j, second)).toBe("2026-11-24T15:00:02.000Z");
  });

  it("uses the supplied delayed occurrence instead of rebucketing wall-clock time", () => {
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 30);
    expect(claimTick(job({ type: "interval", intervalMs: 1_000 }), occurrence)).toBe(
      "2026-11-24T15:00:30.000Z",
    );
  });

  it("uses the target date for once jobs and rejects invalid occurrence timestamps", () => {
    expect(
      claimTick(
        job({ type: "once", schedule: "2026-12-01T10:00:00.000Z" }),
        Date.UTC(2027, 0, 1),
      ),
    ).toBe("2026-12-01T10:00:00.000Z");
    expect(() => claimTick(job(), Number.NaN)).toThrow(RangeError);
  });
});

describe("tryClaim / pruneClaims", () => {
  it("lets exactly one claimant win an occurrence and a different occurrence win separately", () => {
    const j = job();
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 5);
    const first = tryClaim("/proj", j, "session-A", occurrence);
    const second = tryClaim("/proj", j, "session-B", occurrence);
    expect(first).not.toBeNull();
    expect(first!.sessionId).toBe("session-A");
    expect(second).toBeNull();
    expect(tryClaim("/proj", j, "session-B", occurrence + 1_000)).not.toBeNull();
  });

  it("records actual claim time rather than the scheduled occurrence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T15:01:00.000Z"));
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 0);

    const claim = tryClaim("/proj", job(), "session-A", occurrence);

    expect(claim).toMatchObject({
      tick: "2026-11-24T15:00:00.000Z",
      claimedAt: "2026-11-24T15:01:00.000Z",
    });
  });

  it("never steals an existing claim based on its owner's liveness", async () => {
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 5);
    expect(tryClaim("/proj", job(), "session-A", occurrence)).not.toBeNull();
    const file = claimFiles()[0];
    const record = JSON.parse(readFileSync(file, "utf-8"));
    record.pid = await exitedPid();
    writeFileSync(file, JSON.stringify(record));

    expect(tryClaim("/proj", job(), "session-B", occurrence)).toBeNull();
  });

  it("throws coordination errors instead of electing every caller", () => {
    const notADirectory = join(agentDir, "agent-dir-is-a-file");
    writeFileSync(notADirectory, "x");
    process.env.PI_CODING_AGENT_DIR = notADirectory;

    expect(() => tryClaim("/proj", job(), "session-A", Date.now())).toThrow();
    expect(() => tryClaim("/proj", job(), "session-B", Date.now())).toThrow();
  });

  it("prunes whole expired hour shards while retaining current claims", () => {
    const j = job();
    const now = Date.UTC(2026, 10, 24, 15, 30);
    const expired = now - CLAIM_MAX_AGE_MS - 2 * 60 * 60 * 1000;
    const current = tryClaim("/proj", j, "session-A", now)!;
    for (let index = 0; index < 20; index++) {
      expect(tryClaim("/proj", j, "session-A", expired + index * 1_000)).not.toBeNull();
    }
    const before = claimFiles();
    const currentPath = before.find(
      (file) => JSON.parse(readFileSync(file, "utf-8")).tick === current.tick,
    )!;
    const expiredPath = before.find((file) => file !== currentPath)!;
    const expiredBucket = dirname(expiredPath);

    pruneClaims("/proj", now);

    expect(claimFiles()).toEqual([currentPath]);
    expect(existsSync(expiredBucket)).toBe(false);
  });

  it("removes empty job shard directories and legacy stale flat claims", () => {
    const now = Date.UTC(2026, 10, 24, 15, 30);
    const expired = now - CLAIM_MAX_AGE_MS - 2 * 60 * 60 * 1000;
    expect(tryClaim("/proj", job(), "session-A", expired)).not.toBeNull();
    const expiredPath = claimFiles()[0];
    const jobDir = dirname(dirname(expiredPath));
    const projectDir = join(agentDir, "schedule-prompts", "claims", projectKey("/proj"));
    const legacy = join(projectDir, "legacy.claim");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(legacy, "{}");
    const stale = new Date(now - CLAIM_MAX_AGE_MS - 1_000);
    utimesSync(legacy, stale, stale);

    pruneClaims("/proj", now);

    expect(existsSync(jobDir)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(projectDir)).toBe(true);
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
      incrementRunCount: (id: string, nextRun?: string) => {
        const j = jobs.get(id);
        if (!j) return false;
        j.runCount++;
        j.lastRun = new Date().toISOString();
        j.lastStatus = "success";
        j.nextRun = nextRun;
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

  it("headless delay preserves each supplied interval occurrence", async () => {
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
      // A and B supply different occurrences. Occurrence-based claims must not
      // coalesce them merely because the old wall-clock bucket matched.
      await vi.advanceTimersByTimeAsync(1_300);
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([runA, runB]);
    } finally {
      vi.useRealTimers();
    }

    expect(sentA.length + sentB.length).toBe(2);
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

  it("does not execute after stop during the singleton headless grace", async () => {
    const cwd = "/proj-stop-during-grace";
    const j = job({ singleton: true });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    const markers: unknown[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    pi.sendMessage = (...args: unknown[]) => markers.push(args);
    const scheduler = new CronScheduler(storage, pi, makeCtx("headless", cwd, "rpc"));

    vi.useFakeTimers();
    try {
      const occurrence = Date.UTC(2026, 10, 24, 15, 0, 0);
      vi.setSystemTime(occurrence);
      const running = (scheduler as any).executeJob(j, occurrence) as Promise<void>;
      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(1_500);
      await running;
      expect(sent).toHaveLength(0);
      expect(markers).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("does not execute a one-shot rescheduled during the headless grace", async () => {
    const cwd = "/proj-reschedule-during-grace";
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 0);
    const j = job({
      type: "once",
      schedule: new Date(occurrence).toISOString(),
      singleton: true,
    });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("headless", cwd, "rpc"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(occurrence);
      const running = (scheduler as any).executeJob(j, occurrence) as Promise<void>;
      storage.updateJob(j.id, { schedule: new Date(occurrence + 60_000).toISOString() });
      await vi.advanceTimersByTimeAsync(1_500);
      await running;
      expect(sent).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("does not claim when singleton is disabled during the headless grace", async () => {
    const cwd = "/proj-unsingleton-during-grace";
    const j = job({ singleton: true });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("headless", cwd, "rpc"));

    vi.useFakeTimers();
    try {
      const occurrence = Date.now();
      const running = (scheduler as any).executeJob(j, occurrence) as Promise<void>;
      storage.updateJob(j.id, { singleton: false });
      await vi.advanceTimersByTimeAsync(1_500);
      await running;
      expect(sent).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("does not execute after the job is rebound during the headless grace", async () => {
    const cwd = "/proj-rebind-during-grace";
    const j = job({ singleton: true });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("headless", cwd, "rpc"));

    vi.useFakeTimers();
    try {
      const running = (scheduler as any).executeJob(j, Date.now()) as Promise<void>;
      storage.updateJob(j.id, { session: "another-session" });
      await vi.advanceTimersByTimeAsync(1_500);
      await running;
      expect(sent).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("contains a storage failure after claiming and records an error without executing", async () => {
    const cwd = "/proj-post-claim-storage-error";
    const j = job({ singleton: true, singletonPreferTui: false });
    const storage = makeSharedStorage([j]);
    const update = storage.updateJob;
    let first = true;
    storage.updateJob = (id: string, partial: Partial<CronJob>) => {
      if (first) {
        first = false;
        throw new Error("store write failed");
      }
      return update(id, partial);
    };
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A", cwd));

    await expect((scheduler as any).executeJob(j, Date.now())).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
    expect(storage.getJob(j.id)!.lastStatus).toBe("error");
  });

  it("fails closed and records an error when claim coordination is unavailable", async () => {
    const cwd = "/proj-claim-coordination-error";
    const j = job({ singleton: true, singletonPreferTui: false });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notADirectory = join(agentDir, "not-a-directory");
    writeFileSync(notADirectory, "x");
    process.env.PI_CODING_AGENT_DIR = notADirectory;
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A", cwd));

    await expect((scheduler as any).executeJob(j, Date.now())).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
    expect(storage.getJob(j.id)!.lastStatus).toBe("error");
  });

  it("disables a hand-edited singleton idle job instead of executing it", async () => {
    const cwd = "/proj-singleton-idle";
    const j = job({ type: "idle", schedule: "1s", intervalMs: 1_000, singleton: true });
    const storage = makeSharedStorage([j]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx("session-A", cwd, "tui"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    scheduler.start();

    expect(storage.getJob(j.id)).toMatchObject({ enabled: false, lastStatus: "error" });
    await scheduler.stop();
  });

  it("uses the armed cron occurrence across a delayed headless claim", async () => {
    const cwd = "/proj-delayed-cron-occurrence";
    const j = job({ singleton: true });
    const storage = makeSharedStorage([j]);
    const sentTui: string[] = [];
    const sentHeadless: string[] = [];
    const piTui = makePi();
    const piHeadless = makePi();
    piTui.sendUserMessage = (p: string) => sentTui.push(p);
    piHeadless.sendUserMessage = (p: string) => sentHeadless.push(p);
    const tui = new CronScheduler(storage, piTui, makeCtx("tui", cwd, "tui"));
    const headless = new CronScheduler(storage, piHeadless, makeCtx("headless", cwd, "rpc"));
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 0);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(occurrence);
      await (tui as any).executeJob(j, occurrence);
      vi.setSystemTime(occurrence + 61_000);
      const delayed = (headless as any).executeJob(j, occurrence) as Promise<void>;
      await vi.advanceTimersByTimeAsync(1_500);
      await delayed;
      expect(sentTui.length + sentHeadless.length).toBe(1);
    } finally {
      await tui.stop();
      await headless.stop();
    }
  });

  it("fires distinct every-second cron occurrences", async () => {
    const cwd = "/proj-every-second-cron";
    const j = job({ schedule: "* * * * * *", singleton: true, singletonPreferTui: false });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("tui", cwd, "tui"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-24T15:00:00.000Z"));
      scheduler.start();
      await vi.advanceTimersByTimeAsync(3_100);
      expect(sent).toHaveLength(3);
    } finally {
      await scheduler.stop();
    }
  });

  it("aligns staggered singleton interval schedulers to shared occurrences", async () => {
    const cwd = "/proj-aligned-singleton-interval";
    const j = job({
      type: "interval",
      schedule: "1s",
      intervalMs: 1_000,
      singleton: true,
      singletonPreferTui: false,
    });
    const storage = makeSharedStorage([j]);
    const sentA: string[] = [];
    const sentB: string[] = [];
    const piA = makePi();
    const piB = makePi();
    piA.sendUserMessage = (p: string) => sentA.push(p);
    piB.sendUserMessage = (p: string) => sentB.push(p);
    const schedA = new CronScheduler(storage, piA, makeCtx("session-A", cwd, "tui"));
    const schedB = new CronScheduler(storage, piB, makeCtx("session-B", cwd, "tui"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(400);
      schedA.start();
      await vi.advanceTimersByTimeAsync(200);
      schedB.start();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(sentA.length + sentB.length).toBe(2);
    } finally {
      await schedA.stop();
      await schedB.stop();
    }
  });

  it("keeps non-singleton intervals relative to each scheduler's arming time", async () => {
    const cwd = "/proj-relative-normal-interval";
    const j = job({ type: "interval", schedule: "1s", intervalMs: 1_000 });
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
      schedA.start();
      await vi.advanceTimersByTimeAsync(200);
      schedB.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sentA).toHaveLength(1);
      expect(sentB).toHaveLength(1);
    } finally {
      await schedA.stop();
      await schedB.stop();
    }
  });

  it("periodically prunes expired claim buckets while the scheduler stays open", async () => {
    const cwd = "/proj-periodic-claim-prune";
    const storage = makeSharedStorage([]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx("session-A", cwd));

    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 10, 24, 15, 30);
      vi.setSystemTime(now);
      scheduler.start();
      expect(tryClaim(cwd, job(), "session-A", now)).not.toBeNull();
      expect(claimFiles()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(CLAIM_MAX_AGE_MS + 2 * 60 * 60 * 1000);
      expect(claimFiles()).toHaveLength(0);
    } finally {
      await scheduler.stop();
    }
  });

  it("reconciles a save that races watcher registration during start", async () => {
    const cwd = "/proj-watch-start-race";
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 0);
    const j = job({ type: "once", schedule: new Date(occurrence).toISOString() });
    let jobs: CronJob[] = [];
    let watched = false;
    let injected = false;
    const storage = {
      getAllJobs: () => {
        if (watched && !injected) {
          jobs = [{ ...j }];
          injected = true;
        }
        return jobs.map((candidate) => ({ ...candidate }));
      },
      getJob: (id: string) => {
        const found = jobs.find((candidate) => candidate.id === id);
        return found ? { ...found } : undefined;
      },
      updateJob: (id: string, partial: Partial<CronJob>) => {
        const found = jobs.find((candidate) => candidate.id === id);
        if (!found) return false;
        Object.assign(found, partial);
        return true;
      },
      watch: () => {
        watched = true;
        return () => {};
      },
    } as any;
    const scheduler = new CronScheduler(storage, makePi(), makeCtx("session-A", cwd));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(occurrence - 10_000);
      scheduler.start();
      expect(injected).toBe(true);
      expect((scheduler as any).jobs.has(j.id)).toBe(true);
    } finally {
      await scheduler.stop();
    }
  });

  it("fails safely on a malformed store and converges after a valid save", async () => {
    const cwd = "/proj-watch-malformed-recovery";
    const occurrence = Date.UTC(2026, 10, 24, 15, 0, 0);
    const j = job({ type: "once", schedule: new Date(occurrence).toISOString() });
    let valid = true;
    const watchers = new Set<() => void>();
    const jobs = new Map([[j.id, { ...j }]]);
    const storage = {
      getAllJobs: () => valid ? [...jobs.values()].map((candidate) => ({ ...candidate })) : [],
      getJob: (id: string) => {
        const found = jobs.get(id);
        return found ? { ...found } : undefined;
      },
      updateJob: (id: string, partial: Partial<CronJob>) => {
        const found = jobs.get(id);
        if (!found) return false;
        Object.assign(found, partial);
        return true;
      },
      watch: (callback: () => void) => {
        watchers.add(callback);
        return () => watchers.delete(callback);
      },
    } as any;
    const scheduler = new CronScheduler(storage, makePi(), makeCtx("session-A", cwd));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(occurrence - 10_000);
      scheduler.start();
      expect(scheduler.getNextRun(j.id)).not.toBeNull();
      valid = false;
      for (const callback of watchers) callback();
      expect(scheduler.getNextRun(j.id)).toBeNull();
      valid = true;
      for (const callback of watchers) callback();
      expect(scheduler.getNextRun(j.id)).not.toBeNull();
    } finally {
      await scheduler.stop();
    }
  });

  it("does not execute or disable a replaced one-shot from a stale immediate callback", async () => {
    const cwd = "/proj-stale-immediate-once";
    const oldOccurrence = Date.now() + 60_000;
    const newOccurrence = oldOccurrence + 60_000;
    const j = job({
      type: "once",
      schedule: new Date(oldOccurrence).toISOString(),
      singleton: true,
      singletonPreferTui: false,
    });
    const storage = makeSharedStorage([j]);
    const pi = makePi();
    const sent: string[] = [];
    pi.sendUserMessage = (p: string) => sent.push(p);
    const scheduler = new CronScheduler(storage, pi, makeCtx("tui", cwd, "tui"));
    scheduler.addJob(j);
    storage.updateJob(j.id, { schedule: new Date(newOccurrence).toISOString() });

    const cron = (scheduler as any).jobs.get(j.id);
    await cron.trigger();

    expect(sent).toHaveLength(0);
    expect(storage.getJob(j.id)!.enabled).toBe(true);
    await scheduler.stop();
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
