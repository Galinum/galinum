import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInAppService } from "@galinum/core";
import { createPushEngine } from "@galinum/push";
import { createApp } from "./app.js";
import { createProduct, MemoryProductStore } from "./local-product.js";
import { MemoryMediaStore } from "./local-media-store.js";
import { createCommunicationHandler, invokeCommunication, authorizeManagementRead, authorizeOperation, resolveOperation, pushTransaction, inAppTransaction,
  type CommunicationServices, type ProjectAuthenticator, type ProjectPrincipal, type AuthorizedOperation, type ResolvedOperation } from "./communications.js";
import { keyAuthenticator, permits } from "./authorization.js";
import { OPERATIONS } from "./operations.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(projectId = "project") {
  const store = new MemoryProductStore(); const media = new MemoryMediaStore();
  const secret = randomBytes(32).toString("hex"); const publishable = randomBytes(24).toString("hex"); const agent = randomBytes(32).toString("hex");
  const digests = new Map<string, ProjectPrincipal>([
    [hash(secret), { projectId, credentials: [{ scheme: "secretKey" }] }],
    [hash(publishable), { projectId, credentials: [{ scheme: "publishableKey" }] }],
    [hash(agent), { projectId, credentials: [{ scheme: "hostedAgentKey", operations: ["listCampaigns"] }] }],
  ]);
  const authenticate = vi.fn<ProjectAuthenticator>(async (request) => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    return digests.get(hash(token)) ?? null;
  });
  const effects = { recordActivity: vi.fn(async () => {}) };
  const push = createPushEngine({ projectId, store: { transaction: (work) => store.transaction((tx) => work(pushTransaction(tx, effects, { projectId, vault: null, media }))) },
    vault: null, provider: { send: async () => { throw new Error("Provider must not run"); } }, maySend: async () => true, recordAcceptance: async () => {} });
  const inapp = createInAppService({ projectId, now: () => 1000, transaction: (work) => store.transaction((tx) => work(inAppTransaction(tx, media, projectId, effects))), mayServe: async () => true, recordExposure: async () => {} });
  const services: CommunicationServices<Parameters<Parameters<typeof store.transaction>[0]>[0]> = { projectId, installations: store, transaction: (work) => store.transaction(work), push, inapp, effects, now: () => 1000 };
  const handle = createCommunicationHandler(services, authenticate);
  const request = (path: string, method = "GET", body?: unknown, key = publishable, extra: Record<string, string> = {}) => new Request("https://fixture.test/api/v1/" + path, { method, headers: { authorization: "Bearer " + key, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { services, handle, request, authenticate, store, secret, publishable, agent, digests, effects };
}
function operation(request: Request): ResolvedOperation {
  const result = resolveOperation(request); if (result instanceof Response) throw new Error("Expected operation"); return result;
}
async function grant(f: ReturnType<typeof fixture>, request: Request, op = operation(request)): Promise<AuthorizedOperation> {
  const value = await authorizeOperation(op, request, f.authenticate); if (value instanceof Response) throw new Error("Expected authorization"); return value;
}

describe("configured bearer authentication", () => {
  const authenticate = keyAuthenticator({ projectId: "project", secretKey: "sk-secret", publishableKey: "pk-public-long" });
  it.each([null, "", "Basic sk-secret", "Bearer", "Bearer  sk-secret", "Bearer sk-secrex", "Bearer pk-public-lonx", "Bearer x", "Bearer sk-secret-extra", "Bearer sk-secré"])("rejects malformed or unequal credentials: %s", async (bearer) => {
    const request = new Request("https://fixture.test/api/v1/campaigns", { headers: bearer === null ? {} : { authorization: bearer } });
    expect(await authenticate(request, operation(request))).toBeNull();
  });
  it.each([["campaigns", "GET", "sk-secret", "secretKey"], ["identify", "POST", "pk-public-long", "publishableKey"]])("accepts the matching key for %s", async (path, method, key, scheme) => {
    const request = new Request("https://fixture.test/api/v1/" + path, { method, headers: { authorization: "Bearer " + key } });
    expect(await authenticate(request, operation(request))).toEqual({ projectId: "project", credentials: [{ scheme }] });
  });
  it("does not use a matching publishable key for a management operation", async () => {
    const request = new Request("https://fixture.test/api/v1/campaigns", { headers: { authorization: "Bearer pk-public-long" } });
    expect(await authenticate(request, operation(request))).toBeNull();
  });
});

describe("portable canonical authorization", () => {
  it("inherits SDK security and preserves management alternatives and installation AND requirements", () => {
    expect(OPERATIONS.find((op) => op.operationId === "identifyUser")?.security).toEqual([{ publishableKey: [] }]);
    expect(OPERATIONS.find((op) => op.operationId === "listCampaigns")?.security).toEqual([{ secretKey: [] }, { hostedAgentKey: [] }]);
    expect(OPERATIONS.find((op) => op.operationId === "getInstallation")?.security).toEqual([{ publishableKey: [], installationCapability: [] }]);
  });
  it("resolves preflight, methods and bad paths before host authentication", async () => {
    const f = fixture();
    const preflight = await f.handle(f.request("sdk/installations/device", "OPTIONS"));
    expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Galinum-Installation-Capability");
    expect((await f.handle(f.request("sdk/installations/%QQ"))).status).toBe(400);
    expect((await f.handle(f.request("messages", "PUT"))).status).toBe(404);
    expect((await f.handle(f.request("../operator/shipping-settings", "OPTIONS"))).status).toBe(404);
    expect(f.authenticate).not.toHaveBeenCalled();
  });
  it("rejects forged descriptors before calling the authenticator", async () => {
    const f = fixture(); const request = f.request("identify", "POST", { userId: "A" }); const actual = operation(request);
    const fake = { ...actual, security: [] };
    const response = await authorizeOperation(fake, request, f.authenticate);
    if (!(response instanceof Response)) throw new Error("Expected authorization rejection");
    expect(response.status).toBe(400);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(Object.isFrozen(actual.params)).toBe(true); expect(Object.isFrozen(actual.security)).toBe(true);
  });
  it("rejects forged and consumed grants and binds method/path/request identity", async () => {
    const f = fixture(); const request = f.request("identify", "POST", { userId: "A" }); const op = operation(request);
    expect((await invokeCommunication(op, request, { projectId: "project" }, f.services)).status).toBe(401);
    const approved = await grant(f, request, op);
    expect((await invokeCommunication(op, request, { ...approved }, f.services)).status).toBe(401);
    expect((await invokeCommunication(op, request, approved, f.services)).status).toBe(200);
    expect((await invokeCommunication(op, request, approved, f.services)).status).toBe(401);
    const second = f.request("identify", "POST", { userId: "B" }); const secondOp = operation(second); const secondGrant = await grant(f, second, secondOp);
    expect((await invokeCommunication(secondOp, f.request("track", "POST", { userId: "B", event: "event" }), secondGrant, f.services)).status).toBe(400);
    expect(await f.store.getUserByExternalId("B")).toBeNull();
  });
  it("rejects changed headers, descriptors and principal/service project mismatch before body reads", async () => {
    const f = fixture(); const other = fixture("other");
    for (const mismatch of ["headers", "descriptor", "project"] as const) {
      const request = f.request("identify", "POST", { userId: mismatch }); const op = operation(request); const approved = await grant(f, request, op);
      if (mismatch === "headers") request.headers.set("x-galinum-installation-capability", "changed");
      const response = await invokeCommunication(mismatch === "descriptor" ? operation(request) : op, request, approved, mismatch === "project" ? other.services : f.services);
      expect(response.status).toBe(mismatch === "project" ? 403 : 400); expect(request.bodyUsed).toBe(false);
    }
    expect(f.effects.recordActivity).not.toHaveBeenCalled(); expect(other.effects.recordActivity).not.toHaveBeenCalled();
  });
  it("never treats a hosted-agent key as a secret key, even with a claimed write scope", async () => {
    const f = fixture(); const read = f.request("campaigns", "GET", undefined, f.agent);
    expect(await authorizeOperation(operation(read), read, f.authenticate)).not.toBeInstanceOf(Response);
    const denied = f.request("goals", "GET", undefined, f.agent);
    const response = await authorizeOperation(operation(denied), denied, f.authenticate);
    if (!(response instanceof Response)) throw new Error("Expected authorization rejection");
    expect(response.status).toBe(403);
    f.digests.set(hash(f.agent), { projectId: "project", credentials: [{ scheme: "hostedAgentKey", operations: ["createCampaign", "configurePushCredential"] }] });
    const write = f.request("push/credentials", "PUT", {}, f.agent);
    expect((await f.handle(write)).status).toBe(403); expect(write.bodyUsed).toBe(false);
  });
  it("evaluates OR, AND, anonymous alternatives and required scopes without flattening", () => {
    const f = fixture(); const request = f.request("campaigns"); const base = operation(request);
    const principal: ProjectPrincipal = { projectId: "project", credentials: [{ scheme: "hostedAgentKey", scopes: ["read"], operations: ["listCampaigns"] }] };
    expect(permits({ ...base, security: [{ hostedAgentKey: ["read"] }, { secretKey: [] }] }, request, principal)).toBe(true);
    expect(permits({ ...base, security: [{ hostedAgentKey: ["write"] }] }, request, principal)).toBe(false);
    expect(permits({ ...base, security: [{ hostedAgentKey: ["read"], secretKey: [] }] }, request, principal)).toBe(false);
    expect(permits({ ...base, security: [] }, request, { projectId: "project", credentials: [] })).toBe(true);
    expect(permits({ ...base, security: [{}, { secretKey: [] }] }, request, { projectId: "project", credentials: [] })).toBe(true);
  });
});

describe("hashed credential communication fixture", () => {
  it("uses real hashed credential lookup without configuring or substituting self-host keys", async () => {
    const f = fixture(); const request = f.request("identify", "POST", { userId: "A", traits: { plan: "free" } });
    const authorization = request.headers.get("authorization"); expect((await f.handle(request)).status).toBe(200);
    expect(f.authenticate.mock.calls[0][0]).toBe(request); expect(request.headers.get("authorization")).toBe(authorization);
    expect((await f.store.getUserByExternalId("A"))?.traits).toEqual({ plan: "free" });
    expect((await f.handle(f.request("push/credentials", "GET", undefined, f.secret))).status).toBe(200);
    expect((await f.handle(f.request("push/credentials", "GET", undefined, "wrong"))).status).toBe(401);
  });
  it("keeps capability verification independent and scoped to the actual installation store", async () => {
    const f = fixture(); const other = fixture("other"); const capability = randomBytes(32).toString("base64url");
    expect((await f.handle(f.request("sdk/installations", "POST", { installationId: "device", appId: "app", platform: "ios", environment: "development", capability }))).status).toBe(200);
    expect((await f.handle(f.request("sdk/installations/device"))).status).toBe(401);
    expect((await f.handle(f.request("sdk/installations/device", "GET", undefined, f.publishable, { "X-Galinum-Installation-Capability": "wrong" }))).status).toBe(401);
    expect((await f.handle(f.request("sdk/installations/device", "GET", undefined, f.publishable, { "X-Galinum-Installation-Capability": capability }))).status).toBe(200);
    expect((await other.handle(other.request("sdk/installations/device", "GET", undefined, other.publishable, { "X-Galinum-Installation-Capability": capability }))).status).toBe(401);
    expect((await f.handle(f.request("sdk/installations/device", "GET", undefined, f.secret, { "X-Galinum-Installation-Capability": capability }))).status).toBe(403);
  });
  it("reads bounded streamed UTF8 without Content-Length and applies trusted identify traits only after client validation", async () => {
    const f = fixture();
    f.digests.set(hash(f.publishable), { projectId: "project", credentials: [{ scheme: "publishableKey" }], identifyTraits: { region: "south" } });
    const streamed = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      return new Request("https://fixture.test/api/v1/identify", { method: "POST", headers: { authorization: "Bearer " + f.publishable }, body: new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 37) controller.enqueue(bytes.slice(offset, offset + 37)); controller.close(); } }), ...{ duplex: "half" } });
    };
    const valid = streamed({ userId: "A", traits: { plan: "free" } }); expect(valid.headers.has("content-length")).toBe(false);
    expect((await f.handle(valid)).status).toBe(200); expect((await f.store.getUserByExternalId("A"))?.traits).toEqual({ plan: "free", region: "south" });
    expect((await f.handle(streamed({ userId: "B", traits: { text: "😀".repeat(3000) } }))).status).toBe(413);
    expect((await f.handle(streamed({ userId: "C", traits: { text: "😀".repeat(1100) } }))).status).toBe(400);
    expect(await f.store.getUserByExternalId("B")).toBeNull(); expect(await f.store.getUserByExternalId("C")).toBeNull();
    const bad = await f.handle(f.request("messages")); expect(bad.status).toBe(400); expect(bad.headers.get("cache-control")).toBe("no-store");
    expect(await bad.json()).toEqual({ error: "Invalid decision correlation or path" });
  });
  it("returns noncacheable domain/auth failures without exposing host exceptions", async () => {
    const f = fixture(); f.authenticate.mockRejectedValueOnce(new Error("private connection material"));
    const response = await f.handle(f.request("messages")); expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Authentication failed" });
  });
});


describe("trusted session push inspection authorization", () => {
  const read = () => new Request("https://fixture.test/api/v1/campaigns/campaign/push?page=1&perPage=25");
  const session = async () => ({ projectId: "project", operationId: "inspectPushCampaign" as const });
  it("invokes the canonical read with a credential-free one-use grant", async () => {
    const f = fixture(); const request = read(); const op = operation(request);
    const approved = await authorizeManagementRead(op, request, session);
    expect(approved).not.toBeInstanceOf(Response);
    if (approved instanceof Response) throw new Error("Expected grant");
    expect(Object.isFrozen(approved)).toBe(true);
    expect(request.headers.has("authorization")).toBe(false);
    expect((await invokeCommunication(op, request, approved, f.services)).status).toBe(404);
    expect((await invokeCommunication(op, request, approved, f.services)).status).toBe(401);
    expect(f.authenticate).not.toHaveBeenCalled();
  });
  it("reads a public API-created draft through a session host and rejects a cross-tenant campaign", async () => {
    const f = fixture(); const other = fixture("other");
    const product = createProduct(f.store, { projectId: "project", secretKey: f.secret, publishableKey: f.publishable });
    try {
      const created = await createApp(product.handlers)(f.request("campaigns", "POST", {
        name: "Session draft", channel: "push", push: { appId: "app", selection: { kind: "all" } },
        message: { title: "Title", body: "Body", destination: { kind: "app", url: "example://stored" } },
      }, f.secret));
      expect(created.status).toBe(201);
      const id = (await created.json()).campaign.id;
      for (const host of [f, other]) {
        const request = new Request(`https://fixture.test/api/v1/campaigns/${id}/push?page=1&perPage=25`);
        const op = operation(request);
        const approved = await authorizeManagementRead(op, request, async () => ({ projectId: host.services.projectId, operationId: "inspectPushCampaign" }));
        if (approved instanceof Response) throw new Error("Expected grant");
        const response = await invokeCommunication(op, request, approved, host.services);
        expect(response.status).toBe(host === f ? 200 : 404);
        if (host === f) expect(await response.json()).toMatchObject({ users: { targeted: 0 }, devices: { targeted: 0 }, targets: [], page: 1, perPage: 25 });
      }
    } finally { await product.close(); }
  });
  it.each(["campaigns", "campaigns/campaign/push/dispatch", "campaigns/campaign/push/test", "push/credentials", "sdk/installations/device"])("denies non-inspection operation %s before session authentication", async (path) => {
    const f = fixture(); const request = f.request(path, path.endsWith("dispatch") || path.endsWith("test") ? "POST" : "GET");
    const authenticate = vi.fn(session);
    const response = await authorizeManagementRead(operation(request), request, authenticate);
    if (!(response instanceof Response)) throw new Error("Expected authorization rejection");
    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it("rejects absent, revoked, malformed and failed host authentication without leaking details", async () => {
    const attempts = [async () => null, async () => null, async () => ({ projectId: "", operationId: "inspectPushCampaign" as const }), async () => { throw new Error("private session data"); }, async () => Response.json({ error: "Rate limited" }, { status: 429 })];
    for (const [index, authenticate] of attempts.entries()) {
      const request = read(); const response = await authorizeManagementRead(operation(request), request, authenticate);
      if (!(response instanceof Response)) throw new Error("Expected authorization rejection");
      expect(response.status).toBe([401, 401, 403, 500, 429][index]);
      expect(await response.text()).not.toContain("private session data");
    }
  });
  it.each(["headers-before", "headers-during", "clone-before", "descriptor-before"])("checks binding around session authentication: %s", async (change) => {
    const request = read(); const op = operation(request);
    const authenticate = vi.fn(async () => {
      if (change === "headers-during") request.headers.set("x-project", "other");
      return session();
    });
    if (change === "headers-before") request.headers.set("x-project", "other");
    const response = await authorizeManagementRead(change === "descriptor-before" ? { ...op } : op, change === "clone-before" ? request.clone() : request, authenticate);
    if (!(response instanceof Response)) throw new Error("Expected authorization rejection");
    expect(response.status).toBe(400);
    expect(authenticate).toHaveBeenCalledTimes(change === "headers-during" ? 1 : 0);
  });
  it.each(["headers", "clone", "descriptor", "project", "operation", "url", "method"])("rejects invocation mismatch and consumes the grant: %s", async (change) => {
    const f = fixture(); const request = read(); const op = operation(request);
    const approved = await authorizeManagementRead(op, request, session);
    if (approved instanceof Response) throw new Error("Expected grant");
    if (change === "headers") request.headers.set("x-project", "other");
    if (change === "url") Object.defineProperty(request, "url", { value: "https://fixture.test/api/v1/campaigns/other/push" });
    if (change === "method") Object.defineProperty(request, "method", { value: "POST" });
    const next = change === "operation" ? f.request("campaigns/campaign/push/dispatch", "POST") : change === "clone" ? request.clone() : request;
    const nextOp = change === "descriptor" ? { ...op } : change === "operation" ? operation(next) : op;
    const response = await invokeCommunication(nextOp, next, approved, change === "project" ? fixture("other").services : f.services);
    expect(response.status).toBe(change === "project" ? 403 : 400);
    expect((await invokeCommunication(op, request, approved, f.services)).status).toBe(401);
    expect(f.effects.recordActivity).not.toHaveBeenCalled();
  });
  it("leaves external headers and hosted-agent inspection policy unchanged", async () => {
    const f = fixture();
    expect((await f.handle(read())).status).toBe(401);
    expect((await f.handle(f.request("campaigns/campaign/push", "GET", undefined, f.secret))).status).toBe(404);
    f.digests.set(hash(f.agent), { projectId: "project", credentials: [{ scheme: "hostedAgentKey", operations: ["inspectPushCampaign"] }] });
    expect((await f.handle(f.request("campaigns/campaign/push", "GET", undefined, f.agent))).status).toBe(403);
    expect((await f.handle(f.request("campaigns/campaign/push", "GET", undefined, f.publishable))).status).toBe(403);
  });
});
