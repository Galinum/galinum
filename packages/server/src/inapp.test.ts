import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { nodeAdapter } from "./node-adapter.js";
import { createLocalProduct, type LocalProductOptions } from "./local-product.js";
import { createPostgresProduct } from "./postgres-product.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(pg: boolean) {
  const projectId = "inapp_" + randomUUID();
  let clock = Date.UTC(2026, 0, 31, 23, 59); let serving = true; let failExposure = false;
  const exposures: unknown[] = [];
  const options: LocalProductOptions = { projectId, secretKey: "sk_" + randomUUID(), publishableKey: "pk_" + randomUUID(), now: () => clock,
    inAppMayServe: async () => serving, inAppRecordExposure: async (_tx, fact) => { if (failExposure) throw new Error("ledger failed"); exposures.push(fact); } };
  if (pg) {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.startsWith("/galinum_installations_test_")) throw new Error("Disposable loopback database required");
    const pool = new Pool({ connectionString: url.href });
    const identity = (await pool.query("SELECT current_database() AS db, host(inet_server_addr()) AS host")).rows[0];
    expect(identity.db).toBe(url.pathname.slice(1)); expect(["127.0.0.1", "::1"]).toContain(identity.host);
    cleanup.push(async () => {
      for (const table of ["push_records", "installations", "campaigns", "events", "end_users", "goals", "projects"]) await pool.query("DELETE FROM " + table + " WHERE " + (table === "projects" ? "id" : "project_id") + "=$1", [projectId]);
      await pool.end();
    });
  }
  const product = pg ? await createPostgresProduct({ ...options, connectionString: process.env.DATABASE_URL! }) : createLocalProduct(options);
  cleanup.push(() => product.close());
  const server = createServer(nodeAdapter(createApp(product.handlers)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  const origin = "http://127.0.0.1:" + address.port;
  async function call(path: string, body?: object, sdk = true) {
    const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + (sdk ? product.publishableKey : product.secretKey), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  }
  await call("/api/v1/identify", { userId: "A", traits: { plan: "free" } });
  const campaign = (await call("/api/v1/campaigns", { name: "Shared", launch: true, message: { title: "Shared", presentation: "toast" }, pages: ["/screen*"] }, false)).body.campaign;
  const decide = (entry: string, userId = "A", path = "/screen") => call("/api/v1/messages?" + new URLSearchParams({ userId, entryId: entry, requestId: randomUUID(), path }));
  const feedback = (deliveryId: string, type: string, userId = "A", feedbackId = deliveryId + ":" + type) => call("/api/v1/deliveries/" + deliveryId + "/event", { userId, type, feedbackId });
  return { call, decide, feedback, campaign, exposures, advance: () => { clock += 86400000; }, gate: (value: boolean) => { serving = value; }, fail: (value: boolean) => { failExposure = value; } };
}
for (const pg of [false, true]) {
  const suite = pg && process.env.RUN_DB_INTEGRATION !== "1" ? describe.skip : describe;
  suite((pg ? "Postgres" : "memory") + " authoritative in-app", () => {
    it.each([["web", "native"], ["native", "web"]])("completion on %s suppresses a later %s entry with warm content", async (first, later) => {
      const f = await fixture(pg);
      const warm = await f.decide(later + "-old");
      const message = warm.body.messages[0];
      const another = await f.decide(first);
      expect(another.body.messages[0]).toEqual(message);
      expect(warm.cache).toBe("no-store"); expect(warm.body.entryId).toBe(later + "-old");
      expect((await f.feedback(message.deliveryId, "shown")).status).toBe(200);
      expect((await f.feedback(message.deliveryId, "dismissed")).status).toBe(200);
      const current = await f.decide(later + "-new");
      expect(current.body.messages).toEqual([]); expect(current.body.entryId).toBe(later + "-new");
      expect(current.body.requestId).not.toBe(warm.body.requestId);
    });
    it("enforces correlation, path, serving and captured identity", async () => {
      const f = await fixture(pg);
      expect((await f.call("/api/v1/messages?userId=A")).status).toBe(400);
      expect((await f.decide("off-path", "A", "/other")).body.messages).toEqual([]);
      f.gate(false); expect((await f.decide("closed")).body.messages).toEqual([]);
      f.gate(true); const message = (await f.decide("open")).body.messages[0];
      expect((await f.feedback(message.deliveryId, "shown", "B")).status).toBe(409);
      expect((await f.feedback(message.deliveryId, "dismissed")).status).toBe(409);
      const other = await fixture(pg);
      expect((await other.feedback(message.deliveryId, "shown")).status).toBe(404);
    });
    it("retains exact receipt and first exposure across periods and rollback", async () => {
      const f = await fixture(pg); const message = (await f.decide("entry")).body.messages[0];
      f.fail(true); expect((await f.feedback(message.deliveryId, "shown")).status).toBe(500);
      f.fail(false); const first = await f.feedback(message.deliveryId, "shown");
      expect(first.status).toBe(200); expect(f.exposures).toHaveLength(1);
      f.advance();
      expect((await f.feedback(message.deliveryId, "shown")).body).toEqual(first.body);
      expect(f.exposures).toHaveLength(1);
      expect((await f.call("/api/v1/usage", undefined, false)).body.activeUsers).toBe(0);
      expect((await f.feedback(message.deliveryId, "shown", "A", "new-render")).status).toBe(200);
      expect(f.exposures).toHaveLength(2);
      expect((await f.call("/api/v1/usage", undefined, false)).body.activeUsers).toBe(1);
      expect((await f.feedback(message.deliveryId, "dismissed", "A", "new-render")).status).toBe(409);
      const done = await f.feedback(message.deliveryId, "converted");
      f.advance(); expect((await f.feedback(message.deliveryId, "converted")).body).toEqual(done.body);
      await f.feedback(message.deliveryId, "shown");
      expect((await f.decide("later")).body.messages).toEqual([]);
    });
  });
}


(process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip)("in-app receipt upgrade", () => {
  it("preserves M2 data, rolls back DDL failure and installs receipt indexes", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/galinum_installations_test_")) throw new Error("Disposable loopback database required");
    const pool = new Pool({ connectionString: url.href });
    const ns = "inapp_upgrade_" + randomUUID().replaceAll("-", "");
    await pool.query('CREATE SCHEMA "' + ns + '"');
    const client = await pool.connect();
    try {
      await client.query('SET search_path TO "' + ns + '"');
      const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
      await client.query(schema.slice(0, schema.indexOf("CREATE TABLE inapp_feedback (")));
      await client.query("INSERT INTO projects (id,name,created_at) VALUES ('kept','Kept',1)");
      const before = (await client.query("SELECT * FROM projects")).rows;
      const upgrade = readFileSync(new URL("../upgrades/inapp.sql", import.meta.url), "utf8");
      await expect(client.query(upgrade.replace("COMMIT;", "SELECT 1/0; COMMIT;"))).rejects.toThrow();
      await client.query("ROLLBACK");
      expect((await client.query("SELECT to_regclass('inapp_feedback') AS name")).rows[0].name).toBeNull();
      await client.query(upgrade);
      expect((await client.query("SELECT * FROM projects")).rows).toEqual(before);
      await client.query("SET enable_seqscan=off");
      const plan = await client.query("EXPLAIN (COSTS OFF) SELECT * FROM inapp_feedback WHERE project_id='kept' AND id='receipt'");
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join(" ")).toContain("inapp_feedback_pkey");
    } finally {
      client.release();
      await pool.query('DROP SCHEMA "' + ns + '" CASCADE');
      await pool.end();
    }
  });
});
