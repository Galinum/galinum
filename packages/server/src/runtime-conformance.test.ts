import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";
import { OPERATIONS } from "./operations.js";

type ProductOperationId = Extract<(typeof OPERATIONS)[number], { availability: "product" }>["operationId"];
type TestClient = ReturnType<typeof testClient>;
type Scenario = (client: TestClient) => Promise<void>;

const budget = JSON.parse(
  readFileSync(new URL("../conformance-budget.json", import.meta.url), "utf8"),
) as { missing: string[] };

function testClient() {
  const product = createLocalProduct({ now: () => 1_755_000_000_000 });
  const app = createApp(product.handlers, product.media);
  const call = (path: string, method = "GET", value?: unknown, publishable = false) => app(new Request(`http://local${path}`, {
    method,
    headers: {
      authorization: `Bearer ${publishable ? product.publishableKey : product.secretKey}`,
      "content-type": "application/json",
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
  return { product, app, call };
}

async function expectJson(response: Response, status: number, expected: Record<string, unknown>) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject(expected);
}

const expression = {
  version: 1,
  root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" },
};

async function createGoal(client: TestClient) {
  const response = await client.call("/api/v1/goals", "POST", { name: "Activation", targetEvent: "activated" });
  expect(response.status).toBe(201);
  return (await response.json()).goal;
}

async function createCampaign(client: TestClient, launch = false) {
  const response = await client.call("/api/v1/campaigns", "POST", {
    name: "Welcome",
    message: { presentation: "toast", title: "Welcome" },
    launch,
  });
  expect(response.status).toBe(201);
  return (await response.json()).campaign;
}

async function identify(client: TestClient, userId = "user") {
  const response = await client.call("/api/v1/identify", "POST", { userId, traits: { plan: "free" } }, true);
  expect(response.status).toBe(200);
}

async function createDelivery(client: TestClient) {
  const campaign = await createCampaign(client, true);
  await identify(client);
  const response = await client.call("/api/v1/messages?userId=user", "GET", undefined, true);
  expect(response.status).toBe(200);
  return { campaign, delivery: (await response.json()).messages[0] };
}

async function createSegment(client: TestClient) {
  const response = await client.call("/api/v1/segments", "POST", {
    key: "free-users",
    name: "Free users",
    expression,
  });
  expect(response.status).toBe(201);
  return (await response.json()).segment;
}

const scenarios = {
  async identifyUser(client) {
    await expectJson(await client.call("/api/v1/identify", "POST", { userId: "user" }, true), 200, { ok: true });
  },
  async trackEvent(client) {
    await expectJson(await client.call("/api/v1/track", "POST", { userId: "user", event: "activated" }, true), 200, { ok: true });
  },
  async getMessages(client) {
    const { campaign } = await createDelivery(client);
    const response = await client.call("/api/v1/messages?userId=user", "GET", undefined, true);
    await expectJson(response, 200, { messages: [{ campaignId: campaign.id, content: { title: "Welcome" } }] });
  },
  async recordDeliveryEvent(client) {
    const { delivery } = await createDelivery(client);
    await expectJson(await client.call(`/api/v1/deliveries/${delivery.deliveryId}/event`, "POST", { type: "shown" }, true), 200, { ok: true });
  },
  async uploadCampaignMedia(client) {
    const bytes = Buffer.alloc(58);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "latin1");
    bytes.writeUInt32BE(10, 16);
    bytes.writeUInt32BE(10, 20);
    bytes.writeUInt32BE(1, 33);
    bytes.write("IDAT", 37, "latin1");
    bytes[41] = 1;
    bytes.write("IEND", 50, "latin1");
    const form = new FormData();
    form.set("file", new File([bytes], "image.png", { type: "image/png" }));
    const response = await client.app(new Request("http://local/api/v1/campaign-media", {
      method: "POST",
      headers: { authorization: `Bearer ${client.product.secretKey}` },
      body: form,
    }));
    await expectJson(response, 201, { media: { contentType: "image/png", width: 10, height: 10 } });
  },
  async listCampaigns(client) {
    const campaign = await createCampaign(client);
    await expectJson(await client.call("/api/v1/campaigns"), 200, { campaigns: [{ id: campaign.id }] });
  },
  async createCampaign(client) {
    const response = await client.call("/api/v1/campaigns", "POST", {
      name: "Created",
      message: { presentation: "toast", title: "Created" },
    });
    await expectJson(response, 201, { campaign: { name: "Created", status: "draft" } });
  },
  async getCampaign(client) {
    const campaign = await createCampaign(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}`), 200, { campaign: { id: campaign.id } });
  },
  async updateCampaign(client) {
    const campaign = await createCampaign(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}`, "PATCH", { name: "Updated" }), 200, { campaign: { name: "Updated" } });
  },
  async setCampaignStatus(client) {
    const campaign = await createCampaign(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/status`, "POST", { action: "launch" }), 200, { id: campaign.id, status: "running" });
  },
  async listCampaignDeliveries(client) {
    const { campaign, delivery } = await createDelivery(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/deliveries`), 200, { deliveries: [{ id: delivery.deliveryId }], total: 1 });
  },
  async getCampaignEventConversions(client) {
    const { campaign } = await createDelivery(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/conversions?event=activated`), 200, {
      campaignId: campaign.id,
      event: "activated",
      totals: { exposedDeliveries: 0, convertedDeliveries: 0 },
    });
  },
  async listUsers(client) {
    await identify(client);
    await expectJson(await client.call("/api/v1/users"), 200, { users: [{ externalUserId: "user" }], total: 1 });
  },
  async getUser(client) {
    await identify(client);
    const users = await (await client.call("/api/v1/users")).json();
    await expectJson(await client.call(`/api/v1/users/${users.users[0].id}`), 200, { user: { externalUserId: "user" } });
  },
  async listEvents(client) {
    await client.call("/api/v1/track", "POST", { userId: "user", event: "activated" }, true);
    await expectJson(await client.call("/api/v1/events"), 200, { events: [{ name: "activated" }], total: 1 });
  },
  async listGoals(client) {
    const goal = await createGoal(client);
    await expectJson(await client.call("/api/v1/goals"), 200, { goals: [{ id: goal.id }] });
  },
  async createGoal(client) {
    await expectJson(await client.call("/api/v1/goals", "POST", { name: "Activation" }), 201, { goal: { name: "Activation" } });
  },
  async getGoal(client) {
    const goal = await createGoal(client);
    await expectJson(await client.call(`/api/v1/goals/${goal.id}`), 200, { goal: { id: goal.id } });
  },
  async updateGoal(client) {
    const goal = await createGoal(client);
    await expectJson(await client.call(`/api/v1/goals/${goal.id}`, "PATCH", { name: "Updated" }), 200, { goal: { name: "Updated" } });
  },
  async listAgentRuns(client) {
    await client.call("/api/v1/agent-runs", "POST", { kind: "evaluation" });
    await expectJson(await client.call("/api/v1/agent-runs"), 200, { runs: [{ kind: "evaluation" }], total: 1 });
  },
  async createAgentRun(client) {
    await expectJson(await client.call("/api/v1/agent-runs", "POST", { kind: "evaluation" }), 201, { run: { kind: "evaluation" } });
  },
  async getAudienceCapabilities(client) {
    await identify(client);
    await expectJson(await client.call("/api/v1/audiences/capabilities"), 200, { capabilities: { traits: [{ key: "plan" }] } });
  },
  async checkAudience(client) {
    await identify(client);
    await expectJson(await client.call("/api/v1/audiences/check", "POST", { expression }), 200, { matchedCount: 1, totalUsers: 1 });
  },
  async explainAudience(client) {
    await identify(client);
    await expectJson(await client.call("/api/v1/audiences/explain", "POST", { expression, userId: "user" }), 200, { matched: true, user: { externalUserId: "user" } });
  },
  async listSegments(client) {
    const segment = await createSegment(client);
    await expectJson(await client.call("/api/v1/segments"), 200, { segments: [{ id: segment.id }] });
  },
  async createSegment(client) {
    await expectJson(await client.call("/api/v1/segments", "POST", { key: "free-users", name: "Free users", expression }), 201, {
      segment: { key: "free-users", currentVersion: 1 },
    });
  },
  async getSegment(client) {
    const segment = await createSegment(client);
    await expectJson(await client.call(`/api/v1/segments/${segment.id}`), 200, { segment: { id: segment.id } });
  },
  async updateSegment(client) {
    const segment = await createSegment(client);
    await expectJson(await client.call(`/api/v1/segments/${segment.id}`, "PATCH", { name: "Updated" }), 200, { segment: { name: "Updated" } });
  },
  async archiveSegment(client) {
    const segment = await createSegment(client);
    await expectJson(await client.call(`/api/v1/segments/${segment.id}/archive`, "POST"), 200, { segment: { status: "archived" } });
  },
  async listSegmentVersions(client) {
    const segment = await createSegment(client);
    await expectJson(await client.call(`/api/v1/segments/${segment.id}/versions`), 200, { segmentId: segment.id, versions: [{ version: 1 }] });
  },
  async getSegmentVersion(client) {
    const segment = await createSegment(client);
    await expectJson(await client.call(`/api/v1/segments/${segment.id}/versions/1`), 200, { segmentId: segment.id, version: { version: 1 } });
  },
  async getUsage(client) {
    await identify(client);
    await expectJson(await client.call("/api/v1/usage"), 200, { serving: "ok", activeUsers: 1, projects: [{ id: "local" }] });
  },
  async getProjectOverview(client) {
    await identify(client);
    await client.call("/api/v1/track", "POST", { userId: "user", event: "activated" }, true);
    await createCampaign(client, true);
    await expectJson(await client.call("/api/v1/overview"), 200, {
      evaluatedAt: 1_755_000_000_000,
      endUsers: 1,
      eventsLast7d: 1,
      activeCampaigns: 1,
    });
  },
  async listProjectActivity(client) {
    const { campaign, delivery } = await createDelivery(client);
    await expectJson(await client.call("/api/v1/activity"), 200, {
      evaluatedAt: 1_755_000_000_000,
      nextCursor: null,
      items: [
        { kind: "delivery", id: delivery.deliveryId, campaign: { id: campaign.id }, user: { externalUserId: "user" } },
        { kind: "user", user: { externalUserId: "user" } },
      ],
    });
  },
  async getProjectMetrics(client) {
    await client.call("/api/v1/track", "POST", { userId: "user", event: "activated" }, true);
    const response = await client.call("/api/v1/metrics");
    await expectJson(response, 200, {
      evaluatedAt: 1_755_000_000_000,
      timezone: "UTC",
      totals: { events: 1, impressions: 0, clicks: 0, conversions: 0 },
      topEvents: [{ name: "activated", count: 1 }],
      hasAnyActivity: true,
    });
  },
  async getUserSummary(client) {
    await identify(client);
    await expectJson(await client.call("/api/v1/users/summary"), 200, {
      evaluatedAt: 1_755_000_000_000,
      window: "7d",
      startAt: 1_755_000_000_000 - 7 * 86_400_000,
      totalUsers: 1,
      activeUsers: 1,
      newUsers: 1,
    });
  },
  async listUserEvents(client) {
    await client.call("/api/v1/track", "POST", { userId: "user", event: "activated" }, true);
    await expectJson(await client.call("/api/v1/users/user/events"), 200, {
      events: [{ name: "activated", externalUserId: "user" }],
      total: 1,
      page: 1,
      pageCount: 1,
    });
  },
  async listUserDeliveries(client) {
    const { campaign, delivery } = await createDelivery(client);
    await expectJson(await client.call("/api/v1/users/user/deliveries"), 200, {
      deliveries: [{ id: delivery.deliveryId, campaignId: campaign.id, campaignName: "Welcome", variantName: "A", state: "queued" }],
      total: 1,
      page: 1,
      pageCount: 1,
    });
  },
} satisfies Record<ProductOperationId, Scenario>;

const productOperations = OPERATIONS.filter((operation) => operation.availability === "product");
const cloudOperations = OPERATIONS.filter((operation) => operation.availability === "galinum_cloud");

describe("runtime operation conformance", () => {
  it("keeps the reviewed product registry complete", () => {
    expect(budget.missing).toEqual([]);
    expect(Object.keys(scenarios).sort()).toEqual(productOperations.map((operation) => operation.operationId).sort());
    expect(productOperations).toHaveLength(38);
  });

  for (const operation of productOperations) {
    it(`${operation.operationId} performs a valid operation`, async () => {
      const client = testClient();
      try {
        await scenarios[operation.operationId](client);
      } finally {
        await client.product.close();
      }
    });
  }

  it("keeps cloud-only operations unavailable locally", async () => {
    const client = testClient();
    try {
      for (const operation of cloudOperations) {
        const path = operation.path.replace(/\{[^}]+\}/g, "missing");
        const response = await client.app(new Request(`http://local${path}`, {
          method: operation.method,
          headers: { authorization: `Bearer ${client.product.secretKey}`, "content-type": "application/json" },
          ...(["GET", "HEAD"].includes(operation.method) ? {} : { body: "{}" }),
        }));
        await expectJson(response, 501, { operationId: operation.operationId, availability: "galinum_cloud" });
      }
    } finally {
      await client.product.close();
    }
  });
});
