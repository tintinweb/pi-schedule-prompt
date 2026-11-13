// Persistence for pi-schedule-prompt settings.
// Settings live in the active pi agent directory (`getAgentDir()`, which honors
// PI_CODING_AGENT_DIR) so they are scoped per profile and do not collide with
// other profiles sharing a working directory. A legacy project-local
// <cwd>/.pi file is migrated once on first load.
//
// The cwd argument is kept on the public API so callers do not change; it is
// only used to find the legacy file.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type JobScope = "session" | "workdir";

export interface ScheduleSettings {
  /** Default true. */
  widgetVisible?: boolean;
  /**
   * Default scope for newly-created jobs. `"session"` (default) writes
   * `session: <currentSessionId>` so only the creating pi fires the job;
   * `"workdir"` omits the field so every pi session using this agent dir fires
   * it. The value name is historical; the store is now agent-scoped.
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
  const agentPath = join(getAgentDir(), FILE);
  const legacyPath = join(cwd, ".pi", FILE);

  if (!existsSync(agentPath) && existsSync(legacyPath)) {
    try {
      mkdirSync(dirname(agentPath), { recursive: true });
      copyFileSync(legacyPath, agentPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pi-schedule-prompt] Could not migrate legacy settings from ${legacyPath}: ${reason}`,
      );
    }
  }

  return read(agentPath);
}

/**
 * Apply a partial update to the agent-dir settings file. Reads the current
 * agent file (not the merged in-memory state), spreads `change` over it, and
 * writes it back, so a toggle only persists the field it changed.
 *
 * `loadSettings` is called first to migrate any legacy project-local file before
 * a partial write could shadow it.
 */
export function saveSettings(cwd: string, change: Partial<ScheduleSettings>): boolean {
  loadSettings(cwd);

  const path = join(getAgentDir(), FILE);
  try {
    const merged = { ...read(path), ...change };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
