import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import type { CronStorage } from "./storage.js";
import { runSubagentOnce, type SubagentResult } from "./subagent.js";
import type { CronChangeEvent, CronJob, CronJobType } from "./types.js";

/** Result of `CronScheduler.validateSchedule`. On success, `schedule` is the
 *  resolved form to persist (ISO for `once`, original for `cron`/`interval`). */
type ValidateScheduleResult =
  | { ok: true; schedule: string; intervalMs?: number }
  | { ok: false; error: string };

const SUBAGENT_OUTPUT_SNIPPET_LENGTH = 500;

/** Longest delay Node timers accept (2^31−1 ms, ~24.8 days). Node replaces a
 *  longer delay with 1 ms, so an interval above this would fire every
 *  millisecond. */
export const MAX_INTERVAL_MS = 2_147_483_647;

/** How often an overdue idle job re-checks while pi is busy without a run
 *  (e.g. compacting), since no agent_settled follows that. */
const IDLE_RETRY_MS = 5_000;

/** How soon after idle-time user input its run must start to count as the
 *  user's turn. Input another extension handles starts no run, and must not
 *  make a later scheduled run count as the user's. */
const USER_TURN_START_WINDOW_MS = 5_000;

/** Truncate `text` to `SUBAGENT_OUTPUT_SNIPPET_LENGTH`, appending an ellipsis if cut. */
function snippet(text: string): string {
  return text.length > SUBAGENT_OUTPUT_SNIPPET_LENGTH
    ? text.slice(0, SUBAGENT_OUTPUT_SNIPPET_LENGTH) + "…"
    : text;
}

/**
 * Manages cron job scheduling and execution
 */
export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  /** Scheduled (enabled, loaded) `idle` jobs, with when each was scheduled.
   *  A job never fires sooner than its full duration after being scheduled. */
  private idleJobs = new Map<string, { job: CronJob; since: number }>();
  /** Armed idle timers and the time each is due. Empty while the agent is busy. */
  private idleTimers = new Map<string, { timer: NodeJS.Timeout; fireAt: number }>();
  /** Start of the user's current inactivity (ms epoch): session start, the
   *  user's last activity, or the settle of their last turn. Scheduled turns
   *  don't move it. A scheduler is built per session, so this counts from then. */
  private lastUserActivity = Date.now();
  /** Idle-time user input arrived; a run starting before this time is theirs. */
  private userTurnPendingUntil = 0;
  /** The current run is the user's (or absorbed their input); its settle
   *  restarts the idle clock. */
  private userRun = false;
  /** Between pi's `agent_start` and `agent_settled`. Starts false even if pi
   *  is compacting: no agent_settled would follow, and the fire-time
   *  isIdle() check retries until pi is idle. */
  private busy = false;
  /** A blocking extension dialog (select/confirm/input/editor/custom) is open. */
  private promptOpen = false;
  /** Idle jobs that already fired in the current idle stretch. Cleared only by
   *  user input, so a job's own turn (or another job's) can't re-arm it. */
  private firedThisStretch = new Set<string>();
  /** When an inline idle job last sent its prompt, until that run's
   *  `agent_start` (0 = none pending). pi reports idle while a prompt is still
   *  in preflight, so without this a second idle job due in the same tick
   *  would send a concurrent prompt that pi rejects. */
  private inlineFireAt = 0;
  private activeSubagents = new Set<AbortController>();
  /** Settles when each in-flight subagent run (including its session teardown) finishes. */
  private inflightSubagents = new Set<Promise<void>>();
  private readonly storage: CronStorage;
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;

  constructor(storage: CronStorage, pi: ExtensionAPI, ctx: ExtensionContext) {
    this.storage = storage;
    this.pi = pi;
    this.ctx = ctx;
  }

  /**
   * Schedule all enabled jobs loaded for this session — see `isLoadedFor`.
   * Foreign-session jobs are skipped so two pis in the same cwd don't double-fire.
   *
   * Also clears stale `lastStatus: "running"` from an interrupted prior run of
   * *this* session (process kill, abort) — otherwise the widget sticks on `⟳`
   * until the cron next fires. Other sessions' flags are theirs to manage.
   */
  start(): void {
    const mySessionId = this.ctx.sessionManager.getSessionId();
    for (const job of this.storage.getAllJobs()) {
      if (!CronScheduler.isLoadedFor(job, mySessionId)) continue;
      if (job.lastStatus === "running") {
        this.storage.updateJob(job.id, { lastStatus: undefined });
      }
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /** Unbound jobs (no `session` field) load for everyone. */
  static isLoadedFor(job: CronJob, sessionId: string | undefined): boolean {
    return !job.session || job.session === sessionId;
  }

  /**
   * Stop all scheduled jobs and abort in-flight subagent runs.
   *
   * Timers are cleared synchronously. The returned promise settles once every
   * aborted subagent run has finished tearing its session down (extension
   * `session_shutdown` handlers included; each teardown step is time-bounded).
   * Await it on pi shutdown: pi exits the process right after `session_shutdown`
   * handlers resolve, which would otherwise orphan subagent extensions' child
   * processes.
   */
  stop(): Promise<void> {
    // Stop all cron jobs
    for (const cron of this.jobs.values()) {
      cron.stop();
    }
    this.jobs.clear();

    // Clear all intervals
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();

    this.clearIdleTimers();
    this.idleJobs.clear();

    // Abort any in-flight subagent runs so they don't keep streaming or post
    // markers against a stale pi reference after session shutdown.
    for (const controller of this.activeSubagents) {
      controller.abort();
    }
    this.activeSubagents.clear();

    return Promise.allSettled([...this.inflightSubagents]).then(() => {});
  }

  /**
   * Add and schedule a new job
   */
  addJob(job: CronJob): void {
    if (job.enabled) {
      this.scheduleJob(job);
    }
    this.emitChange({ type: "add", job });
  }

  /**
   * Remove and unschedule a job
   */
  removeJob(id: string): void {
    this.unscheduleJob(id);
    this.firedThisStretch.delete(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  /**
   * Update a job (reschedule if needed)
   */
  updateJob(id: string, updated: CronJob): void {
    // Re-enabling a disabled idle job lets it fire again in this stretch and
    // waits its full duration. Editing an enabled one (even from its own turn)
    // keeps both its fired flag and its original start, so it neither re-arms
    // nor gets pushed back.
    const previous = this.idleJobs.get(id);
    if (!previous) this.firedThisStretch.delete(id);
    this.unscheduleJob(id);
    if (updated.enabled) {
      this.scheduleJob(updated, previous?.since);
    }
    this.emitChange({ type: "update", job: updated });
  }

  /**
   * Get next run time for a job
   */
  getNextRun(jobId: string): Date | null {
    const idle = this.idleTimers.get(jobId);
    // Clamped: an overdue job waiting for pi to go idle is due "now", not in the past.
    if (idle) return new Date(Math.max(idle.fireAt, Date.now()));
    const cron = this.jobs.get(jobId);
    if (cron) {
      const next = cron.nextRun();
      return next || null;
    }
    return null;
  }

  /**
   * The agent finished all work (pi's `agent_settled`). Restarts the idle clock
   * if this settle ends a user turn or an abort (the user is present); a turn
   * started by a scheduled job leaves it running. Then arms every idle job that
   * hasn't fired in this stretch; an overdue one fires right away.
   */
  onSettled(aborted = false): void {
    this.busy = false;
    if (this.userRun || aborted) this.lastUserActivity = Date.now();
    this.userRun = false;
    this.rearmIdleJobs();
  }

  /** The agent started a run: pause the idle timers until it settles. */
  onBusy(): void {
    this.busy = true;
    this.inlineFireAt = 0;
    if (Date.now() <= this.userTurnPendingUntil) this.userRun = true;
    this.userTurnPendingUntil = 0;
    this.disarmIdleJobs();
  }

  /**
   * The user sent input. Like {@link onUserActivity}; in addition the run
   * carrying it (the current one when steering or queueing, else the next one
   * to start) is the user's, so the clock restarts again when it settles.
   */
  onUserInput(): void {
    if (this.busy) this.userRun = true;
    else this.userTurnPendingUntil = Date.now() + USER_TURN_START_WINDOW_MS;
    this.onUserActivity();
  }

  /** The user did something (e.g. ran a `!` command): restart the idle clock
   *  and start a new idle stretch. */
  onUserActivity(): void {
    this.firedThisStretch.clear();
    this.restartIdleClock();
  }

  private restartIdleClock(): void {
    this.lastUserActivity = Date.now();
    this.rearmIdleJobs();
  }

  /** A blocking dialog opened: the user is at the keyboard, so pause. */
  onPromptStart(): void {
    this.promptOpen = true;
    this.disarmIdleJobs();
  }

  /** The dialog closed. Restarts the clock but does not start a new stretch:
   *  pi can't tell an answer from a timeout or abort, and a dialog opened by an
   *  idle job's own turn must not let that job fire again. */
  onPromptEnd(): void {
    this.promptOpen = false;
    this.restartIdleClock();
  }

  private rearmIdleJobs(): void {
    const before = this.idleTimerSnapshot();
    for (const { job, since } of this.idleJobs.values()) this.armIdleJob(job, since);
    if (this.idleTimerSnapshot() !== before) this.emitChange({ type: "update" });
  }

  private disarmIdleJobs(): void {
    if (this.idleTimers.size === 0) return;
    this.clearIdleTimers();
    this.emitChange({ type: "update" });
  }

  /** Armed jobs and due times, to emit `cron:change` only when they change. */
  private idleTimerSnapshot(): string {
    return [...this.idleTimers].map(([id, { fireAt }]) => `${id}@${fireAt}`).join(",");
  }

  /** `ctx.isIdle()`, treating a context without it (tests, older hosts) as idle. */
  private agentIdle(): boolean {
    return this.ctx.isIdle?.() ?? true;
  }

  /** Arm an idle job's timer, due its duration after the later of the user's
   *  last activity and when the job was scheduled. No-op while busy, while a
   *  dialog is open, or once it fired in this stretch. An armed timer with the
   *  same due time is left alone. */
  private armIdleJob(job: CronJob, since: number): void {
    if (this.busy || this.promptOpen || !job.intervalMs) return;
    if (this.firedThisStretch.has(job.id)) return;
    const fireAt = Math.max(this.lastUserActivity, since) + job.intervalMs;
    if (this.idleTimers.get(job.id)?.fireAt === fireAt) return;
    this.clearIdleTimer(job.id);
    this.setIdleTimer(job, fireAt, fireAt - Date.now());
  }

  private setIdleTimer(job: CronJob, fireAt: number, delay: number): void {
    const timer = setTimeout(() => {
      this.idleTimers.delete(job.id);
      // pi can be busy without an agent_start (e.g. a manual /compact) and
      // then never emits agent_settled; poll until it is idle again.
      // An inline job's prompt from another idle job is still in preflight:
      // wait for its run. Bounded, in case that prompt never starts a run.
      const inlinePending = !job.model && Date.now() - this.inlineFireAt < IDLE_RETRY_MS;
      if (!this.agentIdle() || this.ctx.hasPendingMessages?.() || inlinePending) {
        this.setIdleTimer(job, fireAt, IDLE_RETRY_MS);
        return;
      }
      // Mark fired only if executeJob will run it (it re-checks the same).
      const fresh = this.storage.getJob(job.id);
      if (!fresh?.enabled) return;
      if (!CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId())) return;
      this.firedThisStretch.add(job.id);
      if (!job.model) this.inlineFireAt = Date.now();
      void this.executeJob(job);
    }, Math.max(0, delay));
    this.idleTimers.set(job.id, { timer, fireAt });
  }

  private clearIdleTimer(id: string): void {
    const idle = this.idleTimers.get(id);
    if (idle) {
      clearTimeout(idle.timer);
      this.idleTimers.delete(id);
    }
  }

  private clearIdleTimers(): void {
    for (const { timer } of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(job: CronJob, idleSince?: number): void {
    try {
      if ((job.type === "interval" || job.type === "idle") && job.intervalMs) {
        // validateSchedule rejects these, but a store written by an older
        // version or edited by hand can still hold one. Node fires an
        // over-limit timer after 1 ms, so disable the job instead.
        if (job.intervalMs > MAX_INTERVAL_MS) {
          const error = `Duration ${job.schedule} exceeds the ~24-day timer limit; use a cron expression instead`;
          console.warn(`Job ${job.id} (${job.name}): ${error}`);
          this.storage.updateJob(job.id, { enabled: false, lastStatus: "error" });
          this.emitChange({ type: "error", jobId: job.id, error });
          return;
        }
      }
      if (job.type === "idle" && job.intervalMs) {
        const since = idleSince ?? Date.now();
        this.idleJobs.set(job.id, { job, since });
        // Armed now only if the agent is idle; otherwise on the next settle.
        this.armIdleJob(job, since);
      } else if (job.type === "interval" && job.intervalMs) {
        // Interval-based scheduling
        const interval = setInterval(() => {
          this.executeJob(job);
        }, job.intervalMs);
        this.intervals.set(job.id, interval);
      } else if (job.type === "once") {
        // One-shot execution at a specific time
        // Uses Cron with a Date instead of setTimeout to avoid the 32-bit
        // integer overflow (~24.855 days max) that causes far-future jobs
        // to fire immediately.
        const targetDate = new Date(job.schedule);
        if (targetDate.getTime() > Date.now()) {
          const cron = new Cron(targetDate, () => {
            this.executeJob(job);
            // Auto-disable one-shot jobs after execution
            this.storage.updateJob(job.id, { enabled: false });
            this.emitChange({ type: "update", job: { ...job, enabled: false } });
          });
          this.jobs.set(job.id, cron);
        } else {
          // Job is in the past - disable it and log warning
          console.warn(`Job ${job.id} (${job.name}) scheduled for past time: ${job.schedule}`);
          this.storage.updateJob(job.id, { 
            enabled: false,
            lastStatus: "error" 
          });
          this.emitChange({ 
            type: "error", 
            jobId: job.id, 
            error: `Scheduled time ${job.schedule} is in the past` 
          });
        }
      } else {
        // Standard cron expression
        const cron = new Cron(job.schedule, () => {
          this.executeJob(job);
        });
        this.jobs.set(job.id, cron);
      }
    } catch (error) {
      console.error(`Failed to schedule job ${job.id}:`, error);
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Unschedule a job
   */
  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }

    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }

    this.clearIdleTimer(id);
    this.idleJobs.delete(id);
  }

  /**
   * Execute a job's prompt
   */
  private async executeJob(job: CronJob): Promise<void> {
    // Re-read before firing — closure-captured `job` is stale if storage was
    // edited mid-tick (removed, disabled, or `session` rebound by hand-edit).
    const fresh = this.storage.getJob(job.id);
    if (!fresh?.enabled) return;
    if (!CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId())) return;

    console.log(`Executing scheduled prompt: ${job.name} (${job.id})`);

    if (job.model) {
      this.executeJobInSubagent(job);
      return;
    }

    try {
      // Update status to running
      this.storage.updateJob(job.id, {
        lastStatus: "running",
      });
      this.emitChange({ type: "fire", job });

      // Visible-only marker. The renderer reads from `details`, so `content`
      // is intentionally empty — putting the prompt text in `content` would
      // inject it into the LLM context a second time alongside the
      // `sendUserMessage` delivery below, producing duplicate turns /
      // "PROMPT\n\nPROMPT" rendering when the agent was streaming at fire
      // time. No options means: idle → silent append + emit (marker shows
      // before the user message in the chat), streaming → `agent.steer` with
      // empty content (no LLM context change, no extra turn triggered).
      this.pi.sendMessage({
        customType: "scheduled_prompt",
        content: [],
        display: true,
        details: { jobId: job.id, jobName: job.name, prompt: job.prompt },
      });

      // Then send the actual prompt to the agent — this is the single LLM-visible delivery.
      this.pi.sendUserMessage(job.prompt, { deliverAs: "followUp" });

      // Update job execution stats.
      //
      // `job` here is captured by the croner closure in `scheduleJob` and is
      // therefore frozen at the value it had when the scheduler was created —
      // reading `job.runCount` yields a stale count, so incrementing it writes
      // the same value to storage on every fire and the counter never advances.
      // Re-read from storage to get the latest known count.
      const nextRun = this.getNextRun(job.id);
      const latest = this.storage.getJob(job.id);
      const currentRunCount = latest?.runCount ?? job.runCount;
      this.storage.updateJob(job.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "success",
        runCount: currentRunCount + 1,
        nextRun: nextRun?.toISOString(),
      });

      this.emitChange({ type: "fire", job });
    } catch (error) {
      console.error(`Failed to execute job ${job.id}:`, error);
      this.storage.updateJob(job.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "error",
      });
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Run a job's prompt in a fresh in-process AgentSession with the chosen model.
   * Fire-and-forget: the cron tick returns immediately so other jobs keep firing.
   */
  private executeJobInSubagent(job: CronJob): void {
    const model = job.model!;
    const notify = job.notify === true;
    this.storage.updateJob(job.id, { lastStatus: "running" });
    this.emitChange({ type: "fire", job });

    // Start marker needs non-empty content to prevent session poisoning.
    // Pi-ai's openai-completions provider filters out user messages with
    // empty content — if the marker lands right after an assistant message,
    // the conversation ends on assistant and Anthropic 400s.
    this.pi.sendMessage({
      customType: "scheduled_prompt",
      content: [{ type: "text", text: `🕐 Scheduled (subagent: ${model}): ${job.name}` }],
      display: true,
      details: {
        jobId: job.id,
        jobName: job.name,
        prompt: job.prompt,
        mode: "subagent_start",
        model,
      },
    });

    const controller = new AbortController();
    this.activeSubagents.add(controller);

    const run = (async () => {
      try {
        let result: SubagentResult;
        try {
          result = await runSubagentOnce(this.ctx, job.prompt, model, controller.signal, { extensions: job.extensions, skills: job.skills });
        } finally {
          this.activeSubagents.delete(controller);
        }

        // Scheduler was stopped (session shutdown / switch / fork) while we were
        // running. Don't touch storage or post markers — pi may be invalidated.
        if (controller.signal.aborted) return;

        const nextRun = this.getNextRun(job.id);

        // Always advance the storage state to a terminal status BEFORE attempting
        // to post the marker. The marker is best-effort (pi may be invalidated
        // during teardown) and must never leave the job stuck in "running".
        if (result.ok) {
          const outputSnippet = snippet(result.text.trim()) || "(subagent produced no text output)";
          // Re-read runCount from storage; `job` here is the closure-captured
          // snapshot from scheduleJob and would yield a stale count.
          const latest = this.storage.getJob(job.id);
          const currentRunCount = latest?.runCount ?? job.runCount;
          this.storage.updateJob(job.id, {
            lastRun: new Date().toISOString(),
            lastStatus: "success",
            runCount: currentRunCount + 1,
            nextRun: nextRun?.toISOString(),
          });
          this.emitChange({ type: "fire", job });
          try {
            // notify=true: snippet in `content` + followUp/triggerTurn wakes
            // the parent — it sees the result and reacts.
            // notify=false: content is still non-empty (guarded by #10 fallback)
            // to prevent session poisoning — pi-ai filters empty user messages,
            // leaving the conversation ending on assistant which Anthropic 400s.
            // No delivery options means the marker is silent (parent not woken).
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [{ type: "text", text: outputSnippet }],
                display: true,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_done",
                  model,
                  output: outputSnippet,
                },
              },
              notify ? { deliverAs: "followUp", triggerTurn: true } : undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_done marker for job ${job.id}:`, markerErr);
          }
        } else {
          // Truncate the error the same way as the success snippet — verbose
          // API errors / stack traces would otherwise overflow the chat row.
          const errorSnippet = snippet(result.error.trim()) || "(subagent failed with empty error)";
          this.storage.updateJob(job.id, {
            lastRun: new Date().toISOString(),
            lastStatus: "error",
            nextRun: nextRun?.toISOString(),
          });
          this.emitChange({ type: "error", jobId: job.id, error: errorSnippet });
          try {
            // Same notify-gated wake-up as the done marker — see comment above.
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [{ type: "text", text: errorSnippet }],
                display: true,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_error",
                  model,
                  error: errorSnippet,
                },
              },
              notify ? { deliverAs: "followUp", triggerTurn: true } : undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_error marker for job ${job.id}:`, markerErr);
          }
        }
      } catch (error) {
        // Outer backstop: anything else (e.g. storage write failure) shouldn't
        // escape the IIFE as an unhandled rejection.
        console.error(`Subagent completion handler failed for job ${job.id}:`, error);
      }
    })();
    this.inflightSubagents.add(run);
    void run.finally(() => this.inflightSubagents.delete(run));
  }

  /**
   * Emit a change event via pi.events
   */
  private emitChange(event: CronChangeEvent): void {
    this.pi.events.emit("cron:change", event);
  }

  /**
   * Validate a cron expression (must be 6-field format with seconds)
   */
  static validateCronExpression(expression: string): { valid: boolean; error?: string } {
    // Count fields - must be 6 (second minute hour dom month dow)
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron expression must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 * * * * *" for every minute`,
      };
    }

    try {
      // Try parsing as cron expression
      new Cron(expression, () => {});
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid cron expression",
      };
    }
  }

  /**
   * Parse relative time delta (e.g., "+10s", "+5m", "+1h")
   * Returns ISO timestamp if valid, null otherwise
   */
  static parseRelativeTime(delta: string): string | null {
    const match = delta.match(/^\+(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    const msMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const ms = value * msMap[unit];
    const futureTime = new Date(Date.now() + ms);
    return futureTime.toISOString();
  }

  /**
   * Parse interval string to milliseconds
   */
  static parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  }

  /**
   * Validate and resolve a schedule string for the given type.
   * Single source of truth shared by tool `add`/`update` and the UI command.
   *
   * - `cron`: validates the 6-field expression
   * - `once`: accepts ISO timestamps and relative time (`+10s`); rejects past
   *   timestamps and ones <5s away (the agent should use relative time instead)
   * - `interval`: accepts duration strings (`5m`, `1h`, `30s`) up to 24 days
   *   (`MAX_INTERVAL_MS`)
   * - `idle`: same duration format and limit; the time the agent must be idle
   */
  static validateSchedule(type: CronJobType, schedule: string): ValidateScheduleResult {
    if (type === "interval" || type === "idle") {
      const label = type === "idle" ? "Idle duration" : "Interval";
      const intervalMs = CronScheduler.parseInterval(schedule);
      if (!intervalMs) {
        return {
          ok: false,
          error: `Invalid ${label.toLowerCase()} format: ${schedule}. Use format like '5m', '1h', '30s'`,
        };
      }
      if (intervalMs > MAX_INTERVAL_MS) {
        const hint =
          type === "interval"
            ? " For longer or calendar-based repeats, use a cron expression (e.g. '0 0 9 1 * *' = 9am on the 1st of each month)."
            : "";
        return {
          ok: false,
          error: `${label} ${schedule} is too long: limited to 24 days (24d).${hint}`,
        };
      }
      return { ok: true, schedule, intervalMs };
    }

    if (type === "once") {
      const relative = CronScheduler.parseRelativeTime(schedule);
      if (relative) return { ok: true, schedule: relative };

      const date = new Date(schedule);
      if (Number.isNaN(date.getTime())) {
        return {
          ok: false,
          error: `Invalid timestamp: ${schedule}. Use ISO format or relative time like '+10s', '+5m'`,
        };
      }
      const delay = date.getTime() - Date.now();
      if (delay < 0) {
        return {
          ok: false,
          error: `Timestamp is in the past: ${formatLocal(date)}. Current time: ${formatLocal(new Date())}`,
        };
      }
      if (delay < 5000) {
        return {
          ok: false,
          error: `Timestamp is too soon (${Math.round(delay / 1000)}s). For delays under 5s, use relative time like '+${Math.ceil(delay / 1000)}s' instead, or schedule at least 5s in the future.`,
        };
      }
      return { ok: true, schedule: date.toISOString() };
    }

    // cron
    const validation = CronScheduler.validateCronExpression(schedule);
    if (!validation.valid) {
      return { ok: false, error: `Invalid cron expression: ${validation.error}` };
    }
    return { ok: true, schedule };
  }

  /**
   * Render a resolved schedule as a short human-readable phrase.
   * Used for confirm dialogs and the widget. `schedule` is the resolved form
   * returned by `validateSchedule` (ISO for `once`).
   */
  static describeSchedule(type: CronJobType, schedule: string): string {
    if (type === "interval") return `every ${schedule}`;
    if (type === "idle") return `after ${schedule} idle`;
    if (type === "once") {
      const date = new Date(schedule);
      return Number.isNaN(date.getTime()) ? schedule : formatISOShort(date);
    }
    return humanizeCron(schedule);
  }
}

const HUMANIZED_CRON: Record<string, string> = {
  "* * * * * *": "every second",
  "0 * * * * *": "every minute",
  "0 */5 * * * *": "every 5 min",
  "0 */10 * * * *": "every 10 min",
  "0 */15 * * * *": "every 15 min",
  "0 */30 * * * *": "every 30 min",
  "0 0 * * * *": "every hour",
  "0 0 */2 * * *": "every 2 hours",
  "0 0 */3 * * *": "every 3 hours",
  "0 0 */6 * * *": "every 6 hours",
  "0 0 0 * * *": "daily",
  "0 0 0 * * 0": "weekly",
  "0 0 0 1 * *": "monthly",
  "0 0 9 * * 1-5": "9am weekdays",
  "0 0 0 * * 1-5": "weekdays",
  "0 0 0 * * 0,6": "weekends",
};

/** Human-readable form of a 6-field cron expression for common patterns.
 *  Falls back to the raw expression for anything not recognized — never
 *  guesses a wrong description. Callers truncate for column-width displays. */
export function humanizeCron(expression: string): string {
  const normalized = expression.trim();
  if (HUMANIZED_CRON[normalized]) return HUMANIZED_CRON[normalized];

  const minMatch = normalized.match(/^0 \*\/(\d+) \* \* \* \*$/);
  if (minMatch) return `every ${minMatch[1]} min`;

  const hourMatch = normalized.match(/^0 0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) return `every ${hourMatch[1]}h`;

  const timeMatch = normalized.match(/^0 0 (\d+) \* \* \*$/);
  if (timeMatch) return `daily at ${parseInt(timeMatch[1], 10)}:00`;

  return normalized;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact ISO timestamp render: "Feb 13 15:30". Returns the input unchanged
 *  if it doesn't parse as a date. */
export function formatISOShort(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}

/** Local wall-clock time with its UTC offset: "2026-11-16 10:30:00 -03:00".
 *  Used wherever a time is shown to the user or the model, so it matches the
 *  time the user means ("at 5pm") while the offset keeps it unambiguous.
 *  Stored values stay UTC ISO. Returns the input unchanged if it doesn't
 *  parse as a date. */
export function formatLocal(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`
  );
}

/** A job's schedule as shown to the user or the model: one-shot ISO
 *  timestamps in local time, cron and interval strings unchanged. */
export function displaySchedule(job: Pick<CronJob, "type" | "schedule">): string {
  return job.type === "once" ? formatLocal(job.schedule) : job.schedule;
}
