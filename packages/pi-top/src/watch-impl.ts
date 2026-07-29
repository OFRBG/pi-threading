/**
 * watch-impl.ts — low-level polling utility used by watcher.ts.
 *
 * Provides a lightweight polling loop that compares results of an async
 * function call-by-call. When the result changes (reference-level:
 * JSON.stringify for arrays), it fires a callback.
 */

export function createPollingWatcher(
  fetch: () => Promise<unknown>,
  intervalMs: number,
  onChanged: () => void,
) {
  let lastSig = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  timer = setInterval(async () => {
    try {
      const data = await fetch();
      const sig = JSON.stringify(data);
      if (sig !== lastSig) {
        lastSig = sig;
        onChanged();
      }
    } catch {
      // Network blip — don't fire spuriously, just skip this tick.
    }
  }, intervalMs);

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
