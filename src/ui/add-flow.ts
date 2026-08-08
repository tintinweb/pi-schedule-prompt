import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import type { CronJobManager } from "../manager.js";
import { CronScheduler } from "../scheduler.js";
import type { JobScope, ScheduleSettings } from "../settings.js";
import type { CronStorage } from "../storage.js";
import type { CronJob } from "../types.js";

export async function runAddFlow(
  ctx: ExtensionCommandContext,
  managerOrStorage: CronJobManager | CronStorage,
  schedulerOrSettings: CronScheduler | ScheduleSettings,
  settingsOrSession: ScheduleSettings | string | undefined,
  mySessionId?: string,
): Promise<void> {
  const manager = "addJob" in managerOrStorage && "projectStorage" in managerOrStorage
    ? managerOrStorage as CronJobManager
    : undefined;
  const storage = manager ? undefined : managerOrStorage as CronStorage;
  const scheduler = manager ? undefined : schedulerOrSettings as CronScheduler;
  const settings = (manager ? schedulerOrSettings : settingsOrSession) as ScheduleSettings;
  const sessionId = manager ? settingsOrSession as string | undefined : mySessionId;

  const name = await ctx.ui.input("Job Name", "Enter a name for this scheduled prompt");
  if (!name) return;
  if (storage?.hasJobWithName(name)) {
    ctx.ui.notify(`A job named "${name}" already exists`, "error");
    return;
  }
  const typeChoice = await ctx.ui.select("Job Type", ["Cron (recurring)", "Once (one-shot)", "Interval (periodic)"]);
  if (!typeChoice) return;
  const typeMap: Record<string, CronJob["type"]> = { "Cron (recurring)": "cron", "Once (one-shot)": "once", "Interval (periodic)": "interval" };
  const jobType = typeMap[typeChoice];
  const placeholders = { cron: "6-field cron, e.g. '0 0 9 * * *' for 9am daily", once: "ISO timestamp or relative time (+10s, +5m, +1h)", interval: "Duration, e.g. '5m', '1h', '30s'" };
  let schedule: string | undefined;
  let intervalMs: number | undefined;
  let placeholder = placeholders[jobType];
  while (true) {
    const raw = await ctx.ui.input("Schedule", placeholder);
    if (!raw) return;
    const result = CronScheduler.validateSchedule(jobType, raw.trim());
    if (result.ok) { schedule = result.schedule; intervalMs = result.intervalMs; break; }
    placeholder = result.error;
  }
  const prompt = await ctx.ui.input("Prompt", "Enter the prompt to execute");
  if (!prompt) return;
  const SCOPE_SESSION = "Bind to this session — only this Pi session fires it";
  const SCOPE_WORKDIR = "Share in this workdir — eligible Pis in this cwd may fire it";
  const SCOPE_GLOBAL = "Global — one eligible Pi process fires it; stored for all projects";
  const defaultScope = (settings?.defaultJobScope ?? "session") as JobScope;
  const options = [SCOPE_SESSION, SCOPE_WORKDIR, SCOPE_GLOBAL];
  const ordered = ["session", "workdir", "global"].map((scope) => options[["session", "workdir", "global"].indexOf(scope)]).filter((_, index) => ["session", "workdir", "global"].indexOf(defaultScope) === index || true);
  const scopeChoice = await ctx.ui.select("Scope", [options[["session", "workdir", "global"].indexOf(defaultScope)], ...ordered.filter((item) => item !== options[["session", "workdir", "global"].indexOf(defaultScope)])]);
  if (!scopeChoice) return;
  const scope: JobScope = scopeChoice === SCOPE_SESSION ? "session" : scopeChoice === SCOPE_WORKDIR ? "workdir" : "global";
  const cwd = scope === "global" ? ctx.cwd : undefined;
  const human = CronScheduler.describeSchedule(jobType, schedule);
  const confirmed = await ctx.ui.confirm("Confirm", `Save "${name}"?\nSchedule: ${human}\nScope: ${scope}${cwd ? `\nCreator cwd: ${cwd}` : ""}\nPrompt: ${prompt}`);
  if (!confirmed) return;
  const job: CronJob = { id: nanoid(10), name, schedule, prompt, enabled: true, type: jobType, intervalMs, createdAt: new Date().toISOString(), runCount: 0, scope, session: scope === "session" ? sessionId : undefined, cwd };
  if (manager) manager.addJob(job);
  else { storage!.addJob(job); scheduler!.addJob(job); }
  ctx.ui.notify(`Created scheduled prompt: ${name} (${human})`, "info");
}
