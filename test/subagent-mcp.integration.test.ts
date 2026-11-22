// Native MCP in scheduled subagent sessions, against the real (unmocked) pi
// runtime: an agent-dir mcp.json pointing at a tiny stdio probe server, and a
// fake provider whose model calls the server's tool when pi declares it.
//
// Proves the mcp:true job option makes the background session load pi's
// built-in MCP extension (plus codemode/tool-search), connect the server, let
// the model call its tool, and stop the server on teardown — and that none of
// that happens without mcp:true.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSubagentOnce } from "../src/subagent.js";
import { mcpFakeProviderConfig } from "./fixtures/mcp/fake-provider.js";

const dir = mkdtempSync(join(tmpdir(), "pi-schedule-prompt-mcp-"));
const agentDir = join(dir, "agent");
const cwd = join(dir, "cwd");
const serverPath = join(dir, "mcp-probe-server.mjs");
const logPath = join(dir, "mcp-probe.log");
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;

function readLog(): string[] {
  return existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
}

async function waitForLog(entry: string) {
  const deadline = Date.now() + 10_000;
  while (!readLog().includes(entry)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for log entry "${entry}"`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeCtx() {
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
  runtime.registerProvider("fake", mcpFakeProviderConfig);
  return {
    cwd,
    modelRegistry: new ModelRegistry(runtime),
    sessionManager: { getSessionId: () => "s" },
  } as any;
}

describe("subagent native MCP (real pi)", () => {
  beforeAll(() => {
    cpSync(join(__dirname, "fixtures/mcp"), dir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    // Direct exposure: the tool is declared to the model and the first prompt
    // waits for the server to connect, which keeps the test deterministic.
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          probe: {
            command: process.execPath,
            args: [serverPath],
            env: { PROBE_MCP_LOG: logPath },
            exposure: "direct",
            timeout: 30,
          },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterAll(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test gets a fresh server-probe log.
    rmSync(logPath, { force: true });
  });

  it("mcp:true: connects the mcp.json server, the model calls its tool, teardown stops it", async () => {
    const result = await runSubagentOnce(await makeCtx(), "call the echo tool", "fake/m", undefined, {
      mcp: true,
    });

    // The fake provider answers echo-ok only when the MCP tool result reached
    // it as a toolResult message.
    expect(result).toEqual({ ok: true, text: "echo-ok" });
    expect(readLog()).toEqual(
      expect.arrayContaining(["initialize", "tools_list", "tools_call:hi"]),
    );
    // session_shutdown from the subagent teardown stops the server's stdio.
    await waitForLog("stdin_closed");
  });

  it("without mcp: the subagent cannot call MCP tools (no built-in extensions loaded)", async () => {
    const result = await runSubagentOnce(await makeCtx(), "call the echo tool", "fake/m");

    expect(result.ok).toBe(true);
    // The model issued the call; pi had no mcp__probe__echo tool, so the result
    // reports the failed call instead of the server's echo:hi.
    expect((result as { ok: true; text: string }).text).toMatch(/^echo-failed:/);
    expect((result as { ok: true; text: string }).text).not.toContain("echo:hi");
    // No native MCP: the server in mcp.json is never even spawned.
    expect(readLog()).not.toContain("initialize");
  });
});
