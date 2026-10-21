/**
 * Collapse overlapping calls of an async task: at most one run at a time, and
 * while one runs only the newest arguments are remembered and run afterwards.
 * Every call resolves once the run that covers it has finished.
 *
 * Each run first waits `delayMs`, so a synchronous burst of calls (fast typing,
 * a sequence of `pages` events) costs a single run instead of one per call.
 */
export function latestWins<A extends unknown[]>(
  task: (...args: A) => Promise<void>,
  delayMs = 0,
): (...args: A) => Promise<void> {
  let running: Promise<void> | null = null;
  let pending: A | null = null;

  const drain = async (): Promise<void> => {
    while (pending) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const args = pending;
      pending = null;
      await task(...args);
    }
  };

  return (...args) => {
    pending = args;
    if (!running) {
      running = drain().finally(() => {
        running = null;
      });
    }
    return running;
  };
}
