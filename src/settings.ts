// Persistence for pi-schedule-prompt settings.
// - Global:  ~/.pi/agent/schedule-prompts-settings.json — manual user defaults, never written here
// - Project: <cwd>/.pi/schedule-prompts-settings.json — written by the UI; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface ScheduleSettings {
  /** Default true. Project file overrides global. */
  widgetVisible?: boolean;
}

const FILE = "schedule-prompts-settings.json";

function sanitize(raw: unknown): ScheduleSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  return typeof r.widgetVisible === "boolean" ? { widgetVisible: r.widgetVisible } : {};
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

/** Returns false on IO failure so the caller can surface a "session only" toast. */
export function saveSettings(cwd: string, s: ScheduleSettings): boolean {
  const path = join(cwd, ".pi", FILE);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
