// Contract test against the real (unmocked) pi package.
//
// parentModelRuntime() reads ModelRegistry's TypeScript-private `runtime`
// field because pi exposes no public accessor. If pi renames or wraps that
// field, subagents silently fall back to a fresh default runtime; this test
// makes that a CI failure instead.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { parentModelRuntime } from "../src/subagent.js";

describe("pi ModelRegistry runtime contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-prompt-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parentModelRuntime returns the runtime a real ModelRegistry wraps", async () => {
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
    const registry = new ModelRegistry(runtime);

    expect(parentModelRuntime({ modelRegistry: registry } as any)).toBe(runtime);
  });
});
