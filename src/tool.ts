import type { ToolDefinition, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { nanoid } from "nanoid";
import type { CronToolParamsType, CronToolDetails, CronJob, CronJobType } from "./types.js";
import { CronToolParams } from "./types.js";
import type { CronStorage } from "./storage.js";
import { CronScheduler } from "./scheduler.js";

/**
 * Create the schedule_prompt tool definition
 */
export function createCronTool(
  getStorage: () => CronStorage,
  getScheduler: () => CronScheduler
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

            // Generate name if not provided
            const jobName = params.name || `job-${nanoid(6)}`;

            // Check for duplicate names
            if (storage.hasJobWithName(jobName)) {
              throw new Error(
                `A job named "${jobName}" already exists. Please use a different name or remove the existing job first.`
              );
            }

            const type = (params.type || "cron") as CronJobType;
            let intervalMs: number | undefined;
            let schedule = params.schedule;

            // Parse and validate based on type
            if (type === "interval") {
              const parsed = CronScheduler.parseInterval(params.schedule);
              intervalMs = parsed !== null ? parsed : undefined;
              if (!intervalMs) {
                throw new Error(
                  `Invalid interval format: ${params.schedule}. Use format like '5m', '1h', '30s'`
                );
              }
            } else if (type === "once") {
              // Check for relative time first (e.g., "+10s", "+5m")
              const relativeTime = CronScheduler.parseRelativeTime(params.schedule);
              if (relativeTime) {
                schedule = relativeTime;
              } else {
                // Try parsing as ISO timestamp
                const date = new Date(params.schedule);
                if (isNaN(date.getTime())) {
                  throw new Error(
                    `Invalid timestamp: ${params.schedule}. Use ISO format or relative time like '+10s', '+5m'`
                  );
                }
                schedule = date.toISOString();
                
                // Warn if scheduled in the past or very near future
                const now = Date.now();
                const delay = date.getTime() - now;
                if (delay < 0) {
                  throw new Error(
                    `Timestamp is in the past: ${schedule}. Current time: ${new Date().toISOString()}`
                  );
                } else if (delay < 5000) {
                  // Less than 5 seconds warning
                  throw new Error(
                    `Timestamp is too soon (${Math.round(delay / 1000)}s). For delays under 5s, use relative time like '+${Math.ceil(delay / 1000)}s' instead, or schedule at least 5s in the future.`
                  );
                }
              }
            } else {
              // Validate cron expression
              const validation = CronScheduler.validateCronExpression(params.schedule);
              if (!validation.valid) {
                throw new Error(`Invalid cron expression: ${validation.error}`);
              }
            }

            const now = new Date().toISOString();
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
            };

            storage.addJob(job);
            scheduler.addJob(job);
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;

            return {
              content: [
                {
                  type: "text",
                  text: `✓ Created cron job "${job.name}" (${job.id})\nType: ${job.type}\nSchedule: ${job.schedule}\nPrompt: ${job.prompt}`,
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
            // Remove all disabled jobs
            const allJobs = storage.getAllJobs();
            const disabledJobs = allJobs.filter((j) => !j.enabled);
            
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

            const updates: Partial<CronJob> = {};
            if (params.name) updates.name = params.name;
            if (params.prompt) updates.prompt = params.prompt;
            if (params.description !== undefined) updates.description = params.description;

            if (params.schedule) {
              // Validate new schedule
              const type = job.type;
              if (type === "interval") {
                const parsed = CronScheduler.parseInterval(params.schedule);
                const intervalMs = parsed !== null ? parsed : undefined;
                if (!intervalMs) {
                  throw new Error(`Invalid interval format: ${params.schedule}`);
                }
                updates.schedule = params.schedule;
                updates.intervalMs = intervalMs;
              } else if (type === "once") {
                const date = new Date(params.schedule);
                if (isNaN(date.getTime())) {
                  throw new Error(`Invalid timestamp: ${params.schedule}`);
                }
                updates.schedule = date.toISOString();
              } else {
                const validation = CronScheduler.validateCronExpression(params.schedule);
                if (!validation.valid) {
                  throw new Error(`Invalid cron expression: ${validation.error}`);
                }
                updates.schedule = params.schedule;
              }
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
            const jobs = storage.getAllJobs();
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
