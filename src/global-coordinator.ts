import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { CronScheduler } from "./scheduler.js";
import { isInlineGlobalJobEligible } from "./scope.js";
import type { CronStorage } from "./storage.js";
import type { CronJob } from "./types.js";

export interface GlobalCoordinatorOptions {
  pollMs?: number;
  staleMs?: number;
  updateMs?: number;
  lockDir?: string;
}

type Release = () => Promise<void>;

export class GlobalCoordinator {
  private readonly owned = new Map<string, { release: Release; fingerprint: string }>();
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private stopped = false;
  private readonly options: Required<GlobalCoordinatorOptions>;

  constructor(
    private readonly storage: CronStorage,
    private readonly scheduler: CronScheduler,
    private readonly cwd: string,
    options: GlobalCoordinatorOptions = {},
  ) {
    this.options = {
      pollMs: options.pollMs ?? 2_000,
      staleMs: options.staleMs ?? 15_000,
      updateMs: options.updateMs ?? 5_000,
      lockDir: options.lockDir ?? path.join(getAgentDir(), "schedule-prompts-locks"),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    fs.mkdirSync(this.options.lockDir, { recursive: true });
    await this.reconcileNow();
    this.timer = setInterval(() => void this.reconcileNow(), this.options.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const jobId of [...this.owned.keys()]) await this.releaseJob(jobId);
    this.scheduler.stop();
  }

  async reconcileNow(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      const jobs = this.storage.getAllJobs();
      const byId = new Map(jobs.map((job) => [job.id, job]));
      for (const [jobId] of this.owned) {
        const job = byId.get(jobId);
        if (!job?.enabled || !this.isEligible(job)) await this.releaseJob(jobId);
      }
      for (const job of jobs) {
        if (!job.enabled || !this.isEligible(job)) continue;
        const current = this.owned.get(job.id);
        if (current) {
          const nextFingerprint = executionFingerprint(job);
          if (current.fingerprint !== nextFingerprint) {
            this.scheduler.updateJob(job.id, job);
            current.fingerprint = nextFingerprint;
          }
          continue;
        }
        await this.tryAcquire(job);
      }
    } finally {
      this.reconciling = false;
    }
  }

  ownedJobIds(): string[] {
    return [...this.owned.keys()];
  }

  private isEligible(job: CronJob): boolean {
    return isInlineGlobalJobEligible(job, this.cwd);
  }

  private async tryAcquire(job: CronJob): Promise<void> {
    const target = path.join(this.options.lockDir, job.id);
    try {
      const release = await lockfile.lock(target, {
        realpath: false,
        stale: this.options.staleMs,
        update: this.options.updateMs,
        retries: 0,
        onCompromised: (error) => this.loseOwnership(job.id, error),
      });
      if (this.stopped) {
        await release();
        return;
      }
      const current = this.storage.getJob(job.id);
      if (!current?.enabled || !this.isEligible(current)) {
        await release();
        return;
      }
      this.owned.set(job.id, { release, fingerprint: executionFingerprint(current) });
      this.scheduler.addJob(current);
    } catch {
      // Another healthy Pi owns this job, or the lock is temporarily unavailable.
    }
  }

  private loseOwnership(jobId: string, _error: Error): void {
    this.scheduler.removeJob(jobId);
    this.scheduler.abortJob(jobId);
    this.owned.delete(jobId);
  }

  private releaseJob(jobId: string): Promise<void> {
    const entry = this.owned.get(jobId);
    if (!entry) return Promise.resolve();
    this.scheduler.removeJob(jobId);
    this.scheduler.abortJob(jobId);
    this.owned.delete(jobId);
    return entry.release().catch(() => undefined);
  }
}

export function executionFingerprint(job: CronJob): string {
  return JSON.stringify({
    schedule: job.schedule,
    type: job.type,
    intervalMs: job.intervalMs,
    enabled: job.enabled,
    prompt: job.prompt,
    name: job.name,
    model: job.model,
    notify: job.notify,
    extensions: job.extensions,
    skills: job.skills,
    scope: job.scope,
    cwd: job.cwd,
    session: job.session,
  });
}
