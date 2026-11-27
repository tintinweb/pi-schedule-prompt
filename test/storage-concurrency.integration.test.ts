import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";

let root: string;
let fixture: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  root = mkdtempSync(join(tmpdir(), "pi-schedule-storage-race-"));
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
  if (fixture) rmSync(fixture, { force: true });
  fixture = undefined;
});

function job(id: string): CronJob {
  return {
    id,
    name: id,
    schedule: "0 0 9 * * *",
    prompt: "seed",
    enabled: true,
    type: "cron",
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
}

function startWriter(fixture: string, id: string, projectDir: string, barrierDir: string, agentDir: string) {
  const child = spawn(
    process.execPath,
    [fixture, id, projectDir, barrierDir],
    {
      cwd: resolve("."),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise<{ code: number | null; output: string }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit({ code, output: `${stdout}\n${stderr}` }));
  });
}

describe("CronStorage cross-process mutations", () => {
  it("preserves every concurrent add and terminal update without temp-file collisions", async () => {
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    const barrierDir = join(root, "barrier");
    mkdirSync(projectDir);
    mkdirSync(barrierDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const storage = new CronStorage(projectDir);
    storage.addJob(job("toggle-a"));
    storage.addJob(job("toggle-b"));
    storage.addJob(job("counter"));

    fixture = resolve("node_modules", ".pi-schedule-storage-writer.mjs");
    await build({
      entryPoints: [resolve("test/fixtures/storage-writer.ts")],
      outfile: fixture,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const writers = [
      startWriter(fixture, "a", projectDir, barrierDir, agentDir),
      startWriter(fixture, "b", projectDir, barrierDir, agentDir),
    ];
    await vi.waitFor(
      () => {
        expect(existsSync(join(barrierDir, "a.ready"))).toBe(true);
        expect(existsSync(join(barrierDir, "b.ready"))).toBe(true);
      },
      { timeout: 10_000, interval: 10 },
    );
    writeFileSync(join(barrierDir, "go"), "go");
    const results = await Promise.all(writers);

    expect(results.map((result) => result.code), results.map((result) => result.output).join("\n")).toEqual([0, 0]);
    const jobs = new CronStorage(projectDir).getAllJobs();
    expect(jobs).toHaveLength(403);
    for (const worker of ["a", "b"]) {
      for (let index = 0; index < 200; index++) {
        expect(jobs.some((candidate) => candidate.id === `${worker}-job-${index}`)).toBe(true);
      }
      expect(jobs.find((candidate) => candidate.id === `toggle-${worker}`)).toMatchObject({
        enabled: false,
        lastStatus: "success",
      });
    }

    expect(jobs.find((candidate) => candidate.id === "counter")).toMatchObject({
      runCount: 400,
      lastStatus: "success",
    });

    const files = readdirSync(join(agentDir, "schedule-prompts", "projects"));
    expect(files.filter((file) => file.includes(".tmp") || file.endsWith(".lock"))).toEqual([]);
  }, 30_000);
});
