/**
 * pi-schedule-prompt — A pi extension for scheduling agent prompts
 *
 * Provides:
 * - A `schedule_prompt` tool for managing scheduled prompts
 * - A widget displaying all scheduled prompts with status
 * - /schedule-prompt command for interactive management
 * - Persistence: jobs in <agentDir>/schedule-prompts/projects/<sha256(cwd)>.json; settings in
 *   <agentDir>/schedule-prompts-settings.json (global) and .pi/schedule-prompts-settings.json (project, trusted only)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { CronScheduler } from "./scheduler.js";
import { loadSettings, type ScheduleSettings, saveSettings } from "./settings.js";
import { CronStorage } from "./storage.js";
import { createCronTool } from "./tool.js";
import { runAddFlow } from "./ui/add-flow.js";
import { CronWidget } from "./ui/cron-widget.js";
import { JobsView } from "./ui/jobs-view.js";

/** Longest pi quit waits for in-flight subagent teardown. */
const SHUTDOWN_TEARDOWN_TIMEOUT_MS = 10_000;

/** Resolve when all `pending` settle or after `ms`, whichever is first. */
export async function waitForTeardowns(pending: Set<Promise<void>>, ms: number): Promise<void> {
  if (pending.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  const outcome = await Promise.race([
    Promise.allSettled([...pending]).then(() => "done" as const),
    timeout,
  ]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    console.warn(
      `[pi-schedule-prompt] Subagent teardown did not finish within ${ms}ms of shutdown; exiting anyway.`,
    );
  }
}

export default async function (pi: ExtensionAPI) {
  let storage: CronStorage;
  let scheduler: CronScheduler;
  let widget: CronWidget;
  // Subagent teardowns still running, from every scheduler this extension has
  // created. pi (>=1.5) always emits session_shutdown before replacing a
  // session, but initializeSession also tears down defensively when a
  // session_start arrives without one; tracking here keeps that path from
  // dropping in-flight teardowns. Awaited, bounded, on session_shutdown.
  const pendingTeardowns = new Set<Promise<void>>();
  // Refreshed in initializeSession; mutated by Settings submenu. The tool and
  // widget read via closure so toggles take effect without re-registering.
  let settings: ScheduleSettings = {};
  const isWidgetVisible = () => settings.widgetVisible !== false;
  // ctx.isProjectTrusted() at session start. Project-local files (settings
  // override, legacy job store) are honored only for trusted projects.
  let projectTrusted = false;
  const notPersistedReason = () => (projectTrusted ? "failed to persist" : "project not trusted");

  // Register custom message renderer for scheduled prompts
  pi.registerMessageRenderer("scheduled_prompt", (message, _options, theme) => {
    const details = message.details as
      | {
          jobId: string;
          jobName: string;
          prompt: string;
          mode?: "subagent_start" | "subagent_done" | "subagent_error";
          model?: string;
          output?: string;
          error?: string;
        }
      | undefined;
    const jobName = details?.jobName || "Unknown";
    const prompt = details?.prompt || "";
    const model = details?.model;
    const tag = model ? ` (subagent: ${model})` : "";

    let line: string;
    switch (details?.mode) {
      case "subagent_start":
        line =
          theme.fg("accent", `🕐 Scheduled${tag}: ${jobName}`) +
          (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
        break;
      case "subagent_done":
        line =
          theme.fg("accent", `✓ Scheduled${tag} finished: ${jobName}`) +
          (details?.output ? theme.fg("dim", ` → ${details.output}`) : "");
        break;
      case "subagent_error":
        line =
          theme.fg("error", `✗ Scheduled${tag} failed: ${jobName}`) +
          (details?.error ? theme.fg("dim", ` → ${details.error}`) : "");
        break;
      default:
        line =
          theme.fg("accent", `🕐 Scheduled: ${jobName}`) +
          (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
    }

    return new Text(line, 0, 0);
  });

  // Register the tool once with getter functions
  const tool = createCronTool(
    () => storage,
    () => scheduler,
    () => settings.defaultJobScope ?? "session",
  );
  pi.registerTool(tool);

  // --- Session initialization ---

  const initializeSession = (ctx: any) => {
    // Idempotent: tear down any prior instance before creating a new one.
    // Without this, every `session_start` (fires on reload/resume/fork too, not
    // only on fresh startup) leaks a live croner timer into the event loop,
    // accumulating duplicate fires for every recurring job over time.
    // The old runs' teardown finishes in the background (tracked in pendingTeardowns).
    cleanupSession(ctx);

    projectTrusted = ctx.isProjectTrusted?.() === true;
    settings = loadSettings(ctx.cwd, projectTrusted);
    storage = new CronStorage(ctx.cwd);
    const migration = storage.migrateLegacy(projectTrusted);
    if (migration === "untrusted") {
      ctx.ui?.notify?.(
        "Scheduled prompts in this project's .pi/schedule-prompts.json were not imported: the project is not trusted.",
        "warning",
      );
    } else if (migration === "failed") {
      ctx.ui?.notify?.(
        "Could not import this project's .pi/schedule-prompts.json; see the log.",
        "warning",
      );
    }
    scheduler = new CronScheduler(storage, pi, ctx);
    widget = new CronWidget(storage, scheduler, pi, isWidgetVisible, ctx.sessionManager.getSessionId());

    scheduler.start();

    // Show widget
    if (isWidgetVisible()) {
      widget.show(ctx);
    }
  };

  const cleanupSession = (ctx: any): void => {
    // Stop scheduler (timers clear synchronously; subagent teardown settles later)
    if (scheduler) {
      const stopped = scheduler.stop();
      pendingTeardowns.add(stopped);
      void stopped.finally(() => pendingTeardowns.delete(stopped));
    }

    // Hide widget
    if (widget) {
      widget.hide(ctx);
      widget.destroy();
    }
  };

  const autoCleanupDisabledJobs = (ctx: any) => {
    // Only sweep our own (or unbound) disabled jobs — never another session's.
    if (!storage) return;
    const mySessionId = ctx.sessionManager.getSessionId();
    const disabledJobs = storage
      .getAllJobs()
      .filter((j) => !j.enabled && CronScheduler.isLoadedFor(j, mySessionId));

    if (disabledJobs.length > 0) {
      console.log(`Auto-cleanup: removing ${disabledJobs.length} disabled job(s)`);
      for (const job of disabledJobs) {
        storage.removeJob(job.id);
      }
    }
  };

  // --- Lifecycle events ---

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") {
      autoCleanupDisabledJobs(ctx);
    }
    initializeSession(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    autoCleanupDisabledJobs(ctx);
    cleanupSession(ctx);
    // pi exits right after session_shutdown handlers resolve, which would cut
    // off subagent extensions' cleanup (orphaning e.g. MCP child processes).
    // Wait for it, but bounded: a run stuck in setup (e.g. a hung extension
    // session_start) never settles, and quit must not hang on it.
    await waitForTeardowns(pendingTeardowns, SHUTDOWN_TEARDOWN_TIMEOUT_MS);
  });

  // --- Idle tracking for `idle` jobs ---
  // `agent_settled`, not `agent_end`: pi can start more runs after agent_end
  // (retries, compaction retry, queued follow-ups); settled is the final-idle signal.
  pi.on("agent_start", async () => {
    scheduler?.onBusy();
  });

  pi.on("agent_settled", async (event) => {
    scheduler?.onSettled(event.aborted);
  });

  pi.on("input", async (event) => {
    // Our own scheduled prompts arrive as source "extension" and must not
    // start a new idle stretch, or an idle job would re-arm itself.
    if (event.source !== "extension") scheduler?.onUserInput();
  });

  pi.on("user_bash", async () => {
    scheduler?.onUserActivity();
  });

  // Blocking dialogs, including this extension's own /schedule-prompt menus.
  pi.on("ui_prompt_start", async (event) => {
    scheduler?.onPromptStart(event.kind);
  });

  pi.on("ui_prompt_end", async () => {
    scheduler?.onPromptEnd();
  });

  // --- Register /schedule-prompt command ---

  pi.registerCommand("schedule-prompt", {
    description: "Manage scheduled prompts interactively",
    handler: async (_args, ctx) => {
      const mySessionId = ctx.sessionManager.getSessionId();

      const action = await ctx.ui.select("Scheduled Prompts", ["Jobs", "Settings"]);
      if (!action) return;

      switch (action) {
        case "Jobs": {
          // Hide the Jobs overlay while the add flow's dialogs are open —
          // otherwise it sits on top of them and steals input.
          let jobsOverlay: OverlayHandle | undefined;
          // pi reports these dialogs as part of the overlay, which doesn't
          // pause idle jobs, so pause them here like any question dialog.
          const wrappedRunAdd = async () => {
            jobsOverlay?.setHidden(true);
            scheduler.pauseForDialog();
            try {
              await runAddFlow(ctx, storage, scheduler, settings, mySessionId);
            } finally {
              scheduler.resumeAfterDialog();
              jobsOverlay?.setHidden(false);
              jobsOverlay?.focus();
            }
          };
          await ctx.ui.custom<void>(
            (tui, theme, _kb, done) =>
              new JobsView(
                storage,
                scheduler,
                mySessionId,
                wrappedRunAdd,
                theme,
                () => tui.requestRender(),
                () => done(undefined),
              ),
            {
              overlay: true,
              overlayOptions: { width: "100%", maxHeight: "100%" },
              onHandle: (h) => {
                jobsOverlay = h;
              },
            },
          );
          break;
        }

        case "Settings": {
          // Loop so the menu redraws with current state after each change —
          // the menu is the truth display; only persist failures need a toast.
          while (true) {
            const widgetState = isWidgetVisible() ? "shown" : "hidden";
            const bound = (settings.defaultJobScope ?? "session") === "session";
            const choice = await ctx.ui.select("Settings", [
              `Widget visibility: ${widgetState}`,
              `Bind new jobs to session: ${bound ? "yes" : "no"}`,
              "Back",
            ]);
            if (!choice || choice === "Back") return;
            if (choice.startsWith("Widget visibility:")) {
              const next = !isWidgetVisible();
              settings = { ...settings, widgetVisible: next };
              next ? widget.show(ctx) : widget.hide(ctx);
              const persisted = saveSettings(ctx.cwd, { widgetVisible: next }, projectTrusted);
              if (!persisted) {
                ctx.ui.notify(
                  `Widget ${next ? "shown" : "hidden"} (session only; ${notPersistedReason()})`,
                  "warning",
                );
              }
            } else if (choice.startsWith("Bind new jobs to session:")) {
              // Affects newly-created jobs only; existing jobs keep their binding.
              const next = bound ? "workdir" : "session";
              settings = { ...settings, defaultJobScope: next };
              const persisted = saveSettings(ctx.cwd, { defaultJobScope: next }, projectTrusted);
              if (!persisted) {
                ctx.ui.notify(
                  `Bind new jobs to session: ${next === "session" ? "yes" : "no"} (session only; ${notPersistedReason()})`,
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
