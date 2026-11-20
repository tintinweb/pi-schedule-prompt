/**
 * Keeps a host from evicting an idle session while it has scheduled work.
 *
 * pi-web closes a session after a period without a browser renewing it; that
 * fires `session_shutdown`, which stops every timer this extension armed. pi-web
 * exposes a versioned registry on `globalThis` for exactly this case: a provider
 * whose `isActive()` returns true makes the idle check re-arm instead of closing
 * the session. Explicit shutdown still wins. Under the pi CLI the registry does
 * not exist and this is a no-op.
 *
 * Contract: https://github.com/agegr/pi-web#extension-session-liveness
 */

export const SESSION_LIVENESS_REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
const SESSION_LIVENESS_PROTOCOL_VERSION = 1;

interface SessionLivenessRegistry {
  version: number;
  register(provider: {
    name: string;
    sessionId: string;
    sessionFile?: string;
    isActive(): boolean;
  }): () => void;
}

/** The session identity fields this module reads from an ExtensionContext. */
interface LivenessContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
  };
}

function findRegistry(): SessionLivenessRegistry | undefined {
  const candidate = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(SESSION_LIVENESS_REGISTRY_KEY)] as
    | Partial<SessionLivenessRegistry>
    | undefined;
  if (
    candidate &&
    candidate.version === SESSION_LIVENESS_PROTOCOL_VERSION &&
    typeof candidate.register === "function"
  ) {
    return candidate as SessionLivenessRegistry;
  }
  return undefined;
}

/**
 * Register `isActive` for the context's session with the host's liveness
 * registry, if there is one. Returns an idempotent release; call it when the
 * session shuts down or is re-initialized. Never throws: a failing registry
 * must not break session start.
 *
 * `isActive` must be synchronous and cheap; the host calls it when the
 * session's idle timer runs out.
 */
export function registerSessionLiveness(ctx: LivenessContext, isActive: () => boolean): () => void {
  const registry = findRegistry();
  if (!registry) return () => {};
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return () => {};
    const sessionFile = ctx.sessionManager.getSessionFile?.() || undefined;
    const release = registry.register({
      name: "pi-schedule-prompt",
      sessionId,
      ...(sessionFile ? { sessionFile } : {}),
      isActive,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        release();
      } catch (error) {
        console.warn("[pi-schedule-prompt] Failed to release session liveness:", error);
      }
    };
  } catch (error) {
    console.warn("[pi-schedule-prompt] Failed to register session liveness:", error);
    return () => {};
  }
}
