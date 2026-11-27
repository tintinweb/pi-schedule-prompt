import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectKey } from "./storage.js";
import type { CronJob } from "./types.js";

/**
 * Cross-session "fire once" claims for singleton workdir jobs.
 *
 * Every contender for one scheduled occurrence attempts to create the same
 * file with `wx` (O_EXCL). Only `EEXIST` is a normal lost election. Any other
 * failure is thrown so the scheduler can fail closed instead of running the
 * same occurrence in every session.
 *
 * Claims remain at-most-once: a crashed winner forfeits that occurrence and
 * its claim is never stolen. Seven-day retention bounds how far a delayed
 * contender may trail while retaining that guarantee. Claims are sharded by
 * job and UTC occurrence hour so expired buckets can be removed wholesale.
 */

/** Claims in buckets whose entire hour is older than this are pruned. */
export const CLAIM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long RPC/headless sessions yield before claiming a singleton tick,
 *  giving an attached TUI the first opportunity. TUIs do not wait. */
export const SINGLETON_HEADLESS_GRACE_MS = 1_500;

const HOUR_MS = 60 * 60 * 1000;
const HOUR_BUCKET = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

/** Claim file contents: who won and when (diagnostics / widget display). */
export interface ClaimRecord {
  jobId: string;
  tick: string;
  sessionId: string;
  pid: number;
  claimedAt: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable identity for the scheduled occurrence, not the callback wall clock. */
export function claimTick(
  job: Pick<CronJob, "type" | "schedule" | "intervalMs">,
  occurrenceAt = Date.now(),
): string {
  // A one-shot's identity remains its target even if a stale callback races a
  // schedule edit. Other supported types supply their armed occurrence.
  return new Date(job.type === "once" ? new Date(job.schedule).getTime() : occurrenceAt).toISOString();
}

function claimDir(cwd: string): string {
  return path.join(getAgentDir(), "schedule-prompts", "claims", projectKey(cwd));
}

function claimPath(cwd: string, jobId: string, tick: string): string {
  // The ISO prefix is YYYY-MM-DDTHH. Hashing job/tick components avoids path
  // traversal from hand-edited stores and keeps individual file names flat.
  const hourBucket = tick.slice(0, 13);
  return path.join(claimDir(cwd), hash(jobId), hourBucket, `${hash(tick)}.claim`);
}

/**
 * Try to claim `job`'s scheduled occurrence. Returns the record only for this
 * process's atomic win, null only when another process already claimed it.
 * Coordination failures throw; executing without a claim would be unsafe.
 */
export function tryClaim(
  cwd: string,
  job: CronJob,
  sessionId: string,
  occurrenceAt = Date.now(),
): ClaimRecord | null {
  const tick = claimTick(job, occurrenceAt);
  const record: ClaimRecord = {
    jobId: job.id,
    tick,
    sessionId,
    pid: process.pid,
    claimedAt: new Date().toISOString(),
  };
  const file = claimPath(cwd, job.id, tick);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let fd: number;
  try {
    fd = fs.openSync(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2), "utf-8");
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

function pruneLegacyClaim(full: string, now: number): void {
  try {
    const st = fs.statSync(full);
    if (now - st.mtimeMs > CLAIM_MAX_AGE_MS) fs.unlinkSync(full);
  } catch {
    // Raced with another session's prune — fine.
  }
}

function pruneJobDir(dir: string, now: number): void {
  try {
    for (const bucket of fs.readdirSync(dir)) {
      if (!HOUR_BUCKET.test(bucket)) continue;
      const bucketStart = Date.parse(`${bucket}:00:00.000Z`);
      if (!Number.isFinite(bucketStart)) continue;
      // Do not remove a bucket until every claim it can contain is expired.
      if (now - (bucketStart + HOUR_MS) > CLAIM_MAX_AGE_MS) {
        try {
          fs.rmSync(path.join(dir, bucket), { recursive: true, force: true });
        } catch {
          // Another pruner may have removed it first.
        }
      }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Raced with another session's prune — fine.
  }
}

/** Delete expired hour buckets and legacy flat claims. Best-effort housekeeping. */
export function pruneClaims(cwd: string, now = Date.now()): void {
  const dir = claimDir(cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // No claims dir yet — nothing to prune.
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      if (entry.endsWith(".claim")) {
        pruneLegacyClaim(full, now);
      } else if (fs.statSync(full).isDirectory()) {
        pruneJobDir(full, now);
      }
    } catch {
      // Raced with another session's prune — fine.
    }
  }
}
