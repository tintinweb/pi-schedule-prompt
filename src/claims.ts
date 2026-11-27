import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectKey } from "./storage.js";
import type { CronJob } from "./types.js";

/**
 * Cross-session "fire once" claims for singleton workdir jobs.
 *
 * A singleton job (no `session` field + `singleton: true`) is loaded by every
 * pi session in the cwd, so without coordination each session would fire it at
 * the same tick. Instead, at fire time each session tries to atomically create
 * a per-tick claim file with `fs.openSync(path, "wx")` (O_EXCL): exactly one
 * session in the workdir wins the create, and only the winner executes.
 *
 * The claim key contains the *scheduled* tick, not wall-clock now, so every
 * session firing the same cron tick contends on the same file, while later
 * ticks use fresh keys. Consequences:
 * - at-most-once per tick: if the winner crashes mid-run, that tick is simply
 *   skipped (no heartbeat, no lock stealing);
 * - stale claims are harmless (their key is in the past and never reused), so
 *   they only need opportunistic cleanup, not liveness checks.
 *
 * Claims live under `<agentDir>/schedule-prompts/claims/<projectKey>/`, next to
 * the project store, so pi profiles (PI_CODING_AGENT_DIR) never contend.
 */

/** Claims older than this are deleted on session start (housekeeping only —
 *  their tick is in the past and can never be claimed again). */
export const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long RPC/headless sessions yield before claiming a singleton tick,
 *  giving an attached TUI the first opportunity. TUIs do not wait. */
export const SINGLETON_HEADLESS_GRACE_MS = 1_500;

/** Claim file contents: who won and when (diagnostics / widget display). */
export interface ClaimRecord {
  jobId: string;
  tick: string;
  sessionId: string;
  pid: number;
  claimedAt: string;
}

/** Stable per-tick key shared by every session firing the same scheduled run. */
export function claimTick(job: Pick<CronJob, "type" | "schedule" | "intervalMs">, now = Date.now()): string {
  if (job.type === "once") return new Date(job.schedule).toISOString();
  if (job.type === "interval" && job.intervalMs) {
    return new Date(Math.floor(now / job.intervalMs) * job.intervalMs).toISOString();
  }
  // cron (and idle, which never reaches here): the current minute boundary.
  // Cron fields have 1s resolution, but pi sessions fire within the same
  // second-ish of the tick; flooring to the minute matches the cron schedule
  // granularity and is identical across sessions in the same tick.
  return new Date(Math.floor(now / 60_000) * 60_000).toISOString();
}

function claimDir(cwd: string): string {
  return path.join(getAgentDir(), "schedule-prompts", "claims", projectKey(cwd));
}

function claimPath(cwd: string, jobId: string, tick: string): string {
  // tick is an ISO timestamp (contains ':'); hash it to keep the file name flat.
  const tickHash = createHash("sha256").update(tick).digest("hex").slice(0, 16);
  return path.join(claimDir(cwd), `${jobId}.${tickHash}.claim`);
}

/**
 * Try to claim `job`'s fire for this tick. Returns the claim record when this
 * session won the O_EXCL create, null when another session already holds it.
 */
export function tryClaim(cwd: string, job: CronJob, sessionId: string, now = Date.now()): ClaimRecord | null {
  const tick = claimTick(job, now);
  const record: ClaimRecord = {
    jobId: job.id,
    tick,
    sessionId,
    pid: process.pid,
    claimedAt: new Date(now).toISOString(),
  };
  try {
    const dir = claimDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    // "wx": fail if the file exists — the atomic cross-process test-and-set.
    const fd = fs.openSync(claimPath(cwd, job.id, tick), "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(record, null, 2), "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    return record;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    // Unwritable claim dir etc.: fail open — behave like a non-singleton job
    // rather than silently never firing.
    console.warn(`[pi-schedule-prompt] could not create claim for job ${job.id}:`, err);
    return { ...record, stale: false } as ClaimRecord;
  }
}

/** Delete claim files older than CLAIM_MAX_AGE_MS. Best-effort housekeeping. */
export function pruneClaims(cwd: string, now = Date.now()): void {
  try {
    const dir = claimDir(cwd);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".claim")) continue;
      const full = path.join(dir, entry);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > CLAIM_MAX_AGE_MS) fs.unlinkSync(full);
      } catch {
        // Raced with another session's prune — fine.
      }
    }
  } catch {
    // No claims dir yet — nothing to prune.
  }
}
