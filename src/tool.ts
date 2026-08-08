import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import type { CronJobManager } from "./manager.js";
import { CronScheduler } from "./scheduler.js";
import { assertGlobalCwd, inferJobScope } from "./scope.js";
import type { JobScope } from "./settings.js";
import type { CronStorage } from "./storage.js";
import type { CronJob, CronJobType, CronToolDetails } from "./types.js";
import { CronToolParams } from "./types.js";

type ManagerGetter = () => CronJobManager | LegacyManager;
interface LegacyManager {
  addJob(job: CronJob): void;
  removeJob(id: string): boolean;
  updateJob(id: string, changes: Partial<CronJob>): boolean;
  getJob(id: string): CronJob | undefined;
  list(scope: JobScope | undefined, sessionId: string | undefined): CronJob[];
  cleanup(scope: JobScope | undefined, sessionId: string | undefined): CronJob[];
  getNextRun(id: string): Date | null;
  moveJob?: (id: string, targetScope: JobScope, sessionId: string | undefined, currentCwd: string) => Promise<CronJob>;
}

function legacyManager(storage: CronStorage, scheduler: CronScheduler): LegacyManager {
  return {
    addJob(job) { storage.addJob(job); scheduler.addJob(job); },
    removeJob(id) { const removed = storage.removeJob(id); if (removed) scheduler.removeJob(id); return removed; },
    updateJob(id, changes) { const updated = storage.updateJob(id, changes); if (updated) { const job = storage.getJob(id); if (job) scheduler.updateJob(id, job); } return updated; },
    getJob: (id) => storage.getJob(id),
    list(scope, sessionId) { return storage.getAllJobs().filter((job) => (!scope || inferJobScope(job) === scope) && CronScheduler.isLoadedFor(job, sessionId)); },
    cleanup(scope, sessionId) { const jobs = storage.getAllJobs().filter((job) => !job.enabled && (!scope || inferJobScope(job) === scope) && CronScheduler.isLoadedFor(job, sessionId)); for (const job of jobs) this.removeJob(job.id); return jobs; },
    getNextRun: (id) => scheduler.getNextRun(id),
  };
}

export function createCronTool(
  getManagerOrStorage: () => CronJobManager | CronStorage,
  getSchedulerOrDefault: (() => CronScheduler) | (() => JobScope) = () => "session",
  legacyDefaultScope?: () => JobScope,
): ToolDefinition<typeof CronToolParams, CronToolDetails> {
  const getManager: ManagerGetter = legacyDefaultScope
    ? () => legacyManager(getManagerOrStorage() as CronStorage, (getSchedulerOrDefault as () => CronScheduler)())
    : getManagerOrStorage as () => CronJobManager;
  const getDefaultScope = legacyDefaultScope ?? (getSchedulerOrDefault as () => JobScope);

  return {
    name: "schedule_prompt",
    label: "Schedule Prompt",
    description: "Schedule prompts with cron, once, or interval timing. Scope may be session, workdir, or global. Global jobs are stored under the user Pi agent directory, require an open eligible Pi process, and have no catch-up; at most one healthy Pi process owns each job. Inline global jobs run only in their creator cwd; subagent global jobs run in their stored cwd.",
    parameters: CronToolParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = getManager();
      const sessionId = ctx.sessionManager.getSessionId();
      const details: CronToolDetails = { action: params.action, jobs: [] };
      const requestedScope = params.scope as JobScope | undefined;
      try {
        if (params.action === "add") {
          const entries = ctx.sessionManager.getEntries();
          if (entries.slice(-10).some((entry: any) => entry.type === "custom" && entry.customType === "scheduled_prompt")) {
            throw new Error("Cannot create scheduled prompts from within a scheduled prompt execution. This prevents infinite loops.");
          }
          if (!params.schedule || !params.prompt) {
            const missing = [!params.schedule && "'schedule'", !params.prompt && "'prompt'"].filter(Boolean);
            throw new Error(`Missing required parameters for add action: ${missing.join(" and ")}.`);
          }
          if (params.model !== undefined && params.model.length === 0) throw new Error("'model' must be a non-empty string. Omit the field for inline (no-model) jobs.");
          const type = (params.type || "cron") as CronJobType;
          const validated = CronScheduler.validateSchedule(type, params.schedule);
          if (!validated.ok) throw new Error(validated.error);
          const name = params.name || `job-${nanoid(6)}`;
          const scope = requestedScope ?? getDefaultScope();
          const now = new Date().toISOString();
          const job: CronJob = {
            id: nanoid(10), name, schedule: validated.schedule, prompt: params.prompt, enabled: true, type,
            intervalMs: validated.intervalMs, createdAt: now, runCount: 0, description: params.description,
            model: params.model, notify: params.notify, extensions: params.extensions, skills: params.skills,
            scope, session: scope === "session" ? sessionId : undefined,
            cwd: scope === "global" ? assertGlobalCwd(ctx.cwd ?? process.cwd()) : undefined,
          };
          manager.addJob(job);
          details.jobs = [job]; details.jobId = job.id; details.jobName = job.name;
          const scopeLine = `\nScope: ${scope}${scope === "global" ? ` (${job.cwd})` : ""}`;
          return { content: [{ type: "text", text: `✓ Created cron job "${job.name}" (${job.id})\nType: ${job.type}\nSchedule: ${job.schedule}${scopeLine}\nPrompt: ${job.prompt}${job.model ? `\nModel: ${job.model} (subagent${job.notify ? ", notifies parent" : ""})` : ""}` }], details };
        }

        if (!params.jobId && ["remove", "enable", "disable", "update"].includes(params.action)) throw new Error(`jobId is required for ${params.action} action`);
        if (params.action === "remove") {
          const job = manager.getJob(params.jobId!);
          if (!job || !manager.removeJob(params.jobId!)) throw new Error(`Job not found: ${params.jobId}`);
          details.jobId = job.id; details.jobName = job.name;
          return { content: [{ type: "text", text: `✓ Removed cron job "${job.name}" (${job.id})` }], details };
        }
        if (params.action === "enable" || params.action === "disable") {
          const job = manager.getJob(params.jobId!);
          if (!job) throw new Error(`Job not found: ${params.jobId}`);
          const enabled = params.action === "enable";
          if (!manager.updateJob(job.id, { enabled })) throw new Error(`Failed to update job: ${job.id}`);
          const updated = { ...job, enabled }; details.jobs = [updated]; details.jobId = job.id; details.jobName = job.name;
          return { content: [{ type: "text", text: `✓ ${enabled ? "Enabled" : "Disabled"} cron job "${job.name}" (${job.id})` }], details };
        }
        if (params.action === "cleanup") {
          const jobs = manager.cleanup(requestedScope, sessionId);
          details.jobs = jobs;
          return { content: [{ type: "text", text: jobs.length ? `✓ Removed ${jobs.length} disabled job(s):\n${jobs.map((job) => `  - ${job.name} (${job.id})`).join("\n")}` : "No disabled jobs to clean up" }], details };
        }
        if (params.action === "update") {
          const job = manager.getJob(params.jobId!);
          if (!job) throw new Error(`Job not found: ${params.jobId}`);
          if (params.model !== undefined && params.model.length === 0) throw new Error("'model' must be a non-empty string. To switch a job from subagent back to inline, remove and re-add it without a model.");
          const currentScope = inferJobScope(job, job.scope === "global" ? "global" : "project");
          const targetScope = requestedScope ?? currentScope;
          const updates: Partial<CronJob> = {};
          if (params.name) updates.name = params.name;
          if (params.prompt) updates.prompt = params.prompt;
          if (params.description !== undefined) updates.description = params.description;
          if (params.model !== undefined) updates.model = params.model;
          if (params.notify !== undefined) updates.notify = params.notify;
          if (params.extensions !== undefined) updates.extensions = params.extensions;
          if (params.skills !== undefined) updates.skills = params.skills;
          if (params.schedule) {
            const validated = CronScheduler.validateSchedule(job.type, params.schedule);
            if (!validated.ok) throw new Error(validated.error);
            updates.schedule = validated.schedule;
            if (validated.intervalMs !== undefined) updates.intervalMs = validated.intervalMs;
          }
          let updated: CronJob;
          if (targetScope !== currentScope) {
            if (!manager.moveJob) throw new Error("Scope migration is unavailable for this tool instance");
            updated = await manager.moveJob(job.id, targetScope, sessionId, ctx.cwd ?? process.cwd());
            if (Object.keys(updates).length) {
              manager.updateJob(updated.id, updates);
              updated = { ...updated, ...updates };
            }
          } else {
            if (!manager.updateJob(job.id, updates)) throw new Error(`Failed to update job: ${job.id}`);
            updated = { ...job, ...updates };
          }
          details.jobs = [updated]; details.jobId = updated.id; details.jobName = updated.name;
          return { content: [{ type: "text", text: `✓ Updated cron job "${updated.name}" (${updated.id})` }], details };
        }
        if (params.action === "list") {
          const jobs = manager.list(requestedScope, sessionId);
          details.jobs = jobs;
          if (!jobs.length) return { content: [{ type: "text", text: "No cron jobs configured." }], details };
          const lines = ["Configured cron jobs:", ""];
          for (const job of jobs) {
            const next = manager.getNextRun(job.id);
            lines.push(`${job.enabled ? "✓" : "✗"} ${job.name} (${job.id})`);
            lines.push(`  Scope: ${inferJobScope(job, job.scope === "global" ? "global" : "project")}${job.cwd ? ` | Cwd: ${job.cwd}` : ""}`);
            lines.push(`  Type: ${job.type} | Schedule: ${job.schedule}`);
            if (job.model) lines.push(`  Model: ${job.model} (subagent${job.notify ? ", notifies parent" : ""})`);
            lines.push(`  Prompt: ${job.prompt}`);
            lines.push(`  ${job.lastRun ? `Last: ${job.lastRun}` : "Never run"}${next ? ` | Next: ${next.toISOString()}` : ""}`);
            lines.push(`  Runs: ${job.runCount} | Status: ${job.lastStatus || "pending"}`);
            if (job.description) lines.push(`  Description: ${job.description}`);
            lines.push("");
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details };
        }
        throw new Error(`Unknown action: ${params.action}`);
      } catch (error) {
        details.error = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `✗ Error: ${details.error}` }], details };
      }
    },
    renderCall(params, theme) {
      const name = params.name || params.jobId || "";
      return new Text(theme.fg("accent", params.action) + (name ? ` ${theme.fg("text", name)}` : ""), 0, 0);
    },
    renderResult(result, _options, theme) {
      if (!result.details) return new Text(result.content.map((c) => c.type === "text" ? c.text : "").join("\n"), 0, 0);
      const details = result.details;
      const lines = [details.error ? theme.fg("error", `✗ Error: ${details.error}`) : theme.fg("success", `✓ ${details.action} ${details.jobName || details.jobId || ""}`)];
      if (details.action === "list") for (const job of details.jobs) {
        lines.push(`${job.enabled ? theme.fg("success", "✓") : theme.fg("muted", "✗")} ${theme.fg("text", job.name)} ${theme.fg("dim", `(${job.id})`)}`);
        lines.push(`  ${theme.fg("dim", "Scope:")} ${inferJobScope(job, job.scope === "global" ? "global" : "project")}${job.cwd ? ` (${job.cwd})` : ""}`);
        lines.push(`  ${theme.fg("dim", "Type:")} ${job.type} ${theme.fg("dim", "| Schedule:")} ${job.schedule}`);
        if (job.model) lines.push(`  ${theme.fg("dim", "Model:")} ${job.model}${job.notify ? " (notifies parent)" : ""}`);
        lines.push(`  ${theme.fg("dim", "Prompt:")} ${job.prompt}`);
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  };
}
