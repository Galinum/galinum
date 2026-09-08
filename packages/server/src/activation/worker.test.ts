import { describe, expect, it, vi } from "vitest";
import { createActivationWorker } from "./worker.js";
import type { ActivationRepository } from "./store.js";

describe("stock activation worker", () => {
  it("keeps work bounded, continues after project failure and coalesces concurrent ticks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dueProjects = vi.fn(async () => ["a", "b"]);
    const repository = { dueProjects } as unknown as ActivationRepository;
    const reconcile = vi.fn(async (id: string) => { await gate; if (id === "a") throw new Error("retry"); return { state: "complete" as const, launched: [], warnings: 0 }; });
    const onError = vi.fn();
    const worker = createActivationWorker(repository, { reconcile }, { now: () => 123, projectLimit: 2, onError });
    const first = worker.tick(); const second = worker.tick();
    expect(first).toBe(second);
    release(); await first;
    expect(dueProjects).toHaveBeenCalledWith(123, 2);
    expect(reconcile.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(onError).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("stops periodic scheduling and awaits in-flight work", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const repository = { dueProjects: async () => ["project"] } as unknown as ActivationRepository;
      const reconcile = vi.fn(async () => { await gate; return { state: "complete" as const, launched: [], warnings: 0 }; });
      const worker = createActivationWorker(repository, { reconcile }, { intervalMs: 100 });
      worker.start(); await vi.advanceTimersByTimeAsync(100);
      let stopped = false;
      const stop = worker.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stop; await vi.advanceTimersByTimeAsync(1000);
      expect(reconcile).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
