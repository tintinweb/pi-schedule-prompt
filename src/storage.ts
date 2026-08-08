import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, normalizeJob, type StoreKind } from "./scope.js";
import type { CronJob, CronStore } from "./types.js";

const STORE_FILE = "schedule-prompts.json";
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  update: 3_000,
  retries: { retries: 8, minTimeout: 10, maxTimeout: 100 },
};
const SYNC_LOCK_OPTIONS = { ...LOCK_OPTIONS, retries: 0 };

function acquireSyncLock(storePath: string): () => void {
  for (let attempt = 0; ; attempt++) {
    try {
      return lockfile.lockSync(storePath, SYNC_LOCK_OPTIONS);
    } catch (error: any) {
      if (error?.code !== "ELOCKED" || attempt >= 8) throw error;
      const waitMs = Math.min(100, 10 * 2 ** attempt);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export class DuplicateJobNameError extends Error {
  constructor(name: string) {
    super(`A job named "${name}" already exists.`);
    this.name = "DuplicateJobNameError";
  }
}

/** Persistent, atomically-written cron store. Mutations are serialized by a sidecar lock. */
export class CronStorage {
  private readonly storePath: string;
  private readonly kind: StoreKind;
  private readonly parentDir: string;

  constructor(location: string, kind: StoreKind = "project") {
    this.kind = kind;
    this.storePath = kind === "global"
      ? path.join(location, STORE_FILE)
      : path.join(location, CONFIG_DIR_NAME, STORE_FILE);
    this.parentDir = path.dirname(this.storePath);
  }

  static forProject(cwd: string): CronStorage {
    return new CronStorage(cwd, "project");
  }

  static global(): CronStorage {
    return new CronStorage(getAgentDir(), "global");
  }

  getStoreKind(): StoreKind {
    return this.kind;
  }

  load(): CronStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const store = JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as CronStore;
        return {
          version: store.version ?? 1,
          jobs: Array.isArray(store.jobs)
            ? store.jobs.map((job) => normalizeJob(job, this.kind))
            : [],
        };
      }
    } catch (error) {
      console.error("Failed to load scheduled prompts:", error);
    }
    return { jobs: [], version: 1 };
  }

  save(store: CronStore): void {
    this.mutateStore((current) => {
      current.version = store.version;
      current.jobs = store.jobs;
    });
  }

  private mutateStore<T>(mutator: (store: CronStore) => T): T {
    fs.mkdirSync(this.parentDir, { recursive: true });
    const release = acquireSyncLock(this.storePath);
    try {
      const store = this.load();
      const result = mutator(store);
      const tempPath = `${this.storePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
      fs.renameSync(tempPath, this.storePath);
      return result;
    } finally {
      release();
    }
  }

  hasJobWithName(name: string): boolean {
    return this.load().jobs.some((job) => job.name === name);
  }

  addJob(job: CronJob): void {
    this.mutateStore((store) => {
      if (store.jobs.some((existing) => existing.name === job.name)) {
        throw new DuplicateJobNameError(job.name);
      }
      store.jobs.push(normalizeJob(job, this.kind));
    });
  }

  removeJob(id: string): boolean {
    return this.mutateStore((store) => {
      const initialLength = store.jobs.length;
      store.jobs = store.jobs.filter((job) => job.id !== id);
      return store.jobs.length < initialLength;
    });
  }

  updateJob(id: string, partial: Partial<CronJob>): boolean {
    return this.mutateStore((store) => {
      const job = store.jobs.find((candidate) => candidate.id === id);
      if (!job) return false;
      if (partial.name && store.jobs.some((candidate) => candidate.id !== id && candidate.name === partial.name)) {
        throw new DuplicateJobNameError(partial.name);
      }
      Object.assign(job, partial);
      return true;
    });
  }

  getJob(id: string): CronJob | undefined {
    return this.load().jobs.find((job) => job.id === id);
  }

  getAllJobs(): CronJob[] {
    return this.load().jobs;
  }

  getStorePath(): string {
    return this.storePath;
  }
}
