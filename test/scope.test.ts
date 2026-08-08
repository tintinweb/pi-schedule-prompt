import { describe, expect, it } from "vitest";
import { inferJobScope, isInlineGlobalJobEligible } from "../src/scope.js";
import type { CronJob } from "../src/types.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "j", name: "job", schedule: "0 * * * * *", prompt: "hi", enabled: true,
    type: "cron", createdAt: "2026-01-01T00:00:00Z", runCount: 0, ...overrides,
  };
}

describe("job scopes", () => {
  it("infers legacy session jobs", () => {
    expect(inferJobScope(job({ session: "s" }), "project")).toBe("session");
  });
  it("infers legacy workdir jobs", () => {
    expect(inferJobScope(job(), "project")).toBe("workdir");
  });
  it("treats every global-store job as global", () => {
    expect(inferJobScope(job(), "global")).toBe("global");
  });
  it("accepts explicit global scope", () => {
    expect(inferJobScope(job({ scope: "global" }), "project")).toBe("global");
  });
  it("limits inline global jobs to creator cwd", () => {
    const global = job({ scope: "global", cwd: "/tmp/project" });
    expect(isInlineGlobalJobEligible(global, "/tmp/project")).toBe(true);
    expect(isInlineGlobalJobEligible(global, "/tmp/other")).toBe(false);
  });
  it("allows global subagents from any cwd", () => {
    expect(isInlineGlobalJobEligible(job({ scope: "global", cwd: "/tmp/project", model: "haiku" }), "/tmp/other")).toBe(true);
  });
});
