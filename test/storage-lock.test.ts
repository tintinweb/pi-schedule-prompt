import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStoreLock } from "../src/storage-lock.js";

let root: string;
let storePath: string;
let lockPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-schedule-store-lock-"));
  storePath = join(root, "store.json");
  lockPath = `${storePath}.lock`;
  mkdirSync(dirname(storePath), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ownerPath(): string {
  return join(lockPath, "owner.json");
}

function plantLock(owner: { pid: number; createdAt: number; token?: string }): void {
  mkdirSync(lockPath);
  writeFileSync(ownerPath(), JSON.stringify({ token: "planted", ...owner }));
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return pid;
}

describe("withStoreLock", () => {
  it("holds the lock for the operation, returns its value, and releases afterward", () => {
    const result = withStoreLock(storePath, () => {
      expect(existsSync(lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(ownerPath(), "utf-8")).pid).toBe(process.pid);
      return 42;
    });

    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when the operation throws so a later writer can proceed", () => {
    expect(() =>
      withStoreLock(storePath, () => {
        throw new Error("mutation failed");
      }),
    ).toThrow("mutation failed");
    expect(existsSync(lockPath)).toBe(false);

    expect(withStoreLock(storePath, () => "recovered")).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out without removing a live owner's lock", () => {
    plantLock({ pid: process.pid, createdAt: 0 });

    expect(() =>
      withStoreLock(storePath, () => "must not run", {
        timeoutMs: 30,
        staleMs: 0,
        retryMs: 5,
      }),
    ).toThrow(/timed out/i);

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(ownerPath(), "utf-8")).token).toBe("planted");
  });

  it("does not reclaim an old lock whose owner cannot be inspected", () => {
    mkdirSync(lockPath);

    expect(() =>
      withStoreLock(storePath, () => "must not run", {
        timeoutMs: 30,
        staleMs: 0,
        retryMs: 5,
      }),
    ).toThrow(/timed out/i);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("reclaims an expired lock only when its recorded owner process has exited", async () => {
    const deadPid = await exitedPid();
    plantLock({ pid: deadPid, createdAt: 0 });

    const result = withStoreLock(storePath, () => "acquired", {
      timeoutMs: 200,
      staleMs: 10,
      retryMs: 5,
    });

    expect(result).toBe("acquired");
    expect(existsSync(lockPath)).toBe(false);
  });
});
