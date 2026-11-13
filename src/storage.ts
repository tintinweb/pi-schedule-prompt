import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import type { CronJob, CronStore } from "./types.js";

/**
 * Persists scheduled prompts in the active pi agent directory.
 *
 * The agent dir is pi's configured profile directory (`getAgentDir()`, which
 * honors PI_CODING_AGENT_DIR) and is therefore scoped per profile. Hardcoding
 * <cwd>/.pi ignored that setting and mixed schedules from different profiles
 * that share a working directory.
 *
 * The constructor still accepts `cwd` for one-time migration of a legacy
 * <cwd>/.pi/schedule-prompts.json store.
 */
export class CronStorage {
  private readonly storePath: string;
  private readonly piDir: string;
  private readonly legacyStorePath: string;

  constructor(cwd: string) {
    this.piDir = getAgentDir();
    this.storePath = path.join(this.piDir, "schedule-prompts.json");
    this.legacyStorePath = path.join(cwd, ".pi", "schedule-prompts.json");
  }

  /**
   * Copy a legacy project-local store into the agent dir the first time the
   * new store is absent. The legacy file is left in place as a backup.
   */
  private migrateLegacyStore(): void {
    if (fs.existsSync(this.storePath)) return;
    if (!fs.existsSync(this.legacyStorePath)) return;

    try {
      fs.mkdirSync(this.piDir, { recursive: true });
      fs.copyFileSync(this.legacyStorePath, this.storePath);
    } catch (error) {
      // Do not fail the session if migration fails; load() will report the
      // empty store below and the caller can still create new jobs.
      console.error("Failed to migrate legacy scheduled prompts:", error);
    }
  }

  /**
   * Load scheduled prompts from the agent dir, migrating a legacy store once
   * when the agent-dir file does not exist yet.
   */
  load(): CronStore {
    this.migrateLegacyStore();

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
    try {
      // Ensure the agent dir exists
      if (!fs.existsSync(this.piDir)) {
        fs.mkdirSync(this.piDir, { recursive: true });
      }

      // Write atomically using temp file
      const tempPath = `${this.storePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
      fs.renameSync(tempPath, this.storePath);
    } catch (error) {
      console.error("Failed to save scheduled prompts:", error);
      throw error;
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
    const store = this.load();
    store.jobs.push(job);
    this.save(store);
  }

  /**
   * Remove a job by ID
   */
  removeJob(id: string): boolean {
    const store = this.load();
    const initialLength = store.jobs.length;
    store.jobs = store.jobs.filter((j) => j.id !== id);

    if (store.jobs.length < initialLength) {
      this.save(store);
      return true;
    }
    return false;
  }

  /**
   * Update a job by ID
   */
  updateJob(id: string, partial: Partial<CronJob>): boolean {
    const store = this.load();
    const job = store.jobs.find((j) => j.id === id);

    if (job) {
      Object.assign(job, partial);
      this.save(store);
      return true;
    }
    return false;
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
   * Get the agent-dir storage file path
   */
  getStorePath(): string {
    return this.storePath;
  }
}
