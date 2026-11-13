import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/settings.js";

describe("ScheduleSettings — agent-dir persistence", () => {
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

  const agentSettings = () => join(agentDir, "schedule-prompts-settings.json");
  const projectSettings = () => join(cwd, ".pi", "schedule-prompts-settings.json");

  function writeAgent(raw: unknown) {
    writeFileSync(agentSettings(), JSON.stringify(raw), "utf-8");
  }

  function writeProject(raw: unknown) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectSettings(), JSON.stringify(raw), "utf-8");
  }

  function readAgent(): Record<string, unknown> {
    return JSON.parse(readFileSync(agentSettings(), "utf-8"));
  }

  describe("sanitize", () => {
    it("accepts defaultJobScope='session'", () => {
      writeAgent({ defaultJobScope: "session" });
      expect(loadSettings(cwd).defaultJobScope).toBe("session");
    });

    it("accepts defaultJobScope='workdir'", () => {
      writeAgent({ defaultJobScope: "workdir" });
      expect(loadSettings(cwd).defaultJobScope).toBe("workdir");
    });

    it("drops a typo'd defaultJobScope value (no garbage propagates)", () => {
      writeAgent({ defaultJobScope: "sesssion" });
      expect(loadSettings(cwd).defaultJobScope).toBeUndefined();
    });

    it("drops a non-string defaultJobScope", () => {
      writeAgent({ defaultJobScope: 42 });
      expect(loadSettings(cwd).defaultJobScope).toBeUndefined();
    });

    it("preserves widgetVisible alongside defaultJobScope", () => {
      writeAgent({ widgetVisible: false, defaultJobScope: "workdir" });
      const s = loadSettings(cwd);
      expect(s.widgetVisible).toBe(false);
      expect(s.defaultJobScope).toBe("workdir");
    });
  });

  it("migrates legacy project settings to the agent dir on first load", () => {
    writeProject({ defaultJobScope: "workdir" });

    expect(loadSettings(cwd).defaultJobScope).toBe("workdir");
    expect(existsSync(agentSettings())).toBe(true);
    expect(readAgent()).toEqual({ defaultJobScope: "workdir" });
  });

  it("prefers agent settings over a legacy project file", () => {
    writeAgent({ defaultJobScope: "workdir" });
    writeProject({ defaultJobScope: "session" });

    expect(loadSettings(cwd).defaultJobScope).toBe("workdir");
  });
});

describe("saveSettings — partial update", () => {
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

  const agentSettings = () => join(agentDir, "schedule-prompts-settings.json");
  const projectSettings = () => join(cwd, ".pi", "schedule-prompts-settings.json");

  function readAgent(): Record<string, unknown> {
    return JSON.parse(readFileSync(agentSettings(), "utf-8"));
  }

  it("writes to the agent dir, not the project .pi dir", () => {
    expect(saveSettings(cwd, { widgetVisible: false })).toBe(true);
    expect(readAgent()).toEqual({ widgetVisible: false });
    expect(existsSync(projectSettings())).toBe(false);
  });

  it("merges into existing agent settings rather than overwriting", () => {
    writeFileSync(agentSettings(), JSON.stringify({ defaultJobScope: "session" }), "utf-8");

    saveSettings(cwd, { widgetVisible: false });

    expect(readAgent()).toEqual({ defaultJobScope: "session", widgetVisible: false });
  });

  it("does not add unrelated fields", () => {
    saveSettings(cwd, { widgetVisible: true });
    expect(readAgent()).toEqual({ widgetVisible: true });
  });

  it("overwrites a previously-set field", () => {
    saveSettings(cwd, { widgetVisible: false });
    saveSettings(cwd, { widgetVisible: true });
    expect(readAgent()).toEqual({ widgetVisible: true });
  });
});
