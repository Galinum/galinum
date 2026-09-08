import type { InAppFeedbackReceipt } from "@galinum/contracts";
import { feedbackRequest, validFeedbackReceipt } from "./client.js";
import type { DeliveryFeedback, GalinumConfig } from "./types.js";
export type FeedbackReceipt = { status: "queued" | "acknowledged" | "rejected" | "failed"; userId: string; deliveryId: string; type: DeliveryFeedback; feedbackId: string };
type Record = FeedbackReceipt & { config: GalinumConfig; shownFeedbackId: string };
const receipt = ({ status, userId, deliveryId, type, feedbackId }: FeedbackReceipt): FeedbackReceipt => ({ status, userId, deliveryId, type, feedbackId });
const prefix = "galinum-feedback:";
const active = new Map<string, Promise<FeedbackReceipt>>();
const keyFor = (config: GalinumConfig, userId: string, deliveryId: string, feedbackId: string) => prefix + JSON.stringify([config.apiBase, config.publishableKey, userId, deliveryId, feedbackId]);
function read(key: string): Record | null {
  const raw = localStorage.getItem(key); if (!raw) return null;
  const record = JSON.parse(raw) as Record;
  if (!record || typeof record !== "object" || !record.config) return null;
  if (keyFor(record.config, record.userId, record.deliveryId, record.feedbackId) !== key) return null;
  const ack = localStorage.getItem(key + ":ack");
  if (ack && validFeedbackReceipt(JSON.parse(ack), record)) return { ...record, status: "acknowledged" };
  if (localStorage.getItem(key + ":rejected")) return { ...record, status: "rejected" };
  if (localStorage.getItem(key + ":failed")) return { ...record, status: "failed" };
  return { ...record, status: "queued" };
}
function predecessor(record: Record): { key: string; record: Record } | null {
  const key = keyFor(record.config, record.userId, record.deliveryId, record.shownFeedbackId);
  const shown = read(key);
  return shown && shown.type === "shown" && shown.feedbackId === record.shownFeedbackId
    && shown.userId === record.userId && shown.deliveryId === record.deliveryId
    && shown.config.apiBase === record.config.apiBase && shown.config.publishableKey === record.config.publishableKey
    && ["queued", "acknowledged"].includes(shown.status) ? { key, record: shown } : null;
}
function fail(key: string, record: Record): FeedbackReceipt {
  try { localStorage.setItem(key + ":failed", "1"); } catch {}
  return receipt({ ...record, status: "failed" });
}
async function deliver(key: string, record: Record): Promise<FeedbackReceipt> {
  const prior = active.get(key); if (prior) return prior;
  const work = (async () => {
    if (record.type !== "shown") {
      let shown: ReturnType<typeof predecessor>;
      try { shown = predecessor(record); } catch { return record; }
      if (!shown) return fail(key, record);
      const status = shown.record.status === "queued" ? (await deliver(shown.key, shown.record)).status : shown.record.status;
      if (status === "rejected" || status === "failed") return fail(key, record);
      if (status !== "acknowledged") return record;
    }
    let acknowledgement: InAppFeedbackReceipt | undefined;
    const outcome = await feedbackRequest(record.config, record.deliveryId, record.type, record.userId, record.feedbackId, (value) => { acknowledgement = value; });
    if (outcome === "transient") return record;
    const value: Record = { ...record, status: outcome === "ok" ? "acknowledged" : "rejected" };
    try { localStorage.setItem(key + (outcome === "ok" ? ":ack" : ":rejected"), outcome === "ok" ? JSON.stringify(acknowledgement) : "1"); return read(key) ?? value; } catch { return record; }
  })().finally(() => active.delete(key));
  active.set(key, work); return work;
}
export async function queueFeedback(config: GalinumConfig, userId: string, deliveryId: string, type: DeliveryFeedback, entryId = "manual"): Promise<FeedbackReceipt> {
  const feedbackId = entryId + ":" + deliveryId + ":" + type;
  const key = keyFor(config, userId, deliveryId, feedbackId);
  const record: Record = { config, userId, deliveryId, type, feedbackId, shownFeedbackId: entryId + ":" + deliveryId + ":shown", status: "queued" };
  let inserted = false;
  try {
    const prior = read(key);
    if (prior?.status === "acknowledged" || prior?.status === "rejected") return receipt(prior);
    if (type !== "shown" && !predecessor(record)) return prior ? fail(key, prior) : receipt({ ...record, status: "failed" });
    if (!prior) { localStorage.setItem(key, JSON.stringify(record)); inserted = true; }
    if (type !== "shown") localStorage.setItem(keyFor(config, userId, deliveryId, "completed"), "1");
    if (prior?.status === "failed") localStorage.removeItem(key + ":failed");
  } catch {
    if (inserted) { try { localStorage.removeItem(key); } catch {} }
    return receipt({ ...record, status: "failed" });
  }
  void deliver(key, record); return receipt(record);
}
export function locallyCompleted(config: GalinumConfig, userId: string, deliveryId: string): boolean {
  try { return localStorage.getItem(keyFor(config, userId, deliveryId, "completed")) !== null; } catch { return true; }
}
let cursor = 0;
export async function flushFeedback(config: GalinumConfig): Promise<void> {
  try {
    const length = localStorage.length;
    const keys: string[] = [];
    for (let count = 0; count < Math.min(length, 100); count++) {
      const key = localStorage.key(cursor++ % Math.max(length, 1));
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      try {
      const candidate = read(key);
      if (!candidate || candidate.config.apiBase !== config.apiBase || candidate.config.publishableKey !== config.publishableKey) continue;
      await active.get(key);
      const value = read(key);
      if (value?.status === "queued" && value.config.apiBase === config.apiBase && value.config.publishableKey === config.publishableKey) await deliver(key, value);
      } catch {}
    }
  } catch {}
}
