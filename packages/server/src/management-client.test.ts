import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";
import { nodeAdapter } from "./node-adapter.js";

import {
  createManagementClient,
  type ManagementExecutor,
} from "./management-client.js";

const overview = {
  evaluatedAt: 1_000,
  endUsers: 12,
  eventsLast7d: 34,
  activeCampaigns: 2,
};
const activity = {
  items: [
    {
      kind: "user",
      id: "usr_1",
      occurredAt: 900,
      user: { id: "usr_1", externalUserId: "external" },
    },
  ],
  nextCursor: "cursor",
  evaluatedAt: 1_000,
};
const metrics = {
  evaluatedAt: 1_000,
  timezone: "UTC",
  totals: { impressions: 1, clicks: 2, conversions: 3, events: 4 },
  days: [{ startAt: 0, impressions: 1, clicks: 2, conversions: 3, events: 4 }],
  topEvents: [{ name: "activated", count: 4 }],
  hasAnyActivity: true,
};
const summary = {
  evaluatedAt: 1_000,
  window: "7d",
  startAt: 0,
  totalUsers: 12,
  activeUsers: 8,
  newUsers: 3,
};
const users = {
  users: [{ id: "user", externalUserId: "external", traits: { plan: "pro" }, firstSeenAt: 100, lastSeenAt: 900 }],
  total: 1,
  page: 1,
  pageCount: 1,
};
const events = {
  events: [{ id: "event", name: "activated", props: { source: "app" }, ts: 800, endUserId: "user", externalUserId: "external" }],
  total: 1,
  page: 1,
  pageCount: 1,
};
const userDeliveries = {
  deliveries: [{
    id: "delivery",
    campaignId: "campaign",
    campaignName: "Welcome",
    variantId: "variant",
    variantName: "A",
    state: "shown",
    queuedAt: 700,
  }],
  total: 1,
  page: 1,
  pageCount: 1,
};
const agentRuns = {
  runs: [{
    id: "run",
    kind: "proposal",
    goalId: "goal",
    campaignId: "campaign",
    input: { observation: "low activation" },
    output: [{ action: "iterate" }],
    rationale: "Try a clearer message.",
    createdAt: 600,
  }],
  total: 1,
  page: 1,
  pageCount: 1,
  references: {
    goals: { goal: "Activation" },
    campaigns: { campaign: "Welcome" },
  },
};
const campaignStats = {
  sent: 0,
  frequencyCapped: 0,
  delivered: 0,
  shown: 10,
  opened: 0,
  clicked: 2,
  dismissed: 1,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  converted: 1,
};
const campaigns = {
  campaigns: [{
    id: "campaign",
    name: "Welcome",
    status: "running",
    effectiveStatus: "running",
    channel: "web_inapp",
    goalId: null,
    createdBy: "api",
    createdAt: 100,
    startedAt: 200,
    endedAt: null,
    deliverFrom: null,
    deliverUntil: 2_000,
    audience: { kind: "all" },
    targeting: null,
    pages: null,
    stats: campaignStats,
  }],
  total: 1,
  page: 1,
  pageCount: 1,
  evaluatedAt: 1_000,
};
const campaignDetail = {
  campaign: {
    sourceChanges: { revision: "0", changes: [] },
    ...campaigns.campaigns[0],
    variants: [{
      id: "variant",
      name: "A",
      weight: 1,
      isControl: false,
      content: {
        presentation: "toast",
        title: "Welcome",
        body: "Hello",
        customRenderer: { theme: "dark", animation: "confetti" },
      },
      stats: campaignStats,
    }],
  },
  evaluatedAt: 1_000,
};
const channelMessages = {
  web_inapp: { presentation: "toast", title: "Welcome", body: "Hello" },
  email: { subject: "Welcome", body: "Hello" },
  push: {
    title: "Welcome",
    body: "Hello",
    image: "https://example.test/image.png",
    destination: { kind: "app", url: "example://updates" },
    actions: [{ id: "open", title: "Open" }],
    data: { source: "reader" },
    ios: { categoryId: "updates", sound: "default", badge: 1, subtitle: "News" },
    android: { channelId: "updates", sound: "default" },
  },
};
const pushSettings = { appId: "app", selection: { kind: "all" }, ttlSeconds: 3600, replacementKey: "updates" };
const mixedCampaigns = Object.keys(channelMessages).map((channel) => ({
  ...campaigns.campaigns[0], id: channel, channel,
  ...(channel === "push" ? { push: pushSettings } : {}),
}));
const deliveries = {
  deliveries: [{
    id: "delivery",
    endUserId: "user",
    externalUserId: "external",
    variantId: "variant",
    variantName: "A",
    state: "shown",
    queuedAt: 900,
    sentAt: null,
    deliveredAt: null,
    shownAt: 950,
    openedAt: null,
    clickedAt: null,
    dismissedAt: null,
    bouncedAt: null,
    complainedAt: null,
    unsubscribedAt: null,
    convertedAt: null,
  }],
  total: 1,
  page: 1,
  pageCount: 1,
};

function executor(overrides = new Map<string, unknown>()): ManagementExecutor {
  const responses = new Map<string, unknown>([
    ["/api/v1/overview", overview],
    ["/api/v1/activity?limit=5&cursor=next", activity],
    ["/api/v1/metrics?range=7d", metrics],
    ["/api/v1/users/summary", summary],
    ["/api/v1/users?q=ada&page=2&perPage=25", users],
    ["/api/v1/users/user", { user: users.users[0] }],
    ["/api/v1/users/user/events?page=1&perPage=20", events],
    ["/api/v1/users/user/deliveries?page=1&perPage=20", userDeliveries],
    ["/api/v1/events?q=activated&page=1&perPage=50&since=100&until=900", events],
    ["/api/v1/campaigns?q=welcome&status=running&page=1&perPage=100", campaigns],
    ["/api/v1/agent-runs?page=1&perPage=25&include=names", agentRuns],
    ["/api/v1/campaigns/campaign", campaignDetail],
    ["/api/v1/campaigns/campaign/deliveries?state=shown&page=1&perPage=25", deliveries],
    ["/api/v1/campaigns/campaign/status", { id: "campaign", status: "paused" }],
    ...overrides,
  ]);
  return async (request) => {
    const url = new URL(request.url);
    const value = responses.get(url.pathname + url.search);
    return value instanceof Response ? value : Response.json(value ?? { error: "missing" }, { status: value === undefined ? 404 : 200 });
  };
}

describe("management client", () => {
  it("preserves mixed web, email, and push campaign summaries", async () => {
    const client = createManagementClient(async () => Response.json({
      ...campaigns, campaigns: mixedCampaigns, total: mixedCampaigns.length,
    }));
    await expect(client.listCampaigns()).resolves.toEqual({
      values: mixedCampaigns.map(({ audience, targeting, pages, ...summary }) => summary),
      total: 3, page: 1, pageCount: 1, evaluatedAt: 1_000,
    });
  });

  it.each(Object.entries(channelMessages))("reads %s campaign detail without losing message fields", async (channel, content) => {
    const detail = {
      ...campaignDetail,
      campaign: {
        ...campaignDetail.campaign, channel,
        ...(channel === "push" ? { push: pushSettings } : {}),
        variants: [{ ...campaignDetail.campaign.variants[0], content }],
      },
    };
    const client = createManagementClient(async () => Response.json(detail));
    await expect(client.getCampaign("campaign")).resolves.toEqual(detail);
  });

  it.each(["sms", "PUSH", "", null, 1, { channel: "push" }])("rejects invalid channel %j in mixed lists and detail", async (channel) => {
    const invalid = { ...campaignDetail.campaign, channel };
    const client = createManagementClient(async (request) => Response.json(
      new URL(request.url).pathname === "/api/v1/campaigns"
        ? { ...campaigns, campaigns: [...mixedCampaigns, invalid], total: 4 }
        : { ...campaignDetail, campaign: invalid },
    ));
    await expect(client.listCampaigns()).rejects.toMatchObject({ kind: "invalid_response", status: 200 });
    await expect(client.getCampaign("campaign")).rejects.toMatchObject({ kind: "invalid_response", status: 200 });
  });

  it.each([
    { title: 5 }, { destination: { kind: "app" } }, { data: { invalid: 5 } },
    { actions: [{ id: "open", title: 5 }] }, { ios: { badge: -1 } },
    { android: {} }, { tokenScope: "private" }, { image: 5 },
  ])("rejects malformed or private push content %j", async (fields) => {
    const value = { ...campaignDetail, campaign: { ...campaignDetail.campaign, channel: "push", push: pushSettings,
      variants: [{ ...campaignDetail.campaign.variants[0], content: { ...channelMessages.push, ...fields } }] } };
    await expect(createManagementClient(async () => Response.json(value)).getCampaign("campaign")).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([undefined, {}, { ...pushSettings, selection: { kind: "specific" } }, { ...pushSettings, ttlSeconds: -1 }, { ...pushSettings, secret: "private" }])("rejects invalid push settings in both summary and detail: %j", async (push) => {
    const value = { ...campaignDetail.campaign, channel: "push", push };
    const client = createManagementClient(async request => Response.json(new URL(request.url).pathname === "/api/v1/campaigns"
      ? { ...campaigns, campaigns: [value] } : { ...campaignDetail, campaign: value }));
    await expect(client.listCampaigns()).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(client.getCampaign("campaign")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("reads public HTTP campaign lists and detail after creating a push draft", async () => {
    const product = createLocalProduct();
    const server = createServer(nodeAdapter(createApp(product.handlers, product.media, product.operatorHandler)));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const execute: ManagementExecutor = (request) => {
        const url = new URL(request.url);
        const authenticated = new Request(new URL(url.pathname + url.search, origin), request);
        authenticated.headers.set("authorization", `Bearer ${product.secretKey}`);
        return fetch(authenticated);
      };
      const client = createManagementClient(execute);
      const createdIds = new Map<string, string>();
      for (const channel of ["web_inapp", "push"] as const) {
        const response = await execute(new Request(`${origin}/api/v1/campaigns`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `${channel} reader regression`, channel,
            message: channelMessages[channel],
            ...(channel === "push" ? { push: pushSettings } : {}),
          }),
        }));
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(201);
        createdIds.set(channel, body.campaign.id);
        const list = await client.listCampaigns();
        expect(list.total).toBe(createdIds.size);
        expect(new Map(list.values.map((campaign) => [campaign.channel, campaign.id]))).toEqual(createdIds);
        expect(list.values.every((campaign) => campaign.status === "draft")).toBe(true);
      }
      for (const channel of ["web_inapp", "push"] as const) {
        const detail = await client.getCampaign(createdIds.get(channel)!);
        expect(detail?.campaign).toMatchObject({ id: createdIds.get(channel), channel, status: "draft" });
        expect(detail?.campaign.variants[0].content).toEqual(channelMessages[channel]);
        if (channel === "push") {
          expect(detail?.campaign.push).toEqual(pushSettings);
          expect((await client.listCampaigns()).values.find(c => c.channel === "push")?.push).toEqual(pushSettings);
        }
      }
    } finally {
      try {
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally {
        await product.close();
      }
    }
  });

  it("calls project-bound read operations and parses their responses", async () => {
    const client = createManagementClient(executor());
    await expect(client.getOverview()).resolves.toEqual(overview);
    await expect(client.listActivity({ limit: 5, after: "next" })).resolves.toEqual(activity);
    await expect(client.getMetrics("7d")).resolves.toEqual(metrics);
    await expect(client.getUserSummary()).resolves.toEqual(summary);
    await expect(client.listUsers({ q: "ada", page: 2, perPage: 25 })).resolves.toEqual({
      values: users.users,
      total: 1,
      page: 1,
      pageCount: 1,
    });
    await expect(client.getUser("user")).resolves.toEqual(users.users[0]);
    await expect(client.getUser("missing")).resolves.toBeNull();
    await expect(client.listUserEvents("user", { page: 1, perPage: 20 })).resolves.toEqual({
      values: events.events,
      total: 1,
      page: 1,
      pageCount: 1,
    });
    await expect(client.listUserDeliveries("user", { page: 1, perPage: 20 })).resolves.toEqual(userDeliveries);
    await expect(client.listEvents({ q: "activated", page: 1, perPage: 50, since: 100, until: 900 })).resolves.toEqual({
      values: events.events,
      total: 1,
      page: 1,
      pageCount: 1,
    });
    await expect(client.listCampaigns({ q: "welcome", status: "running", page: 1, perPage: 100 })).resolves.toEqual({
      values: [expect.objectContaining({ id: "campaign", stats: campaignStats })],
      total: 1,
      page: 1,
      pageCount: 1,
      evaluatedAt: 1_000,
    });
    await expect(client.listAgentRuns({ page: 1, perPage: 25, include: "names" })).resolves.toEqual({
      values: agentRuns.runs,
      total: 1,
      page: 1,
      pageCount: 1,
      references: agentRuns.references,
    });
    await expect(client.getCampaign("campaign")).resolves.toEqual(campaignDetail);
    await expect(client.getCampaign("missing")).resolves.toBeNull();
    await expect(client.listCampaignDeliveries("campaign", { state: "shown", page: 1, perPage: 25 })).resolves.toEqual({
      values: deliveries.deliveries,
      total: 1,
      page: 1,
      pageCount: 1,
    });
    await expect(client.setCampaignStatus("campaign", "pause")).resolves.toEqual({
      id: "campaign",
      status: "paused",
    });
  });

  it("distinguishes request failures from invalid response bodies", async () => {
    const unavailable = createManagementClient(executor(new Map([
      ["/api/v1/overview", Response.json({ error: "no" }, { status: 503 })],
    ])));
    await expect(unavailable.getOverview()).rejects.toMatchObject({
      kind: "request_failed",
      status: 503,
    });

    const invalid = createManagementClient(executor(new Map([
      ["/api/v1/overview", { ...overview, endUsers: "12" }],
    ])));
    await expect(invalid.getOverview()).rejects.toMatchObject({
      kind: "invalid_response",
      status: 200,
    });

    const conflict = createManagementClient(executor(new Map([
      ["/api/v1/campaigns/campaign/status", Response.json({ error: "Verify the email domain first." }, { status: 409 })],
    ])));
    await expect(conflict.setCampaignStatus("campaign", "launch")).rejects.toMatchObject({
      kind: "request_failed",
      status: 409,
      detail: "Verify the email domain first.",
    });

    const invalidStatus = createManagementClient(executor(new Map([
      ["/api/v1/campaigns/campaign/status", { id: "campaign", status: "draft" }],
    ])));
    await expect(invalidStatus.setCampaignStatus("campaign", "pause")).rejects.toMatchObject({
      kind: "invalid_response",
      status: 200,
    });

    const invalidDetail = createManagementClient(executor(new Map([
      ["/api/v1/campaigns/campaign", {
        ...campaignDetail,
        campaign: { ...campaignDetail.campaign, variants: [{ ...campaignDetail.campaign.variants[0], weight: "1" }] },
      }],
    ])));
    await expect(invalidDetail.getCampaign("campaign")).rejects.toMatchObject({
      kind: "invalid_response",
      status: 200,
    });
  });

  it("preserves complete source associations beyond authoring limits", async () => {
    const sourceChanges = { revision: "source-owned-revision", changes: [
      ...Array.from({ length: 125 }, (_, index) => ({ sourceId: "source", kind: "commit", sha: index.toString(16).padStart(40, "0") })),
      { sourceId: "source", kind: "pull_request", number: 42, shas: Array.from({ length: 251 }, (_, index) => index.toString(16).padStart(40, "0")) },
    ] };
    const client = createManagementClient(async () => Response.json({ ...campaignDetail, campaign: { ...campaignDetail.campaign, sourceChanges } }));
    expect((await client.getCampaign("campaign"))?.campaign.sourceChanges).toEqual(sourceChanges);
    const invalid = createManagementClient(async () => Response.json({ ...campaignDetail,
      campaign: { ...campaignDetail.campaign, sourceChanges: { revision: "1", changes: [{ sourceId: "source", kind: "commit", sha: "invalid" }] } },
    }));
    await expect(invalid.getCampaign("campaign")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("sends the exact campaign status request", async () => {
    const requests: Request[] = [];
    const client = createManagementClient(async (value) => {
      requests.push(value);
      return Response.json({ id: "campaign", status: "paused" });
    });
    await client.setCampaignStatus("campaign/one", "pause");
    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/v1/campaigns/campaign%2Fone/status");
    expect(request.headers.get("content-type")).toBe("application/json");
    await expect(request.json()).resolves.toEqual({ action: "pause" });
  });

  it("keeps identity-mapped response fields aligned with OpenAPI", () => {
    const openapi = JSON.parse(readFileSync(new URL("../../../apps/docs/openapi.json", import.meta.url), "utf8"));
    const requiredFor = (schema: Record<string, unknown>): string[] => {
      const direct = Array.isArray(schema.required) ? schema.required as string[] : [];
      const nested = Array.isArray(schema.allOf)
        ? schema.allOf.flatMap((entry: Record<string, unknown>) => {
            if (typeof entry.$ref === "string") {
              const name = entry.$ref.split("/").at(-1);
              return name ? requiredFor(openapi.components.schemas[name]) : [];
            }
            return requiredFor(entry);
          })
        : [];
      return [...new Set([...direct, ...nested])].sort();
    };
    const required = (name: string) => requiredFor(openapi.components.schemas[name]);
    expect(Object.keys(overview).sort()).toEqual(required("ProjectOverview"));
    expect(Object.keys(metrics).sort()).toEqual(required("ProjectMetrics"));
    expect(Object.keys(summary).sort()).toEqual(required("UserSummary"));
    expect(Object.keys(metrics.totals).sort()).toEqual(required("MetricTotals"));
    expect(Object.keys(metrics.days[0]).sort()).toEqual(required("MetricDay"));
    expect(Object.keys(activity.items[0]).sort()).toEqual(required("UserActivityItem"));
    expect(Object.keys(users.users[0]).sort()).toEqual(required("EndUser"));
    expect(Object.keys(events.events[0]).sort()).toEqual(required("Event"));
    expect(openapi.components.schemas.UserDelivery.properties.state.enum).toEqual([
      "queued",
      "sending",
      "retryable",
      "frequency_capped",
      "sent",
      "delivered",
      "shown",
      "opened",
      "clicked",
      "dismissed",
      "bounced",
      "complained",
      "unsubscribed",
      "failed",
      "converted",
    ]);
  });
});
