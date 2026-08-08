import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { CronJobManager } from "../manager.js";
import { CronScheduler } from "../scheduler.js";
import type { CronJob } from "../types.js";

 type ConfirmState = { kind: "remove"; id: string; name: string } | { kind: "cleanup"; count: number };
const NAME_W = 18;
const SCHED_W = 16;
const PROMPT_W = 30;
function truncate(s: string, n: number): string { return s.length > n ? `${s.substring(0, n - 3)}...` : s; }

export class JobsView implements Component {
  private mine: CronJob[] = [];
  private global: CronJob[] = [];
  private foreign: CronJob[] = [];
  private selectedIndex = 0;
  private confirm: ConfirmState | null = null;

  constructor(
    private readonly manager: CronJobManager,
    private readonly mySessionId: string | undefined,
    private readonly runAdd: () => Promise<void>,
    private readonly theme: any,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) { this.refresh(); }

  invalidate(): void {}

  private refresh(): void {
    const all = this.manager.listVisible(this.mySessionId);
    this.mine = all.filter((job) => job.scope !== "global" && (!job.session || job.session === this.mySessionId));
    this.global = all.filter((job) => job.scope === "global");
    this.foreign = this.manager.projectStorage.getAllJobs().filter((job) => job.session && job.session !== this.mySessionId);
    const max = Math.max(0, this.mine.length + this.global.length + this.foreign.length - 1);
    if (this.selectedIndex > max) this.selectedIndex = max;
  }

  private selectedJob(): CronJob | undefined {
    if (this.selectedIndex < this.mine.length) return this.mine[this.selectedIndex];
    const globalIndex = this.selectedIndex - this.mine.length;
    if (globalIndex < this.global.length) return this.global[globalIndex];
    return this.foreign[globalIndex - this.global.length];
  }

  private selectedGroup(): "mine" | "global" | "foreign" {
    if (this.selectedIndex < this.mine.length) return "mine";
    if (this.selectedIndex < this.mine.length + this.global.length) return "global";
    return "foreign";
  }

  handleInput(data: string): void { this.confirm ? this.handleConfirmInput(data) : this.handleNormalInput(data); }

  private handleConfirmInput(data: string): void {
    if (matchesKey(data, "y")) {
      if (this.confirm?.kind === "remove") this.manager.removeJob(this.confirm.id);
      else if (this.confirm?.kind === "cleanup") this.manager.cleanup(undefined, this.mySessionId);
      this.confirm = null; this.refresh(); this.requestRender(); return;
    }
    if (matchesKey(data, "n") || matchesKey(data, "escape")) { this.confirm = null; this.requestRender(); }
  }

  private handleNormalInput(data: string): void {
    if (matchesKey(data, "q") || matchesKey(data, "escape")) { this.done(); return; }
    const max = this.mine.length + this.global.length + this.foreign.length - 1;
    if (matchesKey(data, "up")) { if (this.selectedIndex > 0) this.selectedIndex--; return; }
    if (matchesKey(data, "down")) { if (this.selectedIndex < max) this.selectedIndex++; return; }
    if (matchesKey(data, "a")) { this.runAdd().finally(() => { this.refresh(); this.requestRender(); }); return; }
    const job = this.selectedJob();
    if (!job) return;
    const group = this.selectedGroup();
    if (matchesKey(data, "t") && group !== "foreign") { this.manager.updateJob(job.id, { enabled: !job.enabled }); this.refresh(); return; }
    if (matchesKey(data, "s") && group !== "foreign") {
      const next = job.scope === "session" ? "workdir" : job.scope === "workdir" ? "global" : "session";
      void this.manager.moveJob(job.id, next, this.mySessionId).then(() => { this.refresh(); this.requestRender(); }).catch((error) => console.error("[pi-schedule-prompt] scope migration failed:", error));
      return;
    }
    if (matchesKey(data, "x") && group !== "foreign") { this.confirm = { kind: "remove", id: job.id, name: job.name }; return; }
    if (matchesKey(data, "c")) {
      const count = this.mine.filter((item) => !item.enabled).length;
      if (count) this.confirm = { kind: "cleanup", count };
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const total = this.mine.length + this.global.length + this.foreign.length;
    const rule = this.theme.fg("dim", "─".repeat(Math.max(1, width)));
    lines.push(rule);
    if (this.confirm?.kind === "remove") lines.push(this.theme.fg("warning", ` Remove "${this.confirm.name}"? (y/n)`));
    else if (this.confirm?.kind === "cleanup") lines.push(this.theme.fg("warning", ` Remove ${this.confirm.count} disabled job(s)? (y/n)`));
    else lines.push(` ${this.theme.fg("accent", this.theme.bold("Jobs"))}  —  ↑↓ select   a add   t toggle   s scope   x remove   c cleanup   q quit`);
    lines.push(rule);
    if (!total) { lines.push("", "  No scheduled prompts. Press `a` to add one or `q` to quit.", "", rule); return lines; }
    this.mine.forEach((job, index) => { lines.push(this.formatRow(job, index, false)); });
    if (this.global.length) {
      lines.push("", this.theme.fg("dim", "  Global jobs:"));
      this.global.forEach((job, index) => { lines.push(this.formatRow(job, this.mine.length + index, false)); });
    }
    if (this.foreign.length) {
      lines.push("", this.theme.fg("dim", "  Other sessions (read-only):"));
      this.foreign.forEach((job, index) => { lines.push(this.formatRow(job, this.mine.length + this.global.length + index, true)); });
    }
    const selected = this.selectedJob();
    if (selected) {
      lines.push(rule);
      const next = this.manager.getNextRun(selected.id);
      const meta = [`Scope: ${selected.scope ?? (selected.session ? "session" : "workdir")}`, `Type: ${selected.type}`, next ? `Next: ${next.toISOString()}` : null, selected.lastRun ? `Last: ${selected.lastRun}` : null, `Runs: ${selected.runCount}`].filter(Boolean).join("   ");
      lines.push(this.theme.fg("dim", ` Selected: ${selected.name} (${selected.id})`));
      lines.push(this.theme.fg("dim", ` ${meta}`));
      if (selected.cwd) lines.push(this.theme.fg("dim", ` Creator cwd: ${selected.cwd}`));
      lines.push(this.theme.fg("dim", ` Prompt: ${truncate(selected.prompt, 200)}`));
    }
    lines.push(rule); return lines;
  }

  private formatRow(job: CronJob, index: number, foreign: boolean): string {
    const indicator = index === this.selectedIndex ? "▶" : " ";
    const icon = !job.enabled ? "✗" : job.lastStatus === "error" ? "!" : job.lastStatus === "running" ? "⟳" : "✓";
    const name = truncate(job.name, NAME_W).padEnd(NAME_W);
    const schedule = truncate(CronScheduler.describeSchedule(job.type, job.schedule), SCHED_W).padEnd(SCHED_W);
    const prompt = truncate(job.prompt, PROMPT_W).padEnd(PROMPT_W);
    const scope = job.scope === "global" ? " [global]" : job.scope === "workdir" || (!job.scope && !job.session) ? " [workdir]" : " [session]";
    return ` ${indicator} ${foreign ? icon : this.theme.fg(job.enabled ? "success" : "muted", icon)} ${name}  ${schedule}  ${prompt}${this.theme.fg("dim", scope)}`;
  }
}
