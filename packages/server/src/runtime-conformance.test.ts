import { generateKeyPairSync } from "node:crypto";
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
  const product = createLocalProduct({ now: () => 1_755_000_000_000, pushProvider: { async send() { return { kind: "accepted", providerId: "conformance-fixture" }; } } });
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
  const response = await client.call("/api/v1/messages?entryId=test-entry&requestId=test-request&path=%2Fdashboard&userId=user", "GET", undefined, true);
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

async function installationScenario(client: TestClient, operation: string) {
  const capability = "c".repeat(43);
  const base = "/api/v1/sdk/installations";
  await expectJson(await client.call(base, "POST", { installationId: "device", appId: "app", platform: "ios", environment: "development", capability }, true), 200, { installation: { id: "device" } });
  const headers = { authorization: `Bearer ${client.product.publishableKey}`, "X-Galinum-Installation-Capability": capability, "content-type": "application/json" };
  const bodies: Record<string, [string, string, object]> = {
    setInstallationBinding: ["binding", "PUT", { userId: null }],
    setInstallationFacts: ["facts", "PUT", { permission: "granted", consent: true, capabilities: { actions: [], channels: [], richImages: false } }],
    setInstallationToken: ["token", "PUT", { token: "native-token", tokenRevision: 0 }],
    recordInstallationActivity: ["activity", "POST", {}],
  };
  const mutation = bodies[operation];
  if (mutation) await expectJson(await client.app(new Request(`http://local${base}/device/${mutation[0]}`, { method: mutation[1], headers, body: JSON.stringify({ requestId: "request", bindingGeneration: 0, revision: 0, ...mutation[2] }) })), 200, { installation: { revision: 1 } });
  await expectJson(await client.app(new Request(`http://local${base}/device`, { headers })), 200, { installation: { id: "device" } });
  if (operation === "listInstallations") await expectJson(await client.call("/api/v1/installations"), 200, { total: 1 });
}

async function pushScenario(client: TestClient, operation: string) {
  const credential = { provider: "apns", teamId: "ABCDEFGHIJ", keyId: "0123456789", topic: "app", privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  await expectJson(await client.call("/api/v1/push/credentials/validate", "POST", { credential }), 200, { validation: "local_valid" });
  await expectJson(await client.call("/api/v1/push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 0, credential }), 200, { credential: { revision: 1 } });
  await installationScenario(client, "setInstallationFacts");
  await identify(client, "push-user");
  const headers = { authorization: `Bearer ${client.product.publishableKey}`, "X-Galinum-Installation-Capability": "c".repeat(43), "content-type": "application/json" };
  const mutate = (path: string, body: object) => client.app(new Request(`http://local/api/v1/sdk/installations/device/${path}`, { method: "PUT", headers, body: JSON.stringify(body) }));
  await mutate("binding", { requestId: "bind", revision: 1, bindingGeneration: 0, userId: "push-user" });
  await mutate("token", { requestId: "token", revision: 2, bindingGeneration: 1, tokenRevision: 0, token: "token" });
  await mutate("facts", { requestId: "facts", revision: 3, bindingGeneration: 1, permission: "granted", consent: true, capabilities: { actions: [], channels: [], richImages: false } });
  const response = await client.call("/api/v1/campaigns", "POST", { name: "Push", channel: "push", launch: true, push: { appId: "app", selection: { kind: "all" } }, message: { title: "Hello", body: "Body", destination: { kind: "website", url: "https://example.com" } } });
  expect(response.status).toBe(201);
  const campaign = (await response.json()).campaign;
  const dispatched = await client.call(`/api/v1/campaigns/${campaign.id}/push/dispatch`, "POST");
  expect(dispatched.status).toBe(200);
  const inspection = await dispatched.json();
  expect(inspection.users.accepted).toBe(1);
  if (operation === "testPushCampaign" || operation === "getPushTest") await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/push/test`, "POST", { installationId: "device", requestId: "test-1" }), 200, {});
  if (operation === "observeInstallationPush") await expectJson(await client.app(new Request("http://local/api/v1/sdk/installations/device/observations", { method: "POST", headers, body: JSON.stringify({ bindingGeneration: 1, commands: [{ id: "tap", sequence: 1, kind: "tap", targetId: inspection.targets[0].id, attemptId: inspection.attempts[0].id }] }) })), 200, { acknowledgedThrough: 1 });
  if (operation === "getPushTest") await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/push/tests/test-1`), 200, { requestId: "test-1" });
  await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/push`), 200, { users: { targeted: 1 } });
  await expectJson(await client.call("/api/v1/push/credentials"), 200, {});
}

const scenarios = {
  getPushTest: (client: TestClient) => pushScenario(client, "getPushTest"),
  configurePushCredential: (client: TestClient) => pushScenario(client, "configurePushCredential"),
  listPushCredentials: (client: TestClient) => pushScenario(client, "listPushCredentials"),
  validatePushCredential: (client: TestClient) => pushScenario(client, "validatePushCredential"),
  dispatchPushCampaign: (client: TestClient) => pushScenario(client, "dispatchPushCampaign"),
  testPushCampaign: (client: TestClient) => pushScenario(client, "testPushCampaign"),
  inspectPushCampaign: (client: TestClient) => pushScenario(client, "inspectPushCampaign"),
  observeInstallationPush: (client: TestClient) => pushScenario(client, "observeInstallationPush"),
  bootstrapInstallation: (client: TestClient) => installationScenario(client, "bootstrapInstallation"),
  getInstallation: (client: TestClient) => installationScenario(client, "getInstallation"),
  setInstallationBinding: (client: TestClient) => installationScenario(client, "setInstallationBinding"),
  setInstallationFacts: (client: TestClient) => installationScenario(client, "setInstallationFacts"),
  setInstallationToken: (client: TestClient) => installationScenario(client, "setInstallationToken"),
  recordInstallationActivity: (client: TestClient) => installationScenario(client, "recordInstallationActivity"),
  listInstallations: (client: TestClient) => installationScenario(client, "listInstallations"),
  async identifyUser(client) {
    await expectJson(await client.call("/api/v1/identify", "POST", { userId: "user" }, true), 200, { ok: true });
  },
  async trackEvent(client) {
    await expectJson(await client.call("/api/v1/track", "POST", { userId: "user", event: "activated" }, true), 200, { ok: true });
  },
  async getMessages(client) {
    const { campaign } = await createDelivery(client);
    const response = await client.call("/api/v1/messages?entryId=test-entry&requestId=test-request&path=%2Fdashboard&userId=user", "GET", undefined, true);
    await expectJson(response, 200, { messages: [{ campaignId: campaign.id, content: { title: "Welcome" } }] });
  },
  async recordDeliveryEvent(client) {
    const { delivery } = await createDelivery(client);
    await expectJson(await client.call(`/api/v1/deliveries/${delivery.deliveryId}/event`, "POST", { userId: "user", type: "shown", feedbackId: "user" + ":shown" }, true), 200, { type: "shown", userId: "user" });
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
  async getLaunchPolicy(client) {
    await expectJson(await client.call("/api/v1/launch-policy"), 200, { defaultMode: "automatic", revision: "0" });
  },
  async setLaunchPolicy(client) {
    await expectJson(await client.call("/api/v1/launch-policy", "PATCH", { defaultMode: "manual", expectedRevision: "0" }), 200, { defaultMode: "manual", revision: "1" });
    await expectJson(await client.call("/api/v1/launch-policy"), 200, { defaultMode: "manual", revision: "1" });
  },
  async getCampaignActivation(client) {
    const campaign = await createCampaign(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/activation`), 200, {
      campaignId: campaign.id, defaultMode: "automatic", effectiveMode: "automatic", revision: "0:0", launch: null,
    });
  },
  async setCampaignActivationMode(client) {
    const campaign = await createCampaign(client);
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/activation`, "PATCH", { mode: "manual", expectedRevision: "0:0" }), 200, {
      campaignId: campaign.id, override: "manual", effectiveMode: "manual", revision: "0:1",
    });
    await expectJson(await client.call(`/api/v1/campaigns/${campaign.id}/activation`), 200, { effectiveMode: "manual", revision: "0:1" });
  },
} satisfies Record<ProductOperationId, Scenario>;

const productOperations = OPERATIONS.filter((operation) => operation.availability === "product");
const cloudOperations = OPERATIONS.filter((operation) => operation.availability === "galinum_cloud");

describe("runtime operation conformance", () => {
  it("keeps the reviewed product registry complete", () => {
    expect(budget.missing).toEqual([]);
    expect(Object.keys(scenarios).sort()).toEqual(productOperations.map((operation) => operation.operationId).sort());
    expect(productOperations).toHaveLength(57);
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
