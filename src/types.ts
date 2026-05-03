import { StringEnum } from "@mariozechner/pi-ai";
import type { Static } from "typebox";
import { Type } from "typebox";

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval";

/**
 * Status of the last job execution
 */
export type CronJobStatus = "success" | "error" | "running";

/**
 * A scheduled cron job
 */
export interface CronJob {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron expression, ISO timestamp, or interval description */
  schedule: string;
  /** The prompt to execute */
  prompt: string;
  /** Whether the job is enabled */
  enabled: boolean;
  /** Type of job */
  type: CronJobType;
  /** Interval in milliseconds (for interval type) */
  intervalMs?: number;
  /** When the job was created */
  createdAt: string;
  /** Last execution timestamp */
  lastRun?: string;
  /** Status of last execution */
  lastStatus?: CronJobStatus;
  /** Next scheduled run (computed) */
  nextRun?: string;
  /** Number of times executed */
  runCount: number;
  /** Optional description */
  description?: string;
  /** If set, run the prompt in a separate in-process agent session using this model instead of injecting into the current chat. */
  model?: string;
  /** Subagent jobs only. If true, the parent agent is woken up to react to the subagent's result. Default false (result lands in chat silently). */
  notify?: boolean;
  /** Session id this job is bound to. When absent, every pi in the cwd loads it. */
  session?: string;
}

/**
 * Persistent storage for cron jobs
 */
export interface CronStore {
  jobs: CronJob[];
  version: number;
}

/**
 * Tool result details for LLM context
 */
export interface CronToolDetails {
  action: string;
  jobs: CronJob[];
  error?: string;
  jobId?: string;
  jobName?: string;
}

/**
 * Tool parameter schema
 */
export const CronToolParams = Type.Object({
  action: StringEnum(["add", "remove", "list", "enable", "disable", "update", "cleanup"], {
    description: "Action to perform",
  }),
  name: Type.Optional(
    Type.String({
      description: "Job name, auto-generated if omitted",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Required for add. Cron expression, ISO timestamp, relative time (+10s, +5m), or interval string",
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Required for add. The prompt text to execute",
    })
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Job ID for remove, enable, disable, or update actions",
    })
  ),
  type: Type.Optional(
    StringEnum(["cron", "once", "interval"], {
      description: "Job type. Use 'once' for relative times like '+10s'. Default is cron",
    })
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional job description",
    })
  ),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional. If set, runs the prompt in a separate in-process agent session using this model (e.g. 'haiku', 'sonnet', or 'provider/model-id'). If omitted, the prompt is injected into the current chat. Must be a non-empty string — to switch a job from subagent back to inline mode, remove the job and re-add it without a model.",
    })
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        "Subagent jobs only. If true, the parent agent is nudged to react to the subagent's result. Default false: the result is shown in chat but the parent is not interrupted. Ignored for inline (no-model) jobs, where the prompt itself already wakes the parent. Recommended only for low-frequency jobs.",
    })
  ),
});

export type CronToolParamsType = Static<typeof CronToolParams>;

/**
 * Event emitted when a job is added, removed, or updated
 */
export interface CronChangeEvent {
  type: "add" | "remove" | "update" | "fire" | "error";
  job?: CronJob;
  jobId?: string;
  error?: string;
}
