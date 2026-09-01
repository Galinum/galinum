import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";

function client() {
  let clock = 1_755_000_000_000;
  const product = createLocalProduct({
    now: () => clock,
    managementRateLimit: { perMinute: 10_000, perHour: 10_000 },
  });
  const app = createApp(product.handlers, product.media);
  const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
  const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
  const call = (path: string, method = "GET", value?: unknown, headers = secret) => app(new Request(`http://local${path}`, {
    method,
    headers,
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
  return { product, app, call, secret, publishable, tick: (value = 1) => { clock += value; }, now: () => clock };
}

function planExpression(plan: string) {
  return { version: 1, root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: plan } };
}

describe("pre-push review regressions", () => {
  it("enforces expression, pinned segment, and legacy audiences", async () => {
    const { call, publishable } = client();
    await call("/api/v1/identify", "POST", { userId: "free", traits: { plan: "free" } }, publishable);
    await call("/api/v1/identify", "POST", { userId: "pro", traits: { plan: "pro" } }, publishable);
    const created = await call("/api/v1/campaigns", "POST", {
      name: "Free campaign",
      message: { presentation: "toast", title: "Only free" },
      audience: {
        kind: "expression",
        expression: planExpression("free"),
      },
      launch: true,
    });
    expect(created.status).toBe(201);
    expect((await (await call("/api/v1/messages?userId=free", "GET", undefined, publishable)).json()).messages).toHaveLength(1);
    expect((await (await call("/api/v1/messages?userId=pro", "GET", undefined, publishable)).json()).messages).toEqual([]);

    const segment = (await (await call("/api/v1/segments", "POST", {
      key: "free-users",
      name: "Free users",
      expression: planExpression("free"),
    })).json()).segment;
    const pinned = (await (await call("/api/v1/campaigns", "POST", {
      name: "Pinned segment",
      message: { presentation: "toast", title: "Pinned" },
      audience: { kind: "segment", segment: segment.key },
      launch: true,
    })).json()).campaign;
    await call(`/api/v1/segments/${segment.id}`, "PATCH", {
      expression: planExpression("pro"),
      expectedVersion: 1,
    });
    expect(pinned.audience).toMatchObject({ kind: "segment", segmentVersion: 1 });
    expect((await (await call("/api/v1/messages?userId=free", "GET", undefined, publishable)).json()).messages.map((message: { campaignId: string }) => message.campaignId)).toContain(pinned.id);
    expect((await (await call("/api/v1/messages?userId=pro", "GET", undefined, publishable)).json()).messages.map((message: { campaignId: string }) => message.campaignId)).not.toContain(pinned.id);
    const segmentCampaign = (audience: unknown) => call("/api/v1/campaigns", "POST", {
      name: "Segment validation",
      message: { presentation: "toast", title: "Segment" },
      audience,
    });
    expect((await segmentCampaign({ kind: "segment", segment: "missing" })).status).toBe(404);
    expect((await segmentCampaign({ kind: "segment", segment: segment.id, version: 99 })).status).toBe(404);
    await call(`/api/v1/segments/${segment.id}/archive`, "POST");
    expect((await segmentCampaign({ kind: "segment", segment: segment.id })).status).toBe(409);

    const legacy = (await (await call("/api/v1/campaigns", "POST", {
      name: "Legacy targeting",
      message: { presentation: "toast", title: "Legacy" },
      targeting: { traits: { plan: "pro" } },
      launch: true,
    })).json()).campaign;
    expect(legacy.audience).toMatchObject({ kind: "expression", legacy: false });
    expect((await (await call("/api/v1/messages?userId=pro", "GET", undefined, publishable)).json()).messages.map((message: { campaignId: string }) => message.campaignId)).toContain(legacy.id);
    expect((await (await call("/api/v1/messages?userId=free", "GET", undefined, publishable)).json()).messages.map((message: { campaignId: string }) => message.campaignId)).not.toContain(legacy.id);
  });

  it("keeps ended and expired lifecycle states terminal", async () => {
    const { call, tick, now } = client();
    const created = (await (await call("/api/v1/campaigns", "POST", {
      name: "Window",
      message: { presentation: "toast", title: "Window" },
      launch: true,
      deliverUntil: now() + 100,
    })).json()).campaign;
    tick(101);
    for (const action of ["launch", "pause"]) {
      expect((await call(`/api/v1/campaigns/${created.id}/status`, "POST", { action })).status).toBe(409);
    }
    expect((await call(`/api/v1/campaigns/${created.id}/status`, "POST", { action: "end" })).status).toBe(200);
    expect((await call(`/api/v1/campaigns/${created.id}/status`, "POST", { action: "end" })).status).toBe(409);
    const active = (await (await call("/api/v1/campaigns", "POST", {
      name: "Ended",
      message: { presentation: "toast", title: "Ended" },
    })).json()).campaign;
    expect((await call(`/api/v1/campaigns/${active.id}/status`, "POST", { action: "end" })).status).toBe(200);
    for (const action of ["launch", "pause", "end"]) {
      expect((await call(`/api/v1/campaigns/${active.id}/status`, "POST", { action })).status).toBe(409);
    }
  });

  it("serializes content and lifecycle writes without losing disjoint changes", async () => {
    const { app, call, secret, now } = client();
    const campaign = (await (await call("/api/v1/campaigns", "POST", {
      name: "Concurrent",
      message: { presentation: "toast", title: "Concurrent" },
    })).json()).campaign;

    let release = () => {};
    const blockedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: "Patched after end" })));
          controller.close();
        };
      },
    });
    const patch = app(new Request(`http://local/api/v1/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: secret,
      body: blockedBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    await Promise.resolve();
    expect((await call(`/api/v1/campaigns/${campaign.id}/status`, "POST", { action: "end" })).status).toBe(200);
    release();
    expect((await patch).status).toBe(200);
    const ended = (await (await call(`/api/v1/campaigns/${campaign.id}`)).json()).campaign;
    expect(ended).toMatchObject({ name: "Patched after end", status: "ended", endedAt: now() });

    const disjoint = (await (await call("/api/v1/campaigns", "POST", {
      name: "Disjoint",
      message: { presentation: "toast", title: "Disjoint" },
    })).json()).campaign;
    const responses = await Promise.all([
      call(`/api/v1/campaigns/${disjoint.id}`, "PATCH", { name: "Renamed" }),
      call(`/api/v1/campaigns/${disjoint.id}`, "PATCH", { pages: ["/settings"] }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect((await (await call(`/api/v1/campaigns/${disjoint.id}`)).json()).campaign).toMatchObject({
      name: "Renamed",
      pages: ["/settings"],
    });
  });

  it("serializes disjoint goal patches without losing either change", async () => {
    const { call } = client();
    const goal = (await (await call("/api/v1/goals", "POST", { name: "Original" })).json()).goal;
    const responses = await Promise.all([
      call(`/api/v1/goals/${goal.id}`, "PATCH", { name: "Renamed" }),
      call(`/api/v1/goals/${goal.id}`, "PATCH", { description: "Preserved" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect((await (await call(`/api/v1/goals/${goal.id}`)).json()).goal).toMatchObject({ name: "Renamed", description: "Preserved" });
  });

  it("supports variants-only creation and reports per-variant statistics", async () => {
    const { call, publishable } = client();
    const response = await call("/api/v1/campaigns", "POST", {
      name: "Variants",
      variants: [
        { name: "A", message: { presentation: "toast", title: "A" }, weight: 1, isControl: true },
        { name: "B", message: { presentation: "toast", title: "B" }, weight: 1 },
      ],
      launch: true,
    });
    expect(response.status).toBe(201);
    const campaign = (await response.json()).campaign;
    const deliveries = new Map<string, string>();
    for (let index = 0; index < 20 && deliveries.size < 2; index += 1) {
      const userId = `user_${index}`;
      await call("/api/v1/identify", "POST", { userId }, publishable);
      const message = (await (await call(`/api/v1/messages?userId=${userId}`, "GET", undefined, publishable)).json()).messages[0];
      deliveries.set(message.variantId, message.deliveryId);
    }
    expect(deliveries.size).toBe(2);
    for (const deliveryId of deliveries.values()) {
      await call(`/api/v1/deliveries/${deliveryId}/event`, "POST", { type: "shown" }, publishable);
    }
    const detail = (await (await call(`/api/v1/campaigns/${campaign.id}`)).json()).campaign;
    expect(detail.stats.shown).toBe(2);
    expect(detail.variants.map((variant: { stats: { shown: number } }) => variant.stats.shown)).toEqual([1, 1]);
  });

  it("enforces the final ten-variant cap across repeated additions", async () => {
    const { call } = client();
    const campaign = (await (await call("/api/v1/campaigns", "POST", {
      name: "Variant cap",
      message: { presentation: "toast", title: "Initial" },
    })).json()).campaign;
    for (let index = 1; index < 10; index += 1) {
      expect((await call(`/api/v1/campaigns/${campaign.id}`, "PATCH", {
        variants: [{ name: `Variant ${index}`, message: { presentation: "toast", title: String(index) } }],
      })).status).toBe(200);
    }
    expect((await call(`/api/v1/campaigns/${campaign.id}`, "PATCH", {
      variants: [{ name: "Too many", message: { presentation: "toast", title: "Too many" } }],
    })).status).toBe(400);
    expect((await (await call(`/api/v1/campaigns/${campaign.id}`)).json()).campaign.variants).toHaveLength(10);
  });

  it("returns modal messages before toast messages", async () => {
    const { call, publishable } = client();
    await call("/api/v1/campaigns", "POST", { name: "Toast", message: { presentation: "toast", title: "Toast" }, launch: true });
    await call("/api/v1/campaigns", "POST", { name: "Modal", message: { presentation: "modal", title: "Modal" }, launch: true });
    await call("/api/v1/identify", "POST", { userId: "ordered" }, publishable);
    const messages = (await (await call("/api/v1/messages?userId=ordered", "GET", undefined, publishable)).json()).messages;
    expect(messages.map((message: { content: { presentation: string } }) => message.content.presentation)).toEqual(["modal", "toast"]);
  });

  it("fails closed above 100 serving candidates", async () => {
    const full = client();
    await full.call("/api/v1/identify", "POST", { userId: "full" }, full.publishable);
    for (let index = 0; index < 100; index += 1) {
      await full.call("/api/v1/campaigns", "POST", { name: `Full ${index}`, message: { presentation: "toast", title: String(index) }, launch: true });
    }
    const fullResponse = await full.call("/api/v1/messages?userId=full", "GET", undefined, full.publishable);
    expect(fullResponse.status).toBe(200);
    expect((await fullResponse.json()).messages).toHaveLength(100);

    const overflow = client();
    await overflow.call("/api/v1/identify", "POST", { userId: "overflow" }, overflow.publishable);
    for (let index = 0; index < 101; index += 1) {
      await overflow.call("/api/v1/campaigns", "POST", { name: `Overflow ${index}`, message: { presentation: "toast", title: String(index) }, launch: true });
    }
    expect((await overflow.call("/api/v1/messages?userId=overflow", "GET", undefined, overflow.publishable)).status).toBe(503);
  });

  it("keeps resolved feedback monotonic", async () => {
    const { call, publishable } = client();
    const campaign = (await (await call("/api/v1/campaigns", "POST", { name: "Feedback", message: { presentation: "toast", title: "Feedback" }, launch: true })).json()).campaign;
    await call("/api/v1/identify", "POST", { userId: "converted" }, publishable);
    await call("/api/v1/identify", "POST", { userId: "dismissed" }, publishable);
    const converted = (await (await call("/api/v1/messages?userId=converted", "GET", undefined, publishable)).json()).messages[0];
    const dismissed = (await (await call("/api/v1/messages?userId=dismissed", "GET", undefined, publishable)).json()).messages[0];
    await call(`/api/v1/deliveries/${converted.deliveryId}/event`, "POST", { type: "converted" }, publishable);
    await call(`/api/v1/deliveries/${converted.deliveryId}/event`, "POST", { type: "shown" }, publishable);
    await call(`/api/v1/deliveries/${dismissed.deliveryId}/event`, "POST", { type: "dismissed" }, publishable);
    await call(`/api/v1/deliveries/${dismissed.deliveryId}/event`, "POST", { type: "shown" }, publishable);
    const rows = (await (await call(`/api/v1/campaigns/${campaign.id}/deliveries`)).json()).deliveries;
    expect(new Set(rows.map((row: { state: string }) => row.state))).toEqual(new Set(["converted", "dismissed"]));
    expect((await (await call("/api/v1/messages?userId=converted", "GET", undefined, publishable)).json()).messages).toEqual([]);
  });

  it("filters effective status, caps results, and returns newest campaigns first", async () => {
    const { call, tick, now } = client();
    await call("/api/v1/campaigns", "POST", { name: "Old", message: { presentation: "toast", title: "Old" }, launch: true });
    tick();
    await call("/api/v1/campaigns", "POST", { name: "New", message: { presentation: "toast", title: "New" }, launch: true });
    tick();
    await call("/api/v1/campaigns", "POST", { name: "Draft", message: { presentation: "toast", title: "Draft" } });
    const running = (await (await call("/api/v1/campaigns?status=running")).json()).campaigns;
    expect(running.map((campaign: { name: string }) => campaign.name)).toEqual(["New", "Old"]);
    await call("/api/v1/campaigns", "POST", { name: "Scheduled", message: { presentation: "toast", title: "Scheduled" }, deliverFrom: now() + 1_000, launch: true });
    await call("/api/v1/campaigns", "POST", { name: "Expiring", message: { presentation: "toast", title: "Expiring" }, deliverUntil: now() + 1, launch: true });
    tick(2);
    expect((await (await call("/api/v1/campaigns?status=scheduled")).json()).campaigns.map((campaign: { name: string }) => campaign.name)).toEqual(["Scheduled"]);
    expect((await (await call("/api/v1/campaigns?status=expired")).json()).campaigns.map((campaign: { name: string }) => campaign.name)).toEqual(["Expiring"]);
    for (let index = 0; index < 101; index += 1) {
      tick();
      await call("/api/v1/campaigns", "POST", { name: `Campaign ${index}`, message: { presentation: "toast", title: String(index) } });
    }
    const campaigns = (await (await call("/api/v1/campaigns")).json()).campaigns;
    expect(campaigns).toHaveLength(100);
    expect(campaigns[0].name).toBe("Campaign 100");
    expect(campaigns.at(-1).name).toBe("Campaign 1");
    expect((await call("/api/v1/campaigns?status=invalid")).status).toBe(400);
  });

  it("validates messages, page patterns, media, weights, and controls", async () => {
    const { product, call } = client();
    const valid = { presentation: "toast", title: "Valid" };
    expect((await call("/api/v1/campaigns", "POST", { name: "Missing presentation", message: { title: "No" } })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", { name: "Missing content", message: { presentation: "toast" } })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", { name: "Invalid pages", message: valid, pages: ["dashboard"] })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Impossible date",
      message: valid,
      deliverUntil: "2026-02-31T12:00:00Z",
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Invalid weight",
      variants: [{ message: valid, weight: 1.5 }],
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "String weight",
      variants: [{ message: valid, weight: "1" }],
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "String control",
      variants: [{ message: valid, isControl: "true" }],
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Multiple controls",
      variants: [{ message: valid, isControl: true }, { message: valid, isControl: true }],
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "No control",
      variants: [{ message: valid, isControl: false }],
    })).status).toBe(201);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Forged media",
      message: { ...valid, media: { url: "/media/projects/local/media/missing.png", alt: "Missing" } },
    })).status).toBe(400);
    const other = await product.media.put({ projectId: "other", bytes: new Uint8Array([1]), contentType: "image/png", extension: "png" });
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Other media",
      message: { ...valid, media: { url: product.media.publicUrl(other.path), alt: "Other" } },
    })).status).toBe(400);
    const owned = await product.media.put({ projectId: "local", bytes: new Uint8Array([1]), contentType: "image/png", extension: "png" });
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Conflicting media description",
      message: { ...valid, media: { url: product.media.publicUrl(owned.path), alt: "Owned", decorative: true } },
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Invalid decorative value",
      message: { ...valid, media: { url: product.media.publicUrl(owned.path), decorative: "true" } },
    })).status).toBe(400);
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Protocol-relative CTA",
      message: { ...valid, cta: { label: "Open", url: "//example.com" } },
    })).status).toBe(400);
  });

  it("retains immutable media after campaign references are removed", async () => {
    const { product, call, publishable } = client();
    const object = await product.media.put({ projectId: "local", bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", extension: "png" });
    const message = { presentation: "toast", title: "Shared", media: { url: product.media.publicUrl(object.path), alt: "Shared" } };
    const first = (await (await call("/api/v1/campaigns", "POST", { name: "First", message, launch: true })).json()).campaign;
    const secondMessage = { ...message, media: { ...message.media, url: object.path } };
    const second = (await (await call("/api/v1/campaigns", "POST", { name: "Second", message: secondMessage })).json()).campaign;
    expect(first.variants[0].content.media.url).toBe(product.media.publicUrl(object.path));
    expect(second.variants[0].content.media.url).toBe(product.media.publicUrl(object.path));
    await call("/api/v1/identify", "POST", { userId: "media-user" }, publishable);
    const messages = (await (await call("/api/v1/messages?userId=media-user", "GET", undefined, publishable)).json()).messages;
    expect(messages[0].content.media.url).toBe(product.media.publicUrl(object.path));
    expect((await call(`/api/v1/campaigns/${first.id}`, "PATCH", { message: { presentation: "toast", title: "No media" } })).status).toBe(200);
    expect(await product.media.get(object.key)).not.toBeNull();
    expect((await call(`/api/v1/campaigns/${second.id}`, "PATCH", { message: { presentation: "toast", title: "No media" } })).status).toBe(200);
    expect(await product.media.get(object.key)).not.toBeNull();
  });

  it("generates distinct fallback keys and bounds publishable writes", async () => {
    const first = createLocalProduct();
    const second = createLocalProduct();
    expect(first.secretKey).not.toBe(second.secretKey);
    expect(first.publishableKey).not.toBe(second.publishableKey);
    const app = createApp(first.handlers);
    const headers = { authorization: `Bearer ${first.publishableKey}`, "content-type": "application/json" };
    expect((await app(new Request("http://local/api/v1/identify", { method: "POST", headers, body: JSON.stringify({ userId: "x".repeat(257) }) }))).status).toBe(400);
    expect((await app(new Request("http://local/api/v1/track", { method: "POST", headers, body: JSON.stringify({ userId: "user", event: "x".repeat(81) }) }))).status).toBe(400);
    expect((await app(new Request("http://local/api/v1/identify", { method: "POST", headers, body: JSON.stringify({ userId: "user", traits: { value: "x".repeat(9_000) } }) }))).status).toBe(413);
    expect((await app(new Request("http://local/api/v1/identify", { method: "POST", headers, body: "{" }))).status).toBe(400);
    expect((await app(new Request("http://local/api/v1/campaigns", {
      method: "POST",
      headers: { authorization: `Bearer ${first.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Large", message: { presentation: "toast", body: "x".repeat(70_000) } }),
    }))).status).toBe(413);

    const largeRun = await app(new Request("http://local/api/v1/agent-runs", {
      method: "POST",
      headers: { authorization: `Bearer ${first.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "evaluation", input: { value: "x".repeat(12_000) }, output: { value: "y".repeat(12_000) } }),
    }));
    expect(largeRun.status).toBe(201);

    const limited = createLocalProduct({ sdkRateLimit: { perMinute: 2, perHour: 3 } });
    const limitedApp = createApp(limited.handlers);
    const limitedHeaders = { authorization: `Bearer ${limited.publishableKey}`, "content-type": "application/json" };
    for (const [index, expected] of [200, 200, 429].entries()) {
      const response = await limitedApp(new Request("http://local/api/v1/identify", {
        method: "POST",
        headers: limitedHeaders,
        body: JSON.stringify({ userId: `user_${index}` }),
      }));
      expect(response.status).toBe(expected);
      if (expected === 429) expect(response.headers.get("retry-after")).toBe("60");
    }
    expect((await limitedApp(new Request("http://local/api/v1/track", {
      method: "POST",
      headers: limitedHeaders,
      body: JSON.stringify({ userId: "user", event: "separate_endpoint" }),
    }))).status).toBe(200);

    let hourlyClock = 1_755_000_000_000;
    const hourly = createLocalProduct({ now: () => hourlyClock, sdkRateLimit: { perMinute: 10, perHour: 2 } });
    const hourlyApp = createApp(hourly.handlers);
    const hourlyHeaders = { authorization: `Bearer ${hourly.publishableKey}`, "content-type": "application/json" };
    for (const userId of ["hourly_1", "hourly_2"]) {
      expect((await hourlyApp(new Request("http://local/api/v1/identify", {
        method: "POST",
        headers: hourlyHeaders,
        body: JSON.stringify({ userId }),
      }))).status).toBe(200);
    }
    hourlyClock += 61_000;
    const hourlyLimited = await hourlyApp(new Request("http://local/api/v1/identify", {
      method: "POST",
      headers: hourlyHeaders,
      body: JSON.stringify({ userId: "hourly_3" }),
    }));
    expect(hourlyLimited.status).toBe(429);
    expect(Number(hourlyLimited.headers.get("retry-after"))).toBeGreaterThan(3_500);

    const management = createLocalProduct({ managementRateLimit: { perMinute: 2, perHour: 3 } });
    const managementApp = createApp(management.handlers);
    const managementHeaders = { authorization: `Bearer ${management.secretKey}`, "content-type": "application/json" };
    expect((await managementApp(new Request("http://local/api/v1/campaigns", { headers: managementHeaders }))).status).toBe(200);
    expect((await managementApp(new Request("http://local/api/v1/campaigns/missing", { headers: managementHeaders }))).status).toBe(404);
    const grouped = await managementApp(new Request("http://local/api/v1/campaigns", { headers: managementHeaders }));
    expect(grouped.status).toBe(429);
    expect(grouped.headers.get("retry-after")).toBe("60");
    expect((await managementApp(new Request("http://local/api/v1/goals", { headers: managementHeaders }))).status).toBe(200);

    const authorization = createLocalProduct({ managementRateLimit: { perMinute: 1, perHour: 1 } });
    const authorizationApp = createApp(authorization.handlers);
    expect((await authorizationApp(new Request("http://local/api/v1/campaigns", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const authorizedHeaders = { authorization: `Bearer ${authorization.secretKey}` };
    expect((await authorizationApp(new Request("http://local/api/v1/campaigns", { headers: authorizedHeaders }))).status).toBe(200);
    expect((await authorizationApp(new Request("http://local/api/v1/campaigns", { headers: authorizedHeaders }))).status).toBe(429);
    const sdkAuthorization = createLocalProduct({ sdkRateLimit: { perMinute: 1, perHour: 1 } });
    const sdkAuthorizationApp = createApp(sdkAuthorization.handlers);
    const identify = (key: string, userId: string) => sdkAuthorizationApp(new Request("http://local/api/v1/identify", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    }));
    expect((await identify("wrong", "wrong")).status).toBe(401);
    expect((await identify(sdkAuthorization.publishableKey, "allowed")).status).toBe(200);
    expect((await identify(sdkAuthorization.publishableKey, "limited")).status).toBe(429);
    await sdkAuthorization.close();
    await authorization.close();
    await management.close();
    await hourly.close();
    await limited.close();
    await first.close();
    await second.close();
  });

  it("keeps management user ids separate from SDK external ids", async () => {
    const { call, publishable } = client();
    await call("/api/v1/identify", "POST", { userId: "first" }, publishable);
    const first = (await (await call("/api/v1/users")).json()).users[0];
    await call("/api/v1/identify", "POST", { userId: first.id }, publishable);
    expect((await (await call(`/api/v1/users/${first.id}`)).json()).user.externalUserId).toBe("first");
  });

  it("rejects empty foreign identifiers and overlong goal event names", async () => {
    const { call } = client();
    expect((await call("/api/v1/campaigns", "POST", {
      name: "Empty goal",
      message: { presentation: "toast", title: "Empty" },
      goalId: "",
    })).status).toBe(400);
    expect((await call("/api/v1/agent-runs", "POST", { kind: "test", goalId: "" })).status).toBe(400);
    expect((await call("/api/v1/agent-runs", "POST", { kind: "test", campaignId: "" })).status).toBe(400);
    expect((await call("/api/v1/segments", "POST", {
      key: "empty-agent-run",
      name: "Empty agent run",
      expression: planExpression("free"),
      agentRunId: "",
    })).status).toBe(400);
    expect((await call("/api/v1/goals", "POST", { name: "Too long", targetEvent: "x".repeat(81) })).status).toBe(400);
    expect((await call("/api/v1/agent-runs", "POST", { kind: "test", idempotencyKey: "" })).status).toBe(400);
  });

  it("rejects equal keys, elapsed draft launch, Unicode overflow, and non-scalar trait filters", async () => {
    expect(() => createLocalProduct({ secretKey: "same", publishableKey: "same" })).toThrow("must differ");
    const { call, publishable, tick } = client();
    const draft = (await (await call("/api/v1/campaigns", "POST", {
      name: "Expires as draft", message: { presentation: "toast", title: "Draft" }, deliverUntil: 1_755_000_000_010,
    })).json()).campaign;
    tick(11);
    expect((await call(`/api/v1/campaigns/${draft.id}/status`, "POST", { action: "launch" })).status).toBe(409);
    expect((await call("/api/v1/agent-runs", "POST", { kind: "unicode", input: { value: "😀".repeat(5_000) } })).status).toBe(413);
    await call("/api/v1/identify", "POST", { userId: "scalar", traits: { plan: true, nested: { value: true } } }, publishable);
    expect((await (await call("/api/v1/users?traitKey=plan&traitValue=true")).json()).total).toBe(1);
    expect((await (await call("/api/v1/users?traitKey=nested&traitValue=%5Bobject%20Object%5D")).json()).total).toBe(0);
  });

  it("counts shown-only users as active", async () => {
    const { call, publishable, tick } = client();
    await call("/api/v1/identify", "POST", { userId: "shown-only" }, publishable);
    await call("/api/v1/campaigns", "POST", { name: "Shown", message: { presentation: "toast", title: "Shown" }, launch: true });
    tick(40 * 86_400_000);
    const message = (await (await call("/api/v1/messages?userId=shown-only", "GET", undefined, publishable)).json()).messages[0];
    await call(`/api/v1/deliveries/${message.deliveryId}/event`, "POST", { type: "shown" }, publishable);
    expect((await (await call("/api/v1/usage")).json()).activeUsers).toBe(1);
  });

  it("rejects cumulative merged traits above 64 KiB without partial mutation", async () => {
    const { call, publishable } = client();
    for (let index = 0; index < 16; index += 1) {
      expect((await call("/api/v1/identify", "POST", { userId: "traits", traits: { [`key_${index}`]: "x".repeat(3_900) } }, publishable)).status).toBe(200);
    }
    expect((await call("/api/v1/identify", "POST", { userId: "traits", traits: { overflow: "x".repeat(3_900) } }, publishable)).status).toBe(413);
    const user = (await (await call("/api/v1/users?q=traits")).json()).users[0];
    expect(user.traits.overflow).toBeUndefined();
  });
});
