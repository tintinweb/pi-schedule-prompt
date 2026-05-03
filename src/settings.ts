// Persistence for pi-schedule-prompt settings.
// - Global:  ~/.pi/agent/schedule-prompts-settings.json — manual user defaults, never written here
// - Project: <cwd>/.pi/schedule-prompts-settings.json — written by the UI; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

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

export function loadSettings(cwd: string): ScheduleSettings {
  return { ...read(join(getAgentDir(), FILE)), ...read(join(cwd, ".pi", FILE)) };
}

/**
 * Apply a partial update to the project settings file. Reads the *project*
 * file (not the merged in-memory state), spreads `change` over it, writes
 * back. This way the project file only ever contains deliberate overrides,
 * so global defaults bleed through correctly when the user later edits them.
 *
 * Returns false on IO failure so the caller can surface a "session only" toast.
 */
export function saveSettings(cwd: string, change: Partial<ScheduleSettings>): boolean {
  const path = join(cwd, ".pi", FILE);
  try {
    const merged = { ...read(path), ...change };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
