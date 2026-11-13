import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "+10s",
    prompt: "do the thing",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("CronStorage — agent-dir persistence", () => {
  let agentDir: string;
  let cwd: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "pi-schedule-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const storePath = () => join(agentDir, "schedule-prompts.json");
  const legacyPath = () => join(cwd, ".pi", "schedule-prompts.json");

  function writeStore(path: string, jobs: CronJob[]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ jobs, version: 1 }), "utf-8");
  }

  it("stores jobs in the agent dir, not the working directory", () => {
    const storage = new CronStorage(cwd);

    expect(storage.getStorePath()).toBe(storePath());

    storage.addJob(exampleJob());

    expect(existsSync(storePath())).toBe(true);
    expect(existsSync(legacyPath())).toBe(false);
    expect(storage.getAllJobs()).toHaveLength(1);
  });

  it("migrates a legacy <cwd>/.pi store on first load", () => {
    writeStore(legacyPath(), [exampleJob({ name: "legacy" })]);

    const storage = new CronStorage(cwd);

    expect(storage.getAllJobs().map((job) => job.name)).toEqual(["legacy"]);
    expect(existsSync(storePath())).toBe(true);
    expect(JSON.parse(readFileSync(storePath(), "utf-8")).jobs[0].name).toBe("legacy");
  });

  it("prefers the agent-dir store when both exist", () => {
    writeStore(legacyPath(), [exampleJob({ name: "legacy" })]);
    writeStore(storePath(), [exampleJob({ name: "agent" })]);

    const storage = new CronStorage(cwd);

    expect(storage.getAllJobs().map((job) => job.name)).toEqual(["agent"]);
  });
});
