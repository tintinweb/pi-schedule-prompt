// Fake model provider for the MCP integration test. First call: issue a real
// toolCall for the probe server's tool. Second call: report whether the tool
// result reached the model and what it said — "echo-ok" only when the MCP
// server answered, "echo-failed:…" when pi rejected the call (no native MCP).
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const TOOL_NAME = "mcp__probe__echo";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function emit(model, content, stopReason) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
  });
  return stream;
}

function textResultFor(context, toolName) {
  for (const message of context.messages) {
    if (message.role !== "toolResult" || message.toolName !== toolName) continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return undefined;
}

export const mcpFakeProviderConfig = {
  baseUrl: "http://127.0.0.1:9",
  apiKey: "dummy",
  api: "fake-api",
  models: [
    {
      id: "m",
      name: "m",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8000,
      maxTokens: 100,
    },
  ],
  streamSimple(model, context) {
    const result = textResultFor(context, TOOL_NAME);
    if (result !== undefined) {
      return emit(
        model,
        [{ type: "text", text: result === "echo:hi" ? "echo-ok" : `echo-failed:${result}` }],
        "stop",
      );
    }
    return emit(
      model,
      [{ type: "toolCall", id: "call_probe_1", name: TOOL_NAME, arguments: { text: "hi" } }],
      "toolUse",
    );
  },
};
