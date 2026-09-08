import { pushTransaction } from "./communications.js";
import { startPushWorker } from "./push-worker.js";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPushEngine, createEncryptedVault, type AcceptanceFact, type ProviderOutcome, type PushEnvelope, type PushProvider } from "@galinum/push";
import { validateSchema, installationSchemas, type InstallationState } from "@galinum/contracts";
import { createLocalProduct, createProduct, MemoryProductStore, type ProductStore } from "./local-product.js";
import { createPostgresProduct, createPostgresProductStore } from "./postgres-product.js";
import { createApp } from "./app.js";
import { nodeAdapter } from "./node-adapter.js";
const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credential = { provider: "apns", teamId: "ABCDEFGHIJ", keyId: "0123456789", topic: "app", privateKey };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(postgres: boolean) {
  let clock = 1755000000000; let served = true; let failHook = false;
  const accepted: AcceptanceFact[] = []; const sent: PushEnvelope[] = []; const results: ProviderOutcome[] = [];
  const projectId = `push_${randomUUID()}`;
  const options = { projectId, secretKey: `secret_${randomUUID()}`, publishableKey: `pub_${randomUUID()}`, pushEncryptionKey: randomBytes(32).toString("base64"), now: () => clock, sdkRateLimit: { perMinute: 5000, perHour: 10000 }, managementRateLimit: { perMinute: 5000, perHour: 10000 }, pushMaySend: async () => served,
    pushProvider: { async send(_credential: unknown, _installation: unknown, envelope: PushEnvelope): Promise<ProviderOutcome> { sent.push(envelope); return results.shift() ?? { kind: "accepted", providerId: `fake_${sent.length}` }; } } as PushProvider,
    pushRecordAcceptance: async (_tx: unknown, fact: AcceptanceFact) => { if (failHook) throw new Error("ledger failure"); accepted.push(fact); },
  };
  let product: ReturnType<typeof createLocalProduct>;
  let store: ProductStore;
  if (postgres) {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/(galinum_product_ci|galinum_installations_test_[a-z0-9_]+)$/.test(url.pathname)) throw new Error("Push tests require a disposable loopback database");
    const pool = new Pool({ connectionString: url.href });
    const target = (await pool.query("select current_database() as name, host(inet_server_addr()) as address")).rows[0];
    expect(target.name).toBe(url.pathname.slice(1)); expect(["127.0.0.1", "::1"]).toContain(target.address);
    cleanup.push(async () => {
      for (const table of ["push_records", "installations", "campaigns", "events", "end_users", "goals", "projects"]) await pool.query(`delete from ${table} where ${table === "projects" ? "id" : "project_id"} = $1`, [projectId]);
      await pool.end();
    });
    store = await createPostgresProductStore({ ...options, connectionString: url.href });
    product = createProduct(store, options);
  } else { store = new MemoryProductStore(); product = createProduct(store, options); }
  cleanup.push(() => product.close());
  const server = createServer(nodeAdapter(createApp(product.handlers)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const cap = randomBytes(32).toString("base64url");
  async function call(path: string, method = "GET", value?: object, sdk = false, capability = cap) {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${sdk ? product.publishableKey : product.secretKey}`, "content-type": "application/json", "x-galinum-installation-capability": capability }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  expect((await call("/api/v1/push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 0, credential })).status).toBe(200);
  async function install(id = "device", user = "A", platform: "ios" | "android" = "ios") {
    await call("/api/v1/identify", "POST", { userId: user, traits: { name: "Ada" } }, true);
    await call("/api/v1/sdk/installations", "POST", { installationId: id, appId: "app", platform, environment: "development", capability: cap }, true);
    let state = (await call(`/api/v1/sdk/installations/${id}`, "GET", undefined, true)).body.installation as InstallationState;
    state = await mutate(state, "binding", { userId: user });
    state = await mutate(state, "token", { tokenRevision: state.tokenRevision, token: `token_${id}` });
    return mutate(state, "facts", { permission: "granted", consent: true, capabilities: { actions: ["open"], categories: [{ id: "exports", actions: [{ id: "open", title: "Open" }] }], channels: ["updates"], richImages: true } });
  }
  async function mutate(state: InstallationState, suffix: string, values: object) {
    const result = await call(`/api/v1/sdk/installations/${state.id}/${suffix}`, suffix === "activity" ? "POST" : "PUT", { requestId: randomUUID(), bindingGeneration: state.bindingGeneration, revision: state.revision, ...values }, true);
    expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body.installation as InstallationState;
  }
  const content = { title: '{{ user.name | default: "Hello" }}', body: "Try exports", image: "https://example.com/image.png", destination: { kind: "app", url: "example://exports" }, actions: [{ id: "open", title: "Open" }], ios: { categoryId: "exports", sound: "default", badge: 1 }, android: { channelId: "updates" } };
  async function campaign(extra: object = {}) {
    const goal = await call("/api/v1/goals", "POST", { name: "Exports", targetEvent: "export_created" });
    const result = await call("/api/v1/campaigns", "POST", { name: "Push exports", channel: "push", launch: true, goalId: goal.body.goal.id, push: { appId: "app", selection: { kind: "all" } }, message: content, ...extra });
    expect(result.status, JSON.stringify(result.body)).toBe(201); return result.body.campaign;
  }
  const inspect = async (id: string) => { const result = await call(`/api/v1/campaigns/${id}/push`); expect(result.status).toBe(200); expect(validateSchema(installationSchemas.PushInspection, result.body, installationSchemas)).toBe(true); return result.body; };
  const dispatch = async (id: string) => { const result = await call(`/api/v1/campaigns/${id}/push/dispatch`, "POST"); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body; };
  return { product, store, options, call, install, mutate, campaign, inspect, dispatch, cap, credential, sent, results, accepted, advance: (ms: number) => { clock += ms; }, gate: (enabled: boolean) => { served = enabled; }, failAcceptance: () => { failHook = true; } };
}
for (const postgres of [false, true]) {
  const suite = postgres && process.env.RUN_DB_INTEGRATION !== "1" ? describe.skip : describe;
  suite(`${postgres ? "Postgres" : "memory"} push HTTP`, () => {



    it("goal fence: targetEvent edits wait for unsettled provider acceptance", async () => {
      const f = await fixture(postgres); await f.install("first"); await f.install("second");
      const c = await f.campaign(); const [id] = await f.product.push.plan(c.id);
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const pending = new Promise<void>((resolve) => { release = resolve; });
      f.options.pushProvider.send = async (_credential, _installation, envelope) => {
        f.sent.push(envelope); enter(); await pending; return { kind: "accepted", providerId: "settled-provider" };
      };
      const dispatch = f.product.push.dispatch(id); await entered;
      let acknowledged = false;
      const edit = f.call(`/api/v1/goals/${c.goalId}`, "PATCH", { targetEvent: "changed_goal" }).then((response) => { acknowledged = true; return response; });
      const monitor = postgres ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
      let observedWait = false;
      try {
        if (monitor) {
          for (let pass = 0; pass < 100 && !acknowledged && !observedWait; pass++) {
            observedWait = (await monitor.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 74102 AND objid::bigint = (hashtext($1)::bigint & 4294967295) AND NOT granted) AS waiting", [f.product.projectId])).rows[0].waiting;
            if (!acknowledged && !observedWait) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect.soft(observedWait, "goal edit must wait on this project's advisory fence").toBe(true);
        } else await new Promise((resolve) => setTimeout(resolve, 25));
        expect.soft(acknowledged, "goal edit acknowledged while old-definition provider was unsettled").toBe(false);
      } finally {
        release(); await dispatch;
        expect((await edit).status).toBe(200);
        await monitor?.end();
      }
      expect((await f.call(`/api/v1/goals/${c.goalId}`)).body.goal.targetEvent).toBe("changed_goal");
      await f.product.push.runDue();
      const after = await f.inspect(c.id);
      expect(f.sent).toHaveLength(1);
      expect(after.devices.accepted).toBe(1);
      expect(after.slots.filter((slot: { state: { kind: string } }) => slot.state.kind === "closed")[0].state.reason).toBe("content_changed_after_acceptance");
    });
    it.each(["public", "direct"])("boundary: appId edits cannot send original-app slots via %s dispatch", async (mode) => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      const [id] = await f.product.push.plan(c.id);
      expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { push: { appId: "other-app", selection: { kind: "all" } } })).status).toBe(200);
      if (mode === "public") await f.dispatch(c.id); else await f.product.push.dispatch(id);
      expect(f.sent).toHaveLength(0);
      expect((await f.inspect(c.id)).devices.accepted).toBe(0);
    });

    it("boundary: direct dispatch passes the latest campaign deadline to the provider", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      const [id] = await f.product.push.plan(c.id); const deadlines: number[] = [];
      f.options.pushProvider.send = async (_credential, _installation, _envelope, expiry) => { deadlines.push(expiry); return { kind: "accepted", providerId: "fixture" }; };
      const until = f.options.now() + 5000;
      expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { deliverUntil: until })).status).toBe(200);
      await f.product.push.dispatch(id);
      expect(deadlines).toEqual([until]);
    });


    it("boundary: a deadline edit between reservation and submission reaches the provider", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      const [id] = await f.product.push.plan(c.id); const until = f.options.now() + 4000;
      let phases = 0; const deadlines: number[] = [];
      const engine = createPushEngine({ projectId: f.product.projectId, vault: createEncryptedVault(f.options.pushEncryptionKey), now: f.options.now, maySend: f.options.pushMaySend, recordAcceptance: f.options.pushRecordAcceptance,
        provider: { async send(_credential, _installation, _envelope, expiry) { deadlines.push(expiry); return { kind: "accepted", providerId: "fixture" }; } },
        store: { async transaction(work) {
          const result = await f.store.transaction((session) => work(pushTransaction(session)));
          if (++phases === 1) expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { deliverUntil: until })).status).toBe(200);
          return result;
        } },
      });
      await engine.dispatch(id);
      expect(deadlines).toEqual([until]);
    });

    it("boundary: expired preparation closes the slot without message budget or acceptance", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      f.options.pushProvider.send = async () => ({ kind: "blocked", code: "expired", messageAttempted: false });
      await f.dispatch(c.id); const view = await f.inspect(c.id);
      expect(view.slots[0]).toMatchObject({ submissionsUsed: 0, state: { kind: "closed", reason: "expired" } });
      expect(view.devices).toMatchObject({ confirmedSubmissions: 0, possibleSubmissions: 0, preSendBlocks: 1, accepted: 0, receiptUnknown: 0 });
      expect(f.accepted).toHaveLength(0);
    });

    it.each([{ hold: "consent", rotate: false }, { hold: "serving", rotate: false }, { hold: "consent", rotate: true }, { hold: "serving", rotate: true }])("boundary: Retry-After survives $hold holds (rotation=$rotate)", async ({ hold, rotate }) => {
      const f = await fixture(postgres); let device = await f.install(); const c = await f.campaign();
      const started = f.options.now();
      f.results.push({ kind: "rejected", code: "transient", retryAfterMs: 90000 });
      await f.dispatch(c.id);
      if (hold === "consent") device = await f.mutate(device, "facts", { permission: device.permission, capabilities: device.capabilities, consent: false }); else f.gate(false);
      await f.product.push.plan(c.id);
      f.advance(2000);
      if (hold === "consent") device = await f.mutate(device, "facts", { permission: device.permission, capabilities: device.capabilities, consent: true }); else f.gate(true);
      if (rotate) device = await f.mutate(device, "token", { tokenRevision: device.tokenRevision, token: "rotated-retry-token" });
      await f.product.push.runDue();
      expect(f.sent).toHaveLength(1);
      expect((await f.inspect(c.id)).slots[0].submissionNotBefore).toBe(started + 90000);
      f.advance(87999); await f.product.push.runDue(); expect(f.sent).toHaveLength(1);
      f.advance(1); await f.product.push.runDue(); expect(f.sent).toHaveLength(2);
      const view = await f.inspect(c.id);
      expect(view.slots[0].submissionsUsed).toBe(2);
      expect(view.targets).toHaveLength(rotate ? 2 : 1);
      expect(new Set(view.targets.map((t: { expiresAt: number }) => t.expiresAt))).toEqual(new Set([started + 86400000]));
    });
    it("recovery contract: expiry is terminal across pause and accepted last-active never moves", async () => {
      const f = await fixture(postgres); await f.install("first");
      const c = await f.campaign({ push: { appId: "app", selection: { kind: "last_active" }, ttlSeconds: 60 } });
      await f.product.push.plan(c.id);
      await f.call(`/api/v1/campaigns/${c.id}/status`, "POST", { action: "pause" });
      await f.product.push.runDue(); f.advance(61000); await f.product.push.runDue();
      await f.call(`/api/v1/campaigns/${c.id}/status`, "POST", { action: "launch" });
      await f.product.push.runDue(); expect(f.sent).toHaveLength(0);
      expect((await f.inspect(c.id)).slots[0].state).toMatchObject({ kind: "closed" });
      const other = await f.campaign({ push: { appId: "app", selection: { kind: "last_active" } } });
      await f.dispatch(other.id); await f.install("later");
      f.advance(1000); await f.product.push.runDue();
      expect((await f.inspect(other.id)).devices).toMatchObject({ targeted: 1, accepted: 1 });
      expect(f.sent).toHaveLength(1);
    });

    it("recovery contract: original fanout repairs missing credentials without adding later devices", async () => {
      const f = await fixture(postgres); await f.install("apple"); await f.install("google", "A", "android");
      const c = await f.campaign(); await f.dispatch(c.id);
      const before = await f.inspect(c.id);
      expect(before.devices.accepted).toBe(1); expect(before.slots).toHaveLength(2);
      await f.install("late");
      const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      expect((await f.call("/api/v1/push/credentials", "PUT", { appId: "app", platform: "android", environment: "development", expectedRevision: 0, credential: { provider: "fcm", projectId: "example-project", clientEmail: "test@example.com", privateKey } })).status).toBe(200);
      f.advance(1000); await f.product.push.runDue();
      const after = await f.inspect(c.id);
      expect(after.devices).toMatchObject({ targeted: 2, accepted: 2, confirmedSubmissions: 2 });
      expect(after.slots).toHaveLength(2); expect(f.sent.map((e) => e.installationId).sort()).toEqual(["apple", "google"]);
      expect(after.targets.find((t: { id: string }) => t.id === before.targets[0].id)).toEqual(before.targets[0]);
    });

    it("recovery contract: partial acceptance closes incompatible content edits", async () => {
      const f = await fixture(postgres); await f.install("first"); await f.install("second");
      const c = await f.campaign(); const ids = await f.product.push.plan(c.id);
      await f.product.push.dispatch(ids[0]);
      expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { message: { title: "Changed", body: "Changed", destination: { kind: "website", url: "https://example.com" } } })).status).toBe(200);
      await f.product.push.runDue();
      const after = await f.inspect(c.id);
      expect(f.sent).toHaveLength(1);
      expect(after.slots.filter((slot: { state: { kind: string } }) => slot.state.kind === "closed")[0].state.reason).toBe("content_changed_after_acceptance");
      expect(after.devices.accepted).toBe(1);
    });

    for (const failure of ["credential", "payload", "auth_refresh"] as const) for (const hold of ["consent", "serving", "pause", "capabilities"] as const) {
      it(`repair barrier: ${failure} survives ${hold} until its input is repaired`, async () => {
        const f = await fixture(postgres); let installation = await f.install(); const capabilities = installation.capabilities; const c = await f.campaign();
        f.results.push({ kind: "rejected", code: failure });
        if (failure === "auth_refresh") f.results.push({ kind: "rejected", code: failure });
        await f.dispatch(c.id);
        if (failure === "auth_refresh") await f.product.push.processDue(c.id);
        const attempts = failure === "auth_refresh" ? 2 : 1;
        const before = await f.inspect(c.id);
        expect(f.sent).toHaveLength(attempts);
        if (hold === "serving") f.gate(false);
        else if (hold === "pause") expect((await f.call(`/api/v1/campaigns/${c.id}/status`, "POST", { action: "pause" })).status).toBe(200);
        else installation = await f.mutate(installation, "facts", { permission: "granted", consent: hold !== "consent", capabilities: hold === "capabilities" ? { ...capabilities, categories: [] } : capabilities });
        f.advance(2000); await f.product.push.runDue();
        const held = await f.inspect(c.id);
        const reason = hold === "serving" ? "serving_gate_closed" : hold === "pause" ? "campaign_paused" : hold === "capabilities" ? "capability_mismatch" : "consent";
        expect(held.slots[0].state).toMatchObject({ kind: "waiting", reason });
        if (hold === "serving") f.gate(true);
        else if (hold === "pause") expect((await f.call(`/api/v1/campaigns/${c.id}/status`, "POST", { action: "launch" })).status).toBe(200);
        else installation = await f.mutate(installation, "facts", { permission: "granted", consent: true, capabilities });
        f.advance(2000); await f.product.push.runDue();
        const blocked = await f.inspect(c.id);
        expect(f.sent).toHaveLength(attempts);
        expect(blocked.slots[0].state).toMatchObject({ kind: "waiting", reason: failure === "payload" ? "payload_invalid" : "credential_repair" });
        expect(blocked.slots[0].submissionsUsed).toBe(attempts);
        if (failure === "payload") expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { message: { title: "Repaired", body: "Try exports", destination: { kind: "app", url: "example://exports" } } })).status).toBe(200);
        else expect((await f.call("/api/v1/push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 1, credential })).status).toBe(200);
        f.advance(2000); await f.product.push.runDue();
        const repaired = await f.inspect(c.id);
        expect(f.sent).toHaveLength(attempts + 1); expect(repaired.users.accepted).toBe(1);
        expect(repaired.slots[0].submissionsUsed).toBe(attempts + 1);
        for (const outcome of before.outcomes) expect(repaired.outcomes.find((row: { id: string }) => row.id === outcome.id)).toEqual(outcome);
      });
    }

    it("recovery contract: auth retry keeps separate evidence and budget across credential generations", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      f.results.push({ kind: "rejected", code: "auth_refresh" }, { kind: "rejected", code: "credential" });
      await f.dispatch(c.id); await f.product.push.processDue(c.id);
      let state = await f.inspect(c.id);
      expect(f.sent).toHaveLength(2); expect(state.slots[0].submissionsUsed).toBe(2);
      f.advance(31000); await f.product.push.runDue(); expect(f.sent).toHaveLength(2);
      await f.call("/api/v1/push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 1, credential });
      await f.product.push.runDue(); state = await f.inspect(c.id);
      expect(f.sent).toHaveLength(3); expect(state.devices).toMatchObject({ targeted: 1, accepted: 1, confirmedSubmissions: 3 });
      expect(state.records).toMatchObject({ targets: 2, attempts: 3, outcomes: 3, slots: 1 });
      expect(new Set(state.targets.map((t: { expiresAt: number }) => t.expiresAt)).size).toBe(1);
      f.results.push({ kind: "rejected", code: "auth_refresh" });
      const test = await f.call(`/api/v1/campaigns/${c.id}/push/test`, "POST", { installationId: "device", requestId: "auth-test" });
      expect(test.status).toBe(200); await f.product.push.runDue();
      expect(f.sent).toHaveLength(4);
    });

    it("recovery contract: pre-message OAuth failures spend no notification opportunities", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      f.results.push({ kind: "rejected", code: "transient", messageAttempted: false, retryAfterMs: 1000 });
      await f.dispatch(c.id);
      let state = await f.inspect(c.id);
      expect(state.devices).toMatchObject({ preSendBlocks: 1, confirmedSubmissions: 0, possibleSubmissions: 0, receiptUnknown: 0 });
      expect(state.slots[0].submissionsUsed).toBe(0);
      f.advance(3000); await f.product.push.runDue(); state = await f.inspect(c.id);
      expect(state.devices).toMatchObject({ accepted: 1, confirmedSubmissions: 1, receiptUnknown: 1 });
    });

    it("recovery contract: abandoned reservations consume one possible submission and remain inspectable", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      const [id] = await f.product.push.plan(c.id); let calls = 0;
      const engine = createPushEngine({ projectId: f.product.projectId, vault: createEncryptedVault(f.options.pushEncryptionKey), provider: f.options.pushProvider, now: f.options.now, maySend: f.options.pushMaySend, recordAcceptance: f.options.pushRecordAcceptance,
        store: { async transaction(work) { if (++calls === 2) throw new Error("worker lost"); return f.store.transaction((session) => work(pushTransaction(session))); } },
      });
      await expect(engine.dispatch(id)).rejects.toThrow("worker lost");
      expect((await f.inspect(c.id)).devices).toMatchObject({ pendingOutcomes: 1, receiptUnknown: 0 });
      f.advance(31000); await f.product.push.processDue(c.id);
      let state = await f.inspect(c.id);
      expect(f.sent).toHaveLength(0);
      expect(state.devices).toMatchObject({ possibleSubmissions: 1, pendingOutcomes: 0, receiptUnknown: 1 });
      expect(state.slots[0].submissionsUsed).toBe(1);
      f.advance(3000); await f.product.push.processDue(c.id); state = await f.inspect(c.id);
      expect(f.sent).toHaveLength(1); expect(state.slots[0].submissionsUsed).toBe(2);
    });

    it("recovery contract: a contended SDK write waits for notification transport settlement", async () => {
      const f = await fixture(postgres); const device = await f.install(); const c = await f.campaign();
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const pending = new Promise<void>((resolve) => { release = resolve; });
      f.options.pushProvider.send = async (_credential, _installation, envelope) => { f.sent.push(envelope); enter(); await pending; return { kind: "unknown", code: "transport" }; };
      const dispatch = f.dispatch(c.id); await entered;
      let acknowledged = false;
      const binding = f.mutate(device, "binding", { userId: null }).then((value) => { acknowledged = true; return value; });
      await new Promise((resolve) => setTimeout(resolve, 25)); expect(acknowledged).toBe(false);
      release(); await dispatch; await binding;
      f.advance(5000); await f.product.push.runDue();
      expect(f.sent).toHaveLength(1);
      expect((await f.inspect(c.id)).slots[0].state).toMatchObject({ kind: "closed", reason: "uncertain_snapshot_changed" });
    });

    it("recovery contract: recipient failures past page 100 repair without losing cursor progress", async () => {
      const f = await fixture(postgres);
      for (let index = 0; index < 102; index++) await f.install(`d-${index}`, `u-${index}`);
      const c = await f.campaign({ message: { title: "{{ user.label }}", body: "Ready", destination: { kind: "website", url: "https://example.com" } } });
      for (let pass = 0; pass < 3; pass++) { f.advance(1000); await f.product.push.runDue(); }
      expect((await f.inspect(c.id)).planning.waiting).toBe(102); expect(f.sent).toHaveLength(0);
      const page = await f.call(`/api/v1/campaigns/${c.id}/push?page=2&perPage=100`);
      expect(page.body.recipients).toHaveLength(2); expect(page.body.records.recipients).toBe(102);
      const user = page.body.recipients[0].externalId;
      await f.call("/api/v1/identify", "POST", { userId: user, traits: { label: "Repaired" } }, true);
      for (let pass = 0; pass < 3; pass++) { f.advance(1000); await f.product.push.runDue(); }
      expect(f.sent).toHaveLength(1); expect(f.sent[0].content.title).toBe("Repaired");
      expect((await f.inspect(c.id)).users.accepted).toBe(1);
    }, 60000);

    it("recovery contract: assignment survives allocation edits before any eligible device", async () => {
      const f = await fixture(postgres);
      await f.call("/api/v1/identify", "POST", { userId: "A" }, true);
      const c = await f.campaign(); await f.dispatch(c.id);
      const before = await f.inspect(c.id); const assigned = before.recipients[0].variantId;
      expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { variants: [{ id: assigned, weight: 0 }, { name: "New", weight: 100, message: { title: "New", body: "New", destination: { kind: "website", url: "https://example.com" } } }] })).status).toBe(200);
      await f.install(); await f.product.push.runDue();
      const deliveries = (await f.call(`/api/v1/campaigns/${c.id}/deliveries`)).body.deliveries;
      expect(deliveries).toHaveLength(1); expect(deliveries[0].variantId).toBe(assigned);
      expect(f.sent[0].content.title).toBe("Ada");
    });

    it("recovery contract: pre-acceptance goal edits update conversion lookup on the same delivery", async () => {
      const f = await fixture(postgres); const device = await f.install(); const c = await f.campaign();
      const [original] = await f.product.push.plan(c.id);
      const goal = await f.call("/api/v1/goals", "POST", { name: "New", targetEvent: "new_goal" });
      expect((await f.call(`/api/v1/campaigns/${c.id}`, "PATCH", { goalId: goal.body.goal.id })).status).toBe(200);
      await f.product.push.runDue();
      const sent = f.sent[0];
      expect(sent.targetId).not.toBe(original);
      expect((await f.inspect(c.id)).devices.targeted).toBe(1);
      expect((await f.call(`/api/v1/sdk/installations/${device.id}/observations`, "POST", { bindingGeneration: device.bindingGeneration, commands: [
        { id: "tap-goal", sequence: 1, kind: "tap", targetId: sent.targetId, attemptId: sent.attemptId },
        { id: "old-goal", sequence: 2, kind: "event", eventId: "old-goal", event: "export_created" },
      ] }, true)).status).toBe(200);
      expect((await f.inspect(c.id)).users.converted).toBe(0);
      await f.call("/api/v1/track", "POST", { userId: "A", eventId: "new-goal", event: "new_goal" }, true);
      expect((await f.inspect(c.id)).users.converted).toBe(1);
    });
    it("validates selected-device test input against Unicode lengths and exact fields", async () => {
      const f = await fixture(postgres); const installation = await f.install(); const campaign = await f.campaign({ launch: false });
      const requestId = "🧪".repeat(128);
      const path = `/api/v1/campaigns/${campaign.id}/push/test`;
      expect((await f.call(path, "POST", { installationId: installation.id, requestId })).status).toBe(200);
      expect((await f.call(`/api/v1/campaigns/${campaign.id}/push/tests/${encodeURIComponent(requestId)}`)).status).toBe(200);
      for (const input of [
        { installationId: installation.id, requestId: "🧪".repeat(129) },
        { installationId: "x".repeat(129), requestId: "long-installation" },
        { installationId: installation.id, requestId: "extra-field", extra: true },
      ]) expect((await f.call(path, "POST", input)).status).toBe(400);
      expect(f.sent).toHaveLength(1);
    });

    it("correction reproduction: resumes an unsent recipient after a paused worker pass", async () => {
      const f = await fixture(postgres);
      await f.install();
      const campaign = await f.campaign();
      expect(await f.product.push.plan(campaign.id)).toHaveLength(1);
      const planned = await f.inspect(campaign.id);
      const deliveriesBefore = (await f.call(`/api/v1/campaigns/${campaign.id}/deliveries`)).body.deliveries;
      expect(deliveriesBefore).toHaveLength(1);
      expect((await f.call(`/api/v1/campaigns/${campaign.id}/status`, "POST", { action: "pause" })).status).toBe(200);
      await f.product.push.runDue();
      expect(f.sent).toHaveLength(0);
      const paused = await f.inspect(campaign.id);
      expect(paused.users.accepted).toBe(0);
      expect((await f.call(`/api/v1/campaigns/${campaign.id}/status`, "POST", { action: "launch" })).status).toBe(200);
      expect((await f.call(`/api/v1/campaigns/${campaign.id}`)).body.campaign.effectiveStatus).toBe("running");
      for (let pass = 0; pass < 3; pass++) { f.advance(1000); await f.product.push.runDue(); }
      const resumed = await f.inspect(campaign.id);
      expect.soft(f.sent, "resume must dispatch the eligible unsent recipient").toHaveLength(1);
      expect.soft(resumed.users.accepted).toBe(1);
      for (const target of planned.targets) expect(resumed.targets.find((entry: { id: string }) => entry.id === target.id)).toEqual(target);
      for (const outcome of paused.outcomes) expect(resumed.outcomes.find((entry: { id: string }) => entry.id === outcome.id)).toEqual(outcome);
      const deliveriesAfter = (await f.call(`/api/v1/campaigns/${campaign.id}/deliveries`)).body.deliveries;
      expect(deliveriesAfter).toHaveLength(1);
      expect(deliveriesAfter[0]).toMatchObject({ id: deliveriesBefore[0].id, variantId: deliveriesBefore[0].variantId });
      await f.product.push.runDue();
      expect.soft(f.sent, "subsequent passes must not resend acceptance").toHaveLength(1);
    });

    it("correction reproduction: one recipient cannot roll back healthy planning or poison its cursor", async () => {
      const f = await fixture(postgres);
      await f.install("first", "first-user");
      await f.install("second", "second-user");
      const users = (await f.call("/api/v1/users")).body.users as { id: string; externalUserId: string }[];
      users.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const [healthy, missingTrait] = users;
      expect((await f.call("/api/v1/identify", "POST", { userId: healthy.externalUserId, traits: { pushLabel: "Ready" } }, true)).status).toBe(200);
      const campaign = await f.campaign({ message: { title: "{{ user.pushLabel }}", body: "Exports", destination: { kind: "website", url: "https://example.com" } } });
      const dispatched = await f.call(`/api/v1/campaigns/${campaign.id}/push/dispatch`, "POST");
      for (let pass = 0; pass < 3; pass++) { f.advance(1000); await f.product.push.runDue(); }
      const firstPass = await f.inspect(campaign.id);
      expect.soft(dispatched.status, "a recipient-local error must not reject the whole planning batch").toBe(200);
      expect.soft(f.sent, "the earlier healthy recipient must make progress").toHaveLength(1);
      expect.soft(firstPass.users.accepted).toBe(1);
      expect((await f.call("/api/v1/identify", "POST", { userId: missingTrait.externalUserId, traits: { pushLabel: "Recovered" } }, true)).status).toBe(200);
      await f.product.push.runDue();
      const recovered = await f.inspect(campaign.id);
      expect(recovered.users.accepted).toBe(2);
      expect(f.sent).toHaveLength(2);
      expect(new Set(recovered.targets.map((target: { userId: string }) => target.userId)).size).toBe(2);
    });

    it("recovery contract: positive acceptance updates generic reads without fabricating delivery", async () => {
      const f = await fixture(postgres); await f.install("a"); await f.install("b"); const campaign = await f.campaign();
      const targets = await f.product.push.plan(campaign.id);
      await f.product.push.dispatch(targets[0]);
      const first = (await f.call(`/api/v1/campaigns/${campaign.id}/deliveries`)).body.deliveries[0];
      expect.soft(first).toMatchObject({ state: "sent", sentAt: 1755000000000, deliveredAt: null });
      expect.soft((await f.call(`/api/v1/campaigns/${campaign.id}`)).body.campaign.stats.sent).toBe(1);
      const inspection = await f.inspect(campaign.id);
      const target = inspection.targets.find((row: { id: string }) => row.id === targets[0]);
      const attempt = inspection.attempts.find((row: { targetId: string }) => row.targetId === target.id);
      await f.call(`/api/v1/sdk/installations/${target.installationId}/observations`, "POST", { bindingGeneration: 1, commands: [{ id: "tap", sequence: 1, kind: "tap", targetId: target.id, attemptId: attempt.id }, { id: "event", sequence: 2, kind: "event", eventId: "acceptance-projection", event: "export_created" }] }, true);
      f.advance(1000); await f.product.push.dispatch(targets[1]);
      const later = (await f.call(`/api/v1/campaigns/${campaign.id}/deliveries`)).body.deliveries[0];
      expect.soft(later).toMatchObject({ state: "converted", sentAt: 1755000000000, deliveredAt: null });
      expect(f.accepted.map((fact) => fact.acceptedAt)).toEqual([1755000000000, 1755000001000]);
      const testCampaign = await f.campaign();
      await f.call(`/api/v1/campaigns/${testCampaign.id}/push/test`, "POST", { installationId: "a", requestId: "no-generic-test-delivery" });
      expect((await f.call(`/api/v1/campaigns/${testCampaign.id}/deliveries`)).body.deliveries).toHaveLength(0);
      expect((await f.call(`/api/v1/campaigns/${testCampaign.id}`)).body.campaign.stats.sent).toBe(0);
    });

    it("recovery contract: a gated test is rejected without poisoning its request ID", async () => {
      const f = await fixture(postgres); await f.install(); const campaign = await f.campaign();
      f.gate(false);
      const body = { installationId: "device", requestId: "gate-repair" };
      const blocked = await f.call(`/api/v1/campaigns/${campaign.id}/push/test`, "POST", body);
      expect.soft(blocked.status).toBe(409);
      expect.soft((await f.call(`/api/v1/campaigns/${campaign.id}/push/tests/gate-repair`)).status).toBe(404);
      expect(f.sent).toHaveLength(0);
      f.gate(true);
      expect((await f.call(`/api/v1/campaigns/${campaign.id}/push/test`, "POST", body)).status).toBe(200);
      expect.soft(f.sent).toHaveLength(1);
    });

    it("recovery contract: no eligible installation creates no queued product delivery", async () => {
      const f = await fixture(postgres);
      await f.call("/api/v1/identify", "POST", { userId: "A", traits: { name: "Ada" } }, true);
      const campaign = await f.campaign(); await f.dispatch(campaign.id);
      expect.soft((await f.call(`/api/v1/campaigns/${campaign.id}/deliveries`)).body.deliveries).toHaveLength(0);
      expect((await f.inspect(campaign.id)).targets).toHaveLength(0);
      await f.install(); await f.product.push.runDue();
      expect(f.sent).toHaveLength(1);
    });

    it("recovery contract: an unused stale reservation does not expire live delivery TTL", async () => {
      const f = await fixture(postgres); await f.install(); const campaign = await f.campaign();
      const [targetId] = await f.product.push.plan(campaign.id);
      let calls = 0;
      const engine = createPushEngine({ projectId: f.product.projectId, vault: createEncryptedVault(f.options.pushEncryptionKey), provider: f.options.pushProvider, now: f.options.now, maySend: f.options.pushMaySend, recordAcceptance: f.options.pushRecordAcceptance,
        store: { async transaction(work) { const result = await f.store.transaction((session) => work(pushTransaction(session))); if (++calls === 1) f.advance(31000); return result; } },
      });
      await engine.dispatch(targetId);
      const stale = await f.inspect(campaign.id);
      expect(stale.targets[0].expiresAt).toBeGreaterThan(f.options.now());
      expect.soft(stale.outcomes[0].result.code).toBe("reservation_expired");
      expect(f.sent).toHaveLength(0);
      await f.product.push.runDue();
      expect.soft(f.sent).toHaveLength(1);
    });

    it("recovery contract: repairs a known-unsent token without changing delivery assignment", async () => {
      const f = await fixture(postgres); const device = await f.install(); const campaign = await f.campaign();
      const [oldTarget] = await f.product.push.plan(campaign.id);
      const before = await f.inspect(campaign.id);
      await f.mutate(device, "token", { tokenRevision: device.tokenRevision, token: "replacement" });
      await f.product.push.dispatch(oldTarget); await f.product.push.runDue();
      const after = await f.inspect(campaign.id);
      expect.soft(f.sent).toHaveLength(1);
      expect(after.targets.find((target: { id: string }) => target.id === oldTarget)).toEqual(before.targets[0]);
      expect(new Set(after.targets.map((target: { deliveryId: string }) => target.deliveryId)).size).toBe(1);
    });

    it("recovery contract: later audience entrants remain discoverable without campaign edits", async () => {
      const f = await fixture(postgres); await f.install("early", "early-user"); const campaign = await f.campaign();
      await f.dispatch(campaign.id); await f.product.push.runDue();
      await f.install("later", "later-user"); await f.product.push.runDue();
      expect(f.sent).toHaveLength(2);
      expect((await f.inspect(campaign.id)).users.accepted).toBe(2);
    });

    it("recovery contract: unknown submission plus token drift never becomes a fresh send", async () => {
      const f = await fixture(postgres); const device = await f.install(); const campaign = await f.campaign();
      f.results.push({ kind: "unknown", code: "transport" }); await f.dispatch(campaign.id);
      const before = await f.inspect(campaign.id);
      await f.mutate(device, "token", { tokenRevision: device.tokenRevision, token: "changed" });
      f.advance(5000); await f.product.push.runDue(); await f.product.push.runDue();
      expect(f.sent).toHaveLength(1); expect((await f.inspect(campaign.id)).users.accepted).toBe(0);
      expect((await f.inspect(campaign.id)).outcomes.find((outcome: { id: string }) => outcome.id === before.outcomes[0].id)).toEqual(before.outcomes[0]);
    });

    it("persists push campaigns, rich frozen fanout, positive acceptances and redacted inspection", async () => {
      const f = await fixture(postgres); await f.install("a"); await f.install("b"); const c = await f.campaign();
      const result = await f.dispatch(c.id);
      expect(result.users).toMatchObject({ targeted: 1, accepted: 1, engaged: 0, converted: 0 });
      expect(result.devices).toMatchObject({ targeted: 2, accepted: 2, receiptObserved: 0, receiptUnknown: 2 });
      expect(f.sent[0].content.title).toBe("Ada"); expect(f.accepted).toHaveLength(2);
      expect((await f.call(`/api/v1/messages?entryId=test-entry&requestId=test-request&path=%2Fdashboard&userId=A`, "GET", undefined, true)).body.messages).toEqual([]);
      const inspected = await f.inspect(c.id); expect(inspected).toEqual(result);
      expect(JSON.stringify(inspected)).not.toContain("token_a"); expect(JSON.stringify(inspected)).not.toContain("tokenScope");
      const creds = await f.call("/api/v1/push/credentials"); expect(JSON.stringify(creds.body)).not.toContain("PRIVATE"); expect(JSON.stringify(creds.body)).not.toContain("encrypted");
      await f.dispatch(c.id); expect(f.sent).toHaveLength(2); expect(f.accepted).toHaveLength(2);
      expect((await f.call(`/api/v1/deliveries/${result.targets[0].deliveryId}/event`, "POST", { userId: "A", type: "converted", feedbackId: "A" + ":converted" }, true)).status).toBe(404);
    });
    it("keeps push campaigns out of the web scheduler capacity limit", async () => {
      const f = await fixture(postgres); await f.install();
      for (let index = 0; index < 101; index++) await f.campaign();
      expect((await f.call("/api/v1/campaigns", "POST", { name: "Web", launch: true, message: { presentation: "toast", title: "Web welcome" } })).status).toBe(201);
      const messages = await f.call("/api/v1/messages?entryId=test-entry&requestId=test-request&path=%2Fdashboard&userId=A", "GET", undefined, true);
      expect(messages.status).toBe(200); expect(messages.body.messages).toHaveLength(1);
      expect(messages.body.messages[0].content.title).toBe("Web welcome");
      expect((await f.product.push.runDue()).processed).toBe(100);
      expect((await f.product.push.runDue()).processed).toBe(1);
      expect((await f.product.push.runDue()).processed).toBe(0);
      expect(f.sent).toHaveLength(101);
    }, 15000);

    it("preserves ordered event properties, targeting and shared identity across both ingestion routes", async () => {
      const f = await fixture(postgres); await f.install();
      f.advance(1000);
      const props = { format: "csv", count: 3, enabled: true, nested: { values: [null, false, 1.5, "text"] } };
      const path = "/api/v1/sdk/installations/device/observations";
      const event = { id: "command-1", sequence: 1, kind: "event", event: "export_created", eventId: "business-1", props };
      const batch = { bindingGeneration: 1, commands: [event] };
      expect((await f.call(path, "POST", batch, true)).status).toBe(200);
      const seen = (await f.call("/api/v1/users")).body.users[0].lastSeenAt;
      expect(seen).toBe(1755000001000);
      f.advance(1000);
      expect((await f.call("/api/v1/track", "POST", { userId: "A", event: event.event, eventId: event.eventId, props }, true)).status).toBe(200);
      expect((await f.call(path, "POST", batch, true)).status).toBe(200);
      const events = await f.call("/api/v1/events?name=export_created");
      expect(events.body.events).toHaveLength(1); expect(events.body.events[0].props).toEqual(props);
      expect((await f.call("/api/v1/users")).body.users[0].lastSeenAt).toBe(seen);
      const audience = await f.call("/api/v1/audiences/check", "POST", { expression: { version: 1, root: { kind: "event", event: "export_created", where: [{ kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" }] } } });
      expect(audience.status).toBe(200); expect(audience.body.matchedCount).toBe(1);
      expect((await f.call("/api/v1/track", "POST", { userId: "A", event: event.event, eventId: "business-2", props }, true)).status).toBe(200);
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: [{ ...event, id: "command-2", sequence: 2, eventId: "business-2" }] }, true)).status).toBe(200);
      expect((await f.call("/api/v1/events?name=export_created")).body.events).toHaveLength(2);
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: [{ ...event, id: "conflict", sequence: 3, props: { format: "json" } }] }, true)).status).toBe(409);
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: [{ ...event, id: "oversized", sequence: 3, eventId: "business-3", props: { value: "x".repeat(4096) } }] }, true)).status).toBe(413);
      expect((await f.call("/api/v1/events?name=export_created")).body.events).toHaveLength(2);
    });

    it("pages history while keeping exact user/device totals independent of the page", async () => {
      const f = await fixture(postgres);
      for (let index = 0; index < 5; index++) await f.install(`device-${index}`);
      const campaign = await f.campaign(); await f.dispatch(campaign.id);
      const ids: string[] = [];
      for (let page = 1; page <= 4; page++) {
        const response = await f.call(`/api/v1/campaigns/${campaign.id}/push?page=${page}&perPage=2`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ page, perPage: 2, records: { targets: 5, attempts: 5, outcomes: 5 }, pageCounts: { targets: 3 }, users: { targeted: 1, accepted: 1 }, devices: { targeted: 5, accepted: 5 } });
        const length = page < 3 ? 2 : page === 3 ? 1 : 0;
        expect(response.body.targets).toHaveLength(length);
        expect(response.body.attempts).toHaveLength(length);
        expect(response.body.outcomes).toHaveLength(length);
        ids.push(...response.body.targets.map((target: { id: string }) => target.id));
      }
      expect(new Set(ids).size).toBe(5);
      for (const query of ["page=0", "perPage=101", "page=NaN"]) expect((await f.call(`/api/v1/campaigns/${campaign.id}/push?${query}`)).status).toBe(400);
      await f.product.push.runDue(); expect(f.sent).toHaveLength(5);
    });

    it("scopes stable event IDs to the project and rejects changed replay bodies", async () => {
      const first = await fixture(postgres); const second = await fixture(postgres);
      const event = { userId: "A", event: "export_created", eventId: "same-client-id", props: { a: 1, b: 2 } };
      expect((await first.call("/api/v1/track", "POST", event, true)).status).toBe(200);
      expect((await second.call("/api/v1/track", "POST", event, true)).status).toBe(200);
      expect((await first.call("/api/v1/track", "POST", { ...event, props: { b: 2, a: 1 } }, true)).status).toBe(200);
      expect((await first.call("/api/v1/track", "POST", { ...event, props: { a: 3 } }, true)).status).toBe(409);
    });

    it("requires tap/action before an event even at equal clock times and replays commands safely", async () => {
      const f = await fixture(postgres); const device = await f.install(); const c = await f.campaign(); const result = await f.dispatch(c.id);
      const reference = { targetId: result.targets[0].id, attemptId: result.attempts[0].id };
      const path = "/api/v1/sdk/installations/device/observations";
      await f.call("/api/v1/track", "POST", { userId: "A", event: "export_created", eventId: "earlier" }, true);
      const commands = [{ id: "receipt", sequence: 1, kind: "receipt", ...reference }, { id: "tap", sequence: 2, kind: "tap", ...reference }];
      expect((await f.call(path, "POST", { bindingGeneration: device.bindingGeneration, commands }, true)).status).toBe(200);
      expect((await f.inspect(c.id)).users.converted).toBe(0);
      await f.call("/api/v1/track", "POST", { userId: "A", event: "export_created", eventId: "earlier" }, true);
      expect((await f.inspect(c.id)).users.converted).toBe(0);
      const later = [...commands, { id: "event", sequence: 3, kind: "event", event: "export_created", eventId: "ordered-export" }];
      expect((await f.call(path, "POST", { bindingGeneration: device.bindingGeneration, commands: later }, true)).body).toEqual({ acknowledgedThrough: 3 });
      expect((await f.call(path, "POST", { bindingGeneration: device.bindingGeneration, commands: later }, true)).body).toEqual({ acknowledgedThrough: 3 });
      expect((await f.inspect(c.id)).users).toMatchObject({ engaged: 1, converted: 1 });
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: [{ id: "forged", sequence: 4, kind: "action", actionId: "not-sent", ...reference }] }, true)).status).toBe(400);
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: [{ id: "gap", sequence: 9, kind: "tap", ...reference }] }, true)).status).toBe(409);
      await f.mutate(device, "binding", { userId: null });
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: later }, true)).status).toBe(409);
      expect((await f.call(path, "POST", { bindingGeneration: 1, commands: later }, true, "wrong")).status).toBe(401);
    });
    it("keeps pre-engagement queued events ineligible and separates test sends", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign(); const result = await f.dispatch(c.id);
      const reference = { targetId: result.targets[0].id, attemptId: result.attempts[0].id };
      const body = { bindingGeneration: 1, commands: [{ id: "old", sequence: 1, kind: "event", event: "export_created", eventId: "ordered-export" }, { id: "action", sequence: 2, kind: "action", actionId: "open", ...reference }] };
      expect((await f.call("/api/v1/sdk/installations/device/observations", "POST", body, true)).status).toBe(200);
      expect((await f.inspect(c.id)).users.converted).toBe(0);
      const count = f.accepted.length;
      expect((await f.call(`/api/v1/campaigns/${c.id}/push/test`, "POST", { installationId: "device", requestId: "test-1" })).status).toBe(200);
      expect(f.accepted).toHaveLength(count); expect((await f.inspect(c.id)).testTargets).toBe(1);
      await f.call("/api/v1/track", "POST", { userId: "A", event: "export_created", eventId: "after-action" }, true);
      expect((await f.inspect(c.id)).conversions).toHaveLength(1);
    });
    it("fences account/token/credential and campaign changes before dispatch", async () => {
      const f = await fixture(postgres); let device = await f.install(); const c = await f.campaign(); const targets = await f.product.push.plan(c.id);
      device = await f.mutate(device, "binding", { userId: null });
      await f.product.push.dispatch(targets[0]); expect(f.sent).toHaveLength(0); expect((await f.inspect(c.id)).outcomes[0].result).toEqual({ kind: "blocked", code: "installation_changed" });
      device = await f.install(); const second = await f.campaign(); const targets2 = await f.product.push.plan(second.id);
      await f.call("/api/v1/push/credentials", "PUT", { appId: "app", platform: "ios", environment: "development", expectedRevision: 1, credential });
      await f.product.push.dispatch(targets2[0]); expect((await f.inspect(second.id)).outcomes[0].result.code).toBe("credential_changed");
      const third = await f.campaign(); const targets3 = await f.product.push.plan(third.id);
      await f.call(`/api/v1/campaigns/${third.id}/status`, "POST", { action: "pause" });
      await f.product.push.dispatch(targets3[0]); expect((await f.inspect(third.id)).outcomes[0].result.kind).toBe("blocked");
      expect(f.sent).toHaveLength(0);
    });
    it("uses app activity for last-active and never falls back from a specific device", async () => {
      const f = await fixture(postgres); const a = await f.install("a"); await f.install("b"); await f.mutate(a, "activity", {});
      const c = await f.campaign({ push: { appId: "app", selection: { kind: "last_active" } } });
      expect((await f.dispatch(c.id)).targets.map((t: { installationId: string }) => t.installationId)).toEqual(["a"]);
      const d = await f.campaign({ push: { appId: "app", selection: { kind: "specific", installationId: "missing" } } });
      expect((await f.dispatch(d.id)).targets).toEqual([]);
      f.gate(false); const e = await f.campaign(); await f.dispatch(e.id); expect((await f.inspect(e.id)).users.accepted).toBe(0);
    });
    it("bounds unknown retries, honors expiry/replacement, and retires only a rejected token", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      f.results.push({ kind: "unknown", code: "transport" }, { kind: "unknown", code: "transport" }, { kind: "unknown", code: "transport" });
      await f.dispatch(c.id); expect((await f.inspect(c.id)).users.accepted).toBe(0);
      for (let i = 0; i < 3; i++) { f.advance(5000); await f.dispatch(c.id); }
      expect(f.sent).toHaveLength(3); expect(f.accepted).toHaveLength(0);
      const old = await f.campaign({ push: { appId: "app", selection: { kind: "all" }, replacementKey: "one" } }); const oldTargets = await f.product.push.plan(old.id);
      const newer = await f.campaign({ push: { appId: "app", selection: { kind: "all" }, replacementKey: "one" } }); await f.product.push.plan(newer.id);
      await f.product.push.dispatch(oldTargets[0]); expect((await f.inspect(old.id)).outcomes[0].result.code).toBe("superseded");
      const expiring = await f.campaign({ push: { appId: "app", selection: { kind: "all" }, ttlSeconds: 1 } }); const expires = await f.product.push.plan(expiring.id); f.advance(2000);
      await f.product.push.dispatch(expires[0]); expect((await f.inspect(expiring.id)).outcomes[0].result.code).toBe("expired");
      const rejected = await f.campaign(); f.results.push({ kind: "rejected", code: "invalid_token" }); await f.dispatch(rejected.id);
      expect((await f.call("/api/v1/sdk/installations/device", "GET", undefined, true)).body.installation.hasToken).toBe(false);
      expect(f.accepted).toHaveLength(0);
    });
    it("correlates test replays and never retries an uncertain test automatically", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign();
      f.results.push({ kind: "unknown", code: "transport" });
      const body = { installationId: "device", requestId: "stable-test" };
      const first = await f.call(`/api/v1/campaigns/${c.id}/push/test`, "POST", body);
      expect(first.status).toBe(200); f.advance(10000);
      expect(await f.call(`/api/v1/campaigns/${c.id}/push/test`, "POST", body)).toEqual(first);
      expect(f.sent).toHaveLength(1); expect(f.accepted).toHaveLength(0);
      const read = await f.call(`/api/v1/campaigns/${c.id}/push/tests/stable-test`);
      expect(read.body).toMatchObject({ requestId: "stable-test", targetIds: first.body.targetIds });
      expect(read.body.attempts).toHaveLength(1); expect(read.body.outcomes[0].result.kind).toBe("unknown");
      expect((await f.call(`/api/v1/campaigns/${c.id}/push/test`, "POST", { ...body, installationId: "other" })).status).toBe(409);
    });
    it("compares exact category actions at planning and again before dispatch", async () => {
      const f = await fixture(postgres); let device = await f.install();
      const wrong = { actions: ["open"], categories: [{ id: "exports", actions: [{ id: "open", title: "Wrong title" }] }], channels: ["updates"], richImages: true };
      device = await f.mutate(device, "facts", { permission: "granted", consent: true, capabilities: wrong });
      const c = await f.campaign(); expect((await f.dispatch(c.id)).targets).toEqual([]);
      device = await f.mutate(device, "facts", { permission: "granted", consent: true, capabilities: { ...wrong, categories: [{ id: "exports", actions: [{ id: "open", title: "Open" }] }] } });
      const targets = await f.product.push.plan(c.id); expect(targets).toHaveLength(1);
      await f.mutate(device, "facts", { permission: "granted", consent: true, capabilities: wrong });
      await f.product.push.dispatch(targets[0]); expect(f.sent).toHaveLength(0);
      expect((await f.inspect(c.id)).outcomes[0].result.code).toBe("capabilities_changed");
    });
    it("runs delivery windows and retries through the same scheduler used by the CLI", async () => {
      const f = await fixture(postgres); await f.install();
      const c = await f.campaign({ deliverFrom: new Date(1755000002000).toISOString(), deliverUntil: new Date(1755000020000).toISOString() });
      f.results.push({ kind: "unknown", code: "transport" });
      const worker = startPushWorker(() => f.product.push.runDue(), 100);
      cleanup.push(() => worker.stop());
      await new Promise((resolve) => setTimeout(resolve, 120)); expect(f.sent).toHaveLength(0);
      f.advance(2000); await vi.waitFor(() => expect(f.sent).toHaveLength(1));
      f.advance(5000); await vi.waitFor(() => expect(f.sent).toHaveLength(2));
      expect((await f.inspect(c.id)).users.accepted).toBe(1);
      await worker.stop();
    });

    it("rolls provider acceptance back when its transactional effect fails", async () => {
      const f = await fixture(postgres); await f.install(); const c = await f.campaign(); f.failAcceptance();
      expect((await f.call(`/api/v1/campaigns/${c.id}/push/dispatch`, "POST")).status).toBe(500);
      const inspection = await f.inspect(c.id); expect(inspection.attempts).toHaveLength(1); expect(inspection.outcomes).toHaveLength(0); expect(inspection.users.accepted).toBe(0);
    });
  });
}
