import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPostgresProduct } from "./postgres-product.js";

const integration = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;

async function cleanProjects(connectionString: string, projectIds: string[]) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM campaigns WHERE project_id = ANY($1)", [projectIds]);
    await client.query("DELETE FROM audience_versions WHERE project_id = ANY($1)", [projectIds]);
    await client.query("DELETE FROM segments WHERE project_id = ANY($1)", [projectIds]);
    await client.query("DELETE FROM events WHERE project_id = ANY($1)", [projectIds]);
    await client.query("DELETE FROM end_users WHERE project_id = ANY($1)", [projectIds]);
    await client.query("DELETE FROM projects WHERE id = ANY($1)", [projectIds]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

integration("Postgres audience operations", () => {
  it("builds project-scoped capabilities, checks, and explain traces from stored facts", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectA = `test_audience_a_${randomUUID()}`;
    const projectB = `test_audience_b_${randomUUID()}`;
    const secretA = `secret_${randomUUID()}`;
    const secretB = `secret_${randomUUID()}`;
    const publishableA = `publishable_${randomUUID()}`;
    const publishableB = `publishable_${randomUUID()}`;
    const clock = 1_755_000_000_000;
    let productA: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    let productB: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      productA = await createPostgresProduct({ connectionString, projectId: projectA, secretKey: secretA, publishableKey: publishableA, now: () => clock });
      productB = await createPostgresProduct({ connectionString, projectId: projectB, secretKey: secretB, publishableKey: publishableB, now: () => clock });
      const appA = createApp(productA.handlers);
      const appB = createApp(productB.handlers);
      const headers = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
      const call = (app: ReturnType<typeof createApp>, key: string, path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers: headers(key),
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));

      await call(appA, publishableA, "/api/v1/identify", "POST", { userId: "user_a", traits: { plan: "free" } });
      await call(appA, publishableA, "/api/v1/track", "POST", { userId: "user_a", event: "exported", props: { format: "csv" } });
      await call(appB, publishableB, "/api/v1/identify", "POST", { userId: "user_b", traits: { plan: "enterprise", private: true } });
      await call(appB, publishableB, "/api/v1/track", "POST", { userId: "user_b", event: "private_event" });

      const capabilities = (await (await call(appA, secretA, "/api/v1/audiences/capabilities")).json()).capabilities;
      expect(capabilities.traits).toContainEqual(expect.objectContaining({ key: "plan", values: ["free"] }));
      expect(capabilities.traits).not.toContainEqual(expect.objectContaining({ key: "private" }));
      expect(capabilities.events).toContainEqual(expect.objectContaining({ name: "exported", users: 1, occurrences: 1 }));
      expect(capabilities.events).not.toContainEqual(expect.objectContaining({ name: "private_event" }));

      const audience = {
        version: 1,
        root: {
          kind: "all",
          children: [
            { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" },
            { kind: "event", event: "exported", where: [
              { kind: "field", field: { kind: "event_property", key: "format" }, op: "eq", value: "csv" },
            ] },
          ],
        },
      };
      const checkedResponse = await call(appA, secretA, "/api/v1/audiences/check", "POST", { expression: audience });
      expect(checkedResponse.status).toBe(200);
      const checked = await checkedResponse.json();
      expect(checked).toMatchObject({
        matchedCount: 1,
        totalUsers: 1,
        samples: [{ externalUserId: "user_a", traits: { plan: "free" }, events: { exported: 1 } }],
      });

      const explainedResponse = await call(appA, secretA, "/api/v1/audiences/explain", "POST", {
        expression: audience,
        userId: "user_a",
      });
      expect(explainedResponse.status).toBe(200);
      expect(await explainedResponse.json()).toMatchObject({
        matched: true,
        user: { externalUserId: "user_a" },
        trace: { kind: "all", matched: true },
      });
      expect((await call(appA, secretA, "/api/v1/audiences/explain", "POST", {
        expression: audience,
        userId: "user_b",
      })).status).toBe(404);
    } finally {
      await productA?.close();
      await productB?.close();
      await cleanProjects(connectionString, [projectA, projectB]);
    }
  });

  it("persists and enforces expression, segment, and stored legacy campaign audiences", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_campaign_audience_${randomUUID()}`;
    const secret = `secret_${randomUUID()}`;
    const publishable = `publishable_${randomUUID()}`;
    const options = { connectionString, projectId, secretKey: secret, publishableKey: publishable, now: () => 1_755_000_000_000 };
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct(options);
      let app = createApp(product.handlers);
      const headers = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
      const call = (key: string, path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers: headers(key),
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      const expression = (plan: string) => ({
        version: 1,
        root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: plan },
      });

      await call(publishable, "/api/v1/identify", "POST", { userId: "free", traits: { plan: "free" } });
      await call(publishable, "/api/v1/identify", "POST", { userId: "pro", traits: { plan: "pro" } });
      const segment = (await (await call(secret, "/api/v1/segments", "POST", {
        key: "free-users",
        name: "Free users",
        expression: expression("free"),
      })).json()).segment;
      const inline = (await (await call(secret, "/api/v1/campaigns", "POST", {
        name: "Inline",
        message: { presentation: "toast", title: "Inline" },
        audience: { kind: "expression", expression: expression("free") },
        launch: true,
      })).json()).campaign;
      const pinned = (await (await call(secret, "/api/v1/campaigns", "POST", {
        name: "Pinned",
        message: { presentation: "toast", title: "Pinned" },
        audience: { kind: "segment", segment: segment.id },
        launch: true,
      })).json()).campaign;

      await product.close();
      product = await createPostgresProduct(options);
      app = createApp(product.handlers);
      expect((await (await call(secret, `/api/v1/campaigns/${inline.id}`)).json()).campaign.audience).toMatchObject({
        kind: "expression",
        audienceVersionId: inline.audience.audienceVersionId,
        legacy: false,
      });
      expect((await (await call(secret, `/api/v1/campaigns/${pinned.id}`)).json()).campaign.audience).toMatchObject({
        kind: "segment",
        audienceVersionId: pinned.audience.audienceVersionId,
        segmentVersion: 1,
      });
      const freeMessages = (await (await call(publishable, "/api/v1/messages?userId=free")).json()).messages;
      expect(new Set(freeMessages.map((message: { campaignId: string }) => message.campaignId))).toEqual(new Set([inline.id, pinned.id]));
      expect((await (await call(publishable, "/api/v1/messages?userId=pro")).json()).messages).toEqual([]);

      const legacyId = `cmp_${randomUUID()}`;
      const legacyVariantId = `var_${randomUUID()}`;
      const pool = new Pool({ connectionString });
      try {
        await pool.query(
          "INSERT INTO campaigns (id, project_id, name, channel, status, targeting_json, created_by, created_at) VALUES ($1, $2, $3, 'web_inapp', 'running', $4, 'api', $5)",
          [legacyId, projectId, "Legacy", JSON.stringify({ traits: { plan: "pro" } }), 1_755_000_000_000],
        );
        await pool.query(
          "INSERT INTO variants (id, campaign_id, name, content_json, weight, is_control) VALUES ($1, $2, 'A', $3, 1, true)",
          [legacyVariantId, legacyId, JSON.stringify({ presentation: "toast", title: "Legacy" })],
        );
      } finally {
        await pool.end();
      }
      const legacy = (await (await call(secret, `/api/v1/campaigns/${legacyId}`)).json()).campaign;
      expect(legacy).toMatchObject({
        targeting: { traits: { plan: "pro" } },
        audience: { kind: "expression", audienceVersionId: null, legacy: true },
      });
      expect((await (await call(publishable, "/api/v1/messages?userId=pro")).json()).messages.map((message: { campaignId: string }) => message.campaignId)).toContain(legacyId);
      expect((await (await call(publishable, "/api/v1/messages?userId=free")).json()).messages.map((message: { campaignId: string }) => message.campaignId)).not.toContain(legacyId);
    } finally {
      await product?.close();
      await cleanProjects(connectionString, [projectId]);
    }
  });
});
