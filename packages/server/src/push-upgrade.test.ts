import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresProduct } from "./postgres-product.js";
import { createApp } from "./app.js";
const integration = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("push upgrade", () => {
  it("preserves installation-era data and enables push routes atomically", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/(galinum_product_ci|galinum_installations_test_[a-z0-9_]+)$/.test(url.pathname)) throw new Error("Disposable loopback database required");
    const pool = new Pool({ connectionString: url.href });
    const target = (await pool.query("select current_database() as name, host(inet_server_addr()) as address")).rows[0];
    expect(target.name).toBe(url.pathname.slice(1)); expect(["127.0.0.1", "::1"]).toContain(target.address);
    const namespace = `push_upgrade_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${namespace}"`);
    url.searchParams.set("options", `-c search_path=${namespace}`);
    const database = new Pool({ connectionString: url.href });
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | undefined;
    try {
      const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
      await database.query(schema.slice(0, schema.indexOf("CREATE TABLE push_records (")).replace("  push_json text,\n", ""));
      await database.query("INSERT INTO projects (id, name, created_at) VALUES ('preserved','Preserved',1)");
      await database.query("INSERT INTO end_users (id, project_id, external_user_id, traits_json, first_seen_at, last_seen_at) VALUES ('existing','preserved','user','{}',1,1)");
      const before = (await database.query("SELECT * FROM end_users")).rows;
      const upgrade = readFileSync(new URL("../upgrades/push.sql", import.meta.url), "utf8");
      const client = await database.connect();
      try {
        await expect(client.query(upgrade.replace("COMMIT;", "SELECT 1/0; COMMIT;"))).rejects.toThrow();
        await client.query("ROLLBACK");
        expect((await client.query("SELECT to_regclass('push_records') as name")).rows[0].name).toBeNull();
      } finally { client.release(); }
      await database.query(upgrade);
      const planner = await database.connect();
      try {
        await planner.query("BEGIN"); await planner.query("SET LOCAL enable_seqscan = off");
        const plan = await planner.query("EXPLAIN (COSTS OFF) SELECT body_json FROM push_records WHERE project_id = 'preserved' AND kind = 'queue' AND available_at <= 100 ORDER BY available_at, id COLLATE \"C\" LIMIT 100");
        expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("push_records_due");
        const work = await planner.query("EXPLAIN (COSTS OFF) SELECT body_json FROM push_records WHERE project_id = 'preserved' AND kind = 'work' AND available_at <= 100 ORDER BY available_at, id COLLATE \"C\" LIMIT 100");
        expect(work.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain("push_records_work_due");
        await planner.query("ROLLBACK");
      } finally { planner.release(); }
      expect((await database.query("SELECT * FROM end_users")).rows).toEqual(before);
      await expect(createPostgresProduct({ connectionString: url.href })).rejects.toThrow("activation-1.sql");
      for (const path of ["../upgrades/inapp.sql", "../migrations/activation-1.sql"]) await database.query(readFileSync(new URL(path, import.meta.url), "utf8"));
      product = await createPostgresProduct({ projectId: "preserved", connectionString: url.href, secretKey: "test-secret", publishableKey: "test-publishable" });
      const app = createApp(product.handlers);
      const headers = { authorization: "Bearer test-secret", "content-type": "application/json" };
      const response = await app(new Request("http://local/api/v1/campaigns", { method: "POST", headers, body: JSON.stringify({ name: "Push", channel: "push", push: { appId: "app", selection: { kind: "all" } }, message: { title: "Title", body: "Body", destination: { kind: "website", url: "https://example.com" } } }) }));
      expect(response.status).toBe(201);
      const campaign = (await response.json()).campaign;
      const inspection = await app(new Request(`http://local/api/v1/campaigns/${campaign.id}/push`, { headers }));
      expect(inspection.status).toBe(200); expect((await inspection.json()).targets).toEqual([]);
    } finally {
      await product?.close(); await database.end(); await pool.query(`DROP SCHEMA "${namespace}" CASCADE`); await pool.end();
    }
  });
});
