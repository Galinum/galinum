export function startPushWorker(run: () => Promise<{ errors: unknown[] }>, intervalMs = 1000, onError: () => void = () => {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error("Push worker interval must be 100–60000 ms");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      try { if ((await run()).errors.length) onError(); } catch { onError(); }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    })();
  };
  tick();
  return { async stop() { stopped = true; clearTimeout(timer); await running; } };
}
