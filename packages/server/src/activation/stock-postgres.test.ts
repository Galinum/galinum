import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresProduct } from "../postgres-product.js";
import { createApp } from "../app.js";

const integration = process.env.RUN_DB_INTEGRATION === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const credentials = { secretKey: "sk_stock_pg", publishableKey: "pk_stock_pg", operatorKey: "operator_stock_pg" };
async function isolated(run: (url: string, pool: Pool) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL!);
  const admin = new Pool({ connectionString: url.toString() });
  const schema = `stock_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString() });
  try { await run(url.toString(), pool); }
  finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
}
function client(product: Awaited<ReturnType<typeof createPostgresProduct>>) {
  const app = createApp(product.handlers, product.media, product.operatorHandler);
  return async (path: string, method = "GET", body?: unknown, operator = false) => {
    const response = await app(new Request(`http://local${path}`, { method,
      headers: { authorization: `Bearer ${operator ? credentials.operatorKey : credentials.secretKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, value: await response.json() };
  };
}
integration("stock Postgres composition", () => {
  it("rejects an unversioned schema and persists atomic source preparation across restart", async () => isolated(async (connectionString, pool) => {
    await expect(createPostgresProduct({ ...credentials, connectionString })).rejects.toThrow("activation-1.sql");
    await pool.query(await readFile(new URL("../../schema.sql", import.meta.url), "utf8"));
    let product = await createPostgresProduct({ ...credentials, connectionString });
    try {
      let request = client(product);
      expect((await request("/operator/sources/source", "PUT", { expectedRevision: "0", installationId: 7, repositoryId: 12,
        owner: "owner", name: "repo", branch: "main", enabled: false, paused: false }, true)).status).toBe(200);
      const changes = [{ sourceId: "source", kind: "commit", sha: "a".repeat(40) }];
      const created = await request("/api/v1/campaigns", "POST", { name: "Before", message: { title: "Release", presentation: "toast" }, sourceChanges: { changes } });
      expect(created.status).toBe(201);
      const id = created.value.campaign.id;
      expect((await request(`/api/v1/campaigns/${id}`, "PATCH", { name: "Must roll back", sourceChanges: { expectedRevision: "0", changes: [] } })).status).toBe(409);
      await pool.query("CREATE FUNCTION fail_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected copy failure'; END $$");
      await pool.query("CREATE TRIGGER fail_copy BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION fail_copy()");
      await expect(request(`/api/v1/campaigns/${id}`, "PATCH", { name: "Must also roll back", sourceChanges: { expectedRevision: "1", changes: [] } })).rejects.toThrow("injected copy failure");
      await pool.query("DROP TRIGGER fail_copy ON campaigns");
      await product.close();
      product = await createPostgresProduct({ ...credentials, connectionString });
      request = client(product);
      expect((await request(`/api/v1/campaigns/${id}`)).value.campaign).toMatchObject({ name: "Before", sourceChanges: { revision: "1", changes } });
      expect((await request(`/api/v1/campaigns/${id}/status`, "POST", { action: "launch" })).status).toBe(200);
      expect((await request(`/api/v1/campaigns/${id}/activation`)).value.launch.mode).toBe("manual");
    } finally { await product.close(); }
  }));

  it("rolls back lifecycle and create-with-launch when receipt persistence fails", async () => isolated(async (connectionString, pool) => {
    await pool.query(await readFile(new URL("../../schema.sql", import.meta.url), "utf8"));
    const product = await createPostgresProduct({ ...credentials, connectionString });
    try {
      const request = client(product);
      const created = await request("/api/v1/campaigns", "POST", { name: "Before", message: { title: "Release", presentation: "toast" } });
      const id = created.value.campaign.id;
      await pool.query("CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$");
      await pool.query("CREATE TRIGGER fail_receipt BEFORE INSERT OR UPDATE ON campaign_activation_state FOR EACH ROW EXECUTE FUNCTION fail_receipt()");
      await expect(request(`/api/v1/campaigns/${id}/status`, "POST", { action: "launch" })).rejects.toThrow("injected receipt failure");
      expect((await request(`/api/v1/campaigns/${id}`)).value.campaign).toMatchObject({ status: "draft", startedAt: null });
      await expect(request("/api/v1/campaigns", "POST", { name: "Must roll back", message: { title: "Release", presentation: "toast" }, launch: true })).rejects.toThrow("injected receipt failure");
      expect((await request("/api/v1/campaigns")).value.total).toBe(1);
      await pool.query("DROP TRIGGER fail_receipt ON campaign_activation_state");
      expect((await request(`/api/v1/campaigns/${id}/status`, "POST", { action: "launch" })).status).toBe(200);
      expect((await request(`/api/v1/campaigns/${id}/activation`)).value.launch.mode).toBe("manual");
    } finally { await product.close(); }
  }));
});
