import { Cron } from "croner";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CronJob, CronChangeEvent } from "./types.js";
import type { CronStorage } from "./storage.js";

/**
 * Manages cron job scheduling and execution
 */
export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private readonly storage: CronStorage;
  private readonly pi: ExtensionAPI;

  constructor(storage: CronStorage, pi: ExtensionAPI) {
    this.storage = storage;
    this.pi = pi;
  }

  /**
   * Start the scheduler with all enabled jobs
   */
  start(): void {
    const allJobs = this.storage.getAllJobs();
    for (const job of allJobs) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /**
   * Stop all scheduled jobs
   */
  stop(): void {
    // Stop all cron jobs
    for (const cron of this.jobs.values()) {
      cron.stop();
    }
    this.jobs.clear();

    // Clear all intervals
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  /**
   * Add and schedule a new job
   */
  addJob(job: CronJob): void {
    if (job.enabled) {
      this.scheduleJob(job);
    }
    this.emitChange({ type: "add", job });
  }

  /**
   * Remove and unschedule a job
   */
  removeJob(id: string): void {
    this.unscheduleJob(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  /**
   * Update a job (reschedule if needed)
   */
  updateJob(id: string, updated: CronJob): void {
    this.unscheduleJob(id);
    if (updated.enabled) {
      this.scheduleJob(updated);
    }
    this.emitChange({ type: "update", job: updated });
  }

  /**
   * Get next run time for a job
   */
  getNextRun(jobId: string): Date | null {
    const cron = this.jobs.get(jobId);
    if (cron) {
      const next = cron.nextRun();
      return next || null;
    }
    return null;
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(job: CronJob): void {
    try {
      if (job.type === "interval" && job.intervalMs) {
        // Interval-based scheduling
        const interval = setInterval(() => {
          this.executeJob(job);
        }, job.intervalMs);
        this.intervals.set(job.id, interval);
      } else if (job.type === "once") {
        // One-shot execution at a specific time
        const targetDate = new Date(job.schedule);
        const now = new Date();
        const delay = targetDate.getTime() - now.getTime();

        if (delay > 0) {
          const timeout = setTimeout(() => {
            void this.executeJob(job);
          }, delay);
          // Store as interval for cleanup purposes
          this.intervals.set(job.id, timeout as any);
        } else {
          // Job is in the past - disable it and log warning
          console.warn(`Job ${job.id} (${job.name}) scheduled for past time: ${job.schedule}`);
          this.storage.updateJob(job.id, { 
            enabled: false,
            lastStatus: "error" 
          });
          this.emitChange({ 
            type: "error", 
            jobId: job.id, 
            error: `Scheduled time ${job.schedule} is in the past` 
          });
        }
      } else {
        // Standard cron expression
        const cron = new Cron(job.schedule, () => {
          this.executeJob(job);
        });
        this.jobs.set(job.id, cron);
      }
    } catch (error) {
      console.error(`Failed to schedule job ${job.id}:`, error);
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Unschedule a job
   */
  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }

    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }

  /**
   * Execute a job's prompt
   */
  private async executeJob(job: CronJob): Promise<void> {
    const releaseLock = this.storage.acquireExecutionLock(job.id);
    if (!releaseLock) {
      console.log(`Skipping scheduled prompt already running elsewhere: ${job.name} (${job.id})`);
      return;
    }

    try {
      const currentJob = this.storage.getJob(job.id);
      if (!currentJob || !currentJob.enabled) {
        console.log(`Skipping disabled or removed scheduled prompt: ${job.name} (${job.id})`);
        return;
      }

      if (this.wasRecentlyExecuted(currentJob)) {
        console.log(`Skipping recently executed scheduled prompt: ${job.name} (${job.id})`);
        return;
      }

      console.log(`Executing scheduled prompt: ${currentJob.name} (${currentJob.id})`);

      // Update status to running
      this.storage.updateJob(currentJob.id, {
        lastStatus: "running",
      });
      this.emitChange({ type: "fire", job: currentJob });

      // Send a visible marker message for the scheduled prompt
      this.pi.sendMessage(
        {
          customType: "scheduled_prompt",
          content: [{ type: "text", text: currentJob.prompt }],
          display: true,
          details: { jobId: currentJob.id, jobName: currentJob.name, prompt: currentJob.prompt },
        }
      );

      // Then send the actual prompt to the agent
      this.pi.sendUserMessage(currentJob.prompt, { deliverAs: "followUp" });

      // Update job execution stats from the latest stored job to avoid stale
      // runCount values when multiple pi sessions share the same schedule file.
      const latestJob = this.storage.getJob(currentJob.id) || currentJob;
      const nextRun = this.getNextRun(currentJob.id);
      const updates: Partial<CronJob> = {
        lastRun: new Date().toISOString(),
        lastStatus: "success",
        runCount: latestJob.runCount + 1,
        nextRun: nextRun?.toISOString(),
      };

      if (currentJob.type === "once") {
        updates.enabled = false;
      }

      this.storage.updateJob(currentJob.id, updates);

      if (currentJob.type === "once") {
        this.unscheduleJob(currentJob.id);
        this.emitChange({ type: "update", job: { ...currentJob, ...updates } });
      }

      this.emitChange({ type: "fire", job: currentJob });
    } catch (error) {
      console.error(`Failed to execute job ${job.id}:`, error);
      this.storage.updateJob(job.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "error",
      });
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      releaseLock();
    }
  }

  /**
   * Return true when another scheduler process already dispatched this job's
   * expected run. Interval jobs are considered duplicates when they fire again
   * before most of their interval has elapsed. Cron and one-shot jobs use a
   * short guard window to catch same-tick executions from another pi session.
   */
  private wasRecentlyExecuted(job: CronJob): boolean {
    if (!job.lastRun) {
      return false;
    }

    const lastRunMs = new Date(job.lastRun).getTime();
    if (Number.isNaN(lastRunMs)) {
      return false;
    }

    const elapsedMs = Date.now() - lastRunMs;
    const minSpacingMs = job.type === "interval" && job.intervalMs
      ? Math.max(500, Math.floor(job.intervalMs * 0.9))
      : 900;

    return elapsedMs >= 0 && elapsedMs < minSpacingMs;
  }

  /**
   * Emit a change event via pi.events
   */
  private emitChange(event: CronChangeEvent): void {
    this.pi.events.emit("cron:change", event);
  }

  /**
   * Validate a cron expression (must be 6-field format with seconds)
   */
  static validateCronExpression(expression: string): { valid: boolean; error?: string } {
    // Count fields - must be 6 (second minute hour dom month dow)
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron expression must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 * * * * *" for every minute`,
      };
    }

    try {
      // Try parsing as cron expression
      new Cron(expression, () => {});
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid cron expression",
      };
    }
  }

  /**
   * Parse relative time delta (e.g., "+10s", "+5m", "+1h")
   * Returns ISO timestamp if valid, null otherwise
   */
  static parseRelativeTime(delta: string): string | null {
    const match = delta.match(/^\+(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    const msMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const ms = value * msMap[unit];
    const futureTime = new Date(Date.now() + ms);
    return futureTime.toISOString();
  }

  /**
   * Parse interval string to milliseconds
   */
  static parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  }
}
