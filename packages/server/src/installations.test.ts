import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { selectInstallations } from "@galinum/core";
import { INSTALLATION_BODY_BYTES, InstallationBootstrapExample, type InstallationState } from "@galinum/contracts";
import { createApp } from "./app.js";
import { createProduct, MemoryProductStore } from "./local-product.js";
import { createPostgresProductStore } from "./postgres-product.js";
import { invalidateInstallationToken } from "./installations.js";
import { nodeAdapter } from "./node-adapter.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function database(connectionString = process.env.DATABASE_URL!) {
  const url = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/(galinum_product_ci|galinum_installations_test_[a-z0-9_]+)$/.test(url.pathname)) throw new Error("Installation tests require a disposable loopback database");
  const pool = new Pool({ connectionString: url.href });
  const target = await pool.query("select current_database() as name, host(inet_server_addr()) as address");
  expect(target.rows[0].name).toBe(url.pathname.slice(1));
  expect(["127.0.0.1", "::1"]).toContain(target.rows[0].address);
  return { url, pool };
}
async function fixture(mode: "memory" | "postgres", settings: { capability?: string; connectionString?: string } = {}) {
  const projectId = `installation_${randomUUID()}`;
  let clock = 1000;
  const options = { projectId, secretKey: `secret_${randomUUID()}`, publishableKey: `pub_${randomUUID()}`, now: () => clock, sdkRateLimit: { perMinute: 5000, perHour: 10000 } };
  let store;
  if (mode === "postgres") {
    const { url, pool } = await database(settings.connectionString);
    cleanup.push(async () => {
      if ((await pool.query("select to_regclass('installations') as table_name")).rows[0].table_name) await pool.query("delete from installations where project_id = $1", [projectId]);
      await pool.query("delete from end_users where project_id = $1", [projectId]);
      await pool.query("delete from projects where id = $1", [projectId]);
      await pool.end();
    });
    store = await createPostgresProductStore({ ...options, connectionString: url.href });
  } else store = new MemoryProductStore();
  const product = createProduct(store, options);
  cleanup.push(() => product.close());
  const server = createServer(nodeAdapter(createApp(product.handlers)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const capability = settings.capability ?? randomBytes(32).toString("base64url");
  async function call(path: string, method = "GET", body?: object | string, key = options.publishableKey, secret = capability) {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-Galinum-Installation-Capability": secret }, ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const base = "/api/v1/sdk/installations";
  const read = async (id = "device") => {
    const result = await call(`${base}/${id}`);
    expect(result.status).toBe(200);
    return result.body.installation as InstallationState;
  };
  const create = async (id = "device", appId = "app") => {
    const body = { ...InstallationBootstrapExample, installationId: id, appId, capability };
    expect((await call(base, "POST", body)).status).toBe(200);
    return { state: await read(id), body };
  };
  async function mutate(state: InstallationState, path: string, fields: object = {}, requestId: string = randomUUID()) {
    const body = { requestId, bindingGeneration: state.bindingGeneration, revision: state.revision, ...fields };
    const response = await call(`${base}/${state.id}/${path}`, path === "activity" ? "POST" : "PUT", body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await read(state.id)).toEqual(response.body.installation);
    return response.body.installation as InstallationState;
  }
  const identify = async (userId: string) => expect((await call("/api/v1/identify", "POST", { userId })).status).toBe(200);
  const facts = { permission: "granted", consent: true, capabilities: { actions: ["open"], channels: ["updates"], richImages: true } };
  return { store, options, call, read, create, mutate, identify, facts, capability, base, advance: () => { clock += 1000; } };
}

for (const mode of ["memory", "postgres"] as const) {
  const suite = mode === "postgres" && process.env.RUN_DB_INTEGRATION !== "1" ? describe.skip : describe;
  suite(`${mode} installation HTTP lifecycle`, () => {
    it("recovers bootstrap acknowledgements and denies capability/project/identity changes without leaks", async () => {
      const f = await fixture(mode);
      const { state, body } = await f.create();
      expect((await f.call(f.base, "POST", body)).body.installation).toEqual(state);
      expect((await f.call(f.base, "POST", { ...body, capability: "x".repeat(43) })).status).toBe(409);
      expect((await f.call(f.base, "POST", { ...body, appId: "changed" })).status).toBe(409);
      expect((await f.call(f.base, "POST", { ...body, platform: "android" })).status).toBe(409);
      expect((await f.call(f.base, "POST", { ...body, environment: "production" })).status).toBe(409);
      expect((await f.call(`${f.base}/device`, "GET", undefined, f.options.publishableKey, "wrong")).status).toBe(401);
      expect((await f.call(`${f.base}/device/facts`, "PUT", { requestId: "bad", revision: 0, bindingGeneration: 0, ...f.facts }, f.options.publishableKey, "wrong")).status).toBe(401);
      const other = await fixture(mode);
      expect((await f.call(`${f.base}/device`, "GET", undefined, other.options.publishableKey)).status).toBe(401);
      expect((await other.call(`${f.base}/device`, "GET", undefined, other.options.publishableKey, f.capability)).status).toBe(401);
      await other.create();
      expect((await other.call(`${f.base}/device`, "GET", undefined, other.options.publishableKey, f.capability)).status).toBe(401);
      const inspect = await f.call("/api/v1/installations", "GET", undefined, f.options.secretKey);
      expect(inspect.body).toMatchObject({ total: 1, installations: [state] });
      expect(JSON.stringify(inspect.body)).not.toContain(f.capability);
      expect(JSON.stringify(inspect.body)).not.toContain("Verifier");
      expect((await f.call("/api/v1/installations")).status).toBe(401);
      expect((await f.call(f.base, "POST", { ...body, extra: true })).status).toBe(400);
    });

    it("isolates identical installation identities and native tokens across projects", async () => {
      const capability = randomBytes(32).toString("base64url");
      const first = await fixture(mode, { capability });
      const second = await fixture(mode, { capability });
      await first.identify("A"); await second.identify("B");
      let { state: a } = await first.create();
      a = await first.mutate(a, "binding", { userId: "A" });
      a = await first.mutate(a, "token", { tokenRevision: 0, token: "same-native-token" });
      let { state: b } = await second.create();
      expect(await first.read()).toEqual(a);
      b = await second.mutate(b, "binding", { userId: "B" });
      b = await second.mutate(b, "token", { tokenRevision: 0, token: "same-native-token" });
      b = await second.mutate(b, "facts", second.facts);
      expect(await first.read()).toEqual(a);
      expect(await second.read()).toEqual(b);
      expect(a.hasToken && b.hasToken).toBe(true);
      const owned = (await second.store.getInstallation(b.id))!;
      expect(await invalidateInstallationToken(second.store, { installationId: b.id, tokenScope: owned.tokenScope!, tokenRevision: owned.tokenRevision })).toBe(true);
      expect(await first.read()).toEqual(a);
      expect(await second.read()).toMatchObject({ hasToken: false });
    });

    it("elects one capability during concurrent bootstrap", async () => {
      const f = await fixture(mode);
      const bodies = [f.capability, randomBytes(32).toString("base64url")].map((capability) => ({ ...InstallationBootstrapExample, installationId: "racing", capability }));
      const results = await Promise.all(bodies.map((body) => f.call(f.base, "POST", body)));
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const winner = results.findIndex((result) => result.status === 200);
      expect((await f.call(`${f.base}/racing`, "GET", undefined, f.options.publishableKey, bodies[winner].capability)).body.installation.id).toBe("racing");
      expect((await f.call(`${f.base}/racing`, "GET", undefined, f.options.publishableKey, bodies[1 - winner].capability)).status).toBe(401);
    });

    it("accepts maximum escaped capabilities and rejects oversized encoded bodies without mutation", async () => {
      const f = await fixture(mode);
      const { state } = await f.create();
      const identifiers = (count: number, length: number) => Array.from({ length: count }, (_, index) => "😀".repeat(length - 2) + String(index).padStart(2, "0"));
      const capabilities = { actions: identifiers(32, 64), channels: identifiers(64, 128), richImages: true };
      const request = { requestId: "😀".repeat(128), bindingGeneration: 0, revision: 0, ...f.facts, capabilities };
      const encoded = JSON.stringify(request).replace(/[\u007f-\uffff]/g, (character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
      expect(Buffer.byteLength(encoded)).toBeGreaterThan(120000);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(INSTALLATION_BODY_BYTES);
      expect((await f.call(`${f.base}/device/facts`, "PUT", encoded)).status).toBe(200);
      const current = await f.read();
      expect(current).toEqual({ ...state, ...f.facts, capabilities, revision: 1 });
      const oversized = JSON.stringify({ ...request, requestId: "oversized", revision: 1 }) + " ".repeat(INSTALLATION_BODY_BYTES);
      expect((await f.call(`${f.base}/device/facts`, "PUT", oversized)).status).toBe(413);
      expect(await f.read()).toEqual(current);
    });

    it("rejects empty bindings and invalid pagination", async () => {
      const f = await fixture(mode);
      const { state } = await f.create();
      expect((await f.call(`${f.base}/device/binding`, "PUT", { requestId: "empty", bindingGeneration: 0, revision: 0, userId: "" })).status).toBe(400);
      for (const query of ["page=0", "page=-1", "perPage=101", "perPage=0", "page=abc", "perPage=no", "page=1.5"]) {
        expect((await f.call(`/api/v1/installations?${query}`, "GET", undefined, f.options.secretKey)).status).toBe(400);
      }
      expect(await f.read()).toEqual(state);
    });

    it("retains only 128 successful acknowledgements per installation and rolls eviction back", async () => {
      const f = await fixture(mode);
      let { state } = await f.create();
      const other = (await f.create("other")).state;
      const otherRequest = { requestId: "other", revision: 0, bindingGeneration: 0 };
      const otherAcknowledgement = await f.mutate(other, "activity", {}, "other");
      const firstRequest = { requestId: "request-0", revision: 0, bindingGeneration: 0 };
      const firstAcknowledgement = await f.mutate(state, "activity", {}, "request-0");
      state = firstAcknowledgement;
      for (let index = 1; index < 128; index++) state = await f.mutate(state, "activity", {}, `request-${index}`);
      expect((await f.call(`${f.base}/device/activity`, "POST", firstRequest)).body.installation).toEqual(firstAcknowledgement);
      expect(await f.read()).toEqual(state);
      await expect(f.store.transaction(async (session) => {
        await session.lockInstallations();
        await session.saveInstallationReplay(state.id, "rolled-back", { digest: "rollback", state: { ...state, revision: state.revision + 1 } });
        expect(await session.getInstallationReplay(state.id, "request-0")).toBeNull();
        throw new Error("rollback eviction");
      })).rejects.toThrow("rollback eviction");
      expect((await f.call(`${f.base}/device/activity`, "POST", firstRequest)).body.installation).toEqual(firstAcknowledgement);
      const latestRequest = { requestId: "request-128", revision: state.revision, bindingGeneration: state.bindingGeneration };
      state = await f.mutate(state, "activity", {}, "request-128");
      expect((await f.call(`${f.base}/device/activity`, "POST", firstRequest)).status).toBe(409);
      expect(await f.read()).toEqual(state);
      expect((await f.call(`${f.base}/device/activity`, "POST", latestRequest)).body.installation).toEqual(state);
      expect((await f.call(`${f.base}/other/activity`, "POST", otherRequest)).body.installation).toEqual(otherAcknowledgement);
      const saved = await f.store.transaction(async (session) => Promise.all(Array.from({ length: 129 }, (_, index) => session.getInstallationReplay(state.id, `request-${index}`))));
      expect(saved.filter(Boolean)).toHaveLength(128);
      expect(saved[0]).toBeNull();
    });

    it("fences A→unbound→B, replay conflicts, old facts, and delayed token callbacks", async () => {
      const f = await fixture(mode);
      await f.identify("A"); await f.identify("B");
      let { state } = await f.create();
      state = await f.mutate(state, "binding", { userId: "A" });
      state = await f.mutate(state, "token", { tokenRevision: 0, token: "token-A" });
      state = await f.mutate(state, "facts", f.facts);
      state = await f.mutate(state, "activity");
      const old = state;
      const unbindId = randomUUID();
      state = await f.mutate(state, "binding", { userId: null }, unbindId);
      const unbound = state;
      state = await f.mutate(state, "binding", { userId: "B" });
      expect(state).toMatchObject({ userId: "B", consent: false, lastActiveAt: null });
      const oldBody = { requestId: unbindId, bindingGeneration: old.bindingGeneration, revision: old.revision, userId: null };
      expect((await f.call(`${f.base}/device/binding`, "PUT", oldBody)).body.installation).toEqual(unbound);
      expect((await f.call(`${f.base}/device/binding`, "PUT", { ...oldBody, userId: "A" })).status).toBe(409);
      for (const [path, fields] of [["facts", f.facts], ["token", { tokenRevision: old.tokenRevision, token: "late-A" }], ["binding", { userId: "A" }]] as const) {
        expect((await f.call(`${f.base}/device/${path}`, "PUT", { requestId: randomUUID(), revision: old.revision, bindingGeneration: old.bindingGeneration, ...fields })).status).toBe(409);
      }
      expect(await f.read()).toEqual(state);
      const inspect = await f.call("/api/v1/installations?userId=A", "GET", undefined, f.options.secretKey);
      expect(inspect.body.total).toBe(0);
      expect(selectInstallations([state], "A", { kind: "all" })).toEqual([]);
      state = await f.mutate(state, "facts", f.facts);
      expect(selectInstallations([state], "B", { kind: "all" })).toHaveLength(1);
    });

    it("transfers scoped tokens atomically and fences captured invalidations", async () => {
      const f = await fixture(mode);
      let { state: first } = await f.create("first");
      first = await f.mutate(first, "token", { tokenRevision: 0, token: "shared-native-token" });
      const captured = (await f.store.getInstallation(first.id))!;
      const replayId = randomUUID();
      const tokenRequest = { requestId: replayId, revision: first.revision, bindingGeneration: first.bindingGeneration, tokenRevision: first.tokenRevision, token: "shared-native-token" };
      first = await f.mutate(first, "token", { tokenRevision: first.tokenRevision, token: "shared-native-token" }, replayId);
      const accepted = first;
      let { state: second } = await f.create("second");
      second = await f.mutate(second, "token", { tokenRevision: 0, token: "shared-native-token" });
      expect(await f.read(first.id)).toMatchObject({ hasToken: false, tokenRevision: 3 });
      expect((await f.call(`${f.base}/first/token`, "PUT", tokenRequest)).body.installation).toEqual(accepted);
      expect(await f.read(first.id)).toMatchObject({ hasToken: false, tokenRevision: 3 });
      expect(await invalidateInstallationToken(f.store, { installationId: first.id, tokenRevision: captured.tokenRevision, tokenScope: captured.tokenScope! })).toBe(false);
      const secondCaptured = (await f.store.getInstallation(second.id))!;
      second = await f.mutate(second, "token", { tokenRevision: second.tokenRevision, token: "replacement" });
      expect(await invalidateInstallationToken(f.store, { installationId: second.id, tokenRevision: secondCaptured.tokenRevision, tokenScope: secondCaptured.tokenScope! })).toBe(false);
      expect(await f.read(second.id)).toEqual(second);
      const current = (await f.store.getInstallation(second.id))!;
      expect(await invalidateInstallationToken(f.store, { installationId: second.id, tokenRevision: current.tokenRevision, tokenScope: current.tokenScope! })).toBe(true);
      expect(await f.read(second.id)).toMatchObject({ hasToken: false });
      let { state: third } = await f.create("third", "different-app");
      third = await f.mutate(third, "token", { tokenRevision: 0, token: "shared-native-token" });
      expect(third.hasToken).toBe(true);
      const inspection = await f.call("/api/v1/installations?perPage=2&page=1", "GET", undefined, f.options.secretKey);
      expect(inspection.body).toMatchObject({ total: 3, perPage: 2 });
      expect(inspection.body.installations).toHaveLength(2);
      expect(JSON.stringify(inspection.body)).not.toContain("shared-native-token");
      const left = await f.read("first"); const right = await f.read("second");
      const outcomes = await Promise.all([left, right].map((state) => f.call(`${f.base}/${state.id}/token`, "PUT", { requestId: randomUUID(), bindingGeneration: state.bindingGeneration, revision: state.revision, tokenRevision: state.tokenRevision, token: "racing-token" })));
      expect(outcomes.every((result) => result.status === 200)).toBe(true);
      expect([await f.read("first"), await f.read("second")].filter((state) => state.hasToken)).toHaveLength(1);
    });

    it("rolls installation changes back when a transaction fails", async () => {
      const f = await fixture(mode);
      const { state } = await f.create();
      await expect(f.store.transaction(async (session) => {
        await session.lockInstallations();
        const record = (await session.getInstallation(state.id))!;
        record.consent = true;
        await session.saveInstallation(record);
        await session.saveInstallationReplay(state.id, "rollback", { digest: "unused", state: { ...state, consent: true } });
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      expect(await f.read()).toEqual(state);
      expect(await f.store.transaction((session) => session.getInstallationReplay(state.id, "rollback"))).toBeNull();
    });

    it("selects eligible devices from observed reads and changes activity only on explicit app use", async () => {
      const f = await fixture(mode); await f.identify("A");
      const states: InstallationState[] = [];
      for (const id of ["b", "a"]) {
        let { state } = await f.create(id);
        state = await f.mutate(state, "binding", { userId: "A" });
        state = await f.mutate(state, "token", { tokenRevision: 0, token: `token-${id}` });
        state = await f.mutate(state, "facts", f.facts);
        expect(state.lastActiveAt).toBeNull();
        states.push(state);
      }
      expect(selectInstallations(states, "A", { kind: "last_active" }).map((s) => s.id)).toEqual(["a"]);
      states[0] = await f.mutate(states[0], "activity");
      f.advance();
      states[1] = await f.mutate(states[1], "token", { tokenRevision: states[1].tokenRevision, token: "refresh" });
      expect(selectInstallations(states, "A", { kind: "last_active" }).map((s) => s.id)).toEqual(["b"]);
      expect(selectInstallations(states, "A", { kind: "all" }).map((s) => s.id)).toEqual(["b", "a"]);
      expect(selectInstallations(states, "A", { kind: "specific", installationId: "a" })).toEqual([states[1]]);
      expect(selectInstallations(states, "A", { kind: "specific", installationId: "missing" })).toEqual([]);
      states[0] = await f.mutate(states[0], "facts", { ...f.facts, permission: "denied" });
      states[1] = await f.mutate(states[1], "facts", { ...f.facts, consent: false });
      expect(states[0].lastActiveAt).toBe(1000);
      expect(selectInstallations(states, "A", { kind: "all" })).toEqual([]);
      const state = states[0];
      const request = { requestId: randomUUID(), revision: state.revision, bindingGeneration: state.bindingGeneration };
      const duplicate = await Promise.all([1, 2].map(() => f.call(`${f.base}/${state.id}/activity`, "POST", request)));
      expect(duplicate[0]).toEqual(duplicate[1]);
      expect(await f.read(state.id)).toMatchObject({ revision: state.revision + 1, lastActiveAt: 2000 });
    });
  });
}

const postgresUpgrade = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;
postgresUpgrade("installation upgrade", () => {
  it("preserves existing data and enables lifecycle routes atomically", async () => {
    const { url, pool } = await database();
    const namespace = `installation_upgrade_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${namespace}"`);
    cleanup.push(async () => { await pool.query(`DROP SCHEMA "${namespace}" CASCADE`); await pool.end(); });
    url.searchParams.set("options", `-c search_path=${namespace}`);
    const legacy = new Pool({ connectionString: url.href });
    cleanup.push(() => legacy.end());
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    const upgrade = readFileSync(new URL("../upgrades/installations.sql", import.meta.url), "utf8");
    await legacy.query(schema.slice(0, schema.indexOf("CREATE TABLE installations (")));
    const f = await fixture("postgres", { connectionString: url.href });
    await f.identify("existing-user");
    const before = await legacy.query("SELECT * FROM end_users ORDER BY id");
    const projectsBefore = await legacy.query("SELECT * FROM projects ORDER BY id");
    const client = await legacy.connect();
    try {
      await expect(client.query(upgrade.replace("COMMIT;", "SELECT 1 / 0; COMMIT;"))).rejects.toThrow();
      await client.query("ROLLBACK");
      expect((await client.query("SELECT to_regclass('installations') as relation")).rows[0].relation).toBeNull();
    } finally { client.release(); }
    await legacy.query(upgrade);
    expect((await legacy.query("SELECT * FROM end_users ORDER BY id")).rows).toEqual(before.rows);
    expect((await legacy.query("SELECT * FROM projects ORDER BY id")).rows).toEqual(projectsBefore.rows);
    let { state } = await f.create();
    state = await f.mutate(state, "binding", { userId: "existing-user" });
    state = await f.mutate(state, "token", { token: "upgraded-token", tokenRevision: 0 });
    state = await f.mutate(state, "facts", f.facts);
    expect((await f.call("/api/v1/installations", "GET", undefined, f.options.secretKey)).body.installations).toEqual([state]);
  });
});
