import { createHash, randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createInAppService, type ProductDB } from "@galinum/core";
import { createEncryptedVault, createPushEngine, type PushHost, type PushEnvelope } from "@galinum/push";
import { createCommunicationHandler, PostgresCommunicationTransaction, pushTransaction, inAppTransaction, recordServerEvent, type CommunicationDB, type CommunicationEffects, type ActivityFact } from "./communications.js";
import { createApp } from "./app.js";
import { createLocalProduct, type LocalProductOptions } from "./local-product.js";
import { createPostgresProduct } from "./postgres-product.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("self-host communication effects", () => {
  it("emits one fresh event effect, no incidental identify, and restores activity on failure", async () => {
    let now = 1000; let fail = false;
    const effects: ActivityFact[] = [];
    const options: LocalProductOptions = { now: () => now, communicationEffects: { recordActivity: async (_tx, fact) => { if (fail) throw new Error("effect failed"); effects.push(fact); } } };
    const product = createLocalProduct(options); cleanup.push(() => product.close());
    const app = createApp(product.handlers);
    const call = (path: string, body: object) => app(new Request("http://local/api/v1/" + path, { method: "POST", headers: { authorization: "Bearer " + product.publishableKey, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await call("identify", { userId: "A", traits: { plan: "paid" } })).status).toBe(200);
    now = 2000;
    expect((await call("track", { userId: "A", event: "fresh", eventId: "stable", props: { count: 2 } })).status).toBe(200);
    expect(effects.map((x) => x.kind)).toEqual(["identify", "event"]);
    now = 3000;
    expect((await call("track", { userId: "A", event: "fresh", eventId: "stable", props: { count: 2 } })).status).toBe(200);
    expect(effects).toHaveLength(2);
    fail = true;
    const failed = await call("track", { userId: "A", event: "fresh", eventId: "retry" });
    expect(failed.status).toBe(500); expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await failed.json()).toEqual({ error: "Internal server error" });
    const read = await app(new Request("http://local/api/v1/users", { headers: { authorization: "Bearer " + product.secretKey } }));
    expect((await read.json()).users[0].lastSeenAt).toBe(2000);
    fail = false;
    expect((await call("track", { userId: "A", event: "fresh", eventId: "retry" })).status).toBe(200);
    expect(effects.map((x) => x.kind)).toEqual(["identify", "event", "event"]);
    expect((await call("identify", { userId: "A" })).status).toBe(200);
    expect(effects.at(-1)?.kind).toBe("identify");
  });
});

type FixtureDB = ProductDB & {
  projects: { id: string; name: string; created_at: number };
  fixture_ledger: { project_id: string; user_id: string; period: number };
  fixture_outbox: { project_id: string; id: string; dispatched: boolean };
  fixture_first_delivery: { project_id: string; delivery_id: string };
  fixture_effects: { project_id: string; id: string; kind: string; txid: string };
};
class FixtureData extends PostgresCommunicationTransaction {
  constructor(readonly executor: Transaction<FixtureDB>, projectId: string) {
    super(executor.$pickTables<keyof CommunicationDB>(), projectId);
  }
}
async function fixture() {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/galinum_installations_test_")) throw new Error("Disposable database required");
  const pool = new Pool({ connectionString: url.href });
  const db = new Kysely<FixtureDB>({ dialect: new PostgresDialect({ pool }) });
  cleanup.push(() => db.destroy());
  const identity = await sql<{ db: string; address: string; directory: string; version: string }>`select current_database() db, host(inet_server_addr()) address, current_setting('data_directory') directory, current_setting('server_version_num') version`.execute(db);
  expect(identity.rows[0]).toMatchObject({ db: url.pathname.slice(1), address: "127.0.0.1", directory: process.env.GALINUM_COMMUNICATIONS_DATA_DIRECTORY });
  expect(identity.rows[0].version.startsWith("17")).toBe(true);
  await sql`create table if not exists fixture_ledger(project_id text not null, user_id text not null, period bigint not null, primary key(project_id,user_id,period))`.execute(db);
  await sql`create table if not exists fixture_outbox(project_id text not null, id text not null, dispatched boolean not null default false, primary key(project_id,id))`.execute(db);
  await sql`create table if not exists fixture_first_delivery(project_id text not null, delivery_id text not null, primary key(project_id,delivery_id))`.execute(db);
  await sql`create table if not exists fixture_effects(project_id text not null, id text not null, kind text not null, txid text not null, primary key(project_id,id))`.execute(db);
  const projectId = "communication_" + randomUUID();
  let now = 1_770_000_000_000; let failing = "";
  const period = () => Math.floor(now / 86400000);
  const encryptionKey = randomBytes(32).toString("base64");
  const product = await createPostgresProduct({ connectionString: url.href, projectId, now: () => now, pushEncryptionKey: encryptionKey });
  cleanup.push(() => product.close());
  const app = createApp(product.handlers);
  async function call(path: string, body?: object, sdk = false, method = body ? "POST" : "GET") {
    const response = await app(new Request("http://local/api/v1/" + path, { method, headers: { authorization: "Bearer " + (sdk ? product.publishableKey : product.secretKey), "content-type": "application/json", "x-galinum-installation-capability": capability }, body: body ? JSON.stringify(body) : undefined }));
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBeLessThan(300); return value;
  }
  const capability = randomBytes(32).toString("base64url");
  await call("identify", { userId: "A", traits: { plan: "paid" } }, true);
  async function fact(data: FixtureData, kind: string, id: string, userId: string, at: number) {
    expect(data.executor.isTransaction).toBe(true);
    const txid = (await sql<{ id: string }>`select txid_current()::text id`.execute(data.executor)).rows[0].id;
    const sourceTxid = (await sql<{ id: string }>`select txid_current()::text id`.execute(data.executor.$pickTables<keyof CommunicationDB>())).rows[0].id;
    expect(txid).toBe(sourceTxid);
    await data.executor.insertInto("fixture_effects").values({ project_id: projectId, id, kind, txid }).execute();
    const fresh = await data.executor.insertInto("fixture_ledger").values({ project_id: projectId, user_id: userId, period: Math.floor(at / 86400000) }).onConflict((c) => c.columns(["project_id", "user_id", "period"]).doNothing()).returning("user_id").executeTakeFirst();
    if (fresh) await data.executor.insertInto("fixture_outbox").values({ project_id: projectId, id: `activity:${userId}:${Math.floor(at / 86400000)}`, dispatched: false }).execute();
    if (failing === kind) throw new Error("fixture effect failure");
  }
  const effects: CommunicationEffects<FixtureData> = {
    recordActivity: async (data, value) => {
      if (value.kind !== "event") throw new Error("Unexpected implicit identify");
      expect(await data.executor.selectFrom("events").select("id").where("id", "=", value.eventRowId).executeTakeFirst()).toBeDefined();
      await fact(data, "event", value.eventId, value.userId, value.occurredAt);
    },
    recordFirstDelivery: async (data, value) => {
      await data.executor.insertInto("fixture_first_delivery").values({ project_id: projectId, delivery_id: value.deliveryId }).execute();
      await data.executor.insertInto("fixture_outbox").values({ project_id: projectId, id: "delivery:" + value.deliveryId, dispatched: false }).execute();
      if (failing === "first") throw new Error("fixture first delivery failure");
    },
  };
  const withData = <T>(work: (data: FixtureData) => Promise<T>) => db.transaction().execute(async (executor) => {
    const data = new FixtureData(executor, projectId); await data.lockInstallations(); return work(data);
  });
  const sent: PushEnvelope[] = [];
  type PushTx = ReturnType<typeof pushTransaction<FixtureData>>;
  const host: PushHost<PushTx> = {
    projectId, now: () => now, vault: createEncryptedVault(encryptionKey),
    provider: { send: async (_credential, _installation, envelope) => { sent.push(envelope); return { kind: "accepted", providerId: "fixture-only" }; } },
    store: { transaction: (work) => withData((data) => work(pushTransaction(data, effects, { projectId, vault: host.vault, media: product.media }))) },
    maySend: async (tx) => { expect(tx.data.executor.isTransaction).toBe(true); return true; },
    recordAcceptance: async (tx, value) => {
      expect(await tx.data.executor.selectFrom("push_records").select("id").where("project_id", "=", projectId).where("kind", "=", "outcome").where("id", "=", value.id).executeTakeFirst()).toBeDefined();
      await fact(tx.data, "acceptance", value.id, value.userId, value.acceptedAt);
    },
  };
  const push = createPushEngine(host);
  const inapp = createInAppService<ReturnType<typeof inAppTransaction<FixtureData>>>({ projectId, now: () => now,
    transaction: (work) => withData((data) => work(inAppTransaction(data, product.media, projectId, effects))),
    mayServe: async (tx) => { expect(tx.data.executor.isTransaction).toBe(true); return true; },
    recordExposure: async (tx, value) => {
      expect(await tx.data.getInAppFeedback(value.id)).not.toBeNull();
      await fact(tx.data, "shown", value.id, value.userId, value.shownAt);
    },
  });
  const publicToken = randomBytes(24).toString("hex"); const secretToken = randomBytes(32).toString("hex");
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const storedPublic = hash(publicToken); const storedSecret = hash(secretToken);
  const portableHandler = createCommunicationHandler({ projectId, transaction: withData, installations: { transaction: withData, withReadSnapshot: withData }, push, inapp, effects, now: () => now }, async (request) => {
    const digest = hash(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    const scheme = digest === storedPublic ? "publishableKey" : digest === storedSecret ? "secretKey" : null;
    return scheme ? { projectId, credentials: [{ scheme }] } : null;
  });
  const portable = (path: string, body: object) => portableHandler(new Request("https://fixture.test/api/v1/" + path, { method: "POST", headers: { authorization: "Bearer " + publicToken, "content-type": "application/json", "x-galinum-installation-capability": capability }, body: JSON.stringify(body) }));
  async function install(id: string) {
    await call("sdk/installations", { installationId: id, appId: "app", platform: "ios", environment: "development", capability }, true);
    let state = (await call("sdk/installations/" + id, undefined, true)).installation;
    for (const [route, fields] of [["binding", { userId: "A" }], ["token", { token: "fixture-token-" + id, tokenRevision: 0 }], ["facts", { permission: "granted", consent: true, capabilities: { actions: [], categories: [], channels: [], richImages: false } }]] as const) {
      state = (await call("sdk/installations/" + id + "/" + route, { requestId: randomUUID(), bindingGeneration: state.bindingGeneration, revision: state.revision, ...fields }, true, "PUT")).installation;
    }
    return state;
  }
  async function campaign(channel: "push" | "web_inapp") {
    const goal = (await call("goals", { name: "Complete", targetEvent: "complete" })).goal;
    return (await call("campaigns", { name: channel, channel, goalId: goal.id, launch: true, ...(channel === "push" ? { push: { appId: "app", selection: { kind: "all" }, ttlSeconds: 172800 }, message: { title: "Fixture", body: "Body", destination: { kind: "website", url: "https://example.com/fixture" } } } : { message: { title: "Fixture", presentation: "toast" }, pages: ["/allowed*"] }) })).campaign;
  }
  async function configure() {
    const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await push.configure({ appId: "app", platform: "ios", environment: "development", expectedRevision: 0, credential: { provider: "apns", teamId: "ABCDEFGHIJ", keyId: "0123456789", topic: "app", privateKey } });
  }
  const counts = async () => ({
    effects: await db.selectFrom("fixture_effects").selectAll().where("project_id", "=", projectId).execute(),
    ledger: await db.selectFrom("fixture_ledger").selectAll().where("project_id", "=", projectId).execute(),
    outbox: await db.selectFrom("fixture_outbox").selectAll().where("project_id", "=", projectId).execute(),
    first: await db.selectFrom("fixture_first_delivery").selectAll().where("project_id", "=", projectId).execute(),
  });
  return { db, projectId, portable, call, withData, effects, push, inapp, sent, install, campaign, configure, capability, counts, period, now: () => now, advance: (ms = 86400000) => { now += ms; }, fail: (kind: string) => { failing = kind; } };
}

const pg = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;
pg("extended public communication transaction", () => {
  it.each([
    { channel: "email", shown: null, delivered: -1, converted: true },
    { channel: "email", shown: null, delivered: 0, converted: true },
    { channel: "email", shown: -1, delivered: null, converted: false },
    { channel: "email", shown: -1, delivered: 1, converted: false },
    { channel: "web_inapp", shown: -1, delivered: null, converted: true },
    { channel: "web_inapp", shown: 0, delivered: null, converted: true },
    { channel: "web_inapp", shown: null, delivered: -1, converted: false },
    { channel: "web_inapp", shown: 1, delivered: -1, converted: false },
    { channel: "push", shown: -1, delivered: -1, converted: false },
  ] as const)("converts only eligible channel exposure: $channel shown=$shown delivered=$delivered", async ({ channel, shown, delivered, converted }) => {
    const f = await fixture();
    const campaign = await f.campaign("web_inapp");
    await f.db.updateTable("campaigns").set({ channel }).where("id", "=", campaign.id).execute();
    const delivery = await f.withData(async (data) => data.getOrCreateDelivery({
      id: "del_" + randomUUID(), campaignId: campaign.id, variantId: campaign.variants[0].id,
      userId: (await data.getUserByExternalId("A"))!.id, state: "sent", queuedAt: f.now() - 10, sentAt: f.now() - 5,
      deliveredAt: delivered === null ? null : f.now() + delivered, shownAt: shown === null ? null : f.now() + shown,
      openedAt: null, clickedAt: null, dismissedAt: null, bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: null,
    }));
    const read = () => f.db.selectFrom("deliveries").select(["converted_at", "state"]).where("id", "=", delivery.id).executeTakeFirstOrThrow();
    await f.call("identify", { userId: "B" }, true);
    for (const event of [
      { userId: "B", event: "complete", eventId: "other-user" },
      { userId: "A", event: "other", eventId: "other-goal" },
    ]) expect((await f.portable("track", event)).status).toBe(200);
    expect((await read()).converted_at).toBeNull();
    const event = { userId: "A", event: "complete", eventId: "conversion" };
    expect((await f.portable("track", event)).status).toBe(200);
    const first = await read();
    expect(first).toEqual({ converted_at: converted ? String(f.now()) : null, state: converted ? "converted" : "sent" });
    const counts = await f.counts();
    f.advance(2);
    expect((await f.portable("track", event)).status).toBe(200);
    expect(await read()).toEqual(first);
    expect(await f.counts()).toEqual(counts);
    expect(await f.db.selectFrom("events").select("id").where("project_id", "=", f.projectId).execute()).toHaveLength(3);
    if (converted) {
      expect((await f.portable("track", { ...event, eventId: "later-conversion" })).status).toBe(200);
      expect(await read()).toEqual(first);
    }
  });

  it.each(["email", "web_inapp"] as const)("rejects a cross-project goal for an exposed %s campaign", async (channel) => {
    const f = await fixture();
    const other = await fixture();
    const foreignGoal = (await other.call("goals", { name: "Foreign goal", targetEvent: "complete" })).goal;
    const campaign = await f.campaign("web_inapp");
    await f.db.updateTable("campaigns").set({ channel, goal_id: foreignGoal.id }).where("id", "=", campaign.id).execute();
    const delivery = await f.withData(async (data) => data.getOrCreateDelivery({
      id: "del_" + randomUUID(), campaignId: campaign.id, variantId: campaign.variants[0].id,
      userId: (await data.getUserByExternalId("A"))!.id, state: "sent", queuedAt: f.now() - 10, sentAt: f.now() - 5,
      deliveredAt: channel === "email" ? f.now() - 1 : null, shownAt: channel === "web_inapp" ? f.now() - 1 : null,
      openedAt: null, clickedAt: null, dismissedAt: null, bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: null,
    }));
    const read = () => f.db.selectFrom("deliveries").select(["converted_at", "state"]).where("id", "=", delivery.id).executeTakeFirstOrThrow();
    expect((await f.portable("track", { userId: "A", event: "complete", eventId: "foreign-goal" })).status).toBe(200);
    expect(await read()).toEqual({ converted_at: null, state: "sent" });
    expect(await f.withData((data) => data.listConversionCandidatesForUpdate(delivery.userId, "complete", f.now()))).toEqual([]);
    await f.db.updateTable("campaigns").set({ goal_id: campaign.goalId }).where("id", "=", campaign.id).execute();
    expect((await f.portable("track", { userId: "A", event: "complete", eventId: "same-project-goal" })).status).toBe(200);
    expect(await read()).toEqual({ converted_at: String(f.now()), state: "converted" });
  });

  it("keeps an email event unconverted after a late delivery stamp and replay until a fresh eligible event", async () => {
    const f = await fixture();
    const campaign = await f.campaign("web_inapp");
    await f.db.updateTable("campaigns").set({ channel: "email" }).where("id", "=", campaign.id).execute();
    const delivery = await f.withData(async (data) => data.getOrCreateDelivery({
      id: "del_" + randomUUID(), campaignId: campaign.id, variantId: campaign.variants[0].id,
      userId: (await data.getUserByExternalId("A"))!.id, state: "sent", queuedAt: f.now() - 10, sentAt: f.now() - 5,
      deliveredAt: null, shownAt: null, openedAt: null, clickedAt: null, dismissedAt: null,
      bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: null,
    }));
    const read = () => f.db.selectFrom("deliveries").select("converted_at").where("id", "=", delivery.id).executeTakeFirstOrThrow();
    const event = { userId: "A", event: "complete", eventId: "before-stamp" };
    expect((await f.portable("track", event)).status).toBe(200);
    expect((await read()).converted_at).toBeNull();
    await f.withData(async (data) => { await data.saveDelivery({ ...delivery, state: "delivered", deliveredAt: f.now() - 1 }); });
    expect((await read()).converted_at).toBeNull();
    f.advance(1);
    expect((await f.portable("track", event)).status).toBe(200);
    expect((await read()).converted_at).toBeNull();
    expect((await f.portable("track", { ...event, eventId: "after-stamp" })).status).toBe(200);
    expect((await read()).converted_at).toBe(String(f.now()));
  });

  it("requires push engagement before a fresh goal event; a receipt and event replay cannot convert", async () => {
    const f = await fixture(); const device = await f.install("conversion-device"); await f.configure();
    const campaign = await f.campaign("push"); const [targetId] = await f.push.plan(campaign.id);
    await f.push.dispatch(targetId);
    const reference = { targetId, attemptId: f.sent[0].attemptId };
    const event = { userId: "A", event: "complete", eventId: "after-receipt" };
    await f.push.observe(device.id, f.capability, device.bindingGeneration, [{ kind: "receipt", id: "receipt", sequence: 1, ...reference }]);
    expect((await f.portable("track", event)).status).toBe(200);
    expect((await f.push.inspect(campaign.id)).users).toMatchObject({ engaged: 0, converted: 0 });
    await f.push.observe(device.id, f.capability, device.bindingGeneration, [{ kind: "tap", id: "tap", sequence: 2, ...reference }]);
    expect((await f.portable("track", event)).status).toBe(200);
    expect((await f.push.inspect(campaign.id)).users).toMatchObject({ engaged: 1, converted: 0 });
    expect((await f.portable("track", { ...event, eventId: "after-tap" })).status).toBe(200);
    expect((await f.push.inspect(campaign.id)).users).toMatchObject({ engaged: 1, converted: 1 });
    expect((await f.push.inspect(campaign.id)).conversions).toHaveLength(1);
  });

  it("invokes through hashed authorization while retaining the actual event/effect transaction", async () => {
    const f = await fixture(); f.fail("event");
    const input = { userId: "A", event: "complete", eventId: "portable-event", props: { retained: true } };
    const rejected = await f.portable("track", input); expect(rejected.status).toBe(500); expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(await f.counts()).toEqual({ effects: [], ledger: [], outbox: [], first: [] });
    expect(await f.db.selectFrom("events").selectAll().where("project_id", "=", f.projectId).execute()).toEqual([]);
    f.fail(""); expect((await f.portable("track", input)).status).toBe(200);
    const committed = await f.counts(); expect(committed.effects).toHaveLength(1); expect(committed.ledger).toHaveLength(1);
    f.advance(); expect((await f.portable("track", input)).status).toBe(200); expect(await f.counts()).toEqual(committed);
  });
  it("rolls back accepted outcomes and recovers uncertainty without pretending an effect retry is a send", async () => {
    const f = await fixture(); await f.install("device"); await f.configure(); const c = await f.campaign("push");
    const [target] = await f.push.plan(c.id); f.fail("acceptance");
    await expect(f.push.dispatch(target)).rejects.toThrow("fixture effect failure");
    expect(f.sent).toHaveLength(1);
    expect(await f.counts()).toEqual({ effects: [], ledger: [], outbox: [], first: [] });
    const before = await f.push.inspect(c.id); expect(before.users.accepted).toBe(0);
    const delivery = await f.withData(async (data) => data.getDeliveryForUpdate((await data.getPushRecord("target", target))!.deliveryId));
    expect(delivery?.sentAt).toBeNull(); expect(delivery?.state).toBe("queued");
    f.fail(""); f.advance(31000); await f.push.dispatch(target);
    expect(f.sent).toHaveLength(1);
    const recovered = await f.push.inspect(c.id); expect(recovered.devices.possibleSubmissions).toBe(1);
    expect(await f.counts()).toEqual({ effects: [], ledger: [], outbox: [], first: [] });
  });

  it("keeps per-attempt acceptance, period activity and first-delivery outbox distinct", async () => {
    const f = await fixture(); await f.install("one"); await f.install("two"); await f.install("three"); await f.configure(); const c = await f.campaign("push");
    const targets = await f.push.plan(c.id); expect(targets).toHaveLength(3);
    await f.push.dispatch(targets[0]); await f.push.dispatch(targets[1]); const first = await f.counts(); expect(first.first).toHaveLength(1); expect(first.ledger).toHaveLength(1);
    f.advance(); await f.push.dispatch(targets[0]); expect(f.sent).toHaveLength(2); expect(await f.counts()).toEqual(first);
    await f.push.dispatch(targets[2]); expect(f.sent).toHaveLength(3);
    const rows = await f.counts(); expect(rows.effects).toHaveLength(3); expect(rows.ledger).toHaveLength(2); expect(rows.first).toHaveLength(1); expect(rows.outbox).toHaveLength(3);
    const pending = rows.outbox.map((x) => x.id);
    async function drain(send: (id: string) => Promise<void>) {
      const page = await f.db.selectFrom("fixture_outbox").selectAll().where("project_id", "=", f.projectId).where("dispatched", "=", false).orderBy("id").limit(10).execute();
      for (const row of page) {
        await send(row.id);
        await f.db.updateTable("fixture_outbox").set({ dispatched: true }).where("project_id", "=", f.projectId).where("id", "=", row.id).execute();
      }
    }
    await expect(drain(async () => { throw new Error("fixture dispatcher unavailable"); })).rejects.toThrow();
    expect((await f.counts()).outbox.map((x) => x.id)).toEqual(pending);
    const dispatched: string[] = [];
    await drain(async (id) => { dispatched.push(id); });
    expect(dispatched.sort()).toEqual(pending.sort());
    expect((await f.counts()).outbox.every((x) => x.dispatched)).toBe(true); expect(f.sent).toHaveLength(3);
    await f.push.test(c.id, "one", "selected-test");
    expect(f.sent).toHaveLength(4);
    expect((await f.counts()).effects).toEqual(rows.effects);
    expect((await f.counts()).first).toEqual(rows.first);
  });

  it("rolls back fresh ordered event, cursor and effects; replay across periods touches nothing", async () => {
    const f = await fixture(); const state = await f.install("event-device");
    const user = await f.withData((data) => data.getUserByExternalId("A"));
    const before = user!.lastSeenAt; f.advance(1000); f.fail("event");
    const command = { kind: "event" as const, sequence: 1, id: "ordered-event", eventId: "business-event", event: "complete", props: { value: 7 } };
    await expect(f.push.observe(state.id, f.capability, state.bindingGeneration, [command])).rejects.toThrow("fixture effect failure");
    expect(await f.counts()).toEqual({ effects: [], ledger: [], outbox: [], first: [] });
    await f.withData(async (data) => {
      expect((await data.getUserByExternalId("A"))?.lastSeenAt).toBe(before);
      expect(await data.getPushRecord("event", "business-event")).toBeNull();
      expect(await data.queryPushRecords("cursor", { limit: 10 })).toEqual([]);
      expect(await data.queryPushRecords("observation", { limit: 10 })).toEqual([]);
    });
    f.fail(""); await f.push.observe(state.id, f.capability, state.bindingGeneration, [command]);
    const counts = await f.counts(); expect(counts.effects.map((x) => x.kind)).toEqual(["event"]);
    const committedAt = f.now(); f.advance();
    await f.push.observe(state.id, f.capability, state.bindingGeneration, [command]);
    await f.call("track", { userId: "A", event: "complete", eventId: "business-event", props: { value: 7 } }, true);
    await f.withData(async (data) => {
      const user = (await data.getUserByExternalId("A"))!;
      expect(user.lastSeenAt).toBe(committedAt);
      expect(await recordServerEvent(data, user, "complete", "business-event", f.now(), { value: 7 }, f.effects)).toMatchObject({ kind: "replay", occurredAt: committedAt });
    });
    expect(await f.counts()).toEqual(counts);
    expect(await f.db.selectFrom("events").selectAll().where("project_id", "=", f.projectId).execute()).toHaveLength(1);
  });

  it("rolls back shown receipt, delivery and outbox; retains first acknowledgement and later distinct facts", async () => {
    const f = await fixture(); await f.campaign("web_inapp");
    const decide = (path: string) => f.inapp.decide({ userId: "A", entryId: randomUUID(), requestId: randomUUID(), path });
    expect((await decide("/other")).messages).toEqual([]);
    const message = (await decide("/allowed")).messages[0]; f.fail("shown");
    await expect(f.inapp.feedback(message.deliveryId, "A", "shown", "shown-first")).rejects.toThrow();
    expect(await f.counts()).toEqual({ effects: [], ledger: [], outbox: [], first: [] });
    await f.withData(async (data) => { expect(await data.getInAppFeedback("shown-first")).toBeNull(); expect((await data.getDeliveryForUpdate(message.deliveryId))?.shownAt).toBeNull(); });
    f.fail(""); const receipt = await f.inapp.feedback(message.deliveryId, "A", "shown", "shown-first");
    const first = await f.counts(); expect(first.outbox).toHaveLength(2);
    f.advance(); expect(await f.inapp.feedback(message.deliveryId, "A", "shown", "shown-first")).toEqual(receipt); expect(await f.counts()).toEqual(first);
    await f.inapp.feedback(message.deliveryId, "A", "shown", "shown-second");
    const second = await f.counts(); expect(second.effects).toHaveLength(2); expect(second.ledger).toHaveLength(2); expect(second.first).toHaveLength(1);
    await f.withData(async (data) => { expect((await data.getDeliveryForUpdate(message.deliveryId))?.shownAt).toBe(receipt.acknowledgedAt); });
    await f.inapp.feedback(message.deliveryId, "A", "dismissed", "dismiss"); expect((await decide("/allowed")).messages).toEqual([]);
  });
});
