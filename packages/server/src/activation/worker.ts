import type { ActivationRepository } from "./store.js";
import type { createActivationService } from "./service.js";

export function createActivationWorker(repository: ActivationRepository, service: Pick<ReturnType<typeof createActivationService>, "reconcile">,
  options: { intervalMs?: number; projectLimit?: number; now?: () => number; onError?: (error: unknown) => void } = {}) {
  const interval = options.intervalMs ?? 1000;
  const limit = options.projectLimit ?? 10;
  if (!Number.isSafeInteger(interval) || interval < 100 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid activation worker limits.");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let enabled = false;
  const tick = () => {
    if (running) return running;
    running = (async () => {
      const projects = await repository.dueProjects((options.now ?? Date.now)(), limit);
      for (const id of projects) {
        try { await service.reconcile(id); } catch (error) { options.onError?.(error); }
      }
    })().finally(() => { running = null; });
    return running;
  };
  const schedule = () => {
    if (!enabled) return;
    timer = setTimeout(() => { timer = null; void tick().catch((error) => options.onError?.(error)).finally(schedule); }, interval);
    timer.unref();
  };
  return { tick, start() { if (!enabled) { enabled = true; schedule(); } }, async stop() {
    enabled = false; if (timer) clearTimeout(timer); timer = null; await running;
  } };
}
