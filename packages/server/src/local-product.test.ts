import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";

describe("local single-project path", () => {
  it("creates, serves, exposes, and converts a campaign", async () => {
    const product = createLocalProduct();
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };

    const goalResponse = await app(new Request("http://local/api/v1/goals", {
      method: "POST",
      headers: secret,
      body: JSON.stringify({ name: "Activation", targetEvent: "activated" }),
    }));
    expect(goalResponse.status).toBe(201);
    const goal = (await goalResponse.json()).goal;

    const campaignResponse = await app(new Request("http://local/api/v1/campaigns", {
      method: "POST",
      headers: secret,
      body: JSON.stringify({ name: "Welcome", message: { presentation: "toast", title: "Welcome" }, goalId: goal.id, launch: true }),
    }));
    expect(campaignResponse.status).toBe(201);
    const campaign = (await campaignResponse.json()).campaign;

    expect((await app(new Request("http://local/api/v1/identify", {
      method: "POST",
      headers: publishable,
      body: JSON.stringify({ userId: "user_1", traits: { plan: "free" } }),
    }))).status).toBe(200);

    const messagesResponse = await app(new Request("http://local/api/v1/messages?userId=user_1", { headers: publishable }));
    const messages = (await messagesResponse.json()).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toMatchObject({ title: "Welcome", presentation: "toast" });

    expect((await app(new Request(`http://local/api/v1/deliveries/${messages[0].deliveryId}/event`, {
      method: "POST",
      headers: publishable,
      body: JSON.stringify({ type: "shown" }),
    }))).status).toBe(200);

    expect((await app(new Request("http://local/api/v1/track", {
      method: "POST",
      headers: publishable,
      body: JSON.stringify({ userId: "user_1", event: "activated" }),
    }))).status).toBe(200);

    const detailResponse = await app(new Request(`http://local/api/v1/campaigns/${campaign.id}`, { headers: secret }));
    const detail = (await detailResponse.json()).campaign;
    expect(detail.stats.converted).toBe(1);
  });

  it("rejects the wrong credential kind", async () => {
    const product = createLocalProduct();
    const app = createApp(product.handlers);
    const response = await app(new Request("http://local/api/v1/campaigns", {
      headers: { authorization: `Bearer ${product.publishableKey}` },
    }));
    expect(response.status).toBe(401);
  });

  it("reads and updates the useful management API", async () => {
    let clock = 1_755_000_000_000;
    const product = createLocalProduct({ now: () => clock });
    const app = createApp(product.handlers);
    const secret = { authorization: `Bearer ${product.secretKey}`, "content-type": "application/json" };
    const publishable = { authorization: `Bearer ${product.publishableKey}`, "content-type": "application/json" };
    const request = (path: string, method = "GET", value?: unknown, headers = secret) => app(new Request(`http://local${path}`, {
      method,
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));

    const goalResponse = await request("/api/v1/goals", "POST", {
      name: "Activation",
      targetEvent: "activated",
      guardrails: { tone: "plain" },
      approvalMode: "auto",
    });
    const goal = (await goalResponse.json()).goal;
    expect(goalResponse.status).toBe(201);
    expect((await (await request(`/api/v1/goals/${goal.id}`)).json()).goal).toMatchObject({
      guardrails: { tone: "plain" },
      approvalMode: "auto",
    });
    const updatedGoalResponse = await request(`/api/v1/goals/${goal.id}`, "PATCH", {
      name: "Activated accounts",
      description: "Reach activation",
      status: "active",
    });
    expect((await updatedGoalResponse.json()).goal.name).toBe("Activated accounts");

    const campaignResponse = await request("/api/v1/campaigns", "POST", {
      name: "Welcome",
      message: { presentation: "toast", title: "Welcome" },
      goalId: goal.id,
      launch: true,
    });
    const campaign = (await campaignResponse.json()).campaign;
    const updateResponse = await request(`/api/v1/campaigns/${campaign.id}`, "PATCH", {
      name: "Welcome back",
      pages: ["/dashboard"],
      message: { presentation: "toast", title: "Updated" },
      deliverFrom: clock - 1,
      deliverUntil: clock + 10_000,
    });
    expect((await updateResponse.json()).campaign).toMatchObject({
      name: "Welcome back",
      pages: ["/dashboard"],
      deliverUntil: clock + 10_000,
      variants: [{ content: { title: "Updated", presentation: "toast" } }],
    });
    expect((await request(`/api/v1/campaigns/${campaign.id}`, "PATCH", { name: "Invalid mutation", pages: [42] })).status).toBe(400);
    expect((await (await request(`/api/v1/campaigns/${campaign.id}`)).json()).campaign.name).toBe("Welcome back");

    expect((await request("/api/v1/identify", "POST", { userId: "user_1", traits: { plan: "free", email: "ada@example.com" } }, publishable)).status).toBe(200);
    const listedUsers = await (await request("/api/v1/users?q=user&traitKey=plan&traitValue=free")).json();
    expect(listedUsers).toMatchObject({ total: 1, page: 1, pageCount: 1 });
    expect(listedUsers.users[0]).toMatchObject({ externalUserId: "user_1", traits: { plan: "free" } });
    expect((await (await request("/api/v1/users?q=ada%40example.com")).json()).total).toBe(1);
    expect((await (await request(`/api/v1/users/${listedUsers.users[0].id}`)).json()).user.externalUserId).toBe("user_1");

    const unsupported = (await (await request("/api/v1/messages?userId=user_1", "GET", undefined, publishable)).json()).messages;
    expect(unsupported).toEqual([]);
    const messages = (await (await request("/api/v1/messages?userId=user_1&pages=1", "GET", undefined, publishable)).json()).messages;
    expect(messages[0].content.title).toBe("Updated");
    expect((await request(`/api/v1/deliveries/${messages[0].deliveryId}/event`, "POST", { type: "shown" }, publishable)).status).toBe(200);
    clock += 1;
    expect((await request("/api/v1/track", "POST", { userId: "user_1", event: "activated", props: { source: "test" } }, publishable)).status).toBe(200);

    const listedEvents = await (await request("/api/v1/events?name=activated&externalUserId=user_1")).json();
    expect(listedEvents.events[0]).toMatchObject({ name: "activated", props: { source: "test" }, externalUserId: "user_1" });
    const deliveries = await (await request(`/api/v1/campaigns/${campaign.id}/deliveries?state=converted`)).json();
    expect(deliveries).toMatchObject({ total: 1, pageCount: 1 });
    expect(deliveries.deliveries[0]).toMatchObject({ externalUserId: "user_1", variantName: "A", state: "converted" });
    const conversions = await (await request(`/api/v1/campaigns/${campaign.id}/conversions?event=activated`)).json();
    expect(conversions).toMatchObject({
      campaignId: campaign.id,
      exposure: "shownAt",
      totals: { exposedDeliveries: 1, exposedUsers: 1, convertedDeliveries: 1, convertedUsers: 1 },
    });

    const runResponse = await request("/api/v1/agent-runs", "POST", {
      kind: "evaluation",
      goalId: goal.id,
      campaignId: campaign.id,
      input: { conversions: 1 },
      output: ["keep"],
      rationale: "The campaign converted.",
      idempotencyKey: "evaluation-1",
    });
    const run = (await runResponse.json()).run;
    expect(runResponse.status).toBe(201);
    const replayResponse = await request("/api/v1/agent-runs", "POST", { kind: "ignored", idempotencyKey: "evaluation-1" });
    expect(replayResponse.status).toBe(200);
    expect((await replayResponse.json()).run.id).toBe(run.id);
    const runs = await (await request(`/api/v1/agent-runs?campaignId=${campaign.id}`)).json();
    expect(runs).toMatchObject({ total: 1, runs: [{ id: run.id, kind: "evaluation" }] });

    const usage = await (await request("/api/v1/usage")).json();
    expect(usage).toMatchObject({ serving: "ok", emailServing: "paused", billable: false, activeUsers: 1, estimatedSpendUsd: 0 });
  });
});
