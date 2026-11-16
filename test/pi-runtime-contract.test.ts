// Contract test against the real (unmocked) pi package.
//
// parentModelRuntime() reads ModelRegistry's TypeScript-private `runtime`
// field because pi exposes no public accessor. If pi renames or wraps that
// field, subagents silently fall back to a fresh default runtime; this test
// makes that a CI failure instead.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { parentModelRuntime } from "../src/subagent.js";
import { fakeProviderConfig } from "./fixtures/lifecycle/fake-provider.js";

describe("pi ModelRegistry runtime contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-prompt-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parentModelRuntime returns the runtime a real ModelRegistry wraps", async () => {
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
    const registry = new ModelRegistry(runtime);

    expect(parentModelRuntime({ modelRegistry: registry } as any)).toBe(runtime);
  });
});

// `idle` jobs rely on pi emitting `agent_settled` after a run, and on
// `pi.sendUserMessage` input arriving as source "extension" (so a job's own
// prompt never starts a new idle stretch).
describe("pi idle-signal contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-prompt-idle-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("emits input(source) → agent_start → agent_settled with ctx.isIdle() true", async () => {
    const events: string[] = [];
    let api: any;
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          api = pi;
          pi.on("input", (e) => {
            events.push(`input:${e.source}`);
          });
          pi.on("agent_start", () => {
            events.push("agent_start");
          });
          pi.on("agent_settled", (_e, ctx) => {
            events.push(`agent_settled:idle=${ctx.isIdle()}`);
          });
        },
      ],
    });
    await loader.reload();
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
    runtime.registerProvider("fake", fakeProviderConfig);
    const model = new ModelRegistry(runtime).find("fake", "m");
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
    });
    try {
      await session.bindExtensions({});
      await session.prompt("hi");
      await session.waitForIdle?.();
      api.sendUserMessage("scheduled");
      const deadline = Date.now() + 5000;
      while (events.filter((e) => e.startsWith("agent_settled")).length < 2) {
        if (Date.now() > deadline) throw new Error(`timed out; events: ${events.join(", ")}`);
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(events).toEqual([
        "input:interactive",
        "agent_start",
        "agent_settled:idle=true",
        "input:extension",
        "agent_start",
        "agent_settled:idle=true",
      ]);
    } finally {
      session.dispose();
    }
  });
});
