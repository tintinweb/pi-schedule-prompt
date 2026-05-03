import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { nanoid } from "nanoid";
import { CronScheduler } from "./scheduler.js";
import type { JobScope } from "./settings.js";
import type { CronStorage } from "./storage.js";
import type { CronJob, CronJobType, CronToolDetails, } from "./types.js";
import { CronToolParams } from "./types.js";

/**
 * Create the schedule_prompt tool definition.
 * `getDefaultScope` is a getter so live setting toggles affect the next `add`.
 */
export function createCronTool(
  getStorage: () => CronStorage,
  getScheduler: () => CronScheduler,
  getDefaultScope: () => JobScope = () => "session",
): ToolDefinition<typeof CronToolParams, CronToolDetails> {
  return {
    name: "schedule_prompt",
    label: "Schedule Prompt",
    description:
      "IMPORTANT: For action='add', you MUST provide both 'schedule' parameter AND 'prompt' parameter. Schedule prompts at times/intervals. Schedule formats: 6-field cron (with seconds: '0 * * * * *' = every minute), ISO timestamp, relative time (+10s, +5m, +1h), or interval (5m, 1h). Type defaults to 'cron', use 'once' for relative/ISO times. Actions: add (needs schedule+prompt), list, remove/enable/disable/update (need jobId), cleanup.",
    parameters: CronToolParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const storage = getStorage();
      const scheduler = getScheduler();
      
      // Prevent recursive scheduling from within scheduled prompts
      if (params.action === "add") {
        const entries = ctx.sessionManager.getEntries();
        const recentEntries = entries.slice(-10); // Check last 10 entries
        const hasScheduledPrompt = recentEntries.some(
          (entry) => entry.type === "custom" && entry.customType === "scheduled_prompt"
        );
        
        if (hasScheduledPrompt) {
          throw new Error(
            "Cannot create scheduled prompts from within a scheduled prompt execution. This prevents infinite loops."
          );
        }
      }
      
      const action = params.action;
      const details: CronToolDetails = {
        action,
        jobs: [],
      };

      try {
        switch (action) {
          case "add": {
            if (!params.schedule || !params.prompt) {
              const missing = [];
              if (!params.schedule) missing.push("'schedule'");
              if (!params.prompt) missing.push("'prompt'");
              throw new Error(
                `Missing required parameters for add action: ${missing.join(" and ")}. You must provide both schedule (e.g., '+10s', '*/5 * * * * *') and prompt (the text to execute).`
              );
            }

            // Defense-in-depth — the schema also enforces this with minLength: 1,
            // but tool callers can bypass the schema by passing params directly.
            if (params.model !== undefined && params.model.length === 0) {
              throw new Error(
                "'model' must be a non-empty string. Omit the field for inline (no-model) jobs."
              );
            }

            // Generate name if not provided
            const jobName = params.name || `job-${nanoid(6)}`;

            // Check for duplicate names
            if (storage.hasJobWithName(jobName)) {
              throw new Error(
                `A job named "${jobName}" already exists. Please use a different name or remove the existing job first.`
              );
            }

            const type = (params.type || "cron") as CronJobType;
            const validated = CronScheduler.validateSchedule(type, params.schedule);
            if (!validated.ok) throw new Error(validated.error);
            const schedule = validated.schedule;
            const intervalMs = validated.intervalMs;

            const now = new Date().toISOString();
            const session =
              getDefaultScope() === "session" ? ctx.sessionManager.getSessionId() : undefined;
            const job: CronJob = {
              id: nanoid(10),
              name: jobName,
              schedule,
              prompt: params.prompt,
              enabled: true,
              type,
              intervalMs,
              createdAt: now,
              runCount: 0,
              description: params.description,
              model: params.model,
              notify: params.notify,
              session,
            };

            storage.addJob(job);
            scheduler.addJob(job);
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;

            const modelLine = job.model
              ? `\nModel: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""})`
              : "";
            return {
              content: [
                {
                  type: "text",
                  text: `✓ Created cron job "${job.name}" (${job.id})\nType: ${job.type}\nSchedule: ${job.schedule}\nPrompt: ${job.prompt}${modelLine}`,
                },
              ],
              details,
            };
          }

          case "remove": {
            if (!params.jobId) {
              throw new Error("jobId is required for remove action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const removed = storage.removeJob(params.jobId);
            if (removed) {
              scheduler.removeJob(params.jobId);
              details.jobId = params.jobId;
              details.jobName = job.name;

              return {
                content: [
                  {
                    type: "text",
                    text: `✓ Removed cron job "${job.name}" (${params.jobId})`,
                  },
                ],
                details,
              };
            }
            throw new Error(`Failed to remove job: ${params.jobId}`);
          }

          case "enable":
          case "disable": {
            if (!params.jobId) {
              throw new Error(`jobId is required for ${action} action`);
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            const enabled = action === "enable";
            storage.updateJob(params.jobId, { enabled });
            const updated = { ...job, enabled };
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = job.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ ${enabled ? "Enabled" : "Disabled"} cron job "${job.name}" (${params.jobId})`,
                },
              ],
              details,
            };
          }

          case "cleanup": {
            // Only touch jobs this session can see — foreign-session jobs are
            // owned by other pis. Unbound disabled jobs are fair game.
            const mySessionId = ctx.sessionManager.getSessionId();
            const disabledJobs = storage
              .getAllJobs()
              .filter((j) => !j.enabled && CronScheduler.isLoadedFor(j, mySessionId));

            if (disabledJobs.length === 0) {
              details.jobs = [];
              return {
                content: [
                  {
                    type: "text",
                    text: "No disabled jobs to clean up",
                  },
                ],
                details,
              };
            }

            for (const job of disabledJobs) {
              storage.removeJob(job.id);
              scheduler.removeJob(job.id);
            }

            details.jobs = disabledJobs;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Removed ${disabledJobs.length} disabled job(s):\n${disabledJobs.map((j) => `  - ${j.name} (${j.id})`).join("\n")}`,
                },
              ],
              details,
            };
          }

          case "update": {
            if (!params.jobId) {
              throw new Error("jobId is required for update action");
            }

            const job = storage.getJob(params.jobId);
            if (!job) {
              throw new Error(`Job not found: ${params.jobId}`);
            }

            // Reject empty-string model (schema also enforces minLength: 1).
            // To switch a job from subagent → inline mode, remove and re-add
            // it without `model` — there's no in-place clearing.
            if (params.model !== undefined && params.model.length === 0) {
              throw new Error(
                "'model' must be a non-empty string. To switch a job from subagent back to inline, remove and re-add it without a model."
              );
            }

            const updates: Partial<CronJob> = {};
            if (params.name) updates.name = params.name;
            if (params.prompt) updates.prompt = params.prompt;
            if (params.description !== undefined) updates.description = params.description;
            if (params.model !== undefined) updates.model = params.model;
            if (params.notify !== undefined) updates.notify = params.notify;

            if (params.schedule) {
              // Same resolution rules as `add`: relative time (`+5m`) → ISO,
              // ISO accepted as-is, cron validated by croner.
              const validated = CronScheduler.validateSchedule(job.type, params.schedule);
              if (!validated.ok) throw new Error(validated.error);
              updates.schedule = validated.schedule;
              if (validated.intervalMs !== undefined) updates.intervalMs = validated.intervalMs;
            }

            storage.updateJob(params.jobId, updates);
            const updated = { ...job, ...updates };
            scheduler.updateJob(params.jobId, updated);

            details.jobs = [updated];
            details.jobId = params.jobId;
            details.jobName = updated.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Updated cron job "${updated.name}" (${params.jobId})`,
                },
              ],
              details,
            };
          }

          case "list": {
            const mySessionId = ctx.sessionManager.getSessionId();
            const jobs = storage
              .getAllJobs()
              .filter((j) => CronScheduler.isLoadedFor(j, mySessionId));
            details.jobs = jobs;

            if (jobs.length === 0) {
              return {
                content: [{ type: "text", text: "No cron jobs configured." }],
                details,
              };
            }

            const lines = ["Configured cron jobs:", ""];
            for (const job of jobs) {
              const status = job.enabled ? "✓" : "✗";
              const nextRun = scheduler.getNextRun(job.id);
              const nextStr = nextRun ? `Next: ${nextRun.toISOString()}` : "";
              const lastStr = job.lastRun ? `Last: ${job.lastRun}` : "Never run";

              lines.push(`${status} ${job.name} (${job.id})`);
              lines.push(`  Type: ${job.type} | Schedule: ${job.schedule}`);
              if (job.model) {
                lines.push(`  Model: ${job.model} (runs in subagent${job.notify ? ", notifies parent" : ""})`);
              }
              lines.push(`  Prompt: ${job.prompt}`);
              lines.push(`  ${lastStr} ${nextStr ? `| ${nextStr}` : ""}`);
              lines.push(`  Runs: ${job.runCount} | Status: ${job.lastStatus || "pending"}`);
              if (job.description) {
                lines.push(`  Description: ${job.description}`);
              }
              lines.push("");
            }

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details,
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        details.error = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `✗ Error: ${details.error}`,
            },
          ],
          details,
        };
      }
    },

    renderCall(params, theme) {
      const action = params.action;
      const name = params.name || params.jobId || "";
      const actionText = theme.fg("accent", action);
      const nameText = theme.fg("text", name);

      let text: string;
      switch (action) {
        case "add":
          text = `Adding cron job: ${nameText}`;
          break;
        case "remove":
          text = `Removing cron job: ${nameText}`;
          break;
        case "enable":
        case "disable":
          text = `${actionText.charAt(0).toUpperCase() + actionText.slice(1)} job: ${nameText}`;
          break;
        case "update":
          text = `Updating cron job: ${nameText}`;
          break;
        case "list":
          text = `Listing all cron jobs`;
          break;
        default:
          text = `${actionText} cron job`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      if (!result.details) {
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        return new Text(text, 0, 0);
      }

      const details = result.details;
      const lines: string[] = [];

      // Show action result
      if (details.error) {
        lines.push(theme.fg("error", `✗ Error: ${details.error}`));
      } else {
        const action = details.action;
        const jobName = details.jobName || details.jobId || "";
        lines.push(theme.fg("success", `✓ ${action} ${jobName}`));
      }

      // Show job table for list action
      if (details.action === "list" && details.jobs.length > 0) {
        lines.push("");
        lines.push(theme.bold("Cron Jobs:"));
        for (const job of details.jobs) {
          const status = job.enabled ? theme.fg("success", "✓") : theme.fg("muted", "✗");
          lines.push(`${status} ${theme.fg("text", job.name)} ${theme.fg("dim", `(${job.id})`)}`);
          lines.push(
            `  ${theme.fg("dim", "Type:")} ${job.type} ${theme.fg("dim", "| Schedule:")} ${job.schedule}`
          );
          if (job.model) {
            const subagentTag = job.notify ? "(subagent, notifies parent)" : "(subagent)";
            lines.push(`  ${theme.fg("dim", "Model:")} ${job.model} ${theme.fg("dim", subagentTag)}`);
          }
          lines.push(`  ${theme.fg("dim", "Prompt:")} ${job.prompt}`);
          if (job.lastRun) {
            lines.push(`  ${theme.fg("dim", "Last run:")} ${job.lastRun}`);
          }
          lines.push(`  ${theme.fg("dim", "Runs:")} ${job.runCount}`);
        }
      }

      return new Text(lines.join("\n"), 0, 0);
    },
  };
}
