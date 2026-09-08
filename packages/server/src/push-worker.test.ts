import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { startPushWorker } from "./push-worker.js";
it("does not overlap a pending pass and waits for it during shutdown", async () => {
  let calls = 0; let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const worker = startPushWorker(async () => { calls++; await pending; return { errors: [] }; }, 100);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(calls).toBe(1);
  const stopping = worker.stop(); release(); await stopping;
  await new Promise((resolve) => setTimeout(resolve, 120)); expect(calls).toBe(1);
  expect(readFileSync(new URL("./cli.ts", import.meta.url), "utf8")).toContain("startPushWorker(() => product.push.runDue()");
});
