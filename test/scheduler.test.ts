import { beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import type { CronJob } from "../src/types.js";

// Mock the subagent runner: scheduler tests don't actually want to spin up an
// in-memory AgentSession, just verify the scheduler's wiring around it.
vi.mock("../src/subagent.js", () => ({
  runSubagentOnce: vi.fn(),
}));

import { runSubagentOnce } from "../src/subagent.js";

const mockRunSubagentOnce = vi.mocked(runSubagentOnce);

// In-memory CronStorage stand-in.
function makeStorage(seedJobs: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seedJobs.map((j) => [j.id, j]));
  return {
    hasJobWithName: (name: string) =>
      Array.from(jobs.values()).some((j) => j.name === name),
    addJob: (job: CronJob) => jobs.set(job.id, job),
    removeJob: (id: string) => jobs.delete(id),
    updateJob: (id: string, partial: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    },
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values()),
    getStorePath: () => ":memory:",
  } as any;
}

// Minimal ExtensionAPI: scheduler only touches sendMessage + events.emit.
function makePi() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function makeCtx() {
  return { cwd: "/tmp", modelRegistry: { find: () => undefined, getAvailable: () => [] } } as any;
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "+10s",
    prompt: "do the thing",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("CronScheduler — subagent path marker delivery", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("posts a subagent_start marker with deliverAs=followUp and no triggerTurn", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "result text" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);

    // First call is the start marker, fired synchronously before the IIFE runs.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [startMsg, startOpts] = pi.sendMessage.mock.calls[0];
    expect(startMsg.details.mode).toBe("subagent_start");
    expect(startMsg.details.model).toBe("haiku");
    expect(startOpts).toEqual({ deliverAs: "followUp" });
    // start should never trigger a parent turn — it's just a "running" notification.
    expect(startOpts.triggerTurn).toBeUndefined();
  });

  it("posts a subagent_done marker with triggerTurn=false when notify is unset", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.mode).toBe("subagent_done");
    expect(doneMsg.details.output).toBe("OK");
    expect(doneOpts).toEqual({ deliverAs: "followUp", triggerTurn: false });
  });

  it("posts a subagent_done marker with triggerTurn=true when notify is true", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("posts a subagent_error marker with triggerTurn gated by notify", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "model exploded" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg, errOpts] = pi.sendMessage.mock.calls[1];
    expect(errMsg.details.mode).toBe("subagent_error");
    expect(errMsg.details.error).toBe("model exploded");
    expect(errOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("truncates output longer than 500 chars with an ellipsis", async () => {
    const longText = "x".repeat(600);
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: longText });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.output).toHaveLength(501); // 500 + ellipsis char
    expect(doneMsg.details.output.endsWith("…")).toBe(true);
  });

  it("updates lastStatus and increments runCount on success", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", runCount: 3 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob("job-1").lastStatus).toBe("success"));

    const updated = storage.getJob("job-1");
    expect(updated.runCount).toBe(4);
    expect(updated.lastRun).toBeDefined();
  });

  it("updates lastStatus to error and does not advance runCount on failure", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "boom" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", runCount: 7 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob("job-1").lastStatus).toBe("error"));

    expect(storage.getJob("job-1").runCount).toBe(7);
  });
});

describe("CronScheduler — shutdown abort", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("aborts in-flight subagents when stop() is called", async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveRun!: (r: { ok: true; text: string }) => void;
    mockRunSubagentOnce.mockImplementation(async (_ctx, _prompt, _model, signal) => {
      receivedSignal = signal;
      return new Promise((resolve) => {
        resolveRun = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" } as any));
      });
    });

    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    // Wait until the IIFE has actually invoked the runner and we have its signal.
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    expect(receivedSignal!.aborted).toBe(false);

    scheduler.stop();
    expect(receivedSignal!.aborted).toBe(true);

    // Cleanup the dangling promise so vitest doesn't complain.
    resolveRun({ ok: true, text: "" });
  });

  it("does not post completion markers for runs aborted by stop()", async () => {
    let resolveRun!: (r: { ok: true; text: string }) => void;
    let signalReceived = false;
    mockRunSubagentOnce.mockImplementation(async (_ctx, _prompt, _model, signal) => {
      signalReceived = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" } as any));
      });
    });

    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(signalReceived).toBe(true));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // start only

    scheduler.stop();

    // Wait for the IIFE to clean itself up after abort.
    await vi.waitFor(() => expect((scheduler as any).activeSubagents.size).toBe(0));
    // No done/error marker should be posted because the signal was aborted.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    resolveRun({ ok: true, text: "" });
  });

  it("clears activeSubagents after a natural completion", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect((scheduler as any).activeSubagents.size).toBe(0));
  });

  it("survives a thrown sendMessage and still advances storage to a terminal status", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    let firstCall = true;
    pi.sendMessage = vi.fn(() => {
      if (firstCall) {
        firstCall = false;
        return; // start marker succeeds
      }
      throw new Error("pi is stale (simulated teardown)");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const job = exampleJob({ model: "haiku" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

    // Storage was advanced before the marker post, so the job is NOT stuck in "running"
    // even though sendMessage threw. This is the regression guard for the "stuck running"
    // failure mode.
    expect(storage.getJob("job-1").lastStatus).toBe("success");
    expect(storage.getJob("job-1").runCount).toBe(1);

    // The marker failure was logged via the inner try/catch (not the outer backstop).
    const loggedMessage = consoleSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain(`Failed to post subagent_done marker for job ${job.id}`);
    consoleSpy.mockRestore();
  });
});

describe("CronScheduler — inline path is unaffected by mock", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("does not call runSubagentOnce when job has no model", async () => {
    const pi = makePi();
    const job = exampleJob(); // no model
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    await (scheduler as any).executeJob(job);

    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    // Inline path: marker + sendUserMessage
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      "do the thing",
      { deliverAs: "followUp" },
    );
  });
});
