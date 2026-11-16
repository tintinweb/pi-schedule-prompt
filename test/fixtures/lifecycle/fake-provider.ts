// Fake model provider for lifecycle integration tests. Shared by the probe
// extension (loaded by pi's own loader) and the test's parent runtime; both
// write to one globalThis log so the test can see what pi actually did.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export function probeLog(): string[] {
  const g = globalThis as any;
  if (!g.__piSchedulePromptProbe) g.__piSchedulePromptProbe = [];
  return g.__piSchedulePromptProbe;
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function streamSimple(model: any) {
  probeLog().push("model_called");
  const stream = createAssistantMessageEventStream();
  const message: any = {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message } as any);
    stream.push({ type: "done", reason: "stop", message } as any);
    stream.end();
  });
  return stream;
}

export const fakeProviderConfig: any = {
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
  streamSimple,
};
