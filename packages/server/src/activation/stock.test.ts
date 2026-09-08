import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createLocalProduct, createProduct, MemoryProductStore, stockWebReadiness, type ProductCampaign, type ProductAgentRun } from "../local-product.js";
import { MemoryMediaStore } from "../local-media-store.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const sha = "a".repeat(40);
const credentials = { secretKey: "sk_stock_test", publishableKey: "pk_stock_test", operatorKey: "operator_stock_test" };
const message = { title: "Shipped", presentation: "toast" };
const source = { expectedRevision: "0", installationId: 7, repositoryId: 12, owner: "owner", name: "repo", branch: "main", enabled: true, paused: false };
const changes = [{ sourceId: "source", kind: "commit", sha }];
function githubFixture() {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: "fixture", expires_at: "2099-01-01T00:00:00Z" });
    if (url.pathname === "/repos/owner/repo") return Response.json({ id: 12, owner: { login: "owner" }, name: "repo", description: null, default_branch: "main", private: false, archived: false, disabled: false });
    if (url.pathname.endsWith("/branches/main")) return Response.json({ name: "main", commit: { sha }, protected: true });
    if (url.pathname.endsWith("/deployments")) return Response.json([{ id: 11, sha, environment: "production", created_at: "2026-01-01T00:00:00Z" }]);
    if (url.pathname.endsWith("/deployments/11/statuses")) return Response.json([{ id: 13, state: "success", environment: "production", created_at: "2026-01-01T00:00:01Z" }]);
    if (url.pathname.includes("/commits/")) return Response.json({ sha, commit: { message: "Feature" }, parents: [] });
    if (url.pathname.endsWith("/commits")) return Response.json([{ sha, commit: { message: "Feature" }, parents: [] }]);
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
  return { requests, github: { appId: 9, clientId: "Iv.fixture", privateKey, fetch: fetcher } };
}
function harness(store?: MemoryProductStore) {
  const fixture = githubFixture();
  const options = { ...credentials, github: fixture.github };
  const product = store ? createProduct(store, options) : createLocalProduct(options);
  const app = createApp(product.handlers, product.media, product.operatorHandler);
  const request = async (path: string, method = "GET", value?: unknown, key = credentials.secretKey) => {
    const response = await app(new Request(`http://local${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }));
    return { status: response.status, value: response.status === 204 ? null : await response.json() };
  };
  const operator = (path: string, method = "GET", value?: unknown) => request(path, method, value, credentials.operatorKey);
  return { product, request, operator, ...fixture };
}
async function prepare(h: ReturnType<typeof harness>) {
  expect((await h.operator("/operator/sources/source", "PUT", source)).status).toBe(200);
  expect((await h.operator("/operator/mappings", "POST", { id: null, expectedVersion: null, repositoryId: "12", environment: "production", sourceIds: ["source"], scopeDescription: "Entire repository", confirmed: true })).status).toBe(200);
  const created = await h.request("/api/v1/campaigns", "POST", { name: "Release", message, sourceChanges: { changes } });
  expect(created.status).toBe(201);
  return created.value.campaign.id as string;
}

describe("stock activation composition", () => {
  it.each([{ branch: "invalid..branch" }, { owner: "." }, { name: ".." }])("rejects invalid disabled-source identity %j without provider requests", async invalid => {
    const h = harness();
    try {
      expect((await h.operator("/operator/sources/source", "PUT", { ...source, ...invalid, enabled: false })).status).toBe(400);
      expect(h.requests).toEqual([]);
      expect((await h.operator("/operator/shipping")).value.sources).toEqual([]);
    } finally { await h.product.close(); }
  });
  it("uses real GitHub transport, operator review, worker, and normal SDK delivery", async () => {
    const h = harness();
    const id = await prepare(h);
    const review = await h.operator(`/operator/campaigns/${id}/review`);
    expect((await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision })).status).toBe(200);
    for (let i = 0; i < 5; i++) await h.product.activation.reconcile(h.product.projectId);
    const detail = await h.request(`/api/v1/campaigns/${id}`);
    expect(detail.value.campaign.status).toBe("running");
    const activation = await h.request(`/api/v1/campaigns/${id}/activation`);
    expect(activation.value.launch).toMatchObject({ mode: "automatic" });
    expect(h.requests.some((path) => path.endsWith("/deployments"))).toBe(true);
    await h.request("/api/v1/identify", "POST", { userId: "reader" }, credentials.publishableKey);
    const delivered = await h.request("/api/v1/messages?userId=reader&entryId=activation-entry&requestId=activation-request&path=%2F", "GET", undefined, credentials.publishableKey);
    expect(delivered.value.messages).toHaveLength(1);
    await h.product.close();
  });

  it("rejects drafting credentials, forged approval fields and stale content/source edits atomically", async () => {
    const h = harness();
    const id = await prepare(h);
    const review = await h.operator(`/operator/campaigns/${id}/review`);
    expect((await h.request(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision })).status).toBe(401);
    expect((await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision, approvedBy: "forged" })).status).toBe(400);
    expect((await h.request(`/api/v1/campaigns/${id}`, "PATCH", { name: "Wrong", sourceChanges: { expectedRevision: "0", changes: [] } })).status).toBe(409);
    const unchanged = await h.request(`/api/v1/campaigns/${id}`);
    expect(unchanged.value.campaign).toMatchObject({ name: "Release", sourceChanges: { revision: "1", changes } });
    expect((await h.request(`/api/v1/campaigns/${id}`, "PATCH", { name: "Changed" })).status).toBe(200);
    expect((await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision })).status).toBe(409);
    const fresh = await h.operator(`/operator/campaigns/${id}/review`);
    expect((await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: fresh.value.revision })).status).toBe(200);
    expect((await h.request(`/api/v1/campaigns/${id}`, "PATCH", { sourceChanges: { expectedRevision: "1", changes: [] } })).status).toBe(200);
    expect((await h.request(`/api/v1/campaigns/${id}/activation`)).value.approval).toBe("approved");
    await h.product.worker.tick();
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign.status).toBe("draft");
    await h.product.close();
  });

  it("exposes four management controls and honors operator project and source pause", async () => {
    const h = harness();
    const id = await prepare(h);
    const policy = await h.request("/api/v1/launch-policy");
    expect(policy.status).toBe(200);
    expect((await h.request("/api/v1/launch-policy", "PATCH", { expectedRevision: policy.value.revision, defaultMode: "manual" })).status).toBe(200);
    const activation = await h.request(`/api/v1/campaigns/${id}/activation`);
    expect((await h.request(`/api/v1/campaigns/${id}/activation`, "PATCH", { expectedRevision: activation.value.revision, mode: "automatic" })).status).toBe(200);
    const review = await h.operator(`/operator/campaigns/${id}/review`);
    await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision });
    expect((await h.operator("/operator/shipping", "PATCH", { expectedRevision: "0", paused: true })).status).toBe(200);
    await h.product.activation.reconcile(h.product.projectId);
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign.status).toBe("draft");
    expect((await h.operator("/operator/shipping", "PATCH", { expectedRevision: "1", paused: false })).status).toBe(200);
    expect((await h.operator("/operator/sources/source", "PUT", { ...source, expectedRevision: "1", paused: true })).status).toBe(200);
    await h.product.activation.reconcile(h.product.projectId);
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign.status).toBe("draft");
    await h.product.close();
  });

  it("stages all memory state, hides pending writes, and retains queued root writes after rollback", async () => {
    const store = new MemoryProductStore();
    let release!: () => void;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failed = store.transaction(async (session) => {
      await session.identifyUser("rolled-back", {}, 1);
      await session.activation.saveControls({ paused: true, version: 1 });
      entered(); await gate; throw new Error("injected");
    });
    const asserted = expect(failed).rejects.toThrow("injected");
    await entry;
    expect(await store.getUserByExternalId("rolled-back")).toBeNull();
    expect((await store.activation.controls()).paused).toBe(false);
    const retained = store.identifyUser("retained", {}, 2);
    release(); await asserted; await retained;
    expect(await store.getUserByExternalId("rolled-back")).toBeNull();
    expect(await store.getUserByExternalId("retained")).not.toBeNull();
    expect((await store.activation.controls()).paused).toBe(false);
  });

  it("validates actual channel, variants and audience before manual launch", async () => {
    const store = new MemoryProductStore(); const h = harness(store);
    const created = await h.request("/api/v1/campaigns", "POST", { name: "Manual", message });
    const id = created.value.campaign.id;
    const campaign = (await store.getCampaign(id))!;
    await store.transaction((session) => session.saveCampaignContent({ ...campaign, variants: [{ ...campaign.variants[0], content_json: "{}" }] }));
    expect((await h.request(`/api/v1/campaigns/${id}/status`, "POST", { action: "launch" })).status).toBe(409);
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign.startedAt).toBeNull();
    const badChannel = { ...campaign, channel: "email" } as unknown as ProductCampaign;
    expect((await stockWebReadiness(store, badChannel, new MemoryMediaStore(), "local")).ok).toBe(false);
    await h.product.close();
  });

  it("rolls back source preparation, lifecycle, receipt and activity when a product write fails", async () => {
    class FaultStore extends MemoryProductStore {
      fault: "content" | "activity" | null = null;
      override async saveCampaignContent(campaign: ProductCampaign) {
        await super.saveCampaignContent(campaign);
        if (this.fault === "content") throw new Error("injected content failure");
      }
      override async getOrCreateAgentRun(run: ProductAgentRun) {
        const result = await super.getOrCreateAgentRun(run);
        if (this.fault === "activity") throw new Error("injected activity failure");
        return result;
      }
    }
    const store = new FaultStore(); const h = harness(store);
    const id = await prepare(h);
    store.fault = "content";
    await expect(h.request(`/api/v1/campaigns/${id}`, "PATCH", { name: "Wrong", sourceChanges: { expectedRevision: "1", changes: [] } })).rejects.toThrow("injected content failure");
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign).toMatchObject({ name: "Release", sourceChanges: { revision: "1", changes } });
    store.fault = null;
    const review = await h.operator(`/operator/campaigns/${id}/review`);
    await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision });
    store.fault = "activity";
    await expect(h.product.activation.reconcile(h.product.projectId)).rejects.toThrow("injected activity failure");
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign).toMatchObject({ status: "draft", startedAt: null });
    expect(await store.activation.state(id)).toBeNull();
    expect((await store.queryAgentRuns({ kind: null, goalId: null, campaignId: id, offset: 0, limit: 10 })).values).toEqual([]);
    await h.product.close();
  });

  it("removes configuration without discarding receipts or inventing rollback", async () => {
    const h = harness(); const id = await prepare(h);
    const review = await h.operator(`/operator/campaigns/${id}/review`);
    await h.operator(`/operator/campaigns/${id}/approve`, "POST", { expectedRevision: review.value.revision });
    await h.product.activation.reconcile(h.product.projectId);
    const before = (await h.request(`/api/v1/campaigns/${id}/activation`)).value;
    expect(before.launch.mode).toBe("automatic");
    const second = await h.request("/api/v1/campaigns", "POST", { name: "Waiting", message, sourceChanges: { changes } });
    const other = second.value.campaign.id;
    const otherReview = await h.operator(`/operator/campaigns/${other}/review`);
    await h.operator(`/operator/campaigns/${other}/approve`, "POST", { expectedRevision: otherReview.value.revision });
    const settings = await h.operator("/operator/shipping"); const mapping = settings.value.mappings[0];
    expect((await h.operator(`/operator/mappings/${mapping.id}`, "DELETE", { expectedVersion: mapping.version })).status).toBe(204);
    await h.product.activation.reconcile(h.product.projectId);
    const after = (await h.request(`/api/v1/campaigns/${id}/activation`)).value;
    expect(after.launch).toEqual(before.launch);
    expect(after.warnings).toEqual(before.warnings);
    expect((await h.request(`/api/v1/campaigns/${id}`)).value.campaign.status).toBe("running");
    expect((await h.request(`/api/v1/campaigns/${other}`)).value.campaign.status).toBe("draft");
    await h.product.close();
  });

  it("rejects equal operator keys without disclosing their value", () => {
    expect(() => createLocalProduct({ ...credentials, operatorKey: credentials.secretKey })).toThrow("distinct");
    expect(() => createLocalProduct({ ...credentials, operatorKey: credentials.publishableKey })).toThrow("distinct");
  });
});
