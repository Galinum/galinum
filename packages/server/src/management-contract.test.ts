import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";
import { decodeActivityCursor, encodeActivityCursor } from "./management-contract.js";

const CLOCK = Date.UTC(2026, 7, 20, 15, 30);
const DAY = 86_400_000;

function client(now = CLOCK) {
  let clock = now;
  const product = createLocalProduct({
    now: () => clock,
    sdkRateLimit: { perMinute: 100_000, perHour: 100_000 },
    managementRateLimit: { perMinute: 100_000, perHour: 100_000 },
  });
  const app = createApp(product.handlers, product.media);
  const call = async (path: string, method = "GET", value?: unknown, publishable = false) => {
    const response = await app(new Request(`http://local${path}`, {
      method,
      headers: {
        authorization: `Bearer ${publishable ? product.publishableKey : product.secretKey}`,
        "content-type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));
    return { status: response.status, body: await response.json() };
  };
  return { product, call, at: (value: number) => { clock = value; } };
}

async function campaignNamed(api: ReturnType<typeof client>, name: string, launch = false) {
  const created = await api.call("/api/v1/campaigns", "POST", {
    name,
    message: { presentation: "toast", title: name },
    launch,
  });
  expect(created.status).toBe(201);
  return created.body.campaign;
}

describe("management contract responses", () => {
  it("returns the overview shape from one evaluated instant", async () => {
    const api = client();
    await api.call("/api/v1/identify", "POST", { userId: "user_1" }, true);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "activated" }, true);
    api.at(CLOCK - 8 * DAY);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "stale" }, true);
    api.at(CLOCK);

    const overview = await api.call("/api/v1/overview");
    expect(overview.status).toBe(200);
    expect(overview.body).toEqual({ evaluatedAt: CLOCK, endUsers: 1, eventsLast7d: 1, activeCampaigns: 0 });
  });

  it("counts stored running campaigns even when scheduled or expired", async () => {
    const api = client();
    const scheduled = await campaignNamed(api, "Scheduled");
    await api.call(`/api/v1/campaigns/${scheduled.id}`, "PATCH", { deliverFrom: CLOCK + DAY });
    await api.call(`/api/v1/campaigns/${scheduled.id}/status`, "POST", { action: "launch" });
    api.at(CLOCK - 3 * DAY);
    const expired = await campaignNamed(api, "Expired");
    await api.call(`/api/v1/campaigns/${expired.id}`, "PATCH", { deliverUntil: CLOCK - DAY });
    await api.call(`/api/v1/campaigns/${expired.id}/status`, "POST", { action: "launch" });
    api.at(CLOCK);
    await campaignNamed(api, "Draft");

    const overview = await api.call("/api/v1/overview");
    expect(overview.body.activeCampaigns).toBe(2);
    const list = await api.call("/api/v1/campaigns?status=running");
    expect(list.body.total).toBe(0);
    expect((await api.call("/api/v1/campaigns?status=expired")).body.total).toBe(1);
    expect((await api.call("/api/v1/campaigns?status=scheduled")).body.total).toBe(1);
  });

  it("paginates and searches campaigns with the previous maximum as the default", async () => {
    const api = client();
    for (let index = 0; index < 4; index += 1) {
      api.at(CLOCK + index);
      await campaignNamed(api, index % 2 === 0 ? `Welcome ${index}` : `Reminder ${index}`);
    }
    api.at(CLOCK);

    const all = await api.call("/api/v1/campaigns");
    expect(all.body).toMatchObject({ total: 4, page: 1, pageCount: 1, evaluatedAt: CLOCK });
    expect(all.body.campaigns.map((campaign: { name: string }) => campaign.name)).toEqual([
      "Reminder 3", "Welcome 2", "Reminder 1", "Welcome 0",
    ]);
    for (const campaign of all.body.campaigns) expect(campaign.effectiveStatus).toBe("draft");

    const searched = await api.call("/api/v1/campaigns?q=WELCOME");
    expect(searched.body).toMatchObject({ total: 2, page: 1, pageCount: 1 });
    expect(searched.body.campaigns.map((campaign: { name: string }) => campaign.name)).toEqual(["Welcome 2", "Welcome 0"]);

    const second = await api.call("/api/v1/campaigns?perPage=2&page=2");
    expect(second.body).toMatchObject({ total: 4, page: 2, pageCount: 2 });
    expect(second.body.campaigns.map((campaign: { name: string }) => campaign.name)).toEqual(["Reminder 1", "Welcome 0"]);

    const empty = await api.call("/api/v1/campaigns?q=absent");
    expect(empty.body).toMatchObject({ campaigns: [], total: 0, page: 1, pageCount: 0 });
    expect((await api.call("/api/v1/campaigns?q=")).status).toBe(400);
    expect((await api.call(`/api/v1/campaigns?q=${"a".repeat(201)}`)).status).toBe(400);
  });

  it("returns evaluatedAt beside a single campaign", async () => {
    const api = client();
    const campaign = await campaignNamed(api, "Welcome");
    const response = await api.call(`/api/v1/campaigns/${campaign.id}`);
    expect(response.body.evaluatedAt).toBe(CLOCK);
    expect(response.body.campaign.effectiveStatus).toBe("draft");
  });

  it("filters events by bounded case-insensitive substring, exclusive with name", async () => {
    const api = client();
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "checkout_started" }, true);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "checkout_completed" }, true);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "signup" }, true);

    const searched = await api.call("/api/v1/events?q=CHECKOUT");
    expect(searched.body).toMatchObject({ total: 2, page: 1, pageCount: 1 });
    const exact = await api.call("/api/v1/events?name=signup");
    expect(exact.body.total).toBe(1);
    const filtered = await api.call("/api/v1/events?q=checkout&since=" + CLOCK);
    expect(filtered.body.total).toBe(2);

    expect((await api.call("/api/v1/events?q=checkout&name=signup")).status).toBe(400);
    expect((await api.call("/api/v1/events?q=")).status).toBe(400);
    expect((await api.call("/api/v1/events?q=absent")).body).toMatchObject({ events: [], total: 0, pageCount: 0 });
  });

  it("adds bounded references only for include=names", async () => {
    const api = client();
    const goal = (await api.call("/api/v1/goals", "POST", { name: "Activation" })).body.goal;
    const campaign = await campaignNamed(api, "Welcome");
    await api.call("/api/v1/agent-runs", "POST", { kind: "evaluation", goalId: goal.id, campaignId: campaign.id });
    await api.call("/api/v1/agent-runs", "POST", { kind: "evaluation", input: { goalId: "gl_hidden" } });

    const plain = await api.call("/api/v1/agent-runs");
    expect(plain.body.references).toBeUndefined();

    const named = await api.call("/api/v1/agent-runs?include=names");
    expect(named.body.references).toEqual({
      goals: { [goal.id]: "Activation" },
      campaigns: { [campaign.id]: "Welcome" },
    });
    expect((await api.call("/api/v1/agent-runs?include=other")).status).toBe(400);
  });

  it("pages activity on a stable cursor without duplicates", async () => {
    const api = client();
    const campaign = await campaignNamed(api, "Welcome", true);
    for (let index = 0; index < 5; index += 1) {
      api.at(CLOCK + index);
      await api.call("/api/v1/identify", "POST", { userId: `user_${index}` }, true);
      await api.call(`/api/v1/messages?userId=user_${index}`, "GET", undefined, true);
    }
    api.at(CLOCK);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const path = cursor === null ? "/api/v1/activity?limit=3" : `/api/v1/activity?limit=3&cursor=${cursor}`;
      const response = await api.call(path);
      expect(response.status).toBe(200);
      expect(response.body.evaluatedAt).toBe(CLOCK);
      for (const item of response.body.items) seen.push(`${item.kind}:${item.id}`);
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(10);
    expect(seen.filter((value) => value.startsWith("delivery:"))).toHaveLength(5);

    const first = await api.call("/api/v1/activity?limit=1");
    expect(first.body.items[0]).toMatchObject({
      kind: "delivery",
      occurredAt: CLOCK + 4,
      user: { externalUserId: "user_4" },
      campaign: { id: campaign.id, name: "Welcome" },
      variant: { name: "A" },
    });
    expect(Object.keys(first.body.items[0]).sort()).toEqual(["campaign", "id", "kind", "occurredAt", "user", "variant"]);

    expect((await api.call("/api/v1/activity?cursor=not-a-cursor")).status).toBe(400);
    expect((await api.call("/api/v1/activity?limit=51")).status).toBe(400);
    expect((await api.call("/api/v1/activity?limit=0")).status).toBe(400);
  });

  it("keeps user items structured when a project has no deliveries", async () => {
    const api = client();
    await api.call("/api/v1/identify", "POST", { userId: "user_1" }, true);
    const response = await api.call("/api/v1/activity");
    expect(response.body.items).toHaveLength(1);
    expect(Object.keys(response.body.items[0]).sort()).toEqual(["id", "kind", "occurredAt", "user"]);
    expect(response.body.items[0]).toMatchObject({ kind: "user", occurredAt: CLOCK, user: { externalUserId: "user_1" } });
    expect(response.body.nextCursor).toBeNull();
  });

  it("drains a long activity feed one small page at a time", async () => {
    const api = client();
    await campaignNamed(api, "Welcome", true);
    for (let index = 0; index < 12; index += 1) {
      api.at(CLOCK + index);
      await api.call("/api/v1/identify", "POST", { userId: `user_${index}` }, true);
      await api.call(`/api/v1/messages?userId=user_${index}`, "GET", undefined, true);
    }
    api.at(CLOCK);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 40; page += 1) {
      const path = cursor === null ? "/api/v1/activity?limit=2" : `/api/v1/activity?limit=2&cursor=${cursor}`;
      const response = await api.call(path);
      expect(response.status).toBe(200);
      for (const item of response.body.items) seen.push(`${item.kind}:${item.id}`);
      cursor = response.body.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(24);
    expect(seen.filter((value) => value.startsWith("delivery:"))).toHaveLength(12);
    expect(seen.filter((value) => value.startsWith("user:"))).toHaveLength(12);
  });

  it("buckets metrics by UTC day and ends on the day holding evaluatedAt", async () => {
    const api = client();
    api.at(CLOCK - 2 * DAY);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "activated" }, true);
    api.at(CLOCK);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "activated" }, true);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "signup" }, true);
    api.at(CLOCK + DAY);
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "future" }, true);
    api.at(CLOCK);

    const metrics = await api.call("/api/v1/metrics?range=7d");
    expect(metrics.status).toBe(200);
    expect(metrics.body.timezone).toBe("UTC");
    expect(metrics.body.evaluatedAt).toBe(CLOCK);
    expect(metrics.body.days).toHaveLength(7);
    const lastDay = metrics.body.days.at(-1);
    expect(lastDay.startAt).toBe(Math.floor(CLOCK / DAY) * DAY);
    expect(lastDay).toEqual({ startAt: lastDay.startAt, impressions: 0, clicks: 0, conversions: 0, events: 2 });
    expect(metrics.body.days[4]).toMatchObject({ events: 1 });
    expect(metrics.body.days[0]).toMatchObject({ events: 0, impressions: 0, clicks: 0, conversions: 0 });
    expect(metrics.body.totals).toEqual({ impressions: 0, clicks: 0, conversions: 0, events: 3 });
    expect(metrics.body.topEvents).toEqual([{ name: "activated", count: 2 }, { name: "signup", count: 1 }]);
    expect(metrics.body.hasAnyActivity).toBe(true);

    expect((await api.call("/api/v1/metrics?range=30d")).body.days).toHaveLength(30);
    expect((await api.call("/api/v1/metrics")).body.days).toHaveLength(30);
    expect((await api.call("/api/v1/metrics?range=90d")).body.days).toHaveLength(90);
    expect((await api.call("/api/v1/metrics?range=1d")).status).toBe(400);
    expect((await api.call("/api/v1/overview")).body.eventsLast7d).toBe(3);
  });

  it("reports no activity for an untouched project and counts any delivery", async () => {
    const api = client();
    const quiet = await api.call("/api/v1/metrics");
    expect(quiet.body.hasAnyActivity).toBe(false);
    expect(quiet.body.topEvents).toEqual([]);
    expect(quiet.body.totals).toEqual({ impressions: 0, clicks: 0, conversions: 0, events: 0 });

    api.at(CLOCK - 60 * DAY);
    await campaignNamed(api, "Welcome", true);
    await api.call("/api/v1/identify", "POST", { userId: "user_1" }, true);
    await api.call("/api/v1/messages?userId=user_1", "GET", undefined, true);
    api.at(CLOCK);
    const later = await api.call("/api/v1/metrics?range=7d");
    expect(later.body.totals.impressions).toBe(0);
    expect(later.body.hasAnyActivity).toBe(true);
  });

  it("counts impressions, clicks, and conversions from delivery timestamps", async () => {
    const api = client();
    await campaignNamed(api, "Welcome", true);
    await api.call("/api/v1/identify", "POST", { userId: "user_1" }, true);
    const messages = await api.call("/api/v1/messages?userId=user_1", "GET", undefined, true);
    const deliveryId = messages.body.messages[0].deliveryId;
    await api.call(`/api/v1/deliveries/${deliveryId}/event`, "POST", { type: "clicked" }, true);

    const metrics = await api.call("/api/v1/metrics?range=7d");
    expect(metrics.body.totals).toMatchObject({ impressions: 1, clicks: 1, conversions: 0 });
    expect(metrics.body.days.at(-1)).toMatchObject({ impressions: 1, clicks: 1 });
  });

  it("summarizes users over the only supported window", async () => {
    const api = client();
    api.at(CLOCK - 30 * DAY);
    await api.call("/api/v1/identify", "POST", { userId: "old" }, true);
    api.at(CLOCK - 2 * DAY);
    await api.call("/api/v1/identify", "POST", { userId: "recent" }, true);
    api.at(CLOCK);

    const summary = await api.call("/api/v1/users/summary");
    expect(summary.body).toEqual({
      evaluatedAt: CLOCK,
      window: "7d",
      startAt: CLOCK - 7 * DAY,
      totalUsers: 2,
      activeUsers: 1,
      newUsers: 1,
    });
    expect((await api.call("/api/v1/users/summary?window=7d")).body.totalUsers).toBe(2);
    expect((await api.call("/api/v1/users/summary?window=30d")).status).toBe(400);
  });

  it("keeps the user summary route ahead of the user lookup route", async () => {
    const api = client();
    await api.call("/api/v1/identify", "POST", { userId: "summary" }, true);
    const shadowed = await api.call("/api/v1/users/summary");
    expect(shadowed.body.window).toBe("7d");
    expect(shadowed.body.user).toBeUndefined();
    const nested = await api.call("/api/v1/users/summary/events");
    expect(nested.status).toBe(200);
    expect(nested.body).toMatchObject({ events: [], total: 0, pageCount: 0 });
  });

  it("lists a user's events in the existing wire shape", async () => {
    const api = client();
    await api.call("/api/v1/track", "POST", { userId: "user_1", event: "activated" }, true);
    await api.call("/api/v1/track", "POST", { userId: "user_2", event: "other" }, true);
    const user = (await api.call("/api/v1/users/user_1")).body.user;

    const byExternalId = await api.call("/api/v1/users/user_1/events");
    expect(byExternalId.body).toMatchObject({ total: 1, page: 1, pageCount: 1 });
    expect(Object.keys(byExternalId.body.events[0]).sort()).toEqual([
      "endUserId", "externalUserId", "id", "name", "props", "ts",
    ]);
    const byId = await api.call(`/api/v1/users/${user.id}/events`);
    expect(byId.body.events).toEqual(byExternalId.body.events);
    expect((await api.call("/api/v1/users/absent/events")).status).toBe(404);
    expect((await api.call("/api/v1/users/user_1/events?perPage=101")).status).toBe(400);
  });

  it("lists a user's deliveries with campaign and variant names", async () => {
    const api = client();
    const campaign = await campaignNamed(api, "Welcome", true);
    await api.call("/api/v1/identify", "POST", { userId: "user_1" }, true);
    const messages = await api.call("/api/v1/messages?userId=user_1", "GET", undefined, true);
    const deliveryId = messages.body.messages[0].deliveryId;

    const response = await api.call("/api/v1/users/user_1/deliveries");
    expect(response.body).toMatchObject({ total: 1, page: 1, pageCount: 1 });
    expect(response.body.deliveries[0]).toEqual({
      id: deliveryId,
      campaignId: campaign.id,
      campaignName: "Welcome",
      variantId: campaign.variants[0].id,
      variantName: "A",
      state: "queued",
      queuedAt: CLOCK,
    });
    expect((await api.call("/api/v1/users/absent/deliveries")).status).toBe(404);
    expect((await api.call("/api/v1/users/user_1/deliveries?perPage=0")).status).toBe(400);
  });

  it("returns pageCount 0 for every empty management list", async () => {
    const api = client();
    await api.call("/api/v1/identify", "POST", { userId: "user_1" }, true);
    for (const path of [
      "/api/v1/campaigns?q=absent",
      "/api/v1/events?q=absent",
      "/api/v1/users/user_1/events",
      "/api/v1/users/user_1/deliveries",
    ]) {
      const response = await api.call(path);
      expect(response.status, path).toBe(200);
      expect(response.body.pageCount, path).toBe(0);
      expect(response.body.total, path).toBe(0);
    }
  });

  it("round-trips activity cursors and rejects malformed values", () => {
    const cursor = { occurredAt: CLOCK, kind: "delivery" as const, id: "del_1" };
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
    for (const value of ["", "!!!", Buffer.from("abc").toString("base64url"), Buffer.from("1.other.x").toString("base64url"), Buffer.from("1.delivery.").toString("base64url")]) {
      expect(decodeActivityCursor(value)).toBeNull();
    }
  });
});
