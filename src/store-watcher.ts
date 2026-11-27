import * as fs from "node:fs";
import * as path from "node:path";

/** Coalesce the rename/chmod/event burst produced by one atomic save. */
const WATCH_DEBOUNCE_MS = 40;

/**
 * Watch a store's parent directory for atomic temp-file + rename replacement.
 * Watching the file itself would follow the old inode and could stop reporting
 * after the first rename. Only the store basename is relevant; temp files and
 * sibling projects/claims are ignored. The returned cleanup also cancels a
 * pending debounce. No polling is involved.
 */
export function watchStore(
  storePath: string,
  onChange: () => void,
  onError?: (error: unknown) => void,
): () => void {
  const dir = path.dirname(storePath);
  const basename = path.basename(storePath);
  fs.mkdirSync(dir, { recursive: true });

  let closed = false;
  let debounce: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      if (closed) return;
      try {
        onChange();
      } catch (error) {
        onError?.(error);
      }
    }, WATCH_DEBOUNCE_MS);
    debounce.unref();
  };

  const watcher = fs.watch(dir, (_event, filename) => {
    if (filename && filename.toString() !== basename) return;
    schedule();
  });
  watcher.on("error", (error) => onError?.(error));
  watcher.unref();

  return () => {
    closed = true;
    if (debounce) clearTimeout(debounce);
    debounce = undefined;
    watcher.close();
  };
}
