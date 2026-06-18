import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeAvailableModels,
  getLastAssistantText,
  resolveModel,
} from "../src/subagent.js";
import {
  runSubagentOnce,
} from "../src/subagent.js";

// Mock the pi-coding-agent module for runSubagentOnce tests
// Must be at file scope — vitest hoists vi.mock to the top automatically.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn(function () {
    return { reload: vi.fn().mockResolvedValue(undefined) };
  }),
  getAgentDir: vi.fn(() => "/tmp/agent-dir"),
  SessionManager: { inMemory: vi.fn(() => ({ getSessionId: () => "test" })) },
  SettingsManager: { create: vi.fn(() => ({})) },
}));

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const mockCreateAgentSession = vi.mocked(createAgentSession);
const mockDefaultResourceLoader = vi.mocked(DefaultResourceLoader);

// Mirror of the minimal Model shape resolveModel actually touches: provider, id, name.
const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

function makeRegistry(available = MODELS) {
  return {
    find: (provider: string, id: string) =>
      MODELS.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => available,
  } as any;
}

describe("resolveModel", () => {
  it("matches exact provider/id", () => {
    expect(resolveModel(makeRegistry(), "anthropic/claude-opus-4-6")).toEqual(MODELS[0]);
  });

  it("falls through to fuzzy when provider/id is not exact", () => {
    // 'anthropic/haiku' is not a real id; the slash branch fails registry.find,
    // then fuzzy match scans the full string against id/name and still picks haiku.
    expect(resolveModel(makeRegistry(), "anthropic/haiku")).toEqual(MODELS[2]);
  });

  it("matches exact id without provider prefix", () => {
    expect(resolveModel(makeRegistry(), "gpt-4o")).toEqual(MODELS[3]);
  });

  it("is case-insensitive on exact id", () => {
    expect(resolveModel(makeRegistry(), "GPT-4o")).toEqual(MODELS[3]);
  });

  it("matches via id substring", () => {
    expect(resolveModel(makeRegistry(), "haiku")).toEqual(MODELS[2]);
    expect(resolveModel(makeRegistry(), "sonnet")).toEqual(MODELS[1]);
  });

  it("matches via name substring when id substring misses", () => {
    // 'Gemini' appears in the model name but not in the id.
    expect(resolveModel(makeRegistry(), "Gemini")).toEqual(MODELS[4]);
  });

  it("returns undefined for unknown model", () => {
    expect(resolveModel(makeRegistry(), "definitely-not-a-real-model")).toBeUndefined();
  });

  it("returns undefined when registry is empty", () => {
    expect(resolveModel(makeRegistry([]), "haiku")).toBeUndefined();
  });

  it("only resolves against models with configured auth (getAvailable)", () => {
    // Auth only configured for opus — even though sonnet is in MODELS, it isn't
    // returned by getAvailable() so fuzzy can't reach it.
    const registry = makeRegistry([MODELS[0]]);
    expect(resolveModel(registry, "sonnet")).toBeUndefined();
  });
});

describe("describeAvailableModels", () => {
  it("returns explanatory text when registry is empty", () => {
    expect(describeAvailableModels(makeRegistry([]))).toBe(
      "No models with configured auth.",
    );
  });

  it("lists up to 5 models as provider/id pairs", () => {
    const text = describeAvailableModels(makeRegistry());
    expect(text).toMatch(/^Available: /);
    expect(text).toContain("anthropic/claude-opus-4-6");
    expect(text).toContain("openai/gpt-4o");
  });

  it("appends a '… (N more)' suffix when more than 5 models exist", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      name: `Model ${i}`,
      provider: "p",
    }));
    const text = describeAvailableModels(makeRegistry(many));
    // First 5 listed, 3 more elided
    expect(text).toContain("p/m0");
    expect(text).toContain("p/m4");
    expect(text).not.toContain("p/m5");
    expect(text).toContain("(3 more)");
  });

  it("does not append the 'more' suffix when count is exactly 5", () => {
    const exactly5 = MODELS.slice(0, 5);
    const text = describeAvailableModels(makeRegistry(exactly5));
    expect(text).not.toContain("more");
  });
});

describe("getLastAssistantText", () => {
  // session.messages is the only field we use — the rest of AgentSession is irrelevant.
  function fakeSession(messages: any[]) {
    return { messages } as any;
  }

  it("returns empty string when there are no messages", () => {
    expect(getLastAssistantText(fakeSession([]))).toBe("");
  });

  it("returns empty string when no assistant message exists", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          { role: "user", content: "hi" },
          { role: "toolResult", content: [{ type: "text", text: "ok" }] },
        ]),
      ),
    ).toBe("");
  });

  it("extracts text from a string-content assistant message", () => {
    expect(
      getLastAssistantText(
        fakeSession([{ role: "assistant", content: "hello world" }]),
      ),
    ).toBe("hello world");
  });

  it("concatenates text parts from an array-content assistant message", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          {
            role: "assistant",
            content: [
              { type: "text", text: "part one " },
              { type: "toolCall", name: "bash" },
              { type: "text", text: "part two" },
            ],
          },
        ]),
      ),
    ).toBe("part one part two");
  });

  it("walks backward and returns the most recent assistant message", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          { role: "assistant", content: "first" },
          { role: "user", content: "follow up" },
          { role: "assistant", content: "second" },
        ]),
      ),
    ).toBe("second");
  });

  it("skips assistant messages that contain only tool calls (no text)", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          { role: "assistant", content: "real text" },
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash" }],
          },
        ]),
      ),
    ).toBe("real text");
  });
});

describe("runSubagentOnce", () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockDefaultResourceLoader.mockReset();
  });

  function makeFakeSession() {
    return {
      abort: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn().mockResolvedValue(undefined),
      messages: [],
      bindExtensions: vi.fn(),
    };
  }

  function makeCtx() {
    return {
      cwd: "/tmp",
      modelRegistry: {
        find: () => MODELS[0],
        getAvailable: () => MODELS,
      },
      sessionManager: {
        getSessionId: () => "test",
      },
    } as any;
  }

  it("default: creates subagent with noExtensions=true, noSkills=true, tools=DEFAULT_TOOL_NAMES, no bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id);

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: true, noSkills: true
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.noSkills).toBe(true);

    // Check createAgentSession was called with tools: DEFAULT_TOOL_NAMES
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toEqual(["bash", "read", "edit", "write", "grep", "find", "ls"]);

    // bindExtensions should NOT have been called
    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });

  it("allowExtensions:true: sets noExtensions=false, noSkills=true, tools=undefined, calls bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      allowExtensions: true,
    });

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: false, noSkills: true
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(false);
    expect(loaderOptions.noSkills).toBe(true);

    // Check createAgentSession was called with tools: undefined
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toBeUndefined();

    // bindExtensions should have been called
    expect(fakeSession.bindExtensions).toHaveBeenCalledTimes(1);
  });

  it("allowSkills:true: sets noExtensions=true, noSkills=false, tools=DEFAULT_TOOL_NAMES, no bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      allowSkills: true,
    });

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: true, noSkills: false
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.noSkills).toBe(false);

    // Check createAgentSession was called with tools: DEFAULT_TOOL_NAMES
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toEqual(["bash", "read", "edit", "write", "grep", "find", "ls"]);

    // bindExtensions should NOT have been called
    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });

  it("allowExtensions:true + allowSkills:true: sets noExtensions=false, noSkills=false, tools=undefined, calls bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      allowExtensions: true,
      allowSkills: true,
    });

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: false, noSkills: false
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(false);
    expect(loaderOptions.noSkills).toBe(false);

    // Check createAgentSession was called with tools: undefined
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toBeUndefined();

    // bindExtensions should have been called
    expect(fakeSession.bindExtensions).toHaveBeenCalledTimes(1);
  });
});
