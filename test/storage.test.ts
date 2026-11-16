import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronStorage, projectKey } from "../src/storage.js";
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

describe("CronStorage — per-project store in the agent dir", () => {
  let root: string;
  let agentDir: string;
  let projectA: string;
  let projectB: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-schedule-storage-")));
    agentDir = join(root, "agent");
    projectA = join(root, "a");
    projectB = join(root, "b");
    mkdirSync(projectA);
    mkdirSync(projectB);
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  const projectsDir = () => join(agentDir, "schedule-prompts", "projects");
  const legacyPath = (cwd: string) => join(cwd, ".pi", "schedule-prompts.json");

  function writeLegacy(cwd: string, jobs: CronJob[]) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(legacyPath(cwd), JSON.stringify({ jobs, version: 1 }));
  }

  it("stores jobs under PI_CODING_AGENT_DIR, keyed by project, with cwd recorded", () => {
    const storage = new CronStorage(projectA);
    storage.addJob(exampleJob());

    const file = join(projectsDir(), `${projectKey(projectA)}.json`);
    expect(storage.getStorePath()).toBe(file);
    expect(JSON.parse(readFileSync(file, "utf-8")).cwd).toBe(projectA);
    expect(existsSync(join(projectA, ".pi"))).toBe(false);
  });

  it("keeps projects apart: a shared job in one project does not load in another", () => {
    new CronStorage(projectA).addJob(exampleJob({ name: "only-a" }));

    expect(new CronStorage(projectB).getAllJobs()).toEqual([]);
    expect(new CronStorage(projectA).getAllJobs().map((j) => j.name)).toEqual(["only-a"]);
  });

  it("maps a symlinked path to the same store as its target", () => {
    const link = join(root, "link-to-a");
    symlinkSync(projectA, link);
    new CronStorage(projectA).addJob(exampleJob({ name: "via-target" }));

    expect(new CronStorage(link).getAllJobs().map((j) => j.name)).toEqual(["via-target"]);
  });

  it("migrates each trusted project's legacy store independently", () => {
    writeLegacy(projectA, [exampleJob({ name: "legacy-a" })]);
    writeLegacy(projectB, [exampleJob({ name: "legacy-b" })]);

    const a = new CronStorage(projectA);
    const b = new CronStorage(projectB);
    expect(a.migrateLegacy(true)).toBe("migrated");
    expect(b.migrateLegacy(true)).toBe("migrated");

    expect(a.getAllJobs().map((j) => j.name)).toEqual(["legacy-a"]);
    expect(b.getAllJobs().map((j) => j.name)).toEqual(["legacy-b"]);
    expect(readdirSync(projectsDir())).toHaveLength(2);
    expect(existsSync(legacyPath(projectA))).toBe(true);
  });

  it("does not import a legacy store from an untrusted project", () => {
    writeLegacy(projectA, [exampleJob({ name: "planted" })]);
    const storage = new CronStorage(projectA);

    expect(storage.migrateLegacy(false)).toBe("untrusted");
    expect(storage.getAllJobs()).toEqual([]);
    expect(existsSync(projectsDir())).toBe(false);
  });

  it("imports legacy jobs once trusted, even if a store was created while untrusted", () => {
    writeLegacy(projectA, [
      exampleJob({ id: "legacy-1", name: "legacy" }),
      exampleJob({ id: "shared-id", name: "legacy-dup" }),
    ]);
    const storage = new CronStorage(projectA);
    expect(storage.migrateLegacy(false)).toBe("untrusted");
    storage.addJob(exampleJob({ id: "shared-id", name: "current" }));

    expect(storage.migrateLegacy(true)).toBe("migrated");
    // Store's own job wins on an id clash; the other legacy job is merged in.
    expect(storage.getAllJobs().map((j) => j.name)).toEqual(["current", "legacy"]);
  });

  it("imports only once, and the marker survives later writes", () => {
    writeLegacy(projectA, [exampleJob({ id: "legacy-1", name: "legacy" })]);
    const storage = new CronStorage(projectA);
    expect(storage.migrateLegacy(true)).toBe("migrated");
    storage.removeJob("legacy-1");
    storage.addJob(exampleJob({ id: "new-1", name: "new" }));

    expect(storage.migrateLegacy(true)).toBe("none");
    expect(storage.getAllJobs().map((j) => j.name)).toEqual(["new"]);
  });

  it("does not overwrite a corrupt store during import", () => {
    writeLegacy(projectA, [exampleJob({ name: "legacy" })]);
    const storage = new CronStorage(projectA);
    mkdirSync(projectsDir(), { recursive: true });
    writeFileSync(storage.getStorePath(), "{ corrupt");

    expect(storage.migrateLegacy(true)).toBe("failed");
    expect(readFileSync(storage.getStorePath(), "utf-8")).toBe("{ corrupt");
  });

  it("reports a malformed legacy store as failed and leaves the store empty", () => {
    mkdirSync(join(projectA, ".pi"), { recursive: true });
    writeFileSync(legacyPath(projectA), "{ not json");
    const storage = new CronStorage(projectA);

    expect(storage.migrateLegacy(true)).toBe("failed");
    expect(storage.getAllJobs()).toEqual([]);
  });
});
