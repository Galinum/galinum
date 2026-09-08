import { validateSchema, installationSchemas, type InAppFeedbackReceipt, type InAppFeedbackInput } from "@galinum/contracts";
import type {
  DeliveryFeedback,
  EventProps,
  GalinumConfig,
  InAppMessage,
  Traits,
} from "./types.js";

function headers(config: GalinumConfig): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.publishableKey}`,
  };
}

export type PostResult = "ok" | "transient" | "permanent";

async function post(config: GalinumConfig, path: string, body: unknown, accept?: (value: unknown) => boolean): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${config.apiBase}${path}`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
      keepalive: true,
      signal: controller.signal,
    });
    if (!res.ok) {
      devWarn(`${path} responded ${res.status}`);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      return retryable ? "transient" : "permanent";
    }
    if (accept && (res.status !== 200 || !accept(await res.json().catch(() => null)))) return "transient";
    return "ok";
  } catch (err) {
    devWarn(`${path} request failed: ${String(err)}`);
    return "transient";
  } finally { clearTimeout(timer); }
}

export function isDev(): boolean {
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV;
  return env !== "production";
}

export function devWarn(message: string): void {
  if (isDev()) console.warn(`[galinum] ${message}`);
}

export async function identifyRequest(config: GalinumConfig, userId: string, traits?: Traits): Promise<void> {
  await post(config, "/api/v1/identify", { userId, traits });
}

export async function trackRequest(
  config: GalinumConfig,
  userId: string,
  event: string,
  props?: EventProps,
): Promise<void> {
  await post(config, "/api/v1/track", { userId, event, props });
}

export type MessagesResult = { ok: boolean; messages: InAppMessage[]; userId?: string; entryId?: string; requestId?: string };

export async function fetchMessages(
  config: GalinumConfig,
  userId: string,
  signal?: AbortSignal,
  capture?: { entryId: string; requestId: string; path: string },
): Promise<MessagesResult> {
  const url = `${config.apiBase}/api/v1/messages?${new URLSearchParams({ userId, entryId: capture?.entryId ?? "", requestId: capture?.requestId ?? "", path: capture?.path ?? "/" })}`;
  try {
    const res = await fetch(url, { headers: headers(config), signal, cache: "no-store" });
    if (!res.ok) {
      devWarn(`/api/v1/messages responded ${res.status}`);
      return { ok: false, messages: [] };
    }
    const data = (await res.json().catch(() => null)) as { messages?: InAppMessage[]; userId?: string; entryId?: string; requestId?: string } | null;
    if (!data?.messages) return { ok: false, messages: [] };
    return { ok: true, ...data, messages: data.messages };
  } catch {
    return { ok: false, messages: [] };
  }
}

type FeedbackIdentity = InAppFeedbackInput & { deliveryId: string };
export function validFeedbackReceipt(value: unknown, expected: FeedbackIdentity): value is InAppFeedbackReceipt {
  if (!validateSchema(installationSchemas.InAppFeedbackReceipt, value, installationSchemas)) return false;
  const receipt = value as InAppFeedbackReceipt;
  return receipt.userId === expected.userId && receipt.deliveryId === expected.deliveryId
    && receipt.type === expected.type && receipt.receiptId === expected.feedbackId
    && Number.isSafeInteger(receipt.acknowledgedAt) && receipt.acknowledgedAt >= 0
    && Number.isFinite(new Date(receipt.acknowledgedAt).getTime());
}

export function feedbackRequest(
  config: GalinumConfig,
  deliveryId: string,
  type: DeliveryFeedback,
  userId: string,
  feedbackId: string,
  onReceipt?: (receipt: InAppFeedbackReceipt) => void,
): Promise<PostResult> {
  return post(config, `/api/v1/deliveries/${encodeURIComponent(deliveryId)}/event`, { userId, type, feedbackId }, (value) => {
    if (!validFeedbackReceipt(value, { userId, deliveryId, type, feedbackId })) return false;
    onReceipt?.(value);
    return true;
  });
}
