import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchStore } from "../src/store-watcher.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-schedule-store-watch-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("watchStore", () => {
  it("notifies for atomic temp-file + rename saves and stops on cleanup", async () => {
    const store = join(dir, "project.json");
    writeFileSync(store, '{"jobs":[]}', "utf-8");
    let calls = 0;
    const unwatch = watchStore(store, () => {
      calls++;
    });

    try {
      for (let i = 1; i <= 3; i++) {
        const temp = join(dir, `project.json.${i}.tmp`);
        writeFileSync(temp, JSON.stringify({ jobs: [], version: i }), "utf-8");
        renameSync(temp, store);
      }
      await vi.waitFor(
        () => {
          expect(calls).toBeGreaterThan(0);
        },
        { timeout: 2_000, interval: 10 },
      );
    } finally {
      unwatch();
    }

    const afterClose = calls;
    const temp = join(dir, "project.json.after.tmp");
    writeFileSync(temp, '{"jobs":[]}', "utf-8");
    renameSync(temp, store);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(afterClose);
  });
});
