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

function makeCtx(sessionId = "test-session") {
  return {
    cwd: "/tmp",
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId },
  } as any;
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

  it("posts a silent subagent_start marker (no options, empty content)", async () => {
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
    // Empty content keeps the prompt out of the parent's LLM context (the
    // subagent already has it). No options → idle: silent append + emit
    // (immediately visible in chat); streaming: `agent.steer` with empty
    // content (LLM-invisible, no extra turn triggered).
    expect(startMsg.content).toEqual([]);
    expect(startOpts).toBeUndefined();
  });

  it("posts a silent subagent_done marker when notify is unset (no options, empty content)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.mode).toBe("subagent_done");
    expect(doneMsg.details.output).toBe("OK");
    // notify=false: snippet stays in `details` for the renderer, but content
    // is empty and no options are passed so the parent agent isn't woken.
    // Regression guard for "notify=false still wakes parent" — the previous
    // `{deliverAs: "followUp", triggerTurn: false}` would still queue a
    // follow-up turn when the parent was streaming (the followUp branch in
    // sendCustomMessage takes precedence over the triggerTurn check).
    expect(doneMsg.content).toEqual([]);
    expect(doneOpts).toBeUndefined();
  });

  it("posts a wake-up subagent_done marker when notify is true (followUp + triggerTurn, snippet in content)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content).toEqual([{ type: "text", text: "OK" }]);
    expect(doneOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("posts a subagent_error marker with notify-gated wake-up", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "model exploded" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg, errOpts] = pi.sendMessage.mock.calls[1];
    expect(errMsg.details.mode).toBe("subagent_error");
    expect(errMsg.details.error).toBe("model exploded");
    expect(errMsg.content).toEqual([{ type: "text", text: "model exploded" }]);
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

  it("truncates long error messages the same way as success snippets", async () => {
    const longErr = "boom ".repeat(200); // 1000 chars
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: longErr });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    // Both `details.error` (renderer) and `content` (LLM, since notify=true)
    // see the truncated form so neither floods the chat with stack traces /
    // verbose API errors.
    expect(errMsg.details.error).toHaveLength(501);
    expect(errMsg.details.error.endsWith("…")).toBe(true);
    expect(errMsg.content[0].text).toEqual(errMsg.details.error);
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

describe("CronScheduler — start() recovery", () => {
  it("clears stale lastStatus=running on start (interrupted-by-shutdown recovery)", () => {
    // Simulates the previous session crashing/aborting mid-execution: storage
    // ended up with `lastStatus: "running"` because the IIFE bailed out on the
    // abort signal before reaching its terminal-status update. Without the
    // sweep, the widget would render `⟳` for a job that isn't actually running
    // until the cron next fires.
    //
    // Jobs use type=cron with a valid expression so scheduleJob() doesn't
    // overwrite lastStatus during start() (the once-with-past-timestamp path
    // sets lastStatus="error" itself).
    const pi = makePi();
    const cronSchedule = "0 0 * * * *"; // hourly
    const stuckJob = exampleJob({
      id: "stuck", type: "cron", schedule: cronSchedule, lastStatus: "running",
    });
    const cleanJob = exampleJob({
      id: "clean", type: "cron", schedule: cronSchedule, lastStatus: "success",
    });
    const errorJob = exampleJob({
      id: "errored", type: "cron", schedule: cronSchedule, lastStatus: "error",
    });
    const storage = makeStorage([stuckJob, cleanJob, errorJob]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    try {
      scheduler.start();

      expect(storage.getJob("stuck").lastStatus).toBeUndefined();
      // Other lastStatus values are left alone — we only sweep the one that
      // signals an interrupted run.
      expect(storage.getJob("clean").lastStatus).toBe("success");
      expect(storage.getJob("errored").lastStatus).toBe("error");
    } finally {
      scheduler.stop(); // tear down the live croner timers we just started
    }
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

  it("inline marker uses empty content and no delivery options (regression guard for double-injection)", async () => {
    const pi = makePi();
    const job = exampleJob(); // no model
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    await (scheduler as any).executeJob(job);

    // The marker must NOT carry the prompt in `content` — that would inject
    // the prompt into the LLM context a second time alongside `sendUserMessage`,
    // producing the "PROMPT\n\nPROMPT" / duplicate-turn symptom. No options
    // means: idle → silent append + emit (marker shows before the user
    // message); streaming → `agent.steer` with empty content (no LLM
    // context change, no extra turn triggered).
    const [markerMsg, markerOpts] = pi.sendMessage.mock.calls[0];
    expect(markerMsg.content).toEqual([]);
    expect(markerMsg.details).toEqual({
      jobId: job.id,
      jobName: job.name,
      prompt: job.prompt,
    });
    expect(markerOpts).toBeUndefined();
  });
});

describe("CronScheduler — session binding filter", () => {
  it("isLoadedFor: unbound job is loaded for any session", () => {
    expect(CronScheduler.isLoadedFor(exampleJob(), "any")).toBe(true);
    expect(CronScheduler.isLoadedFor(exampleJob(), undefined)).toBe(true);
  });

  it("isLoadedFor: bound job loads only for the matching session", () => {
    const j = exampleJob({ session: "A" });
    expect(CronScheduler.isLoadedFor(j, "A")).toBe(true);
    expect(CronScheduler.isLoadedFor(j, "B")).toBe(false);
    expect(CronScheduler.isLoadedFor(j, undefined)).toBe(false);
  });

  it("start() does not schedule foreign-session jobs", () => {
    const pi = makePi();
    const cronSchedule = "0 0 * * * *"; // hourly
    // Mark the foreign job lastStatus=running to also assert the stale-running
    // sweep skips it (we don't touch other sessions' state).
    const mine = exampleJob({
      id: "mine", type: "cron", schedule: cronSchedule, session: "session-A",
    });
    const foreign = exampleJob({
      id: "foreign", type: "cron", schedule: cronSchedule,
      session: "session-B", lastStatus: "running",
    });
    const unbound = exampleJob({
      id: "unbound", type: "cron", schedule: cronSchedule,
    });
    const storage = makeStorage([mine, foreign, unbound]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    try {
      scheduler.start();
      const jobsMap = (scheduler as any).jobs as Map<string, unknown>;
      expect(jobsMap.has("mine")).toBe(true);
      expect(jobsMap.has("unbound")).toBe(true);
      expect(jobsMap.has("foreign")).toBe(false);
      // Foreign session's stale-running flag is untouched — it's not ours.
      expect(storage.getJob("foreign").lastStatus).toBe("running");
    } finally {
      scheduler.stop();
    }
  });

  it("executeJob bails when storage now reports the job is bound to another session", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", session: "session-A" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-B"));

    await (scheduler as any).executeJob(job);

    // No marker, no user message — the defensive re-read caught the mismatch
    // before the scheduler dispatched.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails when the job has been removed mid-tick", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j" });
    const storage = makeStorage([]); // job not in storage anymore
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    await (scheduler as any).executeJob(job);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails when the job was disabled mid-tick (e.g. hand-edited file)", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", enabled: false });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    await (scheduler as any).executeJob(job);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails before delegating to subagent when session no longer matches", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", model: "haiku", session: "session-A" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-B"));

    await (scheduler as any).executeJob(job);

    // Guard fires before the model branch — subagent never runs, no markers.
    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("CronScheduler.validateSchedule", () => {
  it("interval: accepts valid duration, returns intervalMs", () => {
    const r = CronScheduler.validateSchedule("interval", "5m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule).toBe("5m");
      expect(r.intervalMs).toBe(5 * 60 * 1000);
    }
  });

  it("interval: rejects garbage with a useful hint", () => {
    const r = CronScheduler.validateSchedule("interval", "five minutes");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'5m', '1h', '30s'");
  });

  it("once: accepts relative time and resolves to ISO", () => {
    const r = CronScheduler.validateSchedule("once", "+5m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = new Date(r.schedule).getTime();
      expect(t - Date.now()).toBeGreaterThan(4 * 60 * 1000);
      expect(t - Date.now()).toBeLessThan(6 * 60 * 1000);
    }
  });

  it("once: rejects past timestamps", () => {
    const r = CronScheduler.validateSchedule("once", "2000-01-01T00:00:00Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in the past");
  });

  it("once: rejects timestamps under 5s away with a relative-time suggestion", () => {
    const soon = new Date(Date.now() + 2000).toISOString();
    const r = CronScheduler.validateSchedule("once", soon);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("too soon");
      expect(r.error).toMatch(/use relative time like '\+\d+s'/);
    }
  });

  it("once: rejects unparseable timestamps", () => {
    const r = CronScheduler.validateSchedule("once", "not-a-date");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Invalid timestamp");
  });

  it("cron: accepts valid 6-field expression", () => {
    const r = CronScheduler.validateSchedule("cron", "0 0 9 * * *");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule).toBe("0 0 9 * * *");
  });

  it("cron: rejects 5-field expression with field-count error", () => {
    const r = CronScheduler.validateSchedule("cron", "0 9 * * *");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("6 fields");
  });
});

describe("CronScheduler.describeSchedule", () => {
  it("cron: humanizes known patterns", () => {
    expect(CronScheduler.describeSchedule("cron", "0 0 0 * * *")).toBe("daily");
    expect(CronScheduler.describeSchedule("cron", "0 */5 * * * *")).toBe("every 5 min");
  });

  it("cron: returns raw expression untouched for unknown patterns (no guessing)", () => {
    const raw = "15 30 8 1,15 * 1-5";
    expect(CronScheduler.describeSchedule("cron", raw)).toBe(raw);
  });

  it("interval: prefixes with 'every'", () => {
    expect(CronScheduler.describeSchedule("interval", "5m")).toBe("every 5m");
  });

  it("once: renders ISO as 'Mon DD HH:MM'", () => {
    const iso = "2026-02-13T15:30:00.000Z";
    const out = CronScheduler.describeSchedule("once", iso);
    // Format depends on local TZ for the day/hour fields, so just assert shape.
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });
});
