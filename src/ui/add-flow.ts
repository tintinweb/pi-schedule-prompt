/**
 * Interactive add flow for `/schedule-prompt`.
 * Steps the user through name → type → schedule (with re-prompt on validation
 * failure) → prompt → run mode (inline, or separate session with model and an
 * MCP toggle) → scope → confirm. Saves and schedules the new job, or
 * returns silently on cancellation.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { CronScheduler } from "../scheduler.js";
import type { ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import { describeAvailableModels, resolveModel } from "../subagent.js";
import type { CronJob, CronJobType } from "../types.js";

export async function runAddFlow(
  ctx: ExtensionCommandContext,
  storage: CronStorage,
  scheduler: CronScheduler,
  settings: ScheduleSettings,
  mySessionId: string | undefined,
): Promise<void> {
  const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
  if (!name) return;

  if (storage.hasJobWithName(name)) {
    ctx.ui.notify(`A job named "${name}" already exists`, "error");
    return;
  }

  const typeChoice = await ctx.ui.select("Job Type", [
    "Cron (recurring)",
    "Once (one-shot)",
    "Interval (periodic)",
    "Idle (after inactivity)",
  ]);
  if (!typeChoice) return;

  const typeMap: Record<string, CronJobType> = {
    "Cron (recurring)": "cron",
    "Once (one-shot)": "once",
    "Interval (periodic)": "interval",
    "Idle (after inactivity)": "idle",
  };
  const jobType = typeMap[typeChoice];

  const placeholders: Record<string, string> = {
    cron: "6-field cron, e.g. '0 0 9 * * *' for 9am daily",
    once: "ISO timestamp or relative time (+10s, +5m, +1h)",
    interval: "Duration, e.g. '5m', '1h', '30s'",
    idle: "Idle time before it fires once, e.g. '10m', '1h'",
  };

  // Re-prompt the schedule field on validation failure so the user
  // doesn't lose name/type and have to start over from the menu.
  let schedule: string | undefined;
  let intervalMs: number | undefined;
  let placeholder = placeholders[jobType];
  while (true) {
    const raw = await ctx.ui.input("Schedule", placeholder);
    if (!raw) return;
    const result = CronScheduler.validateSchedule(jobType, raw.trim());
    if (result.ok) {
      schedule = result.schedule;
      intervalMs = result.intervalMs;
      break;
    }
    placeholder = result.error;
  }

  const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
  if (!prompt) return;

  // Where the prompt runs when the job fires. A separate session keeps this
  // chat untouched; it needs a model, and can load pi's native MCP servers.
  const RUN_INLINE = "In this chat — the prompt arrives here when it fires";
  const RUN_SEPARATE = "Separate session — runs in the background under another model";
  const runChoice = await ctx.ui.select("Run", [RUN_INLINE, RUN_SEPARATE]);
  if (!runChoice) return;

  let model: string | undefined;
  let mcp: boolean | undefined;
  if (runChoice === RUN_SEPARATE) {
    // Re-prompt like the schedule step: an unknown model must not lose the
    // answers already given. Accepts fuzzy names, validated against the same
    // registry the scheduler will use when the job fires.
    let modelPlaceholder = "Model for the separate session, e.g. 'haiku' or 'provider/model-id'";
    while (true) {
      const raw = await ctx.ui.input("Model", modelPlaceholder);
      if (!raw) return;
      const trimmed = raw.trim();
      if (resolveModel(ctx.modelRegistry, trimmed)) {
        model = trimmed;
        break;
      }
      modelPlaceholder = `Unknown model '${trimmed}'. ${describeAvailableModels(ctx.modelRegistry)}`;
    }

    mcp = await ctx.ui.confirm(
      "MCP",
      "Load pi's native MCP servers (mcp.json) in the separate session?\nIt then gets the mcp__<server>__<tool> tools and the full builtin toolset.",
    );
  }

  // Last decision before save. Default option is listed first, picked up
  // from the global `defaultJobScope` setting — so hitting enter takes the
  // configured default.
  const defaultIsSession = (settings.defaultJobScope ?? "session") === "session";
  const SCOPE_SESSION = "Bind to this session — only this pi fires it";
  const SCOPE_SHARED = "Shared — every pi in this cwd fires it (accepts duplicate fires)";
  const scopeChoice = await ctx.ui.select(
    "Scope",
    defaultIsSession ? [SCOPE_SESSION, SCOPE_SHARED] : [SCOPE_SHARED, SCOPE_SESSION],
  );
  if (!scopeChoice) return;
  const session = scopeChoice === SCOPE_SESSION ? mySessionId : undefined;

  const human = CronScheduler.describeSchedule(jobType, schedule);
  const scopeLabel = session ? "session-bound" : "shared (any pi here)";
  const modeLabel = model
    ? `separate session (${model}${mcp ? ", native MCP" : ""})`
    : "this chat";
  const confirmed = await ctx.ui.confirm(
    "Confirm",
    `Save "${name}"?\nSchedule: ${human}\nRun: ${modeLabel}\nScope: ${scopeLabel}\nPrompt: ${prompt}`,
  );
  if (!confirmed) return;

  const job: CronJob = {
    id: nanoid(10),
    name,
    schedule,
    prompt,
    enabled: true,
    type: jobType,
    intervalMs,
    createdAt: new Date().toISOString(),
    runCount: 0,
    model,
    mcp: mcp || undefined,
    session,
  };

  storage.addJob(job);
  scheduler.addJob(job);
  ctx.ui.notify(`Created scheduled prompt: ${name} (${human})`, "info");
}
