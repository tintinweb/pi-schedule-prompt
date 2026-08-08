import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { isInlineGlobalJobEligible } from "./scope.js";
import type { CronStorage } from "./storage.js";
import { runSubagentOnce, type SubagentResult } from "./subagent.js";
import type { CronChangeEvent, CronJob, CronJobType } from "./types.js";

type ValidateScheduleResult =
  | { ok: true; schedule: string; intervalMs?: number }
  | { ok: false; error: string };

const SUBAGENT_OUTPUT_SNIPPET_LENGTH = 500;
function snippet(text: string): string {
  return text.length > SUBAGENT_OUTPUT_SNIPPET_LENGTH
    ? text.slice(0, SUBAGENT_OUTPUT_SNIPPET_LENGTH) + "…"
    : text;
}

export interface CronSchedulerOptions {
  global?: boolean;
}

export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private nextRuns = new Map<string, Date>();
  private activeSubagents = new Map<string, Set<AbortController>>();
  private readonly global: boolean;

  constructor(
    private readonly storage: CronStorage,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    options: CronSchedulerOptions = {},
  ) {
    this.global = options.global === true;
  }

  start(): void {
    const mySessionId = this.ctx.sessionManager.getSessionId();
    for (const job of this.storage.getAllJobs()) {
      if (!this.global && job.scope === "global") continue;
      if (!this.global && !CronScheduler.isLoadedFor(job, mySessionId)) continue;
      if (job.lastStatus === "running") this.storage.updateJob(job.id, { lastStatus: undefined });
      if (job.enabled) this.scheduleJob(job);
    }
  }

  static isLoadedFor(job: CronJob, sessionId: string | undefined): boolean {
    return !job.session || job.session === sessionId;
  }

  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const timer of this.intervals.values()) clearTimeout(timer);
    this.intervals.clear();
    this.nextRuns.clear();
    for (const controllers of this.activeSubagents.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.activeSubagents.clear();
  }

  addJob(job: CronJob): void {
    if (job.enabled) this.scheduleJob(job);
    this.emitChange({ type: "add", job });
  }

  removeJob(id: string): void {
    this.unscheduleJob(id);
    this.abortJob(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  updateJob(id: string, updated: CronJob): void {
    this.unscheduleJob(id);
    this.abortJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emitChange({ type: "update", job: updated });
  }

  getNextRun(jobId: string): Date | null {
    return this.nextRuns.get(jobId) ?? this.jobs.get(jobId)?.nextRun() ?? null;
  }

  abortJob(jobId: string): void {
    const controllers = this.activeSubagents.get(jobId);
    if (!controllers) return;
    for (const controller of controllers) controller.abort();
    this.activeSubagents.delete(jobId);
  }

  private scheduleJob(job: CronJob): void {
    try {
      if (job.type === "interval" && job.intervalMs) {
        this.scheduleNextInterval(job);
      } else if (job.type === "once") {
        const targetDate = new Date(job.schedule);
        const delay = targetDate.getTime() - Date.now();
        if (delay > 0) {
          this.nextRuns.set(job.id, targetDate);
          this.persistNextRun(job.id, targetDate);
          const timeout = setTimeout(() => {
            this.executeJob(job);
            const fresh = this.storage.getJob(job.id);
            if (fresh?.enabled) {
              this.storage.updateJob(job.id, { enabled: false, nextRun: undefined });
              this.emitChange({ type: "update", job: { ...fresh, enabled: false, nextRun: undefined } });
            }
          }, delay);
          this.intervals.set(job.id, timeout);
        } else {
          this.storage.updateJob(job.id, { enabled: false, lastStatus: "error", nextRun: undefined });
          this.emitChange({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        const cron = new Cron(job.schedule, () => {
          this.updateCronNextRun(job.id, cron);
          void this.executeJob(job);
        });
        this.jobs.set(job.id, cron);
        this.updateCronNextRun(job.id, cron);
      }
    } catch (error) {
      this.emitChange({ type: "error", jobId: job.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private scheduleNextInterval(job: CronJob): void {
    const delay = job.intervalMs;
    if (delay === undefined) return;
    const next = new Date(Date.now() + delay);
    this.nextRuns.set(job.id, next);
    this.persistNextRun(job.id, next);
    const timer = setTimeout(() => {
      this.executeJob(job);
      const fresh = this.storage.getJob(job.id);
      if (fresh?.enabled) this.scheduleNextInterval(fresh);
    }, delay);
    this.intervals.set(job.id, timer);
  }

  private updateCronNextRun(id: string, cron: Cron): void {
    const next = cron.nextRun() ?? null;
    if (next) {
      this.nextRuns.set(id, next);
      this.persistNextRun(id, next);
    } else {
      this.nextRuns.delete(id);
    }
  }

  private persistNextRun(id: string, next: Date): void {
    const current = this.storage.getJob(id);
    if (current) this.storage.updateJob(id, { nextRun: next.toISOString() });
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const timer = this.intervals.get(id);
    if (timer) {
      clearTimeout(timer);
      this.intervals.delete(id);
    }
    this.nextRuns.delete(id);
  }

  private executeJob(job: CronJob): void {
    const fresh = this.storage.getJob(job.id);
    if (!fresh?.enabled) return;
    if (!this.global && (fresh.scope === "global" || !CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId()))) return;
    if (this.global && !fresh.model && !isInlineGlobalJobEligible(fresh, this.ctx.cwd)) return;

    if (fresh.model) {
      this.executeJobInSubagent(fresh);
      return;
    }

    try {
      this.storage.updateJob(fresh.id, { lastStatus: "running" });
      this.emitChange({ type: "fire", job: fresh });
      this.pi.sendMessage({
        customType: "scheduled_prompt",
        content: [],
        display: true,
        details: { jobId: fresh.id, jobName: fresh.name, prompt: fresh.prompt },
      });
      // Inline prompt already delivered cannot be recalled if ownership changes.
      this.pi.sendUserMessage(fresh.prompt, { deliverAs: "followUp" });
      const latest = this.storage.getJob(fresh.id);
      this.storage.updateJob(fresh.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "success",
        runCount: (latest?.runCount ?? fresh.runCount) + 1,
        nextRun: this.getNextRun(fresh.id)?.toISOString(),
      });
      this.emitChange({ type: "fire", job: fresh });
    } catch (error) {
      this.storage.updateJob(fresh.id, { lastRun: new Date().toISOString(), lastStatus: "error" });
      this.emitChange({ type: "error", jobId: fresh.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private executeJobInSubagent(job: CronJob): void {
    const model = job.model;
    if (!model) return;
    const notify = job.notify === true;
    this.storage.updateJob(job.id, { lastStatus: "running" });
    this.emitChange({ type: "fire", job });
    this.pi.sendMessage({
      customType: "scheduled_prompt",
      content: [{ type: "text", text: `🕐 Scheduled (subagent: ${model}): ${job.name}` }],
      display: true,
      details: { jobId: job.id, jobName: job.name, prompt: job.prompt, mode: "subagent_start", model },
    });

    const controller = new AbortController();
    const controllers = this.activeSubagents.get(job.id) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeSubagents.set(job.id, controllers);

    void (async () => {
      let result: SubagentResult;
      try {
        result = await runSubagentOnce(this.ctx, job.prompt, model, controller.signal, {
          cwd: this.global ? job.cwd : undefined,
          extensions: job.extensions,
          skills: job.skills,
        });
      } finally {
        controllers.delete(controller);
        if (controllers.size === 0) this.activeSubagents.delete(job.id);
      }
      if (controller.signal.aborted) return;
      const latest = this.storage.getJob(job.id);
      const nextRun = this.getNextRun(job.id)?.toISOString();
      if (result.ok) {
        const output = snippet(result.text.trim()) || "(subagent produced no text output)";
        this.storage.updateJob(job.id, {
          lastRun: new Date().toISOString(), lastStatus: "success",
          runCount: (latest?.runCount ?? job.runCount) + 1, nextRun,
        });
        this.emitChange({ type: "fire", job });
        this.postSubagentMarker(job, "subagent_done", output, model, notify);
      } else {
        const error = snippet(result.error.trim()) || "(subagent failed with empty error)";
        this.storage.updateJob(job.id, { lastRun: new Date().toISOString(), lastStatus: "error", nextRun });
        this.emitChange({ type: "error", jobId: job.id, error });
        this.postSubagentMarker(job, "subagent_error", error, model, notify);
      }
    })().catch((error) => {
      if (!controller.signal.aborted) this.handleSubagentCompletionError(job.id, error);
    });
  }

  private postSubagentMarker(
    job: CronJob,
    mode: "subagent_done" | "subagent_error",
    text: string,
    model: string,
    notify: boolean,
  ): void {
    try {
      this.pi.sendMessage({
        customType: "scheduled_prompt",
        content: [{ type: "text", text }],
        display: true,
        details: {
          jobId: job.id,
          jobName: job.name,
          prompt: job.prompt,
          mode,
          model,
          ...(mode === "subagent_done" ? { output: text } : { error: text }),
        },
      }, notify ? { deliverAs: "followUp", triggerTurn: true } : undefined);
    } catch {
      this.emitChange({ type: "error", jobId: job.id, error: "Failed to post scheduled prompt marker" });
    }
  }

  private handleSubagentCompletionError(jobId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.storage.updateJob(jobId, { lastRun: new Date().toISOString(), lastStatus: "error" });
    this.emitChange({ type: "error", jobId, error: message });
  }

  private emitChange(event: CronChangeEvent): void {
    this.pi.events.emit("cron:change", event);
  }

  static validateCronExpression(expression: string): { valid: boolean; error?: string } {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 6) return { valid: false, error: `Cron expression must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 * * * * *" for every minute` };
    try { new Cron(expression, () => {}); return { valid: true }; }
    catch (error) { return { valid: false, error: error instanceof Error ? error.message : "Invalid cron expression" }; }
  }

  static parseRelativeTime(delta: string): string | null {
    const match = delta.match(/^\+(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return new Date(Date.now() + value * multipliers[match[2]]).toISOString();
  }

  static parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return value * multipliers[match[2]];
  }

  static validateSchedule(type: CronJobType, schedule: string): ValidateScheduleResult {
    if (type === "interval") {
      const intervalMs = CronScheduler.parseInterval(schedule);
      return intervalMs ? { ok: true, schedule, intervalMs } : { ok: false, error: `Invalid interval format: ${schedule}. Use format like '5m', '1h', '30s'` };
    }
    if (type === "once") {
      const relative = CronScheduler.parseRelativeTime(schedule);
      if (relative) return { ok: true, schedule: relative };
      const date = new Date(schedule);
      if (Number.isNaN(date.getTime())) return { ok: false, error: `Invalid timestamp: ${schedule}. Use ISO format or relative time like '+10s', '+5m'` };
      const delay = date.getTime() - Date.now();
      if (delay < 0) return { ok: false, error: `Timestamp is in the past: ${date.toISOString()}. Current time: ${new Date().toISOString()}` };
      if (delay < 5000) return { ok: false, error: `Timestamp is too soon (${Math.round(delay / 1000)}s). For delays under 5s, use relative time like '+${Math.ceil(delay / 1000)}s' instead, or schedule at least 5s in the future.` };
      return { ok: true, schedule: date.toISOString() };
    }
    const validation = CronScheduler.validateCronExpression(schedule);
    return validation.valid ? { ok: true, schedule } : { ok: false, error: `Invalid cron expression: ${validation.error}` };
  }

  static describeSchedule(type: CronJobType, schedule: string): string {
    if (type === "interval") return `every ${schedule}`;
    if (type === "once") { const date = new Date(schedule); return Number.isNaN(date.getTime()) ? schedule : formatISOShort(date); }
    return humanizeCron(schedule);
  }
}

const HUMANIZED_CRON: Record<string, string> = {
  "* * * * * *": "every second", "0 * * * * *": "every minute", "0 */5 * * * *": "every 5 min",
  "0 */10 * * * *": "every 10 min", "0 */15 * * * *": "every 15 min", "0 */30 * * * *": "every 30 min",
  "0 0 * * * *": "every hour", "0 0 */2 * * *": "every 2 hours", "0 0 */3 * * *": "every 3 hours",
  "0 0 */6 * * *": "every 6 hours", "0 0 0 * * *": "daily", "0 0 0 * * 0": "weekly",
  "0 0 0 1 * *": "monthly", "0 0 9 * * 1-5": "9am weekdays", "0 0 0 * * 1-5": "weekdays", "0 0 0 * * 0,6": "weekends",
};
export function humanizeCron(expression: string): string {
  const normalized = expression.trim();
  if (HUMANIZED_CRON[normalized]) return HUMANIZED_CRON[normalized];
  const minMatch = normalized.match(/^0 \*\/(\d+) \* \* \* \*$/);
  if (minMatch) return `every ${minMatch[1]} min`;
  const hourMatch = normalized.match(/^0 0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) return `every ${hourMatch[1]}h`;
  const timeMatch = normalized.match(/^0 0 (\d+) \* \* \*$/);
  if (timeMatch) return `daily at ${Number.parseInt(timeMatch[1], 10)}:00`;
  return normalized;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatISOShort(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}
