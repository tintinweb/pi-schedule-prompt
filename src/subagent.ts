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
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export type SubagentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface RunSubagentOptions {
  /** If true, load extensions and skills in the subagent. Default false. */
  allowExtensions?: boolean;
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
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      // Critical: prevent this very extension (and any other) from re-loading
      // recursively into the subagent and starting another scheduler.
      // Context files (AGENTS.md / CLAUDE.md) are loaded by the loader's defaults
      // so the subagent picks up project conventions.
      // When allowExtensions is true, extensions and skills are loaded so the
      // subagent has access to Telegram, MCP tools, skill files, etc.
      noExtensions: !options.allowExtensions,
      noSkills: !options.allowExtensions,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir),
      modelRegistry: ctx.modelRegistry,
      model,
      tools: options.allowExtensions ? undefined : DEFAULT_TOOL_NAMES,
      resourceLoader: loader,
    });

    if (options.allowExtensions) {
      await session.bindExtensions({});
    }
    let onAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        session.abort();
      } else {
        onAbort = () => session.abort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let buffered = "";
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_start") {
        buffered = "";
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        buffered += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe();
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    const text = buffered.trim() || getLastAssistantText(session);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
