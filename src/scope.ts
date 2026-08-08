import { isAbsolute, resolve } from "node:path";
import type { JobScope } from "./settings.js";
import type { CronJob } from "./types.js";

export const CONFIG_DIR_NAME = ".pi";

export type StoreKind = "project" | "global";

export function canonicalizeCwd(cwd: string): string {
  return resolve(cwd);
}

export function inferJobScope(job: CronJob, storeKind: StoreKind = "project"): JobScope {
  if (storeKind === "global") return "global";
  if (job.scope === "global") return "global";
  if (job.scope === "session" || job.scope === "workdir") return job.scope;
  return job.session ? "session" : "workdir";
}

export function normalizeJob(job: CronJob, storeKind: StoreKind): CronJob {
  const scope = inferJobScope(job, storeKind);
  return {
    ...job,
    scope,
    ...(scope === "global" && job.cwd ? { cwd: canonicalizeCwd(job.cwd) } : {}),
  };
}

export function isInlineGlobalJobEligible(job: CronJob, currentCwd: string): boolean {
  return Boolean(job.model) || (job.cwd !== undefined && canonicalizeCwd(job.cwd) === canonicalizeCwd(currentCwd));
}

export function assertGlobalCwd(cwd: string): string {
  const canonical = canonicalizeCwd(cwd);
  if (!isAbsolute(canonical)) throw new Error("Global jobs require an absolute creator cwd");
  return canonical;
}
