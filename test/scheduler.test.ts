import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler, displaySchedule, formatLocal } from "../src/scheduler.js";
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

  it("posts a subagent_start marker with brief status text (no delivery options)", async () => {
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
    // Non-empty content prevents session poisoning (empty content gets filtered
    // by pi-ai, leaving conversation ending on assistant — Anthropic 400s).
    expect(startMsg.content.length).toBeGreaterThan(0);
    expect(startMsg.content[0].text.length).toBeGreaterThan(0);
    expect(startOpts).toBeUndefined();
  });

  it("posts a subagent_done marker with non-empty content when notify is unset (prevents session poisoning)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.mode).toBe("subagent_done");
    expect(doneMsg.details.output).toBe("OK");
    // notify=false: no delivery options so parent isn't woken, but content
    // is non-empty to prevent session poisoning (empty content gets filtered
    // by pi-ai, leaving conversation ending on assistant — Anthropic 400s).
    expect(doneMsg.content.length).toBeGreaterThan(0);
    expect(doneMsg.content[0].text).toBe("OK");
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

  it("uses placeholder text when subagent produces no output with notify=true (#10)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent produces no output with notify=false (#10 + #12)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    // Even with notify=false, content must be non-empty to prevent session poisoning.
    expect(doneMsg.content.length).toBeGreaterThan(0);
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
    expect(doneMsg.details.output).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent errors with empty error message (#10)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
  });

  it("uses placeholder text when subagent errors with empty error message and notify=false (#10 + #12)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content.length).toBeGreaterThan(0);
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
    expect(errMsg.details.error).toBe("(subagent failed with empty error)");
  });

  it("uses placeholder text when subagent produces whitespace-only output (edge case)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "   " });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent returns whitespace-only error (edge case)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "   " });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
  });

describe("CronScheduler — once scheduling", () => {
  it("schedules far-future one-shot jobs with Cron instead of a long timeout", () => {
    const pi = makePi();
    const target = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const job = exampleJob({
      id: "far-once",
      type: "once",
      schedule: target.toISOString(),
    });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    try {
      scheduler.start();

      const jobsMap = (scheduler as any).jobs as Map<string, unknown>;
      const intervalsMap = (scheduler as any).intervals as Map<string, unknown>;
      expect(jobsMap.has("far-once")).toBe(true);
      expect(intervalsMap.has("far-once")).toBe(false);
      expect(scheduler.getNextRun("far-once")?.toISOString()).toBe(target.toISOString());
    } finally {
      scheduler.stop();
    }
  });
});

describe("CronScheduler — interval scheduling", () => {
  it("disables a stored interval over the timer limit instead of scheduling it", () => {
    vi.useFakeTimers();
    const pi = makePi();
    const job = exampleJob({
      id: "huge-interval",
      type: "interval",
      schedule: "30d",
      intervalMs: 30 * 24 * 60 * 60 * 1000,
    });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    try {
      scheduler.start();
      vi.advanceTimersByTime(100);

      expect((scheduler as any).intervals.has("huge-interval")).toBe(false);
      expect(storage.getJob("huge-interval")).toMatchObject({ enabled: false, lastStatus: "error" });
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});

describe("CronScheduler — idle scheduling", () => {
  const MIN = 60 * 1000;

  // ctx with controllable isIdle / hasPendingMessages.
  function idleCtx(sessionId = "test-session") {
    const state = { idle: true, pending: false };
    const ctx = {
      ...makeCtx(sessionId),
      isIdle: () => state.idle,
      hasPendingMessages: () => state.pending,
    };
    return { ctx: ctx as any, state };
  }

  function idleJob(overrides: Partial<CronJob> = {}): CronJob {
    return exampleJob({
      id: "idle-1",
      type: "idle",
      schedule: "10m",
      intervalMs: 10 * MIN,
      ...overrides,
    });
  }

  function setup(jobs: CronJob[] = [idleJob()], sessionId?: string) {
    const pi = makePi();
    const storage = makeStorage(jobs);
    const { ctx, state } = idleCtx(sessionId);
    const scheduler = new CronScheduler(storage, pi, ctx);
    return { pi, storage, state, scheduler };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once the agent has been idle for the duration, counting from session start", () => {
    const { pi, scheduler } = setup();
    scheduler.start();

    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("do the thing", { deliverAs: "followUp" });
    scheduler.stop();
  });

  it("pauses while busy; a user turn restarts the clock when it settles", () => {
    const { pi, scheduler } = setup();
    scheduler.start();

    vi.advanceTimersByTime(9 * MIN);
    scheduler.onUserInput();
    scheduler.onBusy();
    vi.advanceTimersByTime(30 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    scheduler.onSettled();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("scheduled turns don't restart the clock: a 5m heartbeat can't starve a 15m idle job", () => {
    const { pi, scheduler } = setup([idleJob({ schedule: "15m", intervalMs: 15 * MIN })]);
    scheduler.start();

    // Another job's turn every 5 minutes (no user input).
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5 * MIN - 10);
      scheduler.onBusy();
      vi.advanceTimersByTime(10);
      scheduler.onSettled();
    }
    // 15m of user inactivity reached during the third turn; fires on its settle.
    vi.advanceTimersByTime(0);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("an aborted run restarts the clock (the user is at the keyboard)", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(9 * MIN);
    scheduler.onBusy();
    scheduler.onSettled(true);
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not re-fire after its own turn settles; re-arms only after user input", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // The job's own turn runs and settles.
    scheduler.onBusy();
    scheduler.onSettled();
    vi.advanceTimersByTime(60 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // User types; their turn runs and settles: a new idle stretch.
    scheduler.onUserActivity();
    scheduler.onBusy();
    scheduler.onSettled();
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("two inline idle jobs due together fire one turn at a time, not concurrent prompts", () => {
    const { pi, scheduler } = setup([idleJob({ id: "a" }), idleJob({ id: "b", name: "b" })]);
    scheduler.start();

    // pi still reports idle while A's prompt is in preflight; B must wait.
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // A's run starts and settles; B is overdue and fires right after.
    scheduler.onBusy();
    scheduler.onSettled();
    vi.advanceTimersByTime(0);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("a second inline idle job still fires if the first prompt never starts a run", () => {
    const { pi, scheduler } = setup([idleJob({ id: "a" }), idleJob({ id: "b", name: "b" })]);
    scheduler.start();

    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    // No agent_start (e.g. A's prompt failed preflight): B fires after the retry.
    vi.advanceTimersByTime(5000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("retries while pi is busy without a run (e.g. compacting) or has queued messages", () => {
    const { pi, state, scheduler } = setup();
    scheduler.start();

    state.idle = false; // compaction: isIdle() false, no agent_start / agent_settled
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(scheduler.getNextRun("idle-1")).not.toBeNull();

    state.idle = true;
    state.pending = true;
    vi.advanceTimersByTime(60 * 1000);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    state.pending = false;
    vi.advanceTimersByTime(5000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("never fires disabled or foreign-session idle jobs", () => {
    const { pi, scheduler } = setup([
      idleJob({ id: "off", enabled: false }),
      idleJob({ id: "foreign", session: "other-session" }),
    ]);
    scheduler.start();
    scheduler.onSettled();
    vi.advanceTimersByTime(60 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("a job added after a long idle waits its full duration, not zero", () => {
    const { pi, storage, scheduler } = setup([]);
    scheduler.start();
    vi.advanceTimersByTime(2 * 60 * MIN);

    const job = idleJob();
    storage.addJob(job);
    scheduler.addJob(job);
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("re-enabling a job that already fired lets it fire again without new input", () => {
    const { pi, storage, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const job = storage.getJob("idle-1");
    scheduler.updateJob("idle-1", { ...job, enabled: false });
    scheduler.updateJob("idle-1", { ...job, enabled: true });
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("only arms jobs this scheduler loaded, not ones another process added to the store", () => {
    const { pi, storage, scheduler } = setup([]);
    scheduler.start();
    storage.addJob(idleJob({ id: "from-other-pi" }));
    scheduler.onSettled();
    vi.advanceTimersByTime(60 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("handled input that starts no run doesn't make a later scheduled turn count as the user's", () => {
    const { pi, scheduler } = setup([idleJob({ schedule: "15m", intervalMs: 15 * MIN })]);
    scheduler.start();
    scheduler.onUserInput(); // e.g. another extension handled it: no run follows
    vi.advanceTimersByTime(10 * MIN);
    scheduler.onBusy(); // a scheduled turn, 10 minutes later
    scheduler.onSettled();
    vi.advanceTimersByTime(5 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("input while a scheduled turn runs makes that run the user's", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(5 * MIN);
    scheduler.onBusy();
    vi.advanceTimersByTime(8 * MIN);
    scheduler.onUserInput(); // steer / queued follow-up
    vi.advanceTimersByTime(MIN);
    scheduler.onSettled();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("closing a dialog restarts the clock but doesn't let a fired job fire again", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.onPromptStart();
    scheduler.onPromptEnd(); // e.g. a dialog in the job's own turn timed out
    vi.advanceTimersByTime(60 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("editing an armed idle job keeps its due time", () => {
    const { pi, storage, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(9 * MIN);
    scheduler.updateJob("idle-1", { ...storage.getJob("idle-1"), description: "tweaked" });
    vi.advanceTimersByTime(MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("a fire skipped because storage disabled the job doesn't use up the stretch", () => {
    const { pi, storage, scheduler } = setup();
    scheduler.start();
    storage.updateJob("idle-1", { enabled: false }); // hand edit, no scheduler call
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    storage.updateJob("idle-1", { enabled: true });
    scheduler.onBusy();
    scheduler.onSettled();
    vi.advanceTimersByTime(0);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("user activity without a run (a ! command) restarts the clock while idle", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(9 * MIN);
    scheduler.onUserActivity();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("an open dialog pauses the clock; closing it restarts it", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(5 * MIN);
    scheduler.onPromptStart();
    vi.advanceTimersByTime(30 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    scheduler.onPromptEnd();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("editing an enabled idle job (e.g. from its own turn) does not re-arm it", () => {
    const { pi, storage, scheduler } = setup();
    scheduler.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    scheduler.onBusy();
    scheduler.updateJob("idle-1", { ...storage.getJob("idle-1"), description: "tweaked" });
    scheduler.onSettled();
    vi.advanceTimersByTime(60 * MIN);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("arms at start even if pi is compacting, and fires once it is idle", () => {
    const pi = makePi();
    const { ctx, state } = idleCtx();
    state.idle = false;
    const scheduler = new CronScheduler(makeStorage([idleJob()]), pi, ctx);
    scheduler.start();
    vi.advanceTimersByTime(10 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    state.idle = true;
    vi.advanceTimersByTime(5000);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("getNextRun never reports a past time while an overdue job waits for idle", () => {
    const { state, scheduler } = setup();
    scheduler.start();
    state.idle = false;
    vi.advanceTimersByTime(12 * MIN);
    expect(scheduler.getNextRun("idle-1")!.getTime()).toBeGreaterThanOrEqual(Date.now());
    scheduler.stop();
  });

  it("does not emit cron:change on a settle that leaves the timers unchanged", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    pi.events.emit.mockClear();
    scheduler.onSettled();
    expect(pi.events.emit).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("emits cron:change when idle timers arm or disarm, so the widget redraws", () => {
    const { pi, scheduler } = setup();
    scheduler.start();
    pi.events.emit.mockClear();
    scheduler.onBusy();
    expect(pi.events.emit).toHaveBeenCalledWith("cron:change", { type: "update" });
    pi.events.emit.mockClear();
    scheduler.onSettled();
    expect(pi.events.emit).toHaveBeenCalledWith("cron:change", { type: "update" });
    scheduler.stop();
  });

  it("removeJob and stop clear armed idle timers", () => {
    const { pi, scheduler } = setup([idleJob({ id: "a" }), idleJob({ id: "b", name: "b" })]);
    scheduler.start();
    scheduler.removeJob("a");
    scheduler.stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("getNextRun reports last activity + duration while armed, null while busy", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { scheduler } = setup();
    scheduler.start();
    expect(scheduler.getNextRun("idle-1")?.toISOString()).toBe("2026-01-01T00:10:00.000Z");
    scheduler.onBusy();
    expect(scheduler.getNextRun("idle-1")).toBeNull();
    scheduler.stop();
  });

  it("disables a stored idle job over the timer limit", () => {
    const { pi, storage, scheduler } = setup([
      idleJob({ schedule: "30d", intervalMs: 30 * 24 * 60 * MIN }),
    ]);
    scheduler.start();
    vi.advanceTimersByTime(100);
    expect(storage.getJob("idle-1")).toMatchObject({ enabled: false, lastStatus: "error" });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    scheduler.stop();
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

  it("interval: accepts 24d, the longest whole-day interval under the timer limit", () => {
    const r = CronScheduler.validateSchedule("interval", "24d");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.intervalMs).toBe(24 * 24 * 60 * 60 * 1000);
  });

  it("interval: rejects intervals over the ~24.8-day timer limit and points to cron", () => {
    for (const schedule of ["25d", "30d", "597h"]) {
      const r = CronScheduler.validateSchedule("interval", schedule);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("cron expression");
    }
  });

  it("interval: rejects garbage with a useful hint", () => {
    const r = CronScheduler.validateSchedule("interval", "five minutes");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'5m', '1h', '30s'");
  });

  it("idle: accepts a duration and returns intervalMs", () => {
    const r = CronScheduler.validateSchedule("idle", "10m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule).toBe("10m");
      expect(r.intervalMs).toBe(10 * 60 * 1000);
    }
  });

  it("idle: rejects garbage and durations over the timer limit", () => {
    const bad = CronScheduler.validateSchedule("idle", "ten minutes");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("Invalid idle duration");
    const long = CronScheduler.validateSchedule("idle", "25d");
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toContain("too long");
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

  it("idle: renders 'after <duration> idle'", () => {
    expect(CronScheduler.describeSchedule("idle", "10m")).toBe("after 10m idle");
  });

  it("once: renders ISO as 'Mon DD HH:MM'", () => {
    const iso = "2026-02-13T15:30:00.000Z";
    const out = CronScheduler.describeSchedule("once", iso);
    // Format depends on local TZ for the day/hour fields, so just assert shape.
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });
});

describe("CronScheduler — extensions/skills", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("passes extensions=true to runSubagentOnce when job has extensions=true", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", extensions: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: true, skills: undefined });
  });

  it("passes extensions=false to runSubagentOnce when job has no extensions", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" }); // no extensions
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: undefined, skills: undefined });
  });

  it("passes extensions=false to runSubagentOnce when job has extensions=false", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", extensions: false });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: false, skills: undefined });
  });
});

describe("formatLocal / displaySchedule", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // Zones without DST keep these expectations stable year-round.
  it("renders local wall-clock time with a positive half-hour offset", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(formatLocal("2026-11-16T12:00:00.000Z")).toBe("2026-11-16 17:30:00 +05:30");
  });

  it("renders a negative offset and rolls the date back", () => {
    process.env.TZ = "Pacific/Honolulu";
    expect(formatLocal(new Date("2026-11-16T05:04:03.000Z"))).toBe("2026-11-15 19:04:03 -10:00");
  });

  it("renders UTC as +00:00", () => {
    process.env.TZ = "UTC";
    expect(formatLocal("2026-01-02T03:04:05.000Z")).toBe("2026-01-02 03:04:05 +00:00");
  });

  it("returns unparseable input unchanged", () => {
    expect(formatLocal("not a date")).toBe("not a date");
  });

  it("shows one-shot schedules in local time and leaves cron/interval unchanged", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(displaySchedule({ type: "once", schedule: "2026-11-16T12:00:00.000Z" })).toBe(
      "2026-11-16 17:30:00 +05:30",
    );
    expect(displaySchedule({ type: "cron", schedule: "0 0 9 * * *" })).toBe("0 0 9 * * *");
    expect(displaySchedule({ type: "interval", schedule: "5m" })).toBe("5m");
  });
});
