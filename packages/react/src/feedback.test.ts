import { ackResponse } from "./receipts.test.fixture.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushFeedback, locallyCompleted, queueFeedback } from "./feedback.js";
const config = { apiBase: "https://galinum.test", publishableKey: "pk_outbox" };
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("persists queued feedback before returning and retries exact captured identity", async () => {
  const calls: object[] = []; let status = 503;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return ackResponse(_url, init, status); }));
  expect((await queueFeedback(config, "A", "durable", "shown")).status).toBe("queued");
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(localStorage.length).toBe(1);
  status = 200; await flushFeedback(config);
  expect((await queueFeedback(config, "A", "durable", "shown")).status).toBe("acknowledged");
  expect(calls).toEqual([{ userId: "A", type: "shown", feedbackId: "manual:durable:shown" }, { userId: "A", type: "shown", feedbackId: "manual:durable:shown" }]);
});
it("holds terminal feedback behind shown acknowledgement and suppresses locally before acknowledgement", async () => {
  const calls: string[] = []; let status = 503;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body)).type); return ackResponse(_url, init, status); }));
  await queueFeedback(config, "A", "ordered", "shown");
  await queueFeedback(config, "A", "ordered", "dismissed");
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
  expect(calls).not.toContain("dismissed");
  expect(locallyCompleted(config, "A", "ordered")).toBe(true);
  expect(locallyCompleted(config, "B", "ordered")).toBe(false);
  status = 200; await flushFeedback(config);
  await vi.waitFor(() => expect(calls).toContain("dismissed"));
  expect((await queueFeedback(config, "A", "ordered", "dismissed")).status).toBe("acknowledged");
});
it("does not report queued when durable storage fails", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
  expect((await queueFeedback(config, "A", "full", "shown")).status).toBe("failed");
  expect(fetch).not.toHaveBeenCalled();
});
it("separates project scope and exposes permanent rejection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 409 })));
  await queueFeedback(config, "A", "rejected", "shown");
  await vi.waitFor(async () => expect((await queueFeedback(config, "A", "rejected", "shown")).status).toBe("rejected"));
  expect(locallyCompleted({ ...config, publishableKey: "other" }, "A", "rejected")).toBe(false);
});
it("keeps acknowledgement monotonic across independent senders and late rejection", async () => {
  const replies: ((response: Response) => void)[] = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve))));
  await queueFeedback(config, "A", "race", "shown");
  vi.resetModules();
  const other = await import("./feedback.js");
  await other.queueFeedback(config, "A", "race", "shown");
  expect(replies).toHaveLength(2);
  replies[0]!(Response.json({ userId: "A", deliveryId: "race", type: "shown", receiptId: "manual:race:shown", acknowledgedAt: 1000 }));
  await vi.waitFor(async () => expect((await queueFeedback(config, "A", "race", "shown")).status).toBe("acknowledged"));
  replies[1]!(new Response("{}", { status: 401 }));
  await vi.waitFor(async () => expect((await other.queueFeedback(config, "A", "race", "shown")).status).toBe("acknowledged"));
});
it("suppresses eligibility when local completion storage cannot be read", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); } });
  expect(locallyCompleted(config, "A", "unknown")).toBe(true);
});
