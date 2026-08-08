/**
 * pi-schedule-prompt — scheduled prompts with session, workdir, and global scopes.
 * Global jobs are stored in the user agent directory and owned by one healthy,
 * eligible Pi process at a time. No daemon or catch-up behavior is provided.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { CronJobManager } from "./manager.js";
import { loadSettings, type ScheduleSettings, saveSettings } from "./settings.js";
import { createCronTool } from "./tool.js";
import { runAddFlow } from "./ui/add-flow.js";
import { CronWidget } from "./ui/cron-widget.js";
import { JobsView } from "./ui/jobs-view.js";

export default async function (pi: ExtensionAPI) {
  let manager: CronJobManager | undefined;
  let widget: CronWidget | undefined;
  let settings: ScheduleSettings = {};
  const isWidgetVisible = () => settings.widgetVisible !== false;

  pi.registerMessageRenderer("scheduled_prompt", (message, _options, theme) => {
    const details = message.details as { jobName?: string; prompt?: string; mode?: string; model?: string; output?: string; error?: string } | undefined;
    const jobName = details?.jobName || "Unknown";
    const prompt = details?.prompt || "";
    const tag = details?.model ? ` (subagent: ${details.model})` : "";
    let line: string;
    switch (details?.mode) {
      case "subagent_start": line = theme.fg("accent", `🕐 Scheduled${tag}: ${jobName}`) + (prompt ? theme.fg("dim", ` → "${prompt}"`) : ""); break;
      case "subagent_done": line = theme.fg("accent", `✓ Scheduled${tag} finished: ${jobName}`) + (details.output ? theme.fg("dim", ` → ${details.output}`) : ""); break;
      case "subagent_error": line = theme.fg("error", `✗ Scheduled${tag} failed: ${jobName}`) + (details.error ? theme.fg("dim", ` → ${details.error}`) : ""); break;
      default: line = theme.fg("accent", `🕐 Scheduled: ${jobName}`) + (prompt ? theme.fg("dim", ` → "${prompt}"`) : "");
    }
    return new Text(line, 0, 0);
  });

  pi.registerTool(createCronTool(() => {
    if (!manager) throw new Error("Schedule manager is not initialized");
    return manager;
  }, () => settings.defaultJobScope ?? "session"));

  const cleanupSession = async (ctx: any): Promise<void> => {
    if (manager) {
      await manager.stop();
      manager = undefined;
    }
    if (widget) {
      widget.hide(ctx);
      widget.destroy();
      widget = undefined;
    }
  };

  const initializeSession = async (ctx: any): Promise<void> => {
    await cleanupSession(ctx);
    settings = loadSettings(ctx.cwd);
    manager = new CronJobManager(ctx.cwd, pi, ctx);
    await manager.start();
    widget = new CronWidget(manager.projectStorage, manager.projectScheduler, pi, isWidgetVisible, ctx.sessionManager.getSessionId(), manager);
    if (isWidgetVisible()) widget.show(ctx);
  };

  const autoCleanupDisabledJobs = (ctx: any): void => {
    if (!manager) return;
    const jobs = manager.cleanup(undefined, ctx.sessionManager.getSessionId());
    if (jobs.length) console.log(`Auto-cleanup: removing ${jobs.length} disabled local job(s)`);
  };

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") autoCleanupDisabledJobs(ctx);
    await initializeSession(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    autoCleanupDisabledJobs(ctx);
    await cleanupSession(ctx);
  });

  pi.registerCommand("schedule-prompt", {
    description: "Manage scheduled prompts interactively",
    handler: async (_args, ctx) => {
      if (!manager) return;
      const sessionId = ctx.sessionManager.getSessionId();
      const action = await ctx.ui.select("Scheduled Prompts", ["Jobs", "Settings"]);
      if (!action) return;
      if (action === "Jobs") {
        let jobsOverlay: OverlayHandle | undefined;
        const wrappedRunAdd = async () => {
          jobsOverlay?.setHidden(true);
          try { await runAddFlow(ctx, manager!, settings, sessionId); }
          finally { jobsOverlay?.setHidden(false); jobsOverlay?.focus(); }
        };
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) => new JobsView(manager!, sessionId, wrappedRunAdd, theme, () => tui.requestRender(), () => done(undefined)),
          { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" }, onHandle: (handle) => { jobsOverlay = handle; } },
        );
        return;
      }
      while (true) {
        const widgetState = isWidgetVisible() ? "shown" : "hidden";
        const currentScope = settings.defaultJobScope ?? "session";
        const choice = await ctx.ui.select("Settings", [
          `Widget visibility: ${widgetState}`,
          `Default new-job scope: ${currentScope}`,
          "Back",
        ]);
        if (!choice || choice === "Back") return;
        if (choice.startsWith("Widget visibility:")) {
          const next = !isWidgetVisible();
          settings = { ...settings, widgetVisible: next };
          next ? widget?.show(ctx) : widget?.hide(ctx);
          if (!saveSettings(ctx.cwd, { widgetVisible: next })) ctx.ui.notify(`Widget ${next ? "shown" : "hidden"} (session only; failed to persist)`, "warning");
        } else if (choice.startsWith("Default new-job scope:")) {
          const next = await ctx.ui.select("Default new-job scope", ["session", "workdir", "global"]);
          if (!next) continue;
          settings = { ...settings, defaultJobScope: next as "session" | "workdir" | "global" };
          if (!saveSettings(ctx.cwd, { defaultJobScope: settings.defaultJobScope })) ctx.ui.notify("Default scope changed for session only; failed to persist", "warning");
        }
      }
    },
  });
}
