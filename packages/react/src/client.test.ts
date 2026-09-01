import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMessages, feedbackRequest, identifyRequest, trackRequest } from "./client.js";
import type { GalinumConfig } from "./types.js";

const config: GalinumConfig = {
  publishableKey: "pk_pub_test",
  apiBase: "https://galinum.test",
};

function stubFetch(response: Response | Error) {
  const mock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("identifyRequest", () => {
  it("POSTs userId and traits with the publishable key as bearer token", async () => {
    const mock = stubFetch(json({ ok: true }));
    await identifyRequest(config, "user_1", { plan: "free" });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://galinum.test/api/v1/identify");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${config.publishableKey}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      userId: "user_1",
      traits: { plan: "free" },
    });
  });

  it("never throws on network failure", async () => {
    stubFetch(new Error("network down"));
    await expect(identifyRequest(config, "user_1")).resolves.toBeUndefined();
  });

  it("never throws on a non-2xx response", async () => {
    stubFetch(json({ error: "Unauthorized" }, 401));
    await expect(identifyRequest(config, "user_1")).resolves.toBeUndefined();
  });
});

describe("trackRequest", () => {
  it("POSTs the event with props", async () => {
    const mock = stubFetch(json({ ok: true }));
    await trackRequest(config, "user_1", "signed_up", { source: "landing" });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://galinum.test/api/v1/track");
    expect(JSON.parse(init.body as string)).toEqual({
      userId: "user_1",
      event: "signed_up",
      props: { source: "landing" },
    });
  });
});

describe("fetchMessages", () => {
  it("returns messages and URL-encodes the user id", async () => {
    const message = { deliveryId: "del_1", campaignId: "cmp_1", variantId: "var_1", content: {} };
    const mock = stubFetch(json({ messages: [message] }));

    const result = await fetchMessages(config, "user/1");
    expect(result).toEqual({ ok: true, messages: [message] });
    const [url] = mock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://galinum.test/api/v1/messages?userId=user%2F1&pages=1");
  });

  // A failure must be distinguishable from an empty result: the scheduler
  // would otherwise treat it as a loaded, empty cache.
  it("reports a failure on non-2xx responses", async () => {
    stubFetch(json({ error: "Unauthorized" }, 401));
    expect(await fetchMessages(config, "user_1")).toEqual({ ok: false, messages: [] });
  });

  it("reports a failure on network errors", async () => {
    stubFetch(new Error("network down"));
    expect(await fetchMessages(config, "user_1")).toEqual({ ok: false, messages: [] });
  });

  it("reports a failure on malformed JSON", async () => {
    stubFetch(new Response("not json", { status: 200 }));
    expect(await fetchMessages(config, "user_1")).toEqual({ ok: false, messages: [] });
  });

  it("reports an empty-but-successful response", async () => {
    stubFetch(json({ messages: [] }));
    expect(await fetchMessages(config, "user_1")).toEqual({ ok: true, messages: [] });
  });
});

describe("feedbackRequest", () => {
  it("POSTs the feedback type to the delivery, URL-encoding the id", async () => {
    const mock = stubFetch(json({ ok: true }));
    await feedbackRequest(config, "del/1", "dismissed");

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://galinum.test/api/v1/deliveries/del%2F1/event");
    expect(JSON.parse(init.body as string)).toEqual({ type: "dismissed" });
  });
});
