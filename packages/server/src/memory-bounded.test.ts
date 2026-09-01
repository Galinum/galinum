import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct, MemoryProductStore, type ProductCampaign, type ProductDelivery } from "./local-product.js";

describe("bounded memory store queries", () => {
  it("keeps exact totals across large filtered pages", async () => {
    let clock = 1_755_000_000_000;
    const product = createLocalProduct({
      now: () => clock,
      sdkRateLimit: { perMinute: 10_000, perHour: 10_000 },
      managementRateLimit: { perMinute: 10_000, perHour: 10_000 },
    });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    const call = (path: string, method = "GET", value?: unknown, headers = secret) => app(new Request(`http://local${path}`, {
      method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));
    const campaign = (await (await call("/api/v1/campaigns", "POST", {
      name: "Bounded memory", message: { presentation: "toast", title: "Bounded" }, launch: true,
    })).json()).campaign;
    for (let index = 0; index < 150; index += 1) {
      clock += 1;
      const userId = `user_${String(index).padStart(3, "0")}`;
      const kind = index % 2 === 0 ? "even" : "odd";
      await call("/api/v1/identify", "POST", { userId, traits: { kind } }, publishable);
      await call(`/api/v1/messages?userId=${userId}`, "GET", undefined, publishable);
      await call("/api/v1/track", "POST", { userId, event: kind }, publishable);
      await call("/api/v1/agent-runs", "POST", { kind });
    }
    const users = await (await call("/api/v1/users?traitKey=kind&traitValue=even&perPage=10&page=6")).json();
    expect(users).toMatchObject({ total: 75, page: 6, pageCount: 8 });
    expect(users.users).toHaveLength(10);
    const events = await (await call("/api/v1/events?name=even&perPage=10&page=6")).json();
    expect(events).toMatchObject({ total: 75, page: 6, pageCount: 8 });
    expect(events.events).toHaveLength(10);
    const runs = await (await call("/api/v1/agent-runs?kind=even&perPage=10&page=6")).json();
    expect(runs).toMatchObject({ total: 75, page: 6, pageCount: 8 });
    expect(runs.runs).toHaveLength(10);
    const deliveries = await (await call(`/api/v1/campaigns/${campaign.id}/deliveries?perPage=10&page=11`)).json();
    expect(deliveries).toMatchObject({ total: 150, page: 11, pageCount: 15 });
    expect(deliveries.deliveries).toHaveLength(10);

    for (let index = 0; index < 101; index += 1) {
      clock += 1;
      await call("/api/v1/goals", "POST", { name: `Goal ${index}` });
    }
    const goals = (await (await call("/api/v1/goals")).json()).goals;
    expect(goals).toHaveLength(100);
    expect(goals[0].name).toBe("Goal 100");
    expect(goals.at(-1).name).toBe("Goal 1");

    const segmentIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      clock += 1;
      const response = await call("/api/v1/segments", "POST", {
        key: `segment-${index}`,
        name: `Segment ${index}`,
        expression: { version: 1, root: { kind: "field", field: { kind: "trait", key: "kind" }, op: "eq", value: "even" } },
      });
      segmentIds.push((await response.json()).segment.id);
    }
    await call(`/api/v1/segments/${segmentIds.at(-1)}/archive`, "POST");
    const segments = (await (await call("/api/v1/segments")).json()).segments;
    expect(segments).toHaveLength(100);
    expect(segments[0]).toMatchObject({ name: "Segment 100", status: "archived" });
    const active = (await (await call("/api/v1/segments?status=active")).json()).segments;
    expect(active).toHaveLength(100);
    expect(active[0].name).toBe("Segment 99");
    expect((await (await call("/api/v1/segments?status=archived")).json()).segments).toEqual([expect.objectContaining({ name: "Segment 100" })]);
  });

  it("filters conversion candidates and frequency caps before returning", async () => {
    const store = new MemoryProductStore();
    await store.createGoal({ id: "matching", name: "Matching", description: null, targetEvent: "converted", guardrails: null, approvalMode: "auto", status: "active", createdAt: 1 });
    await store.createGoal({ id: "other", name: "Other", description: null, targetEvent: "other", guardrails: null, approvalMode: "auto", status: "active", createdAt: 1 });
    const campaign = (id: string, goalId: string): ProductCampaign => ({
      id, name: id, status: "running", channel: "web_inapp", goalId, createdAt: 1, startedAt: 1, endedAt: null,
      deliverFrom: null, deliverUntil: null, pages: null, audience: { kind: "all" },
      variants: [{ id: `variant-${id}`, campaign_id: id, name: "A", content_json: "{}", weight: 1, isControl: true }],
    });
    const delivery = (index: number): ProductDelivery => ({
      id: `delivery-${index}`, campaignId: `campaign-${index}`, variantId: `variant-campaign-${index}`, userId: "user",
      state: "queued", queuedAt: index, sentAt: null, deliveredAt: null,
      shownAt: index % 4 === 0 ? 100 : null, openedAt: null, clickedAt: null, dismissedAt: null,
      bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: index % 8 === 0 ? 90 : null,
    });
    for (let index = 0; index < 100; index += 1) {
      await store.createCampaign(campaign(`campaign-${index}`, index % 2 === 0 ? "matching" : "other"));
      await store.getOrCreateDelivery(delivery(index));
    }
    const candidates = await store.listConversionCandidatesForUpdate("user", "converted", 100);
    expect(candidates).toHaveLength(12);
    expect(candidates.every((candidate) => candidate.shownAt === 100 && candidate.convertedAt === null)).toBe(true);

    for (const [index, queuedAt] of [[100, 999], [101, 1_000], [102, 1_999], [103, 2_000]] as const) {
      await store.createCampaign(campaign(`campaign-${index}`, "matching"));
      await store.getOrCreateDelivery({ ...delivery(index), state: "frequency_capped", queuedAt, shownAt: null, convertedAt: null });
    }
    expect(await store.usageSummary(1_000, 2_000)).toMatchObject({ frequencyCapped: 2 });
    expect(await store.usageSummary(2_000, 3_000)).toMatchObject({ frequencyCapped: 1 });
  });
});
