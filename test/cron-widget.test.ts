import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../src/scheduler.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { CronWidget } from "../src/ui/cron-widget.js";

function makeStorage(jobs: CronJob[]): CronStorage {
  return {
    getJob: vi.fn((id: string) => jobs.find((j) => j.id === id)),
    getAllJobs: vi.fn(() => jobs),
    addJob: vi.fn(),
    removeJob: vi.fn(),
    updateJob: vi.fn(),
  } as any;
}

function makeScheduler(_jobs: CronJob[]): CronScheduler {
  return {
    getNextRun: vi.fn(() => null),
    isLoadedFor: vi.fn(() => true),
  } as any;
}

function makePi(): ExtensionAPI {
  return {
    events: { on: vi.fn(() => () => {}) },
  } as any;
}

function makeCtx(): any {
  return {
    ui: {
      setWidget: vi.fn(),
    },
  };
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-1",
    name: "Test Job",
    schedule: "0 * * * * *",
    type: "cron",
    prompt: "say hello",
    enabled: true,
    ...overrides,
  } as CronJob;
}

describe("CronWidget — render", () => {
  it("handles jobs with undefined runCount without crashing", () => {
    const job = exampleJob({ runCount: undefined });
    const storage = makeStorage([job]);
    const scheduler = makeScheduler([job]);
    const pi = makePi();
    const ctx = makeCtx();

    const widget = new CronWidget(storage, scheduler as any, pi, () => true, "test-session");
    widget.show(ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    const widgetFactory = ctx.ui.setWidget.mock.calls[0][1];
    const theme = { fg: () => {}, bold: (s: string) => s, dim: (s: string) => s, error: (s: string) => s, success: (s: string) => s, warning: (s: string) => s, muted: (s: string) => s, accent: (s: string) => s, text: (s: string) => s };
    const widgetImpl = widgetFactory(null, theme);
    expect(() => widgetImpl.render(100)).not.toThrow();
  });
});
