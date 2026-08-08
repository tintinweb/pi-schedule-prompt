import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GlobalCoordinator } from "./global-coordinator.js";
import { CronScheduler } from "./scheduler.js";
import { assertGlobalCwd, canonicalizeCwd, inferJobScope } from "./scope.js";
import type { JobScope } from "./settings.js";
import { CronStorage } from "./storage.js";
import type { CronJob } from "./types.js";

export class CronJobManager {
  readonly projectStorage: CronStorage;
  readonly globalStorage: CronStorage;
  readonly projectScheduler: CronScheduler;
  readonly globalScheduler: CronScheduler;
  readonly coordinator: GlobalCoordinator;

  constructor(
    readonly cwd: string,
    readonly pi: ExtensionAPI,
    readonly ctx: ExtensionContext,
  ) {
    this.projectStorage = CronStorage.forProject(cwd);
    this.globalStorage = CronStorage.global();
    this.projectScheduler = new CronScheduler(this.projectStorage, pi, ctx);
    this.globalScheduler = new CronScheduler(this.globalStorage, pi, ctx, { global: true });
    this.coordinator = new GlobalCoordinator(this.globalStorage, this.globalScheduler, cwd);
  }

  async start(): Promise<void> {
    this.projectScheduler.start();
    await this.coordinator.start();
  }

  async stop(): Promise<void> {
    this.projectScheduler.stop();
    await this.coordinator.stop();
  }

  listVisible(sessionId: string | undefined): CronJob[] {
    const local = this.projectStorage.getAllJobs().filter((job) =>
      job.scope !== "session" || job.session === sessionId,
    );
    return [...local, ...this.globalStorage.getAllJobs()];
  }

  list(scope: JobScope | undefined, sessionId: string | undefined): CronJob[] {
    return this.listVisible(sessionId).filter((job) => !scope || inferJobScope(job, job.scope === "global" ? "global" : "project") === scope);
  }

  getJob(id: string): CronJob | undefined {
    return this.projectStorage.getJob(id) ?? this.globalStorage.getJob(id);
  }

  private owner(job: CronJob): { storage: CronStorage; scheduler: CronScheduler; global: boolean } {
    const global = job.scope === "global" || this.globalStorage.getJob(job.id) !== undefined;
    return global
      ? { storage: this.globalStorage, scheduler: this.globalScheduler, global: true }
      : { storage: this.projectStorage, scheduler: this.projectScheduler, global: false };
  }

  addJob(job: CronJob): void {
    const scope = job.scope ?? (job.session ? "session" : "workdir");
    const prepared: CronJob = scope === "global"
      ? { ...job, scope, session: undefined, cwd: assertGlobalCwd(job.cwd ?? this.cwd) }
      : { ...job, scope, ...(scope === "session" ? { session: job.session } : { session: undefined, cwd: undefined }) };
    if (scope === "global") {
      this.globalStorage.addJob(prepared);
      void this.coordinator.reconcileNow();
    } else {
      this.projectStorage.addJob(prepared);
      this.projectScheduler.addJob(prepared);
    }
  }

  removeJob(id: string): boolean {
    const job = this.getJob(id);
    if (!job) return false;
    const owner = this.owner(job);
    const removed = owner.storage.removeJob(id);
    if (removed) owner.scheduler.removeJob(id);
    if (owner.global) void this.coordinator.reconcileNow();
    return removed;
  }

  updateJob(id: string, changes: Partial<CronJob>): boolean {
    const job = this.getJob(id);
    if (!job) return false;
    if (changes.scope && changes.scope !== (job.scope ?? (job.session ? "session" : "workdir"))) {
      return false;
    }
    const owner = this.owner(job);
    const updated = owner.storage.updateJob(id, changes);
    if (updated) {
      const fresh = owner.storage.getJob(id);
      if (fresh) owner.scheduler.updateJob(id, fresh);
      if (owner.global) void this.coordinator.reconcileNow();
    }
    return updated;
  }

  async moveJob(id: string, targetScope: JobScope, sessionId: string | undefined, currentCwd = this.cwd): Promise<CronJob> {
    const source = this.getJob(id);
    if (!source) throw new Error(`Job not found: ${id}`);
    const old = this.owner(source);
    const wasEnabled = source.enabled;
    const disabled = { ...source, enabled: false };
    old.storage.updateJob(id, { enabled: false });
    old.scheduler.updateJob(id, disabled);
    if (old.global) await this.coordinator.reconcileNow();

    const moved: CronJob = {
      ...source,
      scope: targetScope,
      enabled: wasEnabled,
      session: targetScope === "session" ? sessionId : undefined,
      cwd: targetScope === "global" ? canonicalizeCwd(currentCwd) : undefined,
    };
        const destinationStorage = targetScope === "global" ? this.globalStorage : this.projectStorage;
        try {
          if (destinationStorage === old.storage) {
            old.storage.updateJob(id, moved);
            old.scheduler.updateJob(id, moved);
            return moved;
          }
          destinationStorage.addJob(moved);
          old.storage.removeJob(id);
          old.scheduler.removeJob(id);
          if (targetScope === "global") await this.coordinator.reconcileNow();
          else this.projectScheduler.addJob(moved);
          return moved;
        } catch (error) {
      old.storage.updateJob(id, { enabled: wasEnabled });
      old.scheduler.updateJob(id, { ...source, enabled: wasEnabled });
      if (old.global) await this.coordinator.reconcileNow();
      throw error;
    }
  }

  cleanup(scope: JobScope | undefined, sessionId: string | undefined): CronJob[] {
    const jobs = scope === "global"
      ? this.globalStorage.getAllJobs().filter((job) => !job.enabled)
      : this.projectStorage.getAllJobs().filter((job) => !job.enabled && (scope ? job.scope === scope : job.scope !== "global" && (!job.session || job.session === sessionId)));
    for (const job of jobs) this.removeJob(job.id);
    return jobs;
  }

  getNextRun(id: string): Date | null {
    const job = this.getJob(id);
    if (!job) return null;
    const owner = this.owner(job);
    return owner.scheduler.getNextRun(id) ?? (job.nextRun ? new Date(job.nextRun) : null);
  }
}
