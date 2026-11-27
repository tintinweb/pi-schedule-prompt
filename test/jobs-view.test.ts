import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../src/types.js";
import { JobsView } from "../src/ui/jobs-view.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "0 0 9 * * *",
    prompt: "run",
    enabled: true,
    type: "cron",
    createdAt: new Date().toISOString(),
    runCount: 0,
    session: "session-A",
    ...overrides,
  };
}

function harness(seed: CronJob) {
  let stored = { ...seed };
  const storage = {
    getAllJobs: () => [{ ...stored }],
    updateJob: (_id: string, partial: Partial<CronJob>) => {
      Object.assign(stored, partial);
      return true;
    },
  } as any;
  const scheduler = {
    onUserPresent: vi.fn(),
    updateJob: vi.fn(),
  } as any;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const view = new JobsView(
    storage,
    scheduler,
    "session-A",
    async () => {},
    theme,
    () => {},
    () => {},
  );
  return { view, stored: () => stored };
}

describe("JobsView scope cycling", () => {
  it("cycles supported jobs session → shared → singleton → session", () => {
    const h = harness(job());

    h.view.handleInput("s");
    expect(h.stored()).toMatchObject({ session: undefined, singleton: false });
    h.view.handleInput("s");
    expect(h.stored()).toMatchObject({ session: undefined, singleton: true });
    h.view.handleInput("s");
    expect(h.stored()).toMatchObject({ session: "session-A", singleton: undefined });
  });

  it("cycles idle jobs only between session and ordinary shared scope", () => {
    const h = harness(job({ type: "idle", schedule: "10m", intervalMs: 600_000 }));

    h.view.handleInput("s");
    expect(h.stored()).toMatchObject({ session: undefined, singleton: false });
    h.view.handleInput("s");
    expect(h.stored()).toMatchObject({ session: "session-A", singleton: undefined });
  });
});
