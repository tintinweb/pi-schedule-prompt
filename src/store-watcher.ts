import * as fs from "node:fs";
import * as path from "node:path";

/** Coalesce the rename/chmod/event burst produced by one atomic save. */
const WATCH_DEBOUNCE_MS = 40;
const WATCH_RETRY_MIN_MS = 250;
const WATCH_RETRY_MAX_MS = 5_000;

/**
 * Watch a store's parent directory for atomic temp-file + rename replacement.
 * Watching the file itself would follow the old inode and could stop reporting
 * after the first rename. Terminal watcher errors are retried with bounded
 * backoff, followed by a full reconciliation. Cleanup cancels every timer.
 * The optional factory is a narrow test seam for terminal OS watcher errors.
 */
export function watchStore(
  storePath: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
  watchImplementation: typeof fs.watch = fs.watch,
): () => void {
  const dir = path.dirname(storePath);
  const basename = path.basename(storePath);
  fs.mkdirSync(dir, { recursive: true });

  let closed = false;
  let debounce: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let retryDelay = WATCH_RETRY_MIN_MS;
  let watcher: fs.FSWatcher | undefined;

  const notify = () => {
    if (closed) return;
    try {
      onChange();
    } catch (error) {
      onError?.(error);
    }
  };

  const schedule = () => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      notify();
    }, WATCH_DEBOUNCE_MS);
    debounce.unref();
  };

  const queueRetry = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (closed) return;
      if (open()) notify();
    }, retryDelay);
    retry.unref();
    retryDelay = Math.min(WATCH_RETRY_MAX_MS, retryDelay * 2);
  };

  const handleWatcherError = (failed: fs.FSWatcher, error: unknown) => {
    // A late event from an old generation must not replace or retry over the
    // healthy watcher that superseded it.
    if (closed || watcher !== failed) return;
    onError?.(error);
    try {
      failed.close();
    } catch {
      // It may already be closed by the runtime.
    }
    if (watcher === failed) watcher = undefined;
    queueRetry();
  };

  const open = (): boolean => {
    if (closed) return false;
    try {
      const next = watchImplementation(dir, (_event, filename) => {
        if (filename && filename.toString() !== basename) return;
        schedule();
      });
      next.on("error", (error) => handleWatcherError(next, error));
      next.unref();
      watcher = next;
      retryDelay = WATCH_RETRY_MIN_MS;
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  };

  if (!open()) queueRetry();

  return () => {
    closed = true;
    if (debounce) clearTimeout(debounce);
    if (retry) clearTimeout(retry);
    debounce = undefined;
    retry = undefined;
    watcher?.close();
    watcher = undefined;
  };
}
