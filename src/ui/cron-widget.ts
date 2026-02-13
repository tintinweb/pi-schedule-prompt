/**
 * CronWidget — displays scheduled prompts below the editor
 *
 * Shows a table with status, name, schedule, next run, last run, and run count
 * Auto-refreshes every 30 seconds to update relative times
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer } from "@mariozechner/pi-tui";
import type { CronStorage } from "../storage.js";
import type { CronScheduler } from "../scheduler.js";
import type { CronJob } from "../types.js";

const WIDGET_ID = "schedule-prompts";

/**
 * Format relative time (e.g., "in 5m", "2h ago")
 */
function formatRelativeTime(date: Date | string): string {
  const now = new Date().getTime();
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
 * Convert cron expression to human-readable text
 */
function humanizeCron(expression: string): string {
  // Common patterns (6-field format)
  const patterns: Record<string, string> = {
    '* * * * * *': 'every second',
    '0 * * * * *': 'every minute',
    '0 */5 * * * *': 'every 5 min',
    '0 */10 * * * *': 'every 10 min',
    '0 */15 * * * *': 'every 15 min',
    '0 */30 * * * *': 'every 30 min',
    '0 0 * * * *': 'every hour',
    '0 0 */2 * * *': 'every 2 hours',
    '0 0 */3 * * *': 'every 3 hours',
    '0 0 */6 * * *': 'every 6 hours',
    '0 0 0 * * *': 'daily',
    '0 0 0 * * 0': 'weekly',
    '0 0 0 1 * *': 'monthly',
    '0 0 9 * * 1-5': '9am weekdays',
    '0 0 0 * * 1-5': 'weekdays',
    '0 0 0 * * 0,6': 'weekends',
  };

  // Check exact match first
  const normalized = expression.trim();
  if (patterns[normalized]) {
    return patterns[normalized];
  }

  // Parse */N patterns for minutes/hours
  const match = normalized.match(/^0 \*\/(\d+) \* \* \* \*$/);
  if (match) {
    return `every ${match[1]} min`;
  }

  const hourMatch = normalized.match(/^0 0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) {
    return `every ${hourMatch[1]}h`;
  }

  // Specific time pattern (0 0 HH * * *)
  const timeMatch = normalized.match(/^0 0 (\d+) \* \* \*$/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    return `daily at ${hour}:00`;
  }

  // Fallback to truncated expression
  return normalized.length > 15 ? normalized.substring(0, 12) + '...' : normalized;
}

/**
 * Format ISO timestamp to short readable format (e.g., "Feb 13 15:30")
 */
function formatISOShort(iso: string): string {
  try {
    const date = new Date(iso);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  } catch {
    // Fallback if parsing fails
    return iso.length > 18 ? iso.substring(0, 15) + '...' : iso;
  }
}

/**
 * Create and manage the cron widget
 */
export class CronWidget {
  private refreshInterval?: NodeJS.Timeout;
  private invalidateFn?: () => void;

  constructor(
    private storage: CronStorage,
    private scheduler: CronScheduler,
    private pi: ExtensionAPI,
    private isVisible: () => boolean
  ) {
    // Listen for cron changes to refresh widget
    this.pi.events.on("cron:change", () => {
      this.refresh();
    });
  }

  /**
   * Show the widget
   */
  show(ctx: any): void {
    // Respect visibility setting
    if (!this.isVisible()) {
      this.hide(ctx);
      return;
    }

    // Auto-hide if no jobs configured
    const jobs = this.storage.getAllJobs();
    if (jobs.length === 0) {
      this.hide(ctx);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_ID,
      (tui: any, theme: any) => {
        const component = {
          render: (width: number) => this.renderWidget(width, theme),
          invalidate: () => {
            this.invalidateFn = () => {
              if (ctx.ui) {
                this.show(ctx);
              }
            };
          },
        };

        // Auto-refresh every 30 seconds
        if (this.refreshInterval) {
          clearInterval(this.refreshInterval);
        }
        this.refreshInterval = setInterval(() => {
          if (this.invalidateFn) {
            this.invalidateFn();
          }
        }, 30000);

        return component;
      },
      { placement: "belowEditor" }
    );
  }

  /**
   * Hide the widget
   */
  hide(ctx: any): void {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /**
   * Refresh the widget display
   */
  private refresh(): void {
    if (this.invalidateFn) {
      this.invalidateFn();
    }
  }

  /**
   * Render the widget content
   */
  private renderWidget(width: number, theme: any): string[] {
    const jobs = this.storage.getAllJobs();
    
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

      // Schedule (max 15 chars for column, pad before coloring)
      let scheduleRaw: string;
      if (job.type === "cron") {
        scheduleRaw = humanizeCron(job.schedule);
      } else if (job.type === "once" && job.schedule.includes("T")) {
        // Format ISO timestamps
        scheduleRaw = formatISOShort(job.schedule);
      } else {
        // For intervals and relative times, show as-is
        scheduleRaw = job.schedule.length > 15 ? job.schedule.substring(0, 12) + "..." : job.schedule;
      }
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

      // Combine into a row with proper spacing
      lines.push(
        ` ${statusIcon} ${nameText} ${scheduleText} ${promptText} ${nextText} ${lastText} ${countText}`
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
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
