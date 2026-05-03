/**
 * Interactive add flow for `/schedule-prompt`.
 * Steps the user through name → type → schedule (with re-prompt on validation
 * failure) → prompt → scope → confirm. Saves and schedules the new job, or
 * returns silently on cancellation.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { nanoid } from "nanoid";
import { CronScheduler } from "../scheduler.js";
import type { ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import type { CronJob } from "../types.js";

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
  ]);
  if (!typeChoice) return;

  const typeMap: Record<string, "cron" | "once" | "interval"> = {
    "Cron (recurring)": "cron",
    "Once (one-shot)": "once",
    "Interval (periodic)": "interval",
  };
  const jobType = typeMap[typeChoice];

  const placeholders: Record<string, string> = {
    cron: "6-field cron, e.g. '0 0 9 * * *' for 9am daily",
    once: "ISO timestamp or relative time (+10s, +5m, +1h)",
    interval: "Duration, e.g. '5m', '1h', '30s'",
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
  const confirmed = await ctx.ui.confirm(
    "Confirm",
    `Save "${name}"?\nSchedule: ${human}\nScope: ${scopeLabel}\nPrompt: ${prompt}`,
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
    session,
  };

  storage.addJob(job);
  scheduler.addJob(job);
  ctx.ui.notify(`Created scheduled prompt: ${name} (${human})`, "info");
}
