import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchStore } from "../src/store-watcher.js";

class FakeWatcher extends EventEmitter {
  close = vi.fn();
  unref = vi.fn(() => this);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-schedule-store-watch-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("reopens after a terminal watcher error and reconciles the latest store", async () => {
    vi.useFakeTimers();
    const watchers: FakeWatcher[] = [];
    const watch = () => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    };
    const onChange = vi.fn();
    const onError = vi.fn();
    const unwatch = watchStore(join(dir, "project.json"), onChange, onError, watch as typeof fs.watch);

    expect(watchers).toHaveLength(1);
    watchers[0].emit("error", new Error("watch failed"));
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(watchers).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    unwatch();
  });

  it("ignores late errors from a watcher already replaced after recovery", async () => {
    vi.useFakeTimers();
    const watchers: FakeWatcher[] = [];
    const watch = () => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    };
    const onChange = vi.fn();
    const unwatch = watchStore(join(dir, "project.json"), onChange, () => {}, watch as typeof fs.watch);

    watchers[0].emit("error", new Error("terminal"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watchers).toHaveLength(2);
    watchers[0].emit("error", new Error("late stale error"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(watchers).toHaveLength(2);
    expect(watchers[1].close).not.toHaveBeenCalled();
    unwatch();
  });

  it("does not reopen after cleanup during error backoff", async () => {
    vi.useFakeTimers();
    const watchers: FakeWatcher[] = [];
    const watch = () => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    };
    const onChange = vi.fn();
    const unwatch = watchStore(
      join(dir, "project.json"),
      onChange,
      () => {},
      watch as typeof fs.watch,
    );

    expect(watchers).toHaveLength(1);
    watchers[0].emit("error", new Error("watch failed"));
    unwatch();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(watchers).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
