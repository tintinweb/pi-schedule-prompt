// Persistence for pi-schedule-prompt settings, layered the way pi layers its own settings.json:
// - Global:  <agentDir>/schedule-prompts-settings.json (getAgentDir(), honors PI_CODING_AGENT_DIR;
//            default ~/.pi/agent) — manual user defaults, never written here
// - Project: <cwd>/.pi/schedule-prompts-settings.json — written by the UI; overrides global on
//            load. Read and written only for trusted projects, like pi's project .pi resources.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type JobScope = "session" | "workdir";

export interface ScheduleSettings {
  /** Default true. Project file overrides global. */
  widgetVisible?: boolean;
  /**
   * Default scope for newly-created jobs. `"session"` (default) writes
   * `session: <currentSessionId>` so only the creating pi fires the job;
   * `"workdir"` omits the field so every pi in this cwd fires it.
   */
  defaultJobScope?: JobScope;
  /**
   * Default `singleton` for newly-created cron/once/interval workdir jobs:
   * when true, each scheduled occurrence executes in one session (per-occurrence
   * claim) instead of every session. Default false. Session-bound/idle jobs ignore it.
   */
  defaultSingleton?: boolean;
  /**
   * Default `singletonPreferTui` written when a new singleton workdir job is
   * created. Default true. Changing it affects new jobs only; existing jobs
   * keep their own value (and a missing value means true).
   */
  defaultSingletonPreferTui?: boolean;
}

const FILE = "schedule-prompts-settings.json";

function sanitize(raw: unknown): ScheduleSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: ScheduleSettings = {};
  if (typeof r.widgetVisible === "boolean") out.widgetVisible = r.widgetVisible;
  if (r.defaultJobScope === "session" || r.defaultJobScope === "workdir") {
    out.defaultJobScope = r.defaultJobScope;
  }
  if (typeof r.defaultSingleton === "boolean") out.defaultSingleton = r.defaultSingleton;
  if (typeof r.defaultSingletonPreferTui === "boolean") {
    out.defaultSingletonPreferTui = r.defaultSingletonPreferTui;
  }
  return out;
}

function read(path: string): ScheduleSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-schedule-prompt] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

function projectPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, FILE);
}

/** Global settings, overridden by the project file when the project is trusted. */
export function loadSettings(cwd: string, trusted: boolean): ScheduleSettings {
  const global = read(join(getAgentDir(), FILE));
  return trusted ? { ...global, ...read(projectPath(cwd)) } : global;
}

/**
 * Apply a partial update to the project settings file. Reads the *project*
 * file (not the merged in-memory state), spreads `change` over it, writes
 * back. This way the project file only ever contains deliberate overrides,
 * so global defaults bleed through correctly when the user later edits them.
 *
 * Returns false on IO failure, or without writing when the project is not
 * trusted (its project file would be ignored on load), so the caller can
 * surface a "session only" toast.
 */
export function saveSettings(
  cwd: string,
  change: Partial<ScheduleSettings>,
  trusted: boolean,
): boolean {
  if (!trusted) return false;
  const path = projectPath(cwd);
  try {
    const merged = { ...read(path), ...change };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
