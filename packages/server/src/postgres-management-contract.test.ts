import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";
import { createPostgresProduct } from "./postgres-product.js";

const integration = process.env.RUN_DB_INTEGRATION === "1" ? describe : describe.skip;
const CLOCK = Date.UTC(2026, 7, 20, 15, 30);
const DAY = 86_400_000;

async function cleanProject(connectionString: string, projectId: string) {
  const pool = new Pool({ connectionString });
  try {
    await pool.query("DELETE FROM deliveries WHERE campaign_id IN (SELECT id FROM campaigns WHERE project_id = $1)", [projectId]);
    await pool.query("DELETE FROM agent_runs WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM campaigns WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM audience_versions WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM segments WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM events WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM end_users WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM goals WHERE project_id = $1", [projectId]);
    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  } finally {
    await pool.end();
  }
}

type Caller = (path: string, method?: string, value?: unknown, publishable?: boolean) => Promise<{ status: number; body: any }>;

function callerFor(product: { handlers: any; media?: any; secretKey: string; publishableKey: string }, clock: () => number) {
  const app = createApp(product.handlers, product.media);
  const call: Caller = async (path, method = "GET", value, publishable = false) => {
    const response = await app(new Request(`http://local${path}`, {
      method,
      headers: {
        authorization: `Bearer ${publishable ? product.publishableKey : product.secretKey}`,
        "content-type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));
    return { status: response.status, body: await response.json() };
  };
  void clock;
  return call;
}

async function seed(call: Caller, at: (value: number) => void) {
  at(CLOCK - 30 * DAY);
  const goal = (await call("/api/v1/goals", "POST", { name: "Activation", targetEvent: "activated" })).body.goal;
  await call("/api/v1/identify", "POST", { userId: "old_user" }, true);

  at(CLOCK - 2 * DAY);
  await call("/api/v1/identify", "POST", { userId: "recent_user" }, true);
  await call("/api/v1/track", "POST", { userId: "recent_user", event: "checkout_started" }, true);

  at(CLOCK - DAY);
  const welcome = (await call("/api/v1/campaigns", "POST", {
    name: "Welcome tour",
    message: { presentation: "toast", title: "Welcome" },
    goalId: goal.id,
    launch: true,
  })).body.campaign;
  const messages = (await call("/api/v1/messages?userId=recent_user", "GET", undefined, true)).body.messages;
  const deliveryId = messages[0].deliveryId;
  await call(`/api/v1/deliveries/${deliveryId}/event`, "POST", { type: "clicked" }, true);

  at(CLOCK);
  await call("/api/v1/track", "POST", { userId: "recent_user", event: "checkout_completed" }, true);
  await call("/api/v1/track", "POST", { userId: "old_user", event: "activated" }, true);
  const reminder = (await call("/api/v1/campaigns", "POST", {
    name: "Reminder nudge",
    message: { presentation: "toast", title: "Reminder" },
  })).body.campaign;
  await call("/api/v1/agent-runs", "POST", { kind: "evaluation", goalId: goal.id, campaignId: welcome.id });
  at(CLOCK + DAY);
  await call("/api/v1/track", "POST", { userId: "recent_user", event: "future_event" }, true);
  at(CLOCK);

  return { goal, welcome, reminder, deliveryId };
}

async function contractSnapshot(call: Caller) {
  const paths = [
    "/api/v1/overview",
    "/api/v1/activity?limit=3",
    "/api/v1/metrics?range=7d",
    "/api/v1/metrics?range=30d",
    "/api/v1/users/summary",
    "/api/v1/users/recent_user/events",
    "/api/v1/users/recent_user/deliveries",
    "/api/v1/campaigns",
    "/api/v1/campaigns?q=welcome",
    "/api/v1/campaigns?perPage=1&page=2",
    "/api/v1/events?q=CHECKOUT",
    "/api/v1/agent-runs?include=names",
  ];
  const snapshot: Record<string, unknown> = {};
  for (const path of paths) {
    const response = await call(path);
    expect(response.status, path).toBe(200);
    snapshot[path] = response.body;
  }
  return snapshot;
}

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "nextCursor") {
        result[key] = entry === null ? null : "«cursor»";
        continue;
      }
      if (/^(id|.*Id|.*Ids)$/.test(key) || key === "goals" || key === "campaigns" && !Array.isArray(entry)) {
        result[key] = Array.isArray(entry) ? withoutIds(entry) : typeof entry === "object" && entry !== null ? Object.values(entry).sort() : "«id»";
        continue;
      }
      result[key] = withoutIds(entry);
    }
    return result;
  }
  return value;
}

integration("Postgres management contract parity", () => {
  it("matches the memory store for every management contract response", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    const projectId = `test_${randomUUID()}`;
    const secretKey = `secret_${randomUUID()}`;
    const publishableKey = `publishable_${randomUUID()}`;
    let clock = CLOCK;
    const at = (value: number) => { clock = value; };
    const rateLimits = {
      sdkRateLimit: { perMinute: 100_000, perHour: 100_000 },
      managementRateLimit: { perMinute: 100_000, perHour: 100_000 },
    };

    const memory = createLocalProduct({ projectId, secretKey, publishableKey, now: () => clock, ...rateLimits });
    const memoryCall = callerFor(memory, () => clock);
    await seed(memoryCall, at);
    at(CLOCK);
    const memorySnapshot = await contractSnapshot(memoryCall);

    let postgres: Awaited<ReturnType<typeof createPostgresProduct>> | null = null;
    try {
      clock = CLOCK;
      postgres = await createPostgresProduct({ connectionString, projectId, secretKey, publishableKey, now: () => clock, ...rateLimits });
      const postgresCall = callerFor(postgres, () => clock);
      await seed(postgresCall, at);
      at(CLOCK);
      const postgresSnapshot = await contractSnapshot(postgresCall);

      for (const path of Object.keys(memorySnapshot)) {
        expect(withoutIds(postgresSnapshot[path]), path).toEqual(withoutIds(memorySnapshot[path]));
      }

      const overview = (await postgresCall("/api/v1/overview")).body;
      expect(overview).toMatchObject({ evaluatedAt: CLOCK, endUsers: 2, eventsLast7d: 3, activeCampaigns: 1 });

      const metrics = (await postgresCall("/api/v1/metrics?range=7d")).body;
      expect(metrics.days).toHaveLength(7);
      expect(metrics.days.at(-1).startAt).toBe(Math.floor(CLOCK / DAY) * DAY);
      expect(metrics.totals).toMatchObject({ impressions: 1, clicks: 1, conversions: 0, events: 3 });
      expect(metrics.timezone).toBe("UTC");
      expect(metrics.hasAnyActivity).toBe(true);

      const summary = (await postgresCall("/api/v1/users/summary")).body;
      expect(summary).toEqual({
        evaluatedAt: CLOCK,
        window: "7d",
        startAt: CLOCK - 7 * DAY,
        totalUsers: 2,
        activeUsers: 2,
        newUsers: 1,
      });

      const activity = (await postgresCall("/api/v1/activity?limit=2")).body;
      expect(activity.items).toHaveLength(2);
      expect(activity.nextCursor).not.toBeNull();
      const nextPage = (await postgresCall(`/api/v1/activity?limit=2&cursor=${activity.nextCursor}`)).body;
      const firstIds = activity.items.map((item: { kind: string; id: string }) => `${item.kind}:${item.id}`);
      const nextIds = nextPage.items.map((item: { kind: string; id: string }) => `${item.kind}:${item.id}`);
      expect(firstIds.filter((value: string) => nextIds.includes(value))).toEqual([]);
      expect((await postgresCall("/api/v1/activity?cursor=broken")).status).toBe(400);

      const drained: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const path = cursor === null ? "/api/v1/activity?limit=1" : `/api/v1/activity?limit=1&cursor=${cursor}`;
        const response = await postgresCall(path);
        expect(response.status).toBe(200);
        for (const item of response.body.items) drained.push(`${item.kind}:${item.id}`);
        cursor = response.body.nextCursor;
        if (cursor === null) break;
      }
      expect(cursor).toBeNull();
      expect(new Set(drained).size).toBe(drained.length);
      expect(drained).toHaveLength(3);
      expect(drained.filter((value) => value.startsWith("delivery:"))).toHaveLength(1);

      const deliveries = (await postgresCall("/api/v1/users/recent_user/deliveries")).body;
      expect(deliveries).toMatchObject({ total: 1, page: 1, pageCount: 1 });
      expect(deliveries.deliveries[0]).toMatchObject({ campaignName: "Welcome tour", variantName: "A" });

      const campaigns = (await postgresCall("/api/v1/campaigns?q=WELCOME")).body;
      expect(campaigns).toMatchObject({ total: 1, page: 1, pageCount: 1, evaluatedAt: CLOCK });
      expect(campaigns.campaigns[0].name).toBe("Welcome tour");
      expect((await postgresCall("/api/v1/campaigns")).body).toMatchObject({ total: 2, page: 1, pageCount: 1 });
      expect((await postgresCall("/api/v1/campaigns")).body.campaigns.map((campaign: { name: string }) => campaign.name)).toEqual([
        "Reminder nudge",
        "Welcome tour",
      ]);

      const events = (await postgresCall("/api/v1/events?q=checkout")).body;
      expect(events).toMatchObject({ total: 2, page: 1, pageCount: 1 });
      expect((await postgresCall("/api/v1/events?q=checkout&name=signup")).status).toBe(400);

      const runs = (await postgresCall("/api/v1/agent-runs?include=names")).body;
      expect(Object.values(runs.references.goals)).toEqual(["Activation"]);
      expect(Object.values(runs.references.campaigns)).toEqual(["Welcome tour"]);
      expect((await postgresCall("/api/v1/agent-runs")).body.references).toBeUndefined();
      expect((await postgresCall("/api/v1/agent-runs?include=other")).status).toBe(400);

      expect((await postgresCall("/api/v1/users/absent/events")).status).toBe(404);
      expect((await postgresCall("/api/v1/users/absent/deliveries")).status).toBe(404);
    } finally {
      await postgres?.close();
      await memory.close();
      await cleanProject(connectionString, projectId);
    }
  });
});
