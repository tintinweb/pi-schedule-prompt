/**
 * Lightweight in-process subagent runner.
 *
 * Used when a scheduled job has `model` set: spawn a fresh AgentSession with
 * the chosen model, run the prompt to completion, return the assistant's text.
 * No subprocess, no extension recursion (noExtensions: true), no persistence.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const ABORTED_BEFORE_START = "Subagent aborted before it started";
const DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export type SubagentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface RunSubagentOptions {
  /** If true, load all extensions. If an array, only those named. Default undefined (none). */
  extensions?: boolean | string[];
  /** If true, load all skills. If an array, only those named. Default undefined (none). */
  skills?: boolean | string[];
}

export function resolveModel(
  registry: ExtensionContext["modelRegistry"],
  modelStr: string,
): Model<any> | undefined {
  let fuzzyNeedle = modelStr;
  const slash = modelStr.indexOf("/");
  if (slash !== -1) {
    const provider = modelStr.slice(0, slash);
    const id = modelStr.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    // Slash-form didn't exact-match; fuzzy against the id portion only —
    // matching against "anthropic/haiku" would never find anything since model
    // ids don't include the provider prefix.
    fuzzyNeedle = id;
  }

  const needle = fuzzyNeedle.toLowerCase();
  const candidates = registry.getAvailable();
  return (
    candidates.find((m) => m.id.toLowerCase() === needle) ??
    candidates.find((m) => m.id.toLowerCase().includes(needle)) ??
    candidates.find((m) => m.name.toLowerCase().includes(needle))
  );
}

export function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const parts: string[] = [];
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === "object" && (c as any).type === "text" && (c as any).text) {
          parts.push((c as any).text);
        }
      }
    }
    const text = parts.join("").trim();
    if (text) return text;
  }
  return "";
}

let warnedNoParentRuntime = false;

/**
 * The parent session's ModelRuntime, so the subagent sees the same providers
 * (including ones registered by other extensions) and runtime API keys.
 *
 * pi >=0.80.8 replaced `createAgentSession({ modelRegistry })` with
 * `modelRuntime` and exposes no public accessor for it. `ModelRegistry` wraps
 * the session's runtime in a field that is private only in the TypeScript
 * types (`new ModelRegistry(this._modelRuntime)` in pi's AgentSession), so we
 * read it there. Returns undefined (and warns once) if pi ever renames the
 * field, in which case pi builds a fresh default runtime for the subagent.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  const rt = (ctx.modelRegistry as unknown as { runtime?: Partial<ModelRuntime> }).runtime;
  const looksLikeRuntime =
    typeof rt?.getAuth === "function" &&
    typeof rt.getModel === "function" &&
    typeof rt.hasConfiguredAuth === "function" &&
    typeof rt.registerProvider === "function";
  if (looksLikeRuntime) return rt as ModelRuntime;
  if (!warnedNoParentRuntime) {
    warnedNoParentRuntime = true;
    console.warn(
      "[pi-schedule-prompt] Could not reach the parent session's model runtime; subagent jobs " +
        "fall back to pi's default runtime (auth.json/models.json). Providers registered by " +
        "other extensions and runtime-only API keys will be unavailable to subagents.",
    );
  }
  return undefined;
}

/** Upper bound for each teardown step, so a hung abort or extension shutdown can't wedge the job. */
const TEARDOWN_STEP_TIMEOUT_MS = 5_000;

/** Resolve when `p` settles or after `ms`, whichever comes first. Never rejects. */
async function settleWithin(p: Promise<unknown>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const outcome = await Promise.race([p.then(() => "ok" as const), timeout]);
    if (outcome === "timeout") {
      console.warn(`[pi-schedule-prompt] Subagent ${what} did not finish within ${ms}ms; continuing teardown.`);
    }
  } catch (err) {
    console.warn(`[pi-schedule-prompt] Subagent ${what} failed:`, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tear a finished subagent session down the way pi tears down its own
 * sessions (AgentSessionRuntime.teardownCurrent): settle any in-flight run,
 * let loaded extensions run their `session_shutdown` handlers (MCP servers,
 * child processes, timers), then dispose. `dispose()` alone does not emit
 * `session_shutdown`. The shutdown emit mirrors pi's internal
 * `emitSessionShutdownEvent` (hasHandlers + emit), which pi does not export.
 * Each awaited step is time-bounded and the function never throws, so a
 * successful run's result is always returned.
 */
async function teardownSubagentSession(
  session: AgentSession,
  extensionsLoaded: boolean,
): Promise<void> {
  await settleWithin(session.abort(), TEARDOWN_STEP_TIMEOUT_MS, "abort");
  if (extensionsLoaded) {
    try {
      const runner = session.extensionRunner;
      if (runner.hasHandlers("session_shutdown")) {
        await settleWithin(
          runner.emit({ type: "session_shutdown", reason: "quit" }),
          TEARDOWN_STEP_TIMEOUT_MS,
          "extension shutdown",
        );
      }
    } catch (err) {
      console.warn("[pi-schedule-prompt] Subagent extension shutdown failed:", err);
    }
  }
  try {
    session.dispose();
  } catch (err) {
    console.warn("[pi-schedule-prompt] Subagent session dispose failed:", err);
  }
}

export function describeAvailableModels(
  registry: ExtensionContext["modelRegistry"],
): string {
  const available = registry.getAvailable();
  if (available.length === 0) return "No models with configured auth.";
  const sample = available.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ");
  const more = available.length > 5 ? `, … (${available.length - 5} more)` : "";
  return `Available: ${sample}${more}`;
}

export async function runSubagentOnce(
  ctx: ExtensionContext,
  prompt: string,
  modelStr: string,
  signal?: AbortSignal,
  options: RunSubagentOptions = {},
): Promise<SubagentResult> {
  try {
    const model = resolveModel(ctx.modelRegistry, modelStr);
    if (!model) {
      return {
        ok: false,
        error: `Unknown model '${modelStr}'. ${describeAvailableModels(ctx.modelRegistry)}`,
      };
    }

    const agentDir = getAgentDir();

    // Helper: convert extensions/skills option to boolean and optionally filter.
    // An empty array means "none" — same as unset.
    const isEnabled = (v: boolean | string[] | undefined): boolean =>
      v === true || (Array.isArray(v) && v.length > 0);
    const getNameList = (v: boolean | string[] | undefined): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v : undefined;

    const extList = getNameList(options.extensions);
    const skillList = getNameList(options.skills);

    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      // Prevent recursive loading of this extension into the subagent.
      // Context files (AGENTS.md / CLAUDE.md) are loaded by defaults.
      noExtensions: !isEnabled(options.extensions),
      noSkills: !isEnabled(options.skills),
      noPromptTemplates: true,
      noThemes: true,
      ...(extList && {
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((ext) =>
            extList.some((name) => ext.path.toLowerCase().includes(name.toLowerCase())),
          ),
        }),
      }),
      ...(skillList && {
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) =>
            skillList.includes(skill.name || ""),
          ),
        }),
      }),
    });
    // Skip setup once aborted (e.g. scheduler stopped mid-setup): aborting an
    // idle session records nothing, so prompt() would otherwise still run.
    if (signal?.aborted) return { ok: false, error: ABORTED_BEFORE_START };
    await loader.reload();
    if (signal?.aborted) return { ok: false, error: ABORTED_BEFORE_START };

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir),
      // Share the parent's runtime only when the subagent loads no extensions:
      // extension provider (un)registrations write into whatever runtime the
      // session holds, so a shared one would let subagent extensions rewrite
      // the parent's providers. With extensions loaded, the subagent gets pi's
      // default runtime and its extensions register their own providers.
      // undefined → pi builds its default runtime from agentDir's auth.json/models.json.
      modelRuntime: isEnabled(options.extensions) ? undefined : parentModelRuntime(ctx),
      model,
      tools: isEnabled(options.extensions) ? undefined : DEFAULT_TOOL_NAMES,
      resourceLoader: loader,
    });

    let onAbort: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    // Only extensions that got session_start may get session_shutdown.
    let extensionsBound = false;
    try {
      // Checked before bindExtensions so an aborted job doesn't start (and
      // then shut down) its extensions. Teardown runs in finally.
      if (signal?.aborted) return { ok: false, error: ABORTED_BEFORE_START };
      if (isEnabled(options.extensions)) {
        await session.bindExtensions({});
        extensionsBound = true;
      }
      if (signal) {
        if (signal.aborted) return { ok: false, error: ABORTED_BEFORE_START };
        onAbort = () => {
          session.abort().catch(() => {});
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      let buffered = "";
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "message_start") {
          buffered = "";
        } else if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          buffered += event.assistantMessageEvent.delta;
        }
      });

      await session.prompt(prompt, {
        // An abort during prompt preflight (input hooks, auth check) is lost:
        // pi clears the abort flag when the run starts. Re-apply it then.
        preflightResult: (disposition) => {
          if (disposition === "started" && signal?.aborted) {
            session.abort().catch(() => {});
          }
        },
      });
      // An abort mid-run makes prompt() resolve normally with partial text.
      if (signal?.aborted) return { ok: false, error: "Subagent aborted" };

      const text = buffered.trim() || getLastAssistantText(session);
      return { ok: true, text };
    } finally {
      unsubscribe?.();
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      await teardownSubagentSession(session, extensionsBound);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
