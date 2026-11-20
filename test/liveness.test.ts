import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { registerSessionLiveness, SESSION_LIVENESS_REGISTRY_KEY } from "../src/liveness.js";
import { CronScheduler } from "../src/scheduler.js";
import type { CronJob } from "../src/types.js";

vi.mock("../src/subagent.js", () => ({ runSubagentOnce: vi.fn() }));

const KEY = Symbol.for(SESSION_LIVENESS_REGISTRY_KEY);

type Provider = { name: string; sessionId: string; sessionFile?: string; isActive(): boolean };

/** A registry shaped like pi-web's, recording registrations and releases. */
function installRegistry() {
  const providers = new Set<Provider>();
  const register = vi.fn((provider: Provider) => {
    providers.add(provider);
    return () => providers.delete(provider);
  });
  (globalThis as any)[KEY] = { version: 1, register, hasActiveProvider: () => false };
  return { providers, register };
}

afterEach(() => {
  delete (globalThis as any)[KEY];
  vi.useRealTimers();
});

function makeStorage(seedJobs: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seedJobs.map((j) => [j.id, j]));
  return {
    updateJob: (id: string, partial: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    },
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values()),
  } as any;
}

function makePi() {
  return { sendMessage: vi.fn(), sendUserMessage: vi.fn(), events: { emit: vi.fn(), on: vi.fn() } } as any;
}

function makeCtx(sessionId = "s1") {
  return { cwd: "/tmp", isIdle: () => true, sessionManager: { getSessionId: () => sessionId } } as any;
}

function job(overrides: Partial<CronJob>): CronJob {
  return {
    id: "j",
    name: "demo",
    schedule: "",
    prompt: "p",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("registerSessionLiveness", () => {
  it("is a no-op without a registry (pi CLI)", () => {
    const release = registerSessionLiveness(makeCtx(), () => true);
    expect(() => release()).not.toThrow();
  });

  it("ignores a registry of another protocol version", () => {
    const register = vi.fn();
    (globalThis as any)[KEY] = { version: 2, register };
    registerSessionLiveness(makeCtx(), () => true);
    expect(register).not.toHaveBeenCalled();
  });

  it("registers the session id and file, and releases once", () => {
    const { providers, register } = installRegistry();
    const ctx = {
      sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/sessions/s1.jsonl" },
    };
    const release = registerSessionLiveness(ctx, () => true);
    expect(register).toHaveBeenCalledTimes(1);
    const [provider] = providers;
    expect(provider).toMatchObject({ name: "pi-schedule-prompt", sessionId: "s1", sessionFile: "/sessions/s1.jsonl" });
    expect(provider.isActive()).toBe(true);
    release();
    release();
    expect(providers.size).toBe(0);
  });

  it("leaves sessionFile out for an unsaved session", () => {
    const { providers } = installRegistry();
    registerSessionLiveness(
      { sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined } },
      () => false,
    );
    expect([...providers][0]).not.toHaveProperty("sessionFile");
  });

  it("never throws when the registry does", () => {
    (globalThis as any)[KEY] = {
      version: 1,
      register: () => {
        throw new Error("bad provider");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => registerSessionLiveness(makeCtx(), () => true)()).not.toThrow();
    warn.mockRestore();
  });
});

describe("CronScheduler.hasPendingWork", () => {
  it("is false with no jobs", () => {
    const scheduler = new CronScheduler(makeStorage(), makePi(), makeCtx());
    scheduler.start();
    expect(scheduler.hasPendingWork()).toBe(false);
    scheduler.stop();
  });

  it("is true for a future one-shot and false once it has fired", async () => {
    vi.useFakeTimers();
    const once = job({ id: "once", schedule: new Date(Date.now() + 60_000).toISOString() });
    const scheduler = new CronScheduler(makeStorage([once]), makePi(), makeCtx());
    scheduler.start();
    expect(scheduler.hasPendingWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(scheduler.hasPendingWork()).toBe(false);
    scheduler.stop();
  });

  it("follows a recurring job through disable and remove", () => {
    const cron = job({ id: "cron", type: "cron", schedule: "0 0 9 * * *" });
    const scheduler = new CronScheduler(makeStorage([cron]), makePi(), makeCtx());
    scheduler.start();
    expect(scheduler.hasPendingWork()).toBe(true);
    scheduler.updateJob("cron", { ...cron, enabled: false });
    expect(scheduler.hasPendingWork()).toBe(false);
    scheduler.updateJob("cron", { ...cron, enabled: true });
    expect(scheduler.hasPendingWork()).toBe(true);
    scheduler.removeJob("cron");
    expect(scheduler.hasPendingWork()).toBe(false);
    scheduler.stop();
  });

  it("is true for an interval job", () => {
    const interval = job({ id: "iv", type: "interval", schedule: "5m", intervalMs: 5 * 60_000 });
    const scheduler = new CronScheduler(makeStorage([interval]), makePi(), makeCtx());
    scheduler.start();
    expect(scheduler.hasPendingWork()).toBe(true);
    scheduler.stop();
    expect(scheduler.hasPendingWork()).toBe(false);
  });

  it("counts an idle job until it fires in this stretch", async () => {
    vi.useFakeTimers();
    const idle = job({ id: "idle", type: "idle", schedule: "10m", intervalMs: 10 * 60_000 });
    const scheduler = new CronScheduler(makeStorage([idle]), makePi(), makeCtx());
    scheduler.start();
    expect(scheduler.hasPendingWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(scheduler.hasPendingWork()).toBe(false);
    // The user's next input starts a new stretch, re-arming it.
    scheduler.onUserInput();
    expect(scheduler.hasPendingWork()).toBe(true);
    scheduler.stop();
  });
});

describe("extension lifecycle registers liveness", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-prompt-liveness-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeAll(() => {
    mkdirSync(join(dir, "agent"), { recursive: true });
    mkdirSync(join(dir, "cwd"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  });
  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  async function load() {
    const handlers: Record<string, Array<(e: any, c: any) => unknown>> = {};
    let tool: any;
    const pi = {
      on: (e: string, h: any) => {
        if (!handlers[e]) handlers[e] = [];
        handlers[e].push(h);
      },
      registerTool(t: any) {
        tool = t;
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
      events: { emit() {}, on: () => () => {} },
    } as any;
    await extension(pi);
    const ctx = {
      cwd: join(dir, "cwd"),
      hasUI: false,
      ui: { setWidget() {}, notify() {} },
      isProjectTrusted: () => false,
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "s1",
        getSessionFile: () => join(dir, "s1.jsonl"),
        getEntries: () => [],
      },
    } as any;
    const fire = async (event: string, payload: any) => {
      for (const h of handlers[event] ?? []) await h(payload, ctx);
    };
    return { fire, tool, ctx };
  }

  it("registers once per session start, follows jobs, and releases on shutdown", async () => {
    const { providers, register } = installRegistry();
    const { fire, tool, ctx } = await load();

    await fire("session_start", { type: "session_start", reason: "startup" });
    expect(register).toHaveBeenCalledTimes(1);
    const [provider] = providers;
    expect(provider.sessionId).toBe("s1");
    expect(provider.isActive()).toBe(false);

    await tool.execute(
      "call-1",
      { action: "add", name: "daily", schedule: "0 0 9 * * *", prompt: "hello" },
      undefined,
      undefined,
      ctx,
    );
    expect(provider.isActive()).toBe(true);

    // A repeated session_start (reload/resume) swaps the registration, never stacks it.
    await fire("session_start", { type: "session_start", reason: "resume" });
    expect(register).toHaveBeenCalledTimes(2);
    expect(providers.size).toBe(1);
    expect([...providers][0].isActive()).toBe(true);

    await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(providers.size).toBe(0);
  });
});
