// Subagent lifecycle against the real (unmocked) pi runtime: a probe extension
// loaded by pi's own loader, a fake provider, and a real parent ModelRegistry.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    probeLog().length = 0;
    delete process.env.PROBE_SLOW_INPUT;
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
});
