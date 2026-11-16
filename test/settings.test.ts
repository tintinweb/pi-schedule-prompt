import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/settings.js";

// loadSettings reads from <agentDir>/<file> + <cwd>/.pi/<file>; we only set
// the project-local file in these tests, which is enough to exercise sanitize.
describe("ScheduleSettings — sanitize", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-settings-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeProjectSettings(raw: unknown) {
    writeFileSync(
      join(cwd, ".pi", "schedule-prompts-settings.json"),
      JSON.stringify(raw),
      "utf-8",
    );
  }

  it("accepts defaultJobScope='session'", () => {
    writeProjectSettings({ defaultJobScope: "session" });
    expect(loadSettings(cwd, true).defaultJobScope).toBe("session");
  });

  it("accepts defaultJobScope='workdir'", () => {
    writeProjectSettings({ defaultJobScope: "workdir" });
    expect(loadSettings(cwd, true).defaultJobScope).toBe("workdir");
  });

  it("drops a typo'd defaultJobScope value (no garbage propagates)", () => {
    writeProjectSettings({ defaultJobScope: "sesssion" });
    expect(loadSettings(cwd, true).defaultJobScope).toBeUndefined();
  });

  it("drops a non-string defaultJobScope", () => {
    writeProjectSettings({ defaultJobScope: 42 });
    expect(loadSettings(cwd, true).defaultJobScope).toBeUndefined();
  });

  it("preserves widgetVisible alongside defaultJobScope", () => {
    writeProjectSettings({ widgetVisible: false, defaultJobScope: "workdir" });
    const s = loadSettings(cwd, true);
    expect(s.widgetVisible).toBe(false);
    expect(s.defaultJobScope).toBe("workdir");
  });
});

describe("saveSettings — partial update", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-settings-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function readProjectFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(cwd, ".pi", "schedule-prompts-settings.json"), "utf-8"));
  }

  it("creates the project file when none exists, with only the changed field", () => {
    expect(saveSettings(cwd, { widgetVisible: false }, true)).toBe(true);
    expect(readProjectFile()).toEqual({ widgetVisible: false });
  });

  it("merges into an existing project file rather than overwriting", () => {
    saveSettings(cwd, { widgetVisible: false }, true);
    saveSettings(cwd, { defaultJobScope: "workdir" }, true);
    expect(readProjectFile()).toEqual({ widgetVisible: false, defaultJobScope: "workdir" });
  });

  it("does NOT pin global defaults into the project file (the bug we just fixed)", () => {
    // Simulate: user has a global default for defaultJobScope, then toggles
    // widgetVisible via the UI. The project file should contain only
    // widgetVisible — defaultJobScope must keep bleeding through from global.
    saveSettings(cwd, { widgetVisible: true }, true);
    expect(readProjectFile()).toEqual({ widgetVisible: true });
    expect("defaultJobScope" in readProjectFile()).toBe(false);
  });

  it("overwrites a previously-set field", () => {
    saveSettings(cwd, { widgetVisible: false }, true);
    saveSettings(cwd, { widgetVisible: true }, true);
    expect(readProjectFile()).toEqual({ widgetVisible: true });
  });
});

describe("ScheduleSettings — agent dir and project trust", () => {
  let agentDir: string;
  let cwd: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "pi-schedule-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-schedule-settings-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(agentDir, "schedule-prompts-settings.json"),
      JSON.stringify({ widgetVisible: false, defaultJobScope: "session" }),
    );
    writeFileSync(
      join(cwd, ".pi", "schedule-prompts-settings.json"),
      JSON.stringify({ defaultJobScope: "workdir" }),
    );
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads global settings from PI_CODING_AGENT_DIR, overridden by a trusted project", () => {
    expect(loadSettings(cwd, true)).toEqual({ widgetVisible: false, defaultJobScope: "workdir" });
  });

  it("ignores the project file when the project is not trusted", () => {
    expect(loadSettings(cwd, false)).toEqual({ widgetVisible: false, defaultJobScope: "session" });
  });

  it("does not write the project file when the project is not trusted", () => {
    expect(saveSettings(cwd, { widgetVisible: true }, false)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(cwd, ".pi", "schedule-prompts-settings.json"), "utf-8")),
    ).toEqual({ defaultJobScope: "workdir" });
  });
});
