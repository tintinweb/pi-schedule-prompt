import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { withStoreLock } from "./storage-lock.js";
import { watchStore } from "./store-watcher.js";
import type { CronJob, CronStore } from "./types.js";

const LEGACY_FILE = "schedule-prompts.json";

/**
 * The real path of `cwd`, so a symlinked path and its target share one store.
 * Falls back to the resolved path when it cannot be resolved (e.g. deleted dir).
 */
export function canonicalProjectPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Store key for a project: sha256 of its canonical path (same scheme as pi-subagents' missions). */
export function projectKey(cwd: string): string {
  return createHash("sha256").update(canonicalProjectPath(cwd)).digest("hex");
}

/** Outcome of a legacy-store migration attempt, for the caller to report. */
export type LegacyMigration = "none" | "migrated" | "untrusted" | "failed";

/**
 * Persists scheduled prompts as per-project runtime state in the pi agent dir:
 * `<agentDir>/schedule-prompts/projects/<sha256(realpath(cwd))>.json`.
 *
 * `getAgentDir()` honors `PI_CODING_AGENT_DIR`, so each pi profile has its own
 * store, and the per-project key keeps one project's jobs from loading in
 * another. The project path is written into the file so it can be identified
 * when browsing or hand-editing.
 */
export class CronStorage {
  private readonly storePath: string;
  private readonly storeDir: string;
  private readonly projectPath: string;
  private readonly legacyStorePath: string;

  constructor(cwd: string) {
    this.projectPath = canonicalProjectPath(cwd);
    this.storeDir = path.join(getAgentDir(), "schedule-prompts", "projects");
    this.storePath = path.join(this.storeDir, `${projectKey(cwd)}.json`);
    this.legacyStorePath = path.join(cwd, CONFIG_DIR_NAME, LEGACY_FILE);
  }

  /**
   * One-time import of a pre-0.5 `<cwd>/.pi/schedule-prompts.json`, gated on
   * pi's project-trust decision (`ctx.isProjectTrusted()`). The legacy file is
   * left in place as a backup.
   *
   * The import is recorded as `legacyImported` in the store, not inferred from
   * the store existing: a project that was untrusted at first can gain a store
   * (the user adds a job) and still import its legacy jobs once trusted. Legacy
   * jobs are merged by id, so jobs already in the store win.
   */
  migrateLegacy(trusted: boolean): LegacyMigration {
    if (!fs.existsSync(this.legacyStorePath)) return "none";
    if (!trusted) {
      try {
        // Preserve the no-op result when migration already completed, without
        // creating the agent store directory for an untrusted project.
        if (fs.existsSync(this.storePath)) {
          const current = JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as CronStore;
          if (current.legacyImported) return "none";
        }
        return "untrusted";
      } catch (error) {
        console.error(`Failed to migrate legacy scheduled prompts from ${this.legacyStorePath}:`, error);
        return "failed";
      }
    }
    return withStoreLock(this.storePath, () => {
      try {
        let current: CronStore = { jobs: [], version: 1 };
        if (fs.existsSync(this.storePath)) {
          // Parse directly rather than via load(): a corrupt store must fail the
          // import, not be overwritten with the legacy jobs.
          current = JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as CronStore;
          if (current.legacyImported) return "none";
        }
        const legacy = JSON.parse(fs.readFileSync(this.legacyStorePath, "utf-8")) as Partial<CronStore>;
        if (!Array.isArray(legacy.jobs)) throw new Error("missing jobs array");
        const known = new Set(current.jobs.map((j) => j.id));
        const imported = legacy.jobs.filter((j) => !known.has(j.id));
        this.saveUnlocked({
          ...current,
          version: current.version ?? legacy.version ?? 1,
          jobs: [...current.jobs, ...imported],
          legacyImported: true,
        });
        return "migrated";
      } catch (error) {
        console.error(`Failed to migrate legacy scheduled prompts from ${this.legacyStorePath}:`, error);
        return "failed";
      }
    });
  }

  /**
   * Load scheduled prompts from disk
   */
  load(): CronStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, "utf-8");
        const store = JSON.parse(data) as CronStore;
        return store;
      }
    } catch (error) {
      console.error("Failed to load scheduled prompts:", error);
    }

    // Return empty store if file doesn't exist or is corrupted
    return { jobs: [], version: 1 };
  }

  /**
   * Save scheduled prompts to disk
   */
  save(store: CronStore): void {
    withStoreLock(this.storePath, () => this.saveUnlocked(store));
  }

  /** Caller holds the store mutation lock. */
  private saveUnlocked(store: CronStore): void {
    const tempPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });

      // Atomic rename gives readers a complete old/new snapshot; unique temp
      // names prevent unrelated processes from renaming each other's writes.
      const data: CronStore = {
        cwd: this.projectPath,
        version: store.version,
        ...(store.legacyImported ? { legacyImported: true } : {}),
        jobs: store.jobs,
      };
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tempPath, this.storePath);
    } catch (error) {
      console.error("Failed to save scheduled prompts:", error);
      throw error;
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  /**
   * Check if a job name already exists
   */
  hasJobWithName(name: string): boolean {
    const store = this.load();
    return store.jobs.some((j) => j.name === name);
  }

  /**
   * Add a new job
   */
  addJob(job: CronJob): void {
    withStoreLock(this.storePath, () => {
      const store = this.load();
      store.jobs.push(job);
      this.saveUnlocked(store);
    });
  }

  /**
   * Remove a job by ID
   */
  removeJob(id: string): boolean {
    return withStoreLock(this.storePath, () => {
      const store = this.load();
      const initialLength = store.jobs.length;
      store.jobs = store.jobs.filter((j) => j.id !== id);

      if (store.jobs.length < initialLength) {
        this.saveUnlocked(store);
        return true;
      }
      return false;
    });
  }

  /**
   * Update a job by ID
   */
  updateJob(id: string, partial: Partial<CronJob>): boolean {
    return withStoreLock(this.storePath, () => {
      const store = this.load();
      const job = store.jobs.find((j) => j.id === id);

      if (job) {
        Object.assign(job, partial);
        this.saveUnlocked(store);
        return true;
      }
      return false;
    });
  }

  /** Atomically increment a job's counter and record a successful run. */
  incrementRunCount(id: string, nextRun?: string): boolean {
    return withStoreLock(this.storePath, () => {
      const store = this.load();
      const job = store.jobs.find((candidate) => candidate.id === id);
      if (!job) return false;
      job.runCount = (job.runCount ?? 0) + 1;
      job.lastRun = new Date().toISOString();
      job.lastStatus = "success";
      job.nextRun = nextRun;
      this.saveUnlocked(store);
      return true;
    });
  }

  /**
   * Get a single job by ID
   */
  getJob(id: string): CronJob | undefined {
    const store = this.load();
    return store.jobs.find((j) => j.id === id);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): CronJob[] {
    const store = this.load();
    return store.jobs;
  }

  /**
   * Get storage file path
   */
  getStorePath(): string {
    return this.storePath;
  }

  /** Notify after this store is atomically replaced by any pi session. */
  watch(onChange: () => void, onError?: (error: unknown) => void): () => void {
    return watchStore(this.storePath, onChange, onError);
  }
}
