import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPostgresProduct } from "./postgres-product.js";

const integration = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;

const initialExpression = {
  version: 1,
  root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" },
};

const revisedExpression = {
  version: 1,
  root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "pro" },
};

async function cleanProjects(connectionString: string, projectIds: string[]) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM audience_versions WHERE project_id = ANY($1)", [projectIds]);
    await client.query("DELETE FROM segments WHERE project_id = ANY($1)", [projectIds]);
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

integration("Postgres segment operations", () => {
  it("persists isolated immutable versions and serializes concurrent revisions", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectA = `test_segments_a_${randomUUID()}`;
    const projectB = `test_segments_b_${randomUUID()}`;
    const secretA = `secret_${randomUUID()}`;
    const secretB = `secret_${randomUUID()}`;
    let clock = 1_755_000_000_000;
    const optionsA = { connectionString, projectId: projectA, secretKey: secretA, now: () => clock };
    const optionsB = { connectionString, projectId: projectB, secretKey: secretB, now: () => clock };
    let productA: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    let productB: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      productA = await createPostgresProduct(optionsA);
      productB = await createPostgresProduct(optionsB);
      let appA = createApp(productA.handlers);
      const appB = createApp(productB.handlers);
      const headers = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
      const call = (app: ReturnType<typeof createApp>, key: string, path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers: headers(key),
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      const create = (app: ReturnType<typeof createApp>, key: string, name: string) => call(app, key, "/api/v1/segments", "POST", {
        key: "shared-key",
        name,
        expression: initialExpression,
        idempotencyKey: "shared-idempotency-key",
      });

      const createdAResponse = await create(appA, secretA, "Project A segment");
      const createdBResponse = await create(appB, secretB, "Project B segment");
      expect(createdAResponse.status).toBe(201);
      expect(createdBResponse.status).toBe(201);
      const createdA = (await createdAResponse.json()).segment;
      const createdB = (await createdBResponse.json()).segment;
      expect(createdA.id).not.toBe(createdB.id);
      expect((await call(appA, secretA, `/api/v1/segments/${createdB.id}`)).status).toBe(404);
      expect((await call(appB, secretB, `/api/v1/segments/${createdA.id}/versions/1`)).status).toBe(404);

      await productA.close();
      productA = null;
      productA = await createPostgresProduct(optionsA);
      appA = createApp(productA.handlers);
      const replayResponse = await create(appA, secretA, "Ignored replay name");
      expect(replayResponse.status).toBe(200);
      expect((await replayResponse.json()).segment).toMatchObject({ id: createdA.id, name: "Project A segment" });

      clock += 1;
      const revisions = await Promise.all([
        call(appA, secretA, `/api/v1/segments/${createdA.id}`, "PATCH", {
          expression: revisedExpression,
          expectedVersion: 1,
          reason: "First concurrent revision",
        }),
        call(appA, secretA, `/api/v1/segments/${createdA.id}`, "PATCH", {
          expression: {
            version: 1,
            root: { kind: "event", event: "upgraded" },
          },
          expectedVersion: 1,
          reason: "Second concurrent revision",
        }),
      ]);
      expect(revisions.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await revisions.find((response) => response.status === 409)!.json()).toMatchObject({ currentVersion: 2 });

      const history = await (await call(appA, secretA, `/api/v1/segments/${createdA.id}/versions`)).json();
      expect(history.versions).toHaveLength(2);
      expect(history.versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);
      const original = await (await call(appA, secretA, `/api/v1/segments/${createdA.id}/versions/1`)).json();
      expect(original.version).toMatchObject({ version: 1, expression: initialExpression });

      clock += 1;
      expect((await call(appA, secretA, "/api/v1/segments/shared-key/archive", "POST")).status).toBe(200);
      expect((await call(appA, secretA, `/api/v1/segments/${createdA.id}`, "PATCH", {
        expression: initialExpression,
        expectedVersion: 2,
      })).status).toBe(409);
      expect(await (await call(appB, secretB, "/api/v1/segments/shared-key")).json()).toMatchObject({
        segment: { id: createdB.id, status: "active", currentVersion: 1 },
      });
    } finally {
      await productA?.close();
      await productB?.close();
      await cleanProjects(connectionString, [projectA, projectB]);
    }
  });
});
