import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 10;
const sleepWord = new Int32Array(new SharedArrayBuffer(4));

export interface StoreLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

interface LockOwner {
  pid: number;
  createdAt: number;
  token: string;
}

function sleep(ms: number): void {
  Atomics.wait(sleepWord, 0, 0, ms);
}

function processHasExited(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    // EPERM means the process exists but belongs to another user. Other errors
    // do not prove death, so never use them as permission to steal a lock.
    return undefined;
  }
}

function readOwner(ownerPath: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf-8")) as Partial<LockOwner>;
    if (
      typeof owner.pid !== "number" ||
      typeof owner.createdAt !== "number" ||
      typeof owner.token !== "string"
    ) {
      return undefined;
    }
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

/** Reclaim only a lock whose recorded process is demonstrably gone. Renaming
 *  the directory quarantines exactly the stale generation; a newly-acquired
 *  lock at the original path is never removed by stale cleanup. */
function tryReclaimStaleLock(lockPath: string, staleMs: number): boolean {
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = readOwner(ownerPath);
  if (!owner || Date.now() - owner.createdAt <= staleMs || processHasExited(owner.pid) !== true) {
    return false;
  }

  const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch {
    return false;
  }

  // Another contender may have replaced the lock between inspection and
  // rename. If the quarantined generation is not the one inspected, put it
  // back when possible rather than deleting a potentially live lock.
  if (readOwner(path.join(quarantine, "owner.json"))?.token !== owner.token) {
    try {
      fs.renameSync(quarantine, lockPath);
    } catch {
      // A new lock already occupies the path. Preserve the displaced one for
      // diagnosis rather than deleting something that may be live.
    }
    return false;
  }

  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function releaseLock(lockPath: string, token: string): void {
  const owner = readOwner(path.join(lockPath, "owner.json"));
  // Never remove a newer generation that reused the path.
  if (owner?.token !== token) return;
  fs.rmSync(lockPath, { recursive: true, force: true });
}

/** Serialize one complete store read-modify-write transaction across pi
 *  processes. The operation is synchronous, matching CronStorage's API. */
export function withStoreLock<T>(
  storePath: string,
  operation: () => T,
  options: StoreLockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const lockPath = `${storePath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      const owner: LockOwner = { pid: process.pid, createdAt: Date.now(), token };
      try {
        fs.writeFileSync(ownerPath, JSON.stringify(owner), "utf-8");
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (tryReclaimStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring scheduled-prompt store lock: ${lockPath}`);
      }
      sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }

  try {
    return operation();
  } finally {
    releaseLock(lockPath, token);
  }
}
