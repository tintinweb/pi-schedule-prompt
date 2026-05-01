/**
 * pi-schedule-prompt — A pi extension for scheduling agent prompts
 *
 * Provides:
 * - A `schedule_prompt` tool for managing scheduled prompts
 * - A widget displaying all scheduled prompts with status
 * - /schedule-prompt command for interactive management
 * - Ctrl+Alt+P shortcut to toggle widget
 * - Persistence via .pi/schedule-prompts.json
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Container, Text } from "@mariozechner/pi-tui";
import { CronStorage } from "./storage.js";
import { CronScheduler } from "./scheduler.js";
import { createCronTool } from "./tool.js";
import { CronWidget } from "./ui/cron-widget.js";
import { loadSettings, saveSettings } from "./settings.js";
import { nanoid } from "nanoid";

export default async function (pi: ExtensionAPI) {
  let storage: CronStorage;
  let scheduler: CronScheduler;
  let widget: CronWidget;
  let widgetVisible = true;

  // Register custom message renderer for scheduled prompts
  pi.registerMessageRenderer("scheduled_prompt", (message, _options, theme) => {
    const details = message.details as { jobId: string; jobName: string; prompt: string } | undefined;
    const jobName = details?.jobName || "Unknown";
    const prompt = details?.prompt || "";
    
    return new Text(
      theme.fg("accent", `🕐 Scheduled: ${jobName}`) + 
      (prompt ? theme.fg("dim", ` → "${prompt}"`) : ""),
      0,
      0
    );
  });

  // Register the tool once with getter functions
  const tool = createCronTool(
    () => storage,
    () => scheduler
  );
  pi.registerTool(tool);

  // --- Session initialization ---

  const initializeSession = (ctx: any) => {
    // Create storage and scheduler
    storage = new CronStorage(ctx.cwd);
    scheduler = new CronScheduler(storage, pi);
    widget = new CronWidget(storage, scheduler, pi, () => widgetVisible);

    const s = loadSettings(ctx.cwd);
    if (typeof s.widgetVisible === "boolean") widgetVisible = s.widgetVisible;

    // Load and start all enabled jobs
    scheduler.start();

    // Show widget
    if (widgetVisible) {
      widget.show(ctx);
    }
  };

  const cleanupSession = (ctx: any) => {
    // Stop scheduler
    if (scheduler) {
      scheduler.stop();
    }

    // Hide widget
    if (widget) {
      widget.hide(ctx);
      widget.destroy();
    }
  };

  const autoCleanupDisabledJobs = () => {
    // Remove all disabled jobs on exit
    if (storage) {
      const jobs = storage.getAllJobs();
      const disabledJobs = jobs.filter((j) => !j.enabled);
      
      if (disabledJobs.length > 0) {
        console.log(`Auto-cleanup: removing ${disabledJobs.length} disabled job(s)`);
        for (const job of disabledJobs) {
          storage.removeJob(job.id);
        }
      }
    }
  };

  // --- Lifecycle events ---

  pi.on("session_start", async (_event, ctx) => {
    initializeSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    autoCleanupDisabledJobs();
    cleanupSession(ctx);
    initializeSession(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    autoCleanupDisabledJobs();
    cleanupSession(ctx);
    initializeSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    autoCleanupDisabledJobs();
    cleanupSession(ctx);
  });

  // --- Register /schedule-prompt command ---

  pi.registerCommand("schedule-prompt", {
    description: "Manage scheduled prompts interactively",
    handler: async (_args, ctx) => {
      const action = await ctx.ui.select("Scheduled Prompts", [
        "View All Jobs",
        "Add New Job",
        "Toggle Job (Enable/Disable)",
        "Remove Job",
        "Cleanup Disabled Jobs",
        "Settings",
      ]);

      if (!action) return;

      const actionMap: Record<string, string> = {
        "View All Jobs": "list",
        "Add New Job": "add",
        "Toggle Job (Enable/Disable)": "toggle",
        "Remove Job": "remove",
        "Cleanup Disabled Jobs": "cleanup",
        "Settings": "settings",
      };
      const actionKey = actionMap[action];

      switch (actionKey) {
        case "list": {
          const jobs = storage.getAllJobs();
          if (jobs.length === 0) {
            ctx.ui.notify("No scheduled prompts configured", "info");
            return;
          }

          const lines = ["Scheduled prompts:", ""];
          for (const job of jobs) {
            const status = job.enabled ? "✓" : "✗";
            const nextRun = scheduler.getNextRun(job.id);
            lines.push(`${status} ${job.name} (${job.id})`);
            lines.push(`  Schedule: ${job.schedule} | Type: ${job.type}`);
            lines.push(`  Prompt: ${job.prompt}`);
            if (nextRun) {
              lines.push(`  Next run: ${nextRun.toISOString()}`);
            }
            lines.push(`  Runs: ${job.runCount}`);
            lines.push("");
          }

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "add": {
          const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
          if (!name) return;

          const typeChoice = await ctx.ui.select("Job Type", [
            "Cron (recurring)",
            "Once (one-shot)",
            "Interval (periodic)",
          ]);
          if (!typeChoice) return;

          const typeMap: Record<string, string> = {
            "Cron (recurring)": "cron",
            "Once (one-shot)": "once",
            "Interval (periodic)": "interval",
          };
          const jobType = typeMap[typeChoice];

          let schedulePrompt: string;
          if (jobType === "cron") {
            schedulePrompt = "Enter cron expression (6-field: sec min hour dom month dow):";
          } else if (jobType === "once") {
            schedulePrompt = "Enter ISO timestamp (e.g., 2026-02-13T10:30:00Z)";
          } else {
            schedulePrompt = "Enter interval (e.g., 5m, 1h, 30s)";
          }

          const scheduleRaw = await ctx.ui.input("Schedule", schedulePrompt);
          if (!scheduleRaw) return;
          const schedule = scheduleRaw.trim();

          const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
          if (!prompt) return;

          // Validate and create job
          try {
            let intervalMs: number | undefined;
            let validatedSchedule = schedule;

            if (jobType === "interval") {
              const parsed = CronScheduler.parseInterval(schedule);
              intervalMs = parsed !== null ? parsed : undefined;
              if (!intervalMs) {
                ctx.ui.notify("Invalid interval format", "error");
                return;
              }
            } else if (jobType === "once") {
              const date = new Date(schedule);
              if (isNaN(date.getTime())) {
                ctx.ui.notify("Invalid timestamp format", "error");
                return;
              }
              validatedSchedule = date.toISOString();
            } else {
              const validation = CronScheduler.validateCronExpression(schedule);
              if (!validation.valid) {
                ctx.ui.notify(`Invalid cron expression: ${validation.error}`, "error");
                return;
              }
            }

            const job = {
              id: nanoid(10),
              name,
              schedule: validatedSchedule,
              prompt,
              enabled: true,
              type: jobType as any,
              intervalMs,
              createdAt: new Date().toISOString(),
              runCount: 0,
            };

            storage.addJob(job);
            scheduler.addJob(job);
            ctx.ui.notify(`Created scheduled prompt: ${name}`, "info");
          } catch (error: any) {
            ctx.ui.notify(`Error: ${error.message}`, "error");
          }
          break;
        }

        case "toggle": {
          const jobs = storage.getAllJobs();
          if (jobs.length === 0) {
            ctx.ui.notify("No scheduled prompts configured", "info");
            return;
          }

          const jobId = await ctx.ui.select(
            "Select Job to Toggle",
            jobs.map((j) => `${j.enabled ? "✓" : "✗"} ${j.name}`)
          );

          if (!jobId) return;

          // Find job by matching the label
          const selectedIndex = jobs.findIndex(
            (j) => `${j.enabled ? "✓" : "✗"} ${j.name}` === jobId
          );
          const job = selectedIndex >= 0 ? jobs[selectedIndex] : undefined;
          if (job) {
            const newEnabled = !job.enabled;
            storage.updateJob(job.id, { enabled: newEnabled });
            const updated = { ...job, enabled: newEnabled };
            scheduler.updateJob(job.id, updated);
            ctx.ui.notify(`${newEnabled ? "Enabled" : "Disabled"} job: ${job.name}`, "info");
          }
          break;
        }

        case "remove": {
          const jobs = storage.getAllJobs();
          if (jobs.length === 0) {
            ctx.ui.notify("No scheduled prompts configured", "info");
            return;
          }

          const jobId = await ctx.ui.select(
            "Select Job to Remove",
            jobs.map((j) => j.name)
          );

          if (!jobId) return;

          // Find job by name
          const job = jobs.find((j) => j.name === jobId);
          if (job) {
            const confirmed = await ctx.ui.confirm(
              "Confirm Removal",
              `Remove scheduled prompt "${job.name}"?`
            );

            if (confirmed) {
              storage.removeJob(job.id);
              scheduler.removeJob(job.id);
              ctx.ui.notify(`Removed job: ${job.name}`, "info");
            }
          }
          break;
        }

        case "cleanup": {
          const jobs = storage.getAllJobs();
          const disabledJobs = jobs.filter((j) => !j.enabled);

          if (disabledJobs.length === 0) {
            ctx.ui.notify("No disabled jobs to clean up", "info");
            return;
          }

          const confirmed = await ctx.ui.confirm(
            "Confirm Cleanup",
            `Remove ${disabledJobs.length} disabled job(s)?`
          );

          if (confirmed) {
            for (const job of disabledJobs) {
              storage.removeJob(job.id);
              scheduler.removeJob(job.id);
            }
            ctx.ui.notify(`Removed ${disabledJobs.length} disabled job(s)`, "info");
          }
          break;
        }

        case "settings": {
          // Loop so the menu redraws with current state after each change —
          // the menu is the truth display; only persist failures need a toast.
          while (true) {
            const choice = await ctx.ui.select("Settings", [
              `Widget visibility: ${widgetVisible ? "shown" : "hidden"}`,
              "Back",
            ]);
            if (!choice || choice === "Back") return;
            if (choice.startsWith("Widget visibility:")) {
              widgetVisible = !widgetVisible;
              widgetVisible ? widget.show(ctx) : widget.hide(ctx);
              const persisted = saveSettings(ctx.cwd, { widgetVisible });
              if (!persisted) {
                ctx.ui.notify(
                  `Widget ${widgetVisible ? "shown" : "hidden"} (session only; failed to persist)`,
                  "warning",
                );
              }
            }
          }
        }
      }
    },
  });
}
