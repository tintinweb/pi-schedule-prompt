// Subagent lifecycle against the real (unmocked) pi runtime: a probe extension
// loaded by pi's own loader, a fake provider, and a real parent ModelRegistry.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { waitForTeardowns } from "../src/index.js";
import { CronScheduler } from "../src/scheduler.js";
import { runSubagentOnce } from "../src/subagent.js";
import type { CronJob } from "../src/types.js";
import { fakeProviderConfig, probeLog } from "./fixtures/lifecycle/fake-provider.js";

const dir = mkdtempSync(join(tmpdir(), "pi-schedule-prompt-lifecycle-"));
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

async function makeCtx() {
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
  runtime.registerProvider("fake", fakeProviderConfig);
  return {
    cwd: join(dir, "cwd"),
    modelRegistry: new ModelRegistry(runtime),
    sessionManager: { getSessionId: () => "s" },
  } as any;
}

async function waitForLog(entry: string) {
  const deadline = Date.now() + 10_000;
  while (!probeLog().includes(entry)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${entry}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("subagent lifecycle (real pi)", () => {
  beforeAll(() => {
    cpSync(join(__dirname, "fixtures/lifecycle"), dir, { recursive: true });
    cpSync(join(dir, "agent"), join(dir, "cwd"), { recursive: true }); // cwd must exist
    rmSync(join(dir, "cwd/extensions"), { recursive: true, force: true });
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  });
  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    delete process.env.PROBE_SLOW_INPUT;
    delete process.env.PROBE_BAD_RESOURCES;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    probeLog().length = 0;
    delete process.env.PROBE_SLOW_INPUT;
    delete process.env.PROBE_BAD_RESOURCES;
  });

  it("runs an extension job end to end: session_start, model call, session_shutdown", async () => {
    const result = await runSubagentOnce(await makeCtx(), "hi", "fake/m", undefined, { extensions: true });

    expect(result).toEqual({ ok: true, text: "hello" });
    expect(probeLog()).toEqual(["session_start", "model_called", "session_shutdown_done"]);
  });

  it("does not call the model when aborted during prompt preflight", async () => {
    process.env.PROBE_SLOW_INPUT = "1";
    const controller = new AbortController();
    const pending = runSubagentOnce(await makeCtx(), "hi", "fake/m", controller.signal, {
      extensions: true,
    });
    await waitForLog("input_hook_waiting");
    controller.abort();

    expect(await pending).toEqual({ ok: false, error: "Subagent aborted" });
    expect(probeLog()).not.toContain("model_called");
    expect(probeLog()).toContain("session_shutdown_done");
  });

  it("does not send session_shutdown to extensions that never got session_start", async () => {
    let reads = 0;
    // Reports aborted from the 3rd check on: after the session exists, before bindExtensions.
    const signal = {
      get aborted() {
        return ++reads >= 3;
      },
      addEventListener() {},
      removeEventListener() {},
    } as any;

    const result = await runSubagentOnce(await makeCtx(), "hi", "fake/m", signal, { extensions: true });

    expect(result.ok).toBe(false);
    expect(probeLog()).toEqual([]);
  });

  it("scheduler.stop() settles only after in-flight subagent teardown finishes", async () => {
    process.env.PROBE_SLOW_INPUT = "1";
    const job = {
      id: "j",
      name: "demo",
      schedule: "+10s",
      prompt: "hi",
      enabled: true,
      type: "once",
      createdAt: new Date().toISOString(),
      runCount: 0,
      model: "fake/m",
      extensions: true,
    } as CronJob;
    const jobs = new Map([[job.id, job]]);
    const storage = {
      getJob: (id: string) => jobs.get(id),
      getAllJobs: () => [...jobs.values()],
      updateJob: (id: string, p: Partial<CronJob>) => {
        Object.assign(jobs.get(id) as CronJob, p);
        return true;
      },
    } as any;
    const pi = { sendMessage() {}, sendUserMessage() {}, events: { emit() {}, on() {} } } as any;
    const scheduler = new CronScheduler(storage, pi, await makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await waitForLog("input_hook_waiting");
    await scheduler.stop();

    // pi exits the process right after session_shutdown handlers resolve.
    expect(probeLog()).toContain("session_shutdown_done");
    expect(probeLog()).not.toContain("model_called");
  });

  it("sends session_shutdown when bindExtensions throws after session_start", async () => {
    process.env.PROBE_BAD_RESOURCES = "1";

    const result = await runSubagentOnce(await makeCtx(), "hi", "fake/m", undefined, { extensions: true });

    expect(result.ok).toBe(false);
    expect(probeLog()).toEqual(["session_start", "session_shutdown_done"]);
  });

  // Defensive path: pi >=1.5 always emits session_shutdown before a replacement,
  // but the extension also handles a bare repeated session_start.
  it("on quit, also waits for runs from a scheduler replaced by a bare repeated session_start", async () => {
    process.env.PROBE_SLOW_INPUT = "1";
    const cwd = join(dir, "cwd-restart");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const job = {
      id: "j",
      name: "demo",
      type: "once",
      schedule: new Date(Date.now() + 300).toISOString(),
      prompt: "hi",
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
      model: "fake/m",
      extensions: true,
    };
    writeFileSync(join(cwd, ".pi/schedule-prompts.json"), JSON.stringify({ version: 1, jobs: [job] }));

    const handlers: Record<string, Array<(e: any, c: any) => unknown>> = {};
    const pi = {
      on: (e: string, h: any) => {
        if (!handlers[e]) handlers[e] = [];
        handlers[e].push(h);
      },
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
      events: { emit() {}, on: () => () => {} },
    } as any;
    await extension(pi);
    const ui = { setWidget() {}, notify() {}, select: async () => undefined, custom: async () => undefined };
    // Trusted, so session_start imports the legacy .pi/schedule-prompts.json written above.
    const ctx = { ...(await makeCtx()), cwd, hasUI: false, ui, isProjectTrusted: () => true };
    const fire = async (event: string, payload: any) => {
      for (const h of handlers[event] ?? []) await h(payload, ctx);
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await fire("session_start", { type: "session_start", reason: "startup" });
    await waitForLog("input_hook_waiting");
    await fire("session_start", { type: "session_start", reason: "resume" });
    await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

    // pi exits the process right after session_shutdown handlers resolve.
    expect(probeLog()).toContain("session_shutdown_done");
    log.mockRestore();
  });
});

describe("waitForTeardowns", () => {
  it("gives up after the timeout so pi quit cannot hang on a stuck subagent", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let settled = false;
      const waiting = waitForTeardowns(new Set([new Promise<void>(() => {})]), 10_000).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(settled).toBe(true);
      warn.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves as soon as all teardowns settle", async () => {
    await expect(waitForTeardowns(new Set([Promise.resolve()]), 10_000)).resolves.toBeUndefined();
  });
});
