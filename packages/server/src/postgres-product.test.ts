import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createPostgresProduct } from "./postgres-product.js";
import { FileMediaStore } from "./local-media-store.js";

const integration = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;

async function cleanProject(connectionString: string, projectId: string) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM agent_runs WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM campaigns WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM audience_versions WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM segments WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM events WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM end_users WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM goals WHERE project_id = $1", [projectId]);
    await client.query("DELETE FROM projects WHERE id = $1", [projectId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

integration("Postgres single-project path", () => {
  it("persists, serves, exposes, and converts a campaign", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    const timestamp = 1_755_000_000_000;
    const options = { connectionString, projectId, secretKey, publishableKey, now: () => timestamp };
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct(options);
      let app = createApp(product.handlers);
      const secret = { authorization: `Bearer ${secretKey}`, "content-type": "application/json" };
      const publishable = { authorization: `Bearer ${publishableKey}`, "content-type": "application/json" };

      const goalResponse = await app(new Request("http://local/api/v1/goals", {
        method: "POST",
        headers: secret,
        body: JSON.stringify({ name: "Activation", targetEvent: "activated" }),
      }));
      expect(goalResponse.status).toBe(201);
      const goal = (await goalResponse.json()).goal;

      const campaignResponse = await app(new Request("http://local/api/v1/campaigns", {
        method: "POST",
        headers: secret,
        body: JSON.stringify({ name: "Welcome", message: { presentation: "toast", title: "Welcome" }, goalId: goal.id, launch: true }),
      }));
      expect(campaignResponse.status).toBe(201);
      const campaign = (await campaignResponse.json()).campaign;

      expect((await app(new Request("http://local/api/v1/identify", {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ userId: "user_1", traits: { plan: "free" } }),
      }))).status).toBe(200);

      const messageRequests = await Promise.all([
        app(new Request("http://local/api/v1/messages?userId=user_1", { headers: publishable })),
        app(new Request("http://local/api/v1/messages?userId=user_1", { headers: publishable })),
      ]);
      const messageSets = await Promise.all(messageRequests.map((response) => response.json()));
      expect(messageSets[0].messages).toHaveLength(1);
      expect(messageSets[0].messages[0].content).toMatchObject({ title: "Welcome", presentation: "toast" });
      expect(messageSets[1].messages[0].deliveryId).toBe(messageSets[0].messages[0].deliveryId);

      expect((await app(new Request(`http://local/api/v1/deliveries/${messageSets[0].messages[0].deliveryId}/event`, {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ type: "shown" }),
      }))).status).toBe(200);

      expect((await app(new Request("http://local/api/v1/track", {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ userId: "user_1", event: "activated" }),
      }))).status).toBe(200);

      expect((await app(new Request("http://local/api/v1/identify", {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ userId: "user_2" }),
      }))).status).toBe(200);
      const backfillResponse = await app(new Request("http://local/api/v1/messages?userId=user_2", { headers: publishable }));
      const backfillMessage = (await backfillResponse.json()).messages[0];
      expect((await app(new Request("http://local/api/v1/track", {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ userId: "user_2", event: "activated" }),
      }))).status).toBe(200);
      expect((await app(new Request(`http://local/api/v1/deliveries/${backfillMessage.deliveryId}/event`, {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ type: "shown" }),
      }))).status).toBe(200);

      await product.close();
      product = null;
      product = await createPostgresProduct(options);
      app = createApp(product.handlers);
      const detailResponse = await app(new Request(`http://local/api/v1/campaigns/${campaign.id}`, { headers: secret }));
      expect(detailResponse.status).toBe(200);
      expect((await detailResponse.json()).campaign.stats.converted).toBe(2);
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });

  it("persists management reads and isolates projects", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectA = `test_a_${randomUUID()}`;
    const projectB = `test_b_${randomUUID()}`;
    const secretA = `secret_${randomUUID()}`;
    const secretB = `secret_${randomUUID()}`;
    const publishableA = `publishable_${randomUUID()}`;
    const publishableB = `publishable_${randomUUID()}`;
    let clock = 1_755_000_000_000;
    const optionsA = { connectionString, projectId: projectA, secretKey: secretA, publishableKey: publishableA, now: () => clock };
    const optionsB = { connectionString, projectId: projectB, secretKey: secretB, publishableKey: publishableB, now: () => clock };
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
      const seed = async (app: ReturnType<typeof createApp>, secret: string, publishable: string, suffix: string) => {
        const goal = (await (await call(app, secret, "/api/v1/goals", "POST", { name: `Goal ${suffix}`, targetEvent: "activated" })).json()).goal;
        const campaign = (await (await call(app, secret, "/api/v1/campaigns", "POST", {
          name: `Campaign ${suffix}`,
          message: { presentation: "toast", title: suffix },
          goalId: goal.id,
          launch: true,
        })).json()).campaign;
        await call(app, publishable, "/api/v1/identify", "POST", { userId: `user_${suffix}`, traits: { project: suffix } });
        const messages = (await (await call(app, publishable, `/api/v1/messages?userId=user_${suffix}`)).json()).messages;
        await call(app, publishable, `/api/v1/deliveries/${messages[0].deliveryId}/event`, "POST", { type: "shown" });
        clock += 1;
        await call(app, publishable, "/api/v1/track", "POST", { userId: `user_${suffix}`, event: "activated", props: { project: suffix } });
        const runResponse = await call(app, secret, "/api/v1/agent-runs", "POST", {
          kind: "evaluation",
          goalId: goal.id,
          campaignId: campaign.id,
          input: { project: suffix },
          idempotencyKey: `run_${suffix}`,
        });
        return { goal, campaign, run: (await runResponse.json()).run };
      };

      const a = await seed(appA, secretA, publishableA, "a");
      const b = await seed(appB, secretB, publishableB, "b");
      const updatedGoal = await call(appA, secretA, `/api/v1/goals/${a.goal.id}`, "PATCH", { name: "Persisted goal", approvalMode: "auto" });
      expect((await updatedGoal.json()).goal).toMatchObject({ name: "Persisted goal", approvalMode: "auto" });
      const updatedCampaign = await call(appA, secretA, `/api/v1/campaigns/${a.campaign.id}`, "PATCH", { name: "Persisted campaign", pages: ["/a"] });
      expect((await updatedCampaign.json()).campaign).toMatchObject({ name: "Persisted campaign", pages: ["/a"] });

      await productA.close();
      productA = null;
      productA = await createPostgresProduct(optionsA);
      appA = createApp(productA.handlers);

      const users = await (await call(appA, secretA, "/api/v1/users")).json();
      expect(users).toMatchObject({ total: 1, users: [{ externalUserId: "user_a" }] });
      expect((await call(appA, secretA, `/api/v1/users/${users.users[0].id}`)).status).toBe(200);
      expect((await call(appA, secretA, `/api/v1/users/${encodeURIComponent("user_b")}`)).status).toBe(404);
      const events = await (await call(appA, secretA, "/api/v1/events")).json();
      expect(events).toMatchObject({ total: 1, events: [{ externalUserId: "user_a", props: { project: "a" } }] });
      expect((await call(appA, secretA, `/api/v1/goals/${a.goal.id}`)).status).toBe(200);
      expect((await call(appA, secretA, `/api/v1/goals/${b.goal.id}`)).status).toBe(404);
      expect((await call(appA, secretA, `/api/v1/campaigns/${b.campaign.id}`, "PATCH", { name: "cross-project" })).status).toBe(404);

      const deliveries = await (await call(appA, secretA, `/api/v1/campaigns/${a.campaign.id}/deliveries`)).json();
      expect(deliveries).toMatchObject({ total: 1, deliveries: [{ externalUserId: "user_a", state: "converted" }] });
      expect((await call(appA, secretA, `/api/v1/campaigns/${b.campaign.id}/deliveries`)).status).toBe(404);
      const conversions = await (await call(appA, secretA, `/api/v1/campaigns/${a.campaign.id}/conversions?event=activated`)).json();
      expect(conversions.totals).toEqual({ exposedDeliveries: 1, exposedUsers: 1, convertedDeliveries: 1, convertedUsers: 1 });

      const runs = await (await call(appA, secretA, "/api/v1/agent-runs")).json();
      expect(runs).toMatchObject({ total: 1, runs: [{ id: a.run.id, campaignId: a.campaign.id }] });
      const replay = await call(appA, secretA, "/api/v1/agent-runs", "POST", { kind: "ignored", idempotencyKey: "run_a" });
      expect(replay.status).toBe(200);
      expect((await replay.json()).run.id).toBe(a.run.id);
      const usage = await (await call(appA, secretA, "/api/v1/usage")).json();
      expect(usage).toMatchObject({ activeUsers: 1, projects: [{ id: projectA, activeUsers: 1 }] });
      expect(await (await call(appB, secretB, "/api/v1/agent-runs")).json()).toMatchObject({ total: 1, runs: [{ id: b.run.id }] });
    } finally {
      await productA?.close();
      await productB?.close();
      await cleanProject(connectionString, projectA);
      await cleanProject(connectionString, projectB);
    }
  });

  it("returns deliveries newest first", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_delivery_order_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    let clock = 1_755_000_000_000;
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct({ connectionString, projectId, secretKey, publishableKey, now: () => clock });
      const app = createApp(product.handlers);
      const headers = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
      const call = (key: string, path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers: headers(key),
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      const campaign = (await (await call(secretKey, "/api/v1/campaigns", "POST", {
        name: "Ordered",
        message: { presentation: "toast", title: "Ordered" },
        launch: true,
      })).json()).campaign;
      for (const userId of ["older", "newer"]) {
        await call(publishableKey, "/api/v1/identify", "POST", { userId });
        await call(publishableKey, `/api/v1/messages?userId=${userId}`);
        clock += 1;
      }
      const deliveries = (await (await call(secretKey, `/api/v1/campaigns/${campaign.id}/deliveries`)).json()).deliveries;
      expect(deliveries.map((delivery: { externalUserId: string }) => delivery.externalUserId)).toEqual(["newer", "older"]);
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });

  it("serializes concurrent campaign content and lifecycle writes", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_campaign_races_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    const timestamp = 1_755_000_000_000;
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct({ connectionString, projectId, secretKey, publishableKey, now: () => timestamp });
      const app = createApp(product.handlers);
      const headers = { authorization: `Bearer ${secretKey}`, "content-type": "application/json" };
      const call = (path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers,
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      const create = async (name: string) => (await (await call("/api/v1/campaigns", "POST", {
        name,
        message: { presentation: "toast", title: name },
      })).json()).campaign;

      const campaign = await create("Concurrent");
      let release = () => {};
      const blockedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          release = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ name: "Patched after end" })));
            controller.close();
          };
        },
      });
      const patch = app(new Request(`http://local/api/v1/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers,
        body: blockedBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" }));
      await Promise.resolve();
      expect((await call(`/api/v1/campaigns/${campaign.id}/status`, "POST", { action: "end" })).status).toBe(200);
      release();
      expect((await patch).status).toBe(200);
      expect((await (await call(`/api/v1/campaigns/${campaign.id}`)).json()).campaign).toMatchObject({
        name: "Patched after end",
        status: "ended",
        endedAt: timestamp,
      });

      const disjoint = await create("Disjoint");
      const responses = await Promise.all([
        call(`/api/v1/campaigns/${disjoint.id}`, "PATCH", { name: "Renamed" }),
        call(`/api/v1/campaigns/${disjoint.id}`, "PATCH", { pages: ["/settings"] }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect((await (await call(`/api/v1/campaigns/${disjoint.id}`)).json()).campaign).toMatchObject({
        name: "Renamed",
        pages: ["/settings"],
      });

      const goal = (await (await call("/api/v1/goals", "POST", { name: "Original" })).json()).goal;
      const goalResponses = await Promise.all([
        call(`/api/v1/goals/${goal.id}`, "PATCH", { name: "Renamed goal" }),
        call(`/api/v1/goals/${goal.id}`, "PATCH", { description: "Preserved" }),
      ]);
      expect(goalResponses.map((response) => response.status)).toEqual([200, 200]);
      expect((await (await call(`/api/v1/goals/${goal.id}`)).json()).goal).toMatchObject({
        name: "Renamed goal",
        description: "Preserved",
      });
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });

  it("persists relative media paths and renders them through the current origin", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_media_origin_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    const root = mkdtempSync(join(tmpdir(), "galinum-postgres-media-"));
    const options = { connectionString, projectId, secretKey, publishableKey, now: () => 1_755_000_000_000 };
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      const oldMedia = new FileMediaStore(root, "https://old.example");
      const object = await oldMedia.put({ projectId, bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", extension: "png" });
      product = await createPostgresProduct({ ...options, media: oldMedia });
      let app = createApp(product.handlers, product.media);
      const secret = { authorization: `Bearer ${secretKey}`, "content-type": "application/json" };
      const publishable = { authorization: `Bearer ${publishableKey}`, "content-type": "application/json" };
      const campaignResponse = await app(new Request("http://local/api/v1/campaigns", {
        method: "POST",
        headers: secret,
        body: JSON.stringify({
          name: "Media",
          message: { presentation: "toast", title: "Media", media: { url: oldMedia.publicUrl(object.path), alt: "Media" } },
          launch: true,
        }),
      }));
      expect(campaignResponse.status).toBe(201);
      const campaign = (await campaignResponse.json()).campaign;
      expect(campaign.variants[0].content.media.url).toBe(oldMedia.publicUrl(object.path));

      const pool = new Pool({ connectionString });
      try {
        const row = await pool.query<{ content_json: string }>("SELECT content_json FROM variants WHERE campaign_id = $1", [campaign.id]);
        expect(JSON.parse(row.rows[0].content_json).media.url).toBe(object.path);
      } finally {
        await pool.end();
      }

      await product.close();
      product = await createPostgresProduct({ ...options, media: new FileMediaStore(root, "https://new.example") });
      app = createApp(product.handlers, product.media);
      const detail = (await (await app(new Request(`http://local/api/v1/campaigns/${campaign.id}`, { headers: secret }))).json()).campaign;
      expect(detail.variants[0].content.media.url).toBe(`https://new.example${object.path}`);
      await app(new Request("http://local/api/v1/identify", {
        method: "POST",
        headers: publishable,
        body: JSON.stringify({ userId: "user" }),
      }));
      const messages = (await (await app(new Request("http://local/api/v1/messages?userId=user", { headers: publishable }))).json()).messages;
      expect(messages[0].content.media.url).toBe(`https://new.example${object.path}`);
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });

  it("applies filters, counts, and pagination inside bounded store queries", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_bounded_queries_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    let clock = 1_755_000_000_000;
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct({ connectionString, projectId, secretKey, publishableKey, now: () => clock });
      const app = createApp(product.handlers);
      const call = (key: string, path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      const campaign = (await (await call(secretKey, "/api/v1/campaigns", "POST", {
        name: "Bounded",
        message: { presentation: "toast", title: "Bounded" },
        launch: true,
      })).json()).campaign;
      for (const [userId, plan] of [["alpha", "free"], ["beta", "pro"], ["gamma", "free"]] as const) {
        clock += 1;
        await call(publishableKey, "/api/v1/identify", "POST", { userId, traits: { plan } });
        await call(publishableKey, `/api/v1/messages?userId=${userId}`);
      }
      await call(publishableKey, "/api/v1/track", "POST", { userId: "alpha", event: "exported" });
      await call(publishableKey, "/api/v1/track", "POST", { userId: "beta", event: "ignored" });
      await call(publishableKey, "/api/v1/track", "POST", { userId: "gamma", event: "exported" });
      await call(secretKey, "/api/v1/agent-runs", "POST", { kind: "evaluation" });
      clock += 1;
      await call(secretKey, "/api/v1/agent-runs", "POST", { kind: "other" });
      clock += 1;
      await call(secretKey, "/api/v1/agent-runs", "POST", { kind: "evaluation" });

      const users = await (await call(secretKey, "/api/v1/users?perPage=1&page=2")).json();
      expect(users).toMatchObject({ total: 3, page: 2, pageCount: 3 });
      expect(users.users).toHaveLength(1);
      const filteredUsers = await (await call(secretKey, "/api/v1/users?traitKey=plan&traitValue=free&perPage=1&page=2")).json();
      expect(filteredUsers).toMatchObject({ total: 2, page: 2, pageCount: 2 });
      expect(filteredUsers.users).toHaveLength(1);
      const events = await (await call(secretKey, "/api/v1/events?name=exported&perPage=1&page=2")).json();
      expect(events).toMatchObject({ total: 2, page: 2, pageCount: 2 });
      expect(events.events).toHaveLength(1);
      const runs = await (await call(secretKey, "/api/v1/agent-runs?kind=evaluation&perPage=1&page=2")).json();
      expect(runs).toMatchObject({ total: 2, page: 2, pageCount: 2 });
      expect(runs.runs).toHaveLength(1);
      const deliveries = await (await call(secretKey, `/api/v1/campaigns/${campaign.id}/deliveries?state=queued&perPage=1&page=2`)).json();
      expect(deliveries).toMatchObject({ total: 3, page: 2, pageCount: 3 });
      expect(deliveries.deliveries).toHaveLength(1);
      expect((await call(secretKey, "/api/v1/agent-runs", "POST", { kind: "invalid", goalId: "" })).status).toBe(400);
      expect((await call(secretKey, "/api/v1/agent-runs", "POST", { kind: "invalid", campaignId: "" })).status).toBe(400);
      expect((await call(secretKey, "/api/v1/segments", "POST", {
        key: "invalid-agent-run",
        name: "Invalid agent run",
        expression: { version: 1, root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" } },
        agentRunId: "",
      })).status).toBe(400);
      for (let index = 0; index < 16; index += 1) {
        expect((await call(publishableKey, "/api/v1/identify", "POST", { userId: "large-traits", traits: { [`key_${index}`]: "x".repeat(3_900) } })).status).toBe(200);
      }
      expect((await call(publishableKey, "/api/v1/identify", "POST", { userId: "large-traits", traits: { overflow: "x".repeat(3_900) } })).status).toBe(413);
      await call(publishableKey, "/api/v1/identify", "POST", { userId: "scalar-traits", traits: { plan: true, nested: { value: true } } });
      expect((await (await call(secretKey, "/api/v1/users?traitKey=plan&traitValue=true")).json()).total).toBe(1);
      expect((await (await call(secretKey, "/api/v1/users?traitKey=nested&traitValue=%5Bobject%20Object%5D")).json()).total).toBe(0);
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });

  it("bounds and filters goal and segment listings", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_goal_segment_bounds_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    let clock = 1_755_000_000_000;
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct({
        connectionString, projectId, secretKey, publishableKey, now: () => clock,
        managementRateLimit: { perMinute: 10_000, perHour: 10_000 },
      });
      const app = createApp(product.handlers);
      const call = (path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      for (let index = 0; index < 101; index += 1) {
        clock += 1;
        await call("/api/v1/goals", "POST", { name: `Goal ${index}` });
      }
      const goals = (await (await call("/api/v1/goals")).json()).goals;
      expect(goals).toHaveLength(100);
      expect(goals[0].name).toBe("Goal 100");
      expect(goals.at(-1).name).toBe("Goal 1");

      const segmentIds: string[] = [];
      for (let index = 0; index < 101; index += 1) {
        clock += 1;
        const response = await call("/api/v1/segments", "POST", {
          key: `segment-${index}`,
          name: `Segment ${index}`,
          expression: { version: 1, root: { kind: "field", field: { kind: "trait", key: "plan" }, op: "eq", value: "free" } },
        });
        segmentIds.push((await response.json()).segment.id);
      }
      await call(`/api/v1/segments/${segmentIds.at(-1)}/archive`, "POST");
      const segments = (await (await call("/api/v1/segments")).json()).segments;
      expect(segments).toHaveLength(100);
      expect(segments[0]).toMatchObject({ name: "Segment 100", status: "archived" });
      expect((await (await call("/api/v1/segments?status=active")).json()).segments).toHaveLength(100);
      expect((await (await call("/api/v1/segments?status=archived")).json()).segments).toEqual([expect.objectContaining({ name: "Segment 100" })]);
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });

  it("filters high-history conversions and scopes frequency caps to the usage period", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_conversion_usage_bounds_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    const timestamp = Date.UTC(2025, 7, 15);
    const start = Date.UTC(2025, 7, 1);
    const end = Date.UTC(2025, 8, 1);
    let product: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      product = await createPostgresProduct({
        connectionString, projectId, secretKey, publishableKey, now: () => timestamp,
        managementRateLimit: { perMinute: 10_000, perHour: 10_000 }, sdkRateLimit: { perMinute: 10_000, perHour: 10_000 },
      });
      const app = createApp(product.handlers);
      const call = (key: string, path: string, method = "GET", value?: unknown) => app(new Request(`http://local${path}`, {
        method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }));
      const matching = (await (await call(secretKey, "/api/v1/goals", "POST", { name: "Matching", targetEvent: "converted" })).json()).goal;
      const other = (await (await call(secretKey, "/api/v1/goals", "POST", { name: "Other", targetEvent: "other" })).json()).goal;
      await call(publishableKey, "/api/v1/identify", "POST", { userId: "history" });
      const deliveries: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        const campaign = (await (await call(secretKey, "/api/v1/campaigns", "POST", {
          name: `Campaign ${index}`, message: { presentation: "toast", title: String(index) }, goalId: index % 2 === 0 ? matching.id : other.id, launch: true,
        })).json()).campaign;
        const messages = (await (await call(publishableKey, "/api/v1/messages?userId=history")).json()).messages;
        deliveries.push(messages.find((message: { campaignId: string }) => message.campaignId === campaign.id).deliveryId);
      }
      const pool = new Pool({ connectionString });
      try {
        for (let index = 0; index < deliveries.length; index += 1) {
          await pool.query("UPDATE deliveries SET shown_at = $2, converted_at = $3 WHERE id = $1", [
            deliveries[index], index % 4 === 0 ? timestamp : null, index % 8 === 0 ? timestamp - 1 : null,
          ]);
        }
      } finally {
        await pool.end();
      }
      await call(publishableKey, "/api/v1/track", "POST", { userId: "history", event: "converted" });
      const verifyPool = new Pool({ connectionString });
      try {
        const converted = await verifyPool.query("SELECT count(*)::int AS count FROM deliveries WHERE id = ANY($1) AND converted_at = $2", [deliveries, timestamp]);
        expect(converted.rows[0].count).toBe(5);
        for (const [index, queuedAt] of [[0, start - 1], [1, start], [2, end - 1], [3, end]] as const) {
          await verifyPool.query("UPDATE deliveries SET state = 'frequency_capped', queued_at = $2 WHERE id = $1", [deliveries[index], queuedAt]);
        }
      } finally {
        await verifyPool.end();
      }
      expect((await (await call(secretKey, "/api/v1/usage")).json()).frequencyCapped).toBe(2);
    } finally {
      await product?.close();
      await cleanProject(connectionString, projectId);
    }
  });
});
