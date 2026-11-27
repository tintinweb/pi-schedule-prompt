import { describe, expect, it, vi } from "vitest";
import type { ScheduleSettings } from "../src/settings.js";
import type { CronJob } from "../src/types.js";
import { runAddFlow } from "../src/ui/add-flow.js";

function harness(options: {
  type?: string;
  scope?: string;
  settings: ScheduleSettings;
}) {
  const inputs = ["demo", "+10s", "do the thing"];
  const scopeOptions: string[][] = [];
  const confirmations: string[] = [];
  const ctx = {
    ui: {
      input: vi.fn(async () => inputs.shift()),
      select: vi.fn(async (title: string, choices: string[]) => {
        if (title === "Job Type") return options.type ?? "Once (one-shot)";
        if (title === "Scope") {
          scopeOptions.push(choices);
          return options.scope ?? choices[0];
        }
        return undefined;
      }),
      confirm: vi.fn(async (_title: string, message: string) => {
        confirmations.push(message);
        return true;
      }),
      notify: vi.fn(),
    },
  } as any;
  const jobs: CronJob[] = [];
  const storage = {
    hasJobWithName: () => false,
    addJob: (job: CronJob) => jobs.push({ ...job }),
  } as any;
  const scheduler = { addJob: () => {} } as any;
  return { ctx, storage, scheduler, jobs, scopeOptions, confirmations };
}

describe("interactive add flow singleton scopes", () => {
  it("uses singleton as the default and persists the configured TUI preference", async () => {
    const h = harness({
      settings: {
        defaultJobScope: "workdir",
        defaultSingleton: true,
        defaultSingletonPreferTui: false,
      },
    });

    await runAddFlow(h.ctx, h.storage, h.scheduler, {
      defaultJobScope: "workdir",
      defaultSingleton: true,
      defaultSingletonPreferTui: false,
    }, "session-A");

    expect(h.scopeOptions[0][0]).toBe("Shared, fire once — one pi in this cwd fires each run");
    expect(h.jobs[0]).toMatchObject({
      session: undefined,
      singleton: true,
      singletonPreferTui: false,
    });
    expect(h.confirmations[0]).toContain("shared, fire once");
  });

  it("preserves an explicit ordinary shared choice despite singleton defaults", async () => {
    const settings = { defaultJobScope: "workdir", defaultSingleton: true } as const;
    const h = harness({
      settings,
      scope: "Shared — every pi in this cwd fires it (accepts duplicate fires)",
    });

    await runAddFlow(h.ctx, h.storage, h.scheduler, settings, "session-A");

    expect(h.jobs[0]).toMatchObject({
      session: undefined,
      singleton: undefined,
      singletonPreferTui: undefined,
    });
    expect(h.confirmations[0]).toContain("Scope: shared (any pi here)");
  });

  it("omits singleton scope for idle jobs even when singleton defaults are enabled", async () => {
    const settings = { defaultJobScope: "workdir", defaultSingleton: true } as const;
    const h = harness({ settings, type: "Idle (after inactivity)" });
    h.ctx.ui.input = vi.fn()
      .mockResolvedValueOnce("idle-demo")
      .mockResolvedValueOnce("10m")
      .mockResolvedValueOnce("maintenance");

    await runAddFlow(h.ctx, h.storage, h.scheduler, settings, "session-A");

    expect(h.scopeOptions[0]).not.toContain("Shared, fire once — one pi in this cwd fires each run");
    expect(h.jobs[0]).toMatchObject({
      type: "idle",
      singleton: undefined,
      singletonPreferTui: undefined,
    });
  });
});
