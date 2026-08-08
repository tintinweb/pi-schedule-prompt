import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/tmp/pi-schedule-test-agent" }));

import { CronStorage, DuplicateJobNameError } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1", name: "demo", schedule: "0 * * * * *", prompt: "hi", enabled: true,
    type: "cron", createdAt: "2026-01-01T00:00:00Z", runCount: 0, ...overrides,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync("/tmp/pi-schedule-test-agent", { recursive: true, force: true });
});

describe("CronStorage", () => {
  it("uses project and agent-directory paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-schedule-storage-"));
    tempDirs.push(cwd);
    expect(CronStorage.forProject(cwd).getStorePath()).toBe(join(cwd, ".pi", "schedule-prompts.json"));
    expect(CronStorage.global().getStorePath()).toBe("/tmp/pi-schedule-test-agent/schedule-prompts.json");
  });

  it("normalizes legacy project jobs and locks duplicate checks inside add", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-schedule-storage-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const storage = CronStorage.forProject(cwd);
    storage.addJob(job({ session: "session-a" }));
    expect(storage.getJob("job-1")?.scope).toBe("session");
    expect(() => storage.addJob(job({ id: "job-2" }))).toThrow(DuplicateJobNameError);
    const saved = JSON.parse(readFileSync(storage.getStorePath(), "utf8"));
    expect(saved.jobs).toHaveLength(1);
  });

  it("returns an empty store for malformed JSON", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-schedule-storage-"));
    tempDirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const storage = CronStorage.forProject(cwd);
    writeFileSync(storage.getStorePath(), "not-json");
    expect(storage.load()).toEqual({ jobs: [], version: 1 });
  });
});
