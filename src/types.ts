import { type Static, Type } from "typebox";

/**
 * String enum as `{ type: "string", enum: [...] }` (Google-compatible; a union of
 * literals would emit `anyOf`). Same implementation as the `StringEnum` pi's
 * extension view of pi-ai provides at runtime; defined locally because pi-ai's
 * own export (>=1.5) returns a pi-schema type that TypeBox's `Static` can't infer.
 */
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval" | "idle";

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
  /** Duration in milliseconds: the period for `interval`, the idle threshold for `idle` */
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
  /** If set, run the prompt in a separate in-process session under this model when the job fires, instead of injecting it into the current chat. */
  model?: string;
  /** Only for jobs with `model` set. If true, the parent session is woken up to react to the separate session's result. Default false (result lands in chat silently). */
  notify?: boolean;
  /** Only for jobs with `model` set. If true, loads all registered extensions. If an array of package names, only those extensions. Default undefined (none). */
  extensions?: boolean | string[];
  /** Only for jobs with `model` set. If true, loads all skills. If an array of skill names, only those skills. Default undefined (none). */
  skills?: boolean | string[];
  /** Session id this job is bound to. When absent, every pi in the cwd loads it. */
  session?: string;
  /**
   * Fire-once across sessions. Only meaningful for workdir jobs (no `session`):
   * when true, every pi in the cwd loads the job but a per-tick claim file
   * (see `claims.ts`) lets exactly one session execute each scheduled run.
   * Absent/false keeps the historical behavior: every session fires it.
   */
  singleton?: boolean;
  /**
   * Per-job TUI preference for singleton workdir jobs. True (or absent)
   * lets a TUI claim immediately while headless sessions yield; false lets
   * every session claim immediately. Ignored for non-singleton/session jobs.
   */
  singletonPreferTui?: boolean;
  /** Session id that won the last singleton claim (informational). */
  lastClaimBy?: string;
}

/**
 * Persistent storage for cron jobs
 */
export interface CronStore {
  /** Canonical project path the store belongs to. Informational; the file name is the key. */
  cwd?: string;
  /** Set once the project's legacy `<cwd>/.pi/schedule-prompts.json` has been imported. */
  legacyImported?: boolean;
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
    description: "Action to perform. 'cleanup' deletes every disabled job.",
  }),
  name: Type.Optional(
    Type.String({
      description: "Job name, unique among jobs. Auto-generated if omitted.",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Required for add. Format depends on 'type': cron = 6 fields 'sec min hour day month weekday' in local time ('0 */5 * * * *' = every 5 minutes); once = relative '+N' plus s/m/h/d ('+10m', '+2h') or an ISO timestamp at least 5s in the future; interval/idle = N plus s/m/h/d ('30s', '1h'), max 24d. On update, the new schedule must fit the job's existing type.",
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Required for add. The instruction to run when the job fires. Without 'model' it arrives in this chat as a user message, so write it as an instruction to yourself. With 'model' it is the whole task for a session that has no chat history, so include every detail it needs.",
    })
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Job ID from the add or list output. Required for remove, enable, disable and update.",
    })
  ),
  type: Type.Optional(
    StringEnum(["cron", "once", "interval", "idle"], {
      description:
        "Job type; must match the schedule's format. 'cron' (default): recurring, 6-field cron. 'once': a single run at a relative ('+10s') or ISO time. 'interval': repeats every duration ('5m'). 'idle': fires once after the user has been inactive for the duration ('10m') and your current turn has finished; it re-arms only after new user activity. Cannot be changed by update.",
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
        "Optional. When the job fires, run its prompt in a separate session under this model (e.g. 'haiku', 'sonnet', or 'provider/model-id') instead of sending it to this chat. That session works in the same directory with bash/read/edit/write/grep/find/ls, but cannot see this conversation; a snippet of its reply is posted to this chat. Must be a non-empty string; to switch a job back to inline, remove and re-add it without 'model'.",
    })
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        "Only for jobs with 'model' set. If true, the separate session's result is sent to you as a new message so you can react to it. Default false: the result is shown in chat without interrupting you. Use only for low-frequency jobs.",
    })
  ),
  extensions: Type.Optional(
    Type.Union([
      Type.Boolean({
        description:
          "Only for jobs with 'model' set. If true, the separate session loads all registered extensions and the full builtin toolset.",
      }),
      Type.Array(Type.String(), {
        description:
          "Only for jobs with 'model' set. The separate session loads only these extension package names, plus the full builtin toolset.",
      }),
    ])
  ),
  skills: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "Only for jobs with 'model' set. If true, the separate session loads all skills.",
      }),
      Type.Array(Type.String(), {
        description: "Only for jobs with 'model' set. The separate session loads only these skill names.",
      }),
    ])
  ),
  singleton: Type.Optional(
    Type.Boolean({
      description:
        "Only for jobs without a session binding (workdir scope). If true, the job still loads in every pi session in this cwd, but exactly one session executes each scheduled run (per-tick claim file). Default false: every session fires it (may duplicate). Useful for jobs that must run just once per tick, e.g. a digest.",
    })
  ),
  singletonPreferTui: Type.Optional(
    Type.Boolean({
      description:
        "Only for singleton workdir jobs. If true (default), an interactive TUI claims immediately while RPC/headless sessions yield 1.5s so the TUI gets the first opportunity. If false, every session claims immediately and the first claimant of any mode wins. Ignored for non-singleton and session-bound jobs.",
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
