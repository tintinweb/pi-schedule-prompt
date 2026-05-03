/**
 * CronWidget — displays scheduled prompts below the editor
 *
 * Shows a table with status, name, schedule, next run, last run, and run count
 * Auto-refreshes every 30 seconds to update relative times
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { CronScheduler, formatISOShort, humanizeCron } from "../scheduler.js";
import type { CronStorage } from "../storage.js";

const WIDGET_ID = "schedule-prompts";

/**
 * Format relative time (e.g., "in 5m", "2h ago")
 */
function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const target = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const diff = target - now;
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let timeStr: string;
  if (days > 0) {
    timeStr = `${days}d`;
  } else if (hours > 0) {
    timeStr = `${hours}h`;
  } else if (minutes > 0) {
    timeStr = `${minutes}m`;
  } else {
    timeStr = `${seconds}s`;
  }

  return diff > 0 ? `in ${timeStr}` : `${timeStr} ago`;
}

/**
 * Create and manage the cron widget
 */
export class CronWidget {
  private refreshInterval?: NodeJS.Timeout;
  private ctx?: any;
  private unsubscribe: () => void;

  constructor(
    private storage: CronStorage,
    private scheduler: CronScheduler,
    private pi: ExtensionAPI,
    private isVisible: () => boolean,
    private sessionId: string | undefined = undefined,
  ) {
    // Re-render on add/remove/update/fire/error so the row count, status icons,
    // and counters stay current without waiting for the 30s tick.
    this.unsubscribe = this.pi.events.on("cron:change", () => this.refresh());
  }

  /** Jobs this session loads — same predicate as the scheduler. */
  private loadedJobs() {
    return this.storage
      .getAllJobs()
      .filter((j) => CronScheduler.isLoadedFor(j, this.sessionId));
  }

  show(ctx: any): void {
    this.ctx = ctx;

    if (!this.isVisible() || this.loadedJobs().length === 0) {
      this.hide(ctx);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_ID,
      (_tui: any, theme: any) => ({
        render: (width: number) => this.renderWidget(width, theme),
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );

    // 30s tick re-renders so relative-time labels ("in 5m") update even when
    // nothing else changes. Same path as cron:change-driven refresh.
    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(() => this.refresh(), 30000);
    }
  }

  hide(ctx: any): void {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /** Re-mount the widget against the latest storage state. `show` handles the
   *  visibility / empty-list / first-mount cases uniformly. */
  private refresh(): void {
    if (this.ctx) this.show(this.ctx);
  }

  /**
   * Render the widget content
   */
  private renderWidget(width: number, theme: any): string[] {
    const jobs = this.loadedJobs();

    // Deduplicate jobs by ID (safeguard against rendering issues)
    const uniqueJobs = Array.from(
      new Map(jobs.map(job => [job.id, job])).values()
    );
    
    const container = new Container();
    const borderColor = (s: string) => theme.fg("accent", s);

    // Header
    container.addChild(new DynamicBorder(borderColor));
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Scheduled Prompts")) + theme.fg("dim", ` (${uniqueJobs.length} jobs)`),
        1,
        0
      )
    );
    container.addChild(new Spacer(1));

    // Job rows
    const lines: string[] = [];
    for (const job of uniqueJobs) {
      // Status icon
      let statusIcon: string;
      if (!job.enabled) {
        statusIcon = theme.fg("muted", "✗");
      } else if (job.lastStatus === "running") {
        statusIcon = theme.fg("warning", "⟳");
      } else if (job.lastStatus === "error") {
        statusIcon = theme.fg("error", "!");
      } else {
        statusIcon = theme.fg("success", "✓");
      }

      // Name (max 15 chars for column, pad before coloring)
      const nameRaw = job.name.length > 15 ? job.name.substring(0, 12) + "..." : job.name;
      const namePadded = nameRaw.padEnd(15);
      const nameText = job.enabled ? theme.fg("text", namePadded) : theme.fg("muted", namePadded);

      // Schedule (max 15 chars for column, pad before coloring). The helpers
      // return full strings; we truncate at the column boundary here.
      let scheduleRaw: string;
      if (job.type === "cron") {
        scheduleRaw = humanizeCron(job.schedule);
      } else if (job.type === "once" && job.schedule.includes("T")) {
        scheduleRaw = formatISOShort(job.schedule);
      } else {
        scheduleRaw = job.schedule;
      }
      if (scheduleRaw.length > 15) scheduleRaw = `${scheduleRaw.substring(0, 12)}...`;
      const schedulePadded = scheduleRaw.padEnd(15);
      const scheduleText = theme.fg("dim", schedulePadded);

      // Prompt (max 25 chars, pad before coloring)
      const promptRaw = job.prompt.length > 25 ? job.prompt.substring(0, 22) + "..." : job.prompt;
      const promptPadded = promptRaw.padEnd(25);
      const promptText = theme.fg("dim", promptPadded);

      // Next run (max 10 chars, pad before coloring)
      const nextRun = this.scheduler.getNextRun(job.id);
      const nextRaw = nextRun ? formatRelativeTime(nextRun) : "-";
      const nextPadded = nextRaw.padEnd(10);
      const nextText = nextPadded;

      // Last run (max 10 chars, pad before coloring)
      const lastRaw = job.lastRun ? formatRelativeTime(job.lastRun) : "never";
      const lastPadded = lastRaw.padEnd(10);
      const lastText = job.lastRun ? lastPadded : theme.fg("dim", lastPadded);

      // Run count (pad to 3 chars for alignment)
      const countText = theme.fg("accent", job.runCount.toString().padEnd(3));

      // Model badge (only for jobs that run in a subagent).
      // Trailing "!" marks jobs that wake the parent agent on completion (notify=true).
      const modelBadge = job.model
        ? " " + theme.fg("accent",
            `[${job.model.length > 12 ? job.model.substring(0, 9) + "..." : job.model}${job.notify ? "!" : ""}]`)
        : "";

      // Combine into a row with proper spacing
      lines.push(
        ` ${statusIcon} ${nameText} ${scheduleText} ${promptText} ${nextText} ${lastText} ${countText}${modelBadge}`
      );
    }

    container.addChild(new Text(lines.join("\n"), 1, 0));
    container.addChild(new DynamicBorder(borderColor));

    return container.render(width);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.unsubscribe();
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
