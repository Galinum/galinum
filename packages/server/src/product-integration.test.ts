import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createProduct, MemoryProductStore, type ProductStore } from "./local-product.js";
import { createPostgresProduct, createPostgresProductStore } from "./postgres-product.js";
import { createPostgresActivationSessionData, type ActivationSessionDB } from "./activation/index.js";
import { lockProject } from "./project-fence.js";
import { campaignDefinitionReadiness, type CampaignReadinessResources, type RawCampaignDefinition } from "./activation/readiness.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const message = { title: "Ready", body: "Public push", destination: { kind: "website", url: "https://example.test/ready" } };
async function fixture(pg: boolean) {
  const projectId = "combined_" + randomUUID();
  const sent: string[] = []; let clock = 1780000000000;
  const options = { projectId, now: () => clock, pushEncryptionKey: randomBytes(32).toString("base64"),
    pushProvider: { send: async () => { sent.push("fixture-send"); return { kind: "accepted" as const, providerId: "fixture-only" }; } } };
  const store: ProductStore = pg ? await createPostgresProductStore({ ...options, connectionString: process.env.DATABASE_URL! }) : new MemoryProductStore();
  const product = createProduct(store, options); cleanup.push(() => product.close());
  const app = createApp(product.handlers, product.media, product.operatorHandler);
  const capability = randomBytes(32).toString("base64url");
  async function call(path: string, method = "GET", body?: unknown, sdk = false) {
    const response = await app(new Request("http://local/api/v1/" + path, { method, headers: { authorization: "Bearer " + (sdk ? product.publishableKey : product.secretKey), "content-type": "application/json", "x-galinum-installation-capability": capability }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  }
  async function configure() {
    const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect((await call("push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 0,
      credential: { provider: "apns", teamId: "ABCDEFGHIJ", keyId: "0123456789", topic: "app", privateKey } })).status).toBe(200);
  }
  async function install() {
    await call("identify", "POST", { userId: "A" }, true);
    const result = await call("sdk/installations", "POST", { installationId: "device", appId: "app", platform: "ios", environment: "development", capability }, true);
    expect(result.status).toBe(200);
    let state = result.body.installation;
    for (const [suffix, fields] of [["binding", { userId: "A" }], ["token", { token: "fixture", tokenRevision: 0 }], ["facts", { permission: "granted", consent: true, capabilities: { actions: [], categories: [], channels: [], richImages: false } }]] as const) {
      const value = await call("sdk/installations/device/" + suffix, "PUT", { requestId: randomUUID(), bindingGeneration: state.bindingGeneration, revision: state.revision, ...fields }, true);
      expect(value.status, JSON.stringify(value.body)).toBe(200); state = value.body.installation;
    }
  }
  const campaign = () => call("campaigns", "POST", { name: "Ready", channel: "push", launch: true, message, push: { appId: "app", selection: { kind: "all" } } });
  return { store, product, call, configure, install, campaign, sent, options, advance: () => { clock += 2000; } };
}
for (const pg of [false, true]) {
  const suite = pg && process.env.RUN_DB_INTEGRATION !== "1" ? describe.skip : describe;
  suite((pg ? "Postgres" : "memory") + " combined push activation", () => {
    it("denies unconfigured author-and-launch atomically, then records a real launch receipt", async () => {
      const f = await fixture(pg);
      expect((await f.campaign()).status).toBe(409);
      expect((await f.call("campaigns")).body.total).toBe(0);
      expect(await f.store.activation.preparationCampaignIds("", 10)).toEqual([]);
      await f.configure(); const created = await f.campaign(); expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.campaign.sourceChanges).toEqual({ revision: "0", changes: [] });
      expect((await f.call("campaigns/" + created.body.campaign.id + "/activation")).body.launch.mode).toBe("manual");
    });
    it("settles old-app slots even when the replacement app has no credential", async () => {
      const f = await fixture(pg); await f.configure(); await f.install(); const created = await f.campaign();
      const id = created.body.campaign.id; await f.product.push.plan(id);
      expect((await f.call("campaigns/" + id, "PATCH", { push: { appId: "unconfigured-app", selection: { kind: "all" } } })).status).toBe(200);
      await f.product.push.runCampaign(id);
      expect(f.sent).toEqual([]);
      expect((await f.product.push.inspect(id)).slots).toEqual([expect.objectContaining({ state: { kind: "closed", reason: "app_changed" } })]);
    });
    it("blocks changed raw definitions at dispatch and repairs without bypassing readiness", async () => {
      const f = await fixture(pg); await f.configure(); await f.install(); const created = await f.campaign();
      expect(created.status, JSON.stringify(created.body)).toBe(201); const id = created.body.campaign.id;
      const [target] = await f.product.push.plan(id); expect(target).toBeDefined();
      const original = await f.store.getCampaign(id);
      await f.store.transaction(async (tx) => { await tx.lockInstallations(); const value = (await tx.getCampaign(id))!; value.name = ""; await tx.saveCampaignContent(value); });
      await f.product.push.dispatch(target); expect(f.sent).toEqual([]);
      expect((await f.product.push.inspect(id)).outcomes[0].result).toEqual({ kind: "blocked", code: "readiness_failed" });
      await f.store.transaction(async (tx) => { await tx.lockInstallations(); await tx.saveCampaignContent(original!); });
      f.advance(); await f.product.push.processDue(); expect(f.sent).toHaveLength(1);
    });
  });
}

describe("combined raw readiness", () => {
  const definition: RawCampaignDefinition = { name: "Push", channel: "push", pushJson: JSON.stringify({ appId: "app", selection: { kind: "all" } }), goalId: null,
    pages: null, deliverFrom: null, deliverUntil: null, audience: { kind: "all" }, variants: [{ id: "v", name: "A", weight: 1, isControl: false, contentJson: JSON.stringify(message) }] };
  const resources: CampaignReadinessResources = { getGoal: async () => null, getAudienceVersion: async () => null, getMedia: async () => null,
    channelReadiness: async () => ({ ok: false, error: "Credential unavailable" }) };
  it("requires explicit push settings and a successful channel fact", async () => {
    expect((await campaignDefinitionReadiness("project", { ...definition, pushJson: undefined }, resources)).ok).toBe(false);
    expect(await campaignDefinitionReadiness("project", definition, resources)).toEqual({ ok: false, error: "Credential unavailable" });
    expect((await campaignDefinitionReadiness("project", { ...definition, pages: ["/page"] }, resources)).ok).toBe(false);
  });
});

const integration = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("combined PostgreSQL fences and borrowed activation", () => {
  it("makes activation edits wait for phase-two push under the same project fence", async () => {
    const f = await fixture(true); await f.configure(); await f.install(); const c = await f.campaign();
    const [target] = await f.product.push.plan(c.body.campaign.id);
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
    f.options.pushProvider.send = async () => { enter(); await pending; return { kind: "accepted", providerId: "fixture" }; };
    const send = f.product.push.dispatch(target); await entered;
    let acknowledged = false;
    const edit = f.product.activation.setLaunchPolicy(f.product.projectId, { defaultMode: "manual", expectedRevision: "0" }).then((value) => { acknowledged = true; return value; });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const result = await pool.query("select count(*)::int as count from pg_locks where locktype='advisory' and classid=74102 and not granted");
        if (result.rows[0].count > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true); expect(acknowledged).toBe(false);
    } finally { release(); await Promise.allSettled([send, edit]); await pool.end(); }
    expect(acknowledged).toBe(true);
  });
  it("borrows only activation/preparation tables and rolls host effects back on the exact transaction", async () => {
    const connection = new URL(process.env.DATABASE_URL!); const admin = new Pool({ connectionString: connection.href });
    const schema = "narrow_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`); connection.searchParams.set("options", "-csearch_path=" + schema);
    const pool = new Pool({ connectionString: connection.href });
    type DB = ActivationSessionDB & { host_effects: { id: string; transaction_id: string } };
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    try {
      await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
      await pool.query("DROP TABLE shipping_sources, shipping_project_controls");
      await pool.query("CREATE TABLE host_effects (id text primary key, transaction_id text not null)");
      await pool.query("INSERT INTO projects VALUES ('project','Project',1); INSERT INTO campaigns(id,project_id,name,created_at) VALUES ('campaign','project','Campaign',1)");
      await expect(db.transaction().execute(async (tx) => {
        await lockProject(tx, "project"); const data = createPostgresActivationSessionData(tx.$pickTables<keyof ActivationSessionDB>(), "project");
        await data.saveSettings({ defaultMode: "manual", policyVersion: 1, generation: 1, nextAttemptAt: 0, leaseToken: null, leaseGeneration: null, leaseExpiresAt: null, campaignCursor: "", lastError: null });
        await data.savePreparation("campaign", { version: 1, changes: [], approvedBy: null, approvedAt: null, reviewedContentHash: null });
        expect((await data.settings())?.generation).toBe(1);
        await tx.insertInto("host_effects").values({ id: "same-transaction", transaction_id: sql<string>`txid_current()::text` }).execute();
        expect(await tx.selectFrom("campaign_shipping_preparations").select("version").executeTakeFirst()).toBeDefined();
        throw new Error("rollback fixture");
      })).rejects.toThrow("rollback fixture");
      expect(await db.selectFrom("host_effects").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("project_launch_settings").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("campaign_shipping_preparations").selectAll().execute()).toEqual([]);
    } finally { await db.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  });
  it("does not accept a schema marker when communication constraints are missing", async () => {
    const connection = new URL(process.env.DATABASE_URL!); const admin = new Pool({ connectionString: connection.href });
    const schema = "constraints_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`); connection.searchParams.set("options", "-csearch_path=" + schema); const pool = new Pool({ connectionString: connection.href });
    try {
      await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
      await pool.query("ALTER TABLE installations DROP CONSTRAINT installations_project_id_token_scope_key");
      await expect(createPostgresProduct({ connectionString: connection.href })).rejects.toThrow("constraints are incomplete");
    } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  });
});

describe("combined memory staging", () => {
  it("keeps uncommitted push facts out of public reads and discards them on failure", async () => {
    const store = new MemoryProductStore();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; }); const held = new Promise<void>((resolve) => { release = resolve; });
    const write = store.transaction(async (tx) => { await tx.savePushControl("clock", { id: "clock", value: 1 }); enter(); await held; throw new Error("rollback"); });
    await entered;
    try { expect(await store.getPushRecord("clock", "clock")).toBeNull(); }
    finally { release(); await expect(write).rejects.toThrow("rollback"); }
    expect(await store.getPushRecord("clock", "clock")).toBeNull();
  });
});
