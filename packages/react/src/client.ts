import type {
  DeliveryFeedback,
  EventProps,
  GalinumConfig,
  InAppMessage,
  Traits,
} from "./types.js";

// Thin fetch wrapper around the Galinum /api/v1 endpoints. The publishable key
// travels as a bearer token; these are public, origin-agnostic endpoints.
function headers(config: GalinumConfig): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.publishableKey}`,
  };
}

// Outcome of a best-effort request: `ok` succeeded, `transient` may succeed
// if retried (network error, 408/429, 5xx), `permanent` never will (other
// 4xx — bad request, auth, or a server that doesn't know this event type).
export type PostResult = "ok" | "transient" | "permanent";

// Ingestion is best-effort: a failed request must never throw into the host
// app (identify/track are often fire-and-forget, incl. auto-identify). Swallow
// network errors and non-2xx responses; surface them only in dev. Returns the
// outcome so callers that care (impression reporting) can retry transient
// failures.
async function post(config: GalinumConfig, path: string, body: unknown): Promise<PostResult> {
  try {
    const res = await fetch(`${config.apiBase}${path}`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!res.ok) {
      devWarn(`${path} responded ${res.status}`);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      return retryable ? "transient" : "permanent";
    }
    return "ok";
  } catch (err) {
    devWarn(`${path} request failed: ${String(err)}`);
    return "transient";
  }
}

// True unless bundled for production. Read via globalThis so we don't depend on
// @types/node or ship a `process` global declaration to consumers.
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

// `ok` distinguishes "the server says there is nothing" from "the request
// failed": the scheduler must not treat a failure as a loaded empty cache.
export type MessagesResult = { ok: boolean; messages: InAppMessage[] };

export async function fetchMessages(
  config: GalinumConfig,
  userId: string,
  signal?: AbortSignal,
): Promise<MessagesResult> {
  // `pages=1` declares that this SDK matches page patterns client-side.
  // Without it the server withholds page-targeted campaigns.
  const url = `${config.apiBase}/api/v1/messages?userId=${encodeURIComponent(userId)}&pages=1`;
  try {
    const res = await fetch(url, { headers: headers(config), signal });
    if (!res.ok) {
      devWarn(`/api/v1/messages responded ${res.status}`);
      return { ok: false, messages: [] };
    }
    const data = (await res.json().catch(() => null)) as { messages?: InAppMessage[] } | null;
    if (!data?.messages) return { ok: false, messages: [] };
    return { ok: true, messages: data.messages };
  } catch {
    // Network error or aborted request — treat as "no messages this round".
    return { ok: false, messages: [] };
  }
}

// Returns the request outcome so the impression (`shown`) report can be
// retried on a later poll after a transient failure — and NOT retried when
// the server rejected it permanently.
export function feedbackRequest(
  config: GalinumConfig,
  deliveryId: string,
  type: DeliveryFeedback,
): Promise<PostResult> {
  return post(config, `/api/v1/deliveries/${encodeURIComponent(deliveryId)}/event`, { type });
}
