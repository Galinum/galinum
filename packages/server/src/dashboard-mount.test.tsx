import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CampaignDetailPage } from "@galinum/dashboard/campaign-detail";
import { parsePushSupervisionQuery } from "@galinum/dashboard/push-supervision";
import { createDashboard } from "@galinum/dashboard/mount";

import { createApp } from "./app.js";
import { createLocalProduct } from "./local-product.js";
import { createManagementClient, createPushSupervisionClient } from "./management-client.js";

describe("self-host dashboard mount", () => {
  it("renders the supervision pages through the local management executor", async () => {
    const product = createLocalProduct({ now: () => 1_755_000_000_000 });
    const app = createApp(product.handlers, product.media);
    const call = (path: string, method = "GET", value?: unknown, publishable = false) => app(new Request(`http://local${path}`, {
      method,
      headers: {
        authorization: `Bearer ${publishable ? product.publishableKey : product.secretKey}`,
        "content-type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }));
    const campaignResponse = await call("/api/v1/campaigns", "POST", {
      name: "Welcome",
      message: { presentation: "toast", title: "Welcome" },
      launch: true,
    });
    const campaign = (await campaignResponse.json()).campaign;
    expect(campaignResponse.status).toBe(201);
    expect((await call("/api/v1/identify", "POST", {
      userId: "user_1",
      traits: { name: "Ada", plan: "free" },
    }, true)).status).toBe(200);
    expect((await call("/api/v1/track", "POST", {
      userId: "user_1",
      event: "activated",
      properties: { source: "self-host" },
    }, true)).status).toBe(200);
    expect((await call("/api/v1/agent-runs", "POST", {
      kind: "observation",
      campaignId: campaign.id,
      rationale: "Activation is low.",
    })).status).toBe(201);
    const messages = await (await call("/api/v1/messages?entryId=test&requestId=test&path=%2Fdashboard&userId=user_1", "GET", undefined, true)).json();
    expect(messages.messages).toHaveLength(1);

    const execute = async (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${product.secretKey}`);
      return app(new Request(request, { headers }));
    };
    const management = createManagementClient(execute);
    const pushSupervision = createPushSupervisionClient(execute);
    const user = (await management.listUsers({ page: 1, perPage: 25 })).values[0];
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const dashboard = createDashboard({
      open: async () => ({
        project: { id: "local", name: "Self host" },
        viewer: { name: "Operator" },
        management,
      }),
      Link,
      docsUrl: "https://docs.galinum.com",
    });

    const pushResponse = await call("/api/v1/campaigns", "POST", {
      name: "Push draft", channel: "push", push: { appId: "app", selection: { kind: "all" } },
      message: { title: "Push title", body: "Push body", destination: { kind: "app", url: "example://stored" } },
    });
    expect(pushResponse.status).toBe(201);
    const pushId = (await pushResponse.json()).campaign.id;
    const pushQuery = parsePushSupervisionQuery({ pushKind: "outcomes", pushPage: "1" });
    const pushInspectionHref = (next: typeof pushQuery) => `/campaigns/${pushId}?pushKind=${next.kind}&pushPage=${next.page}`;
    const pushInput = { campaignId: pushId, query: { state: "" as const, page: 1 }, pushSupervision, pushQuery, pushInspectionHref };
    const directPush = await CampaignDetailPage({ ...pushInput, management, projectName: "Self host", Link });
    const mountedPush = await dashboard.pages.campaign(pushInput);
    expect(renderToStaticMarkup(mountedPush)).toBe(renderToStaticMarkup(directPush));
    expect(renderToStaticMarkup(mountedPush)).toContain("No outcomes yet");
    expect(renderToStaticMarkup(mountedPush)).toContain("Push title");
    expect(renderToStaticMarkup(mountedPush)).not.toContain("Impressions");

    const [home, metrics, users, userDetail, events, campaigns, campaignDetail, agentRuns] = await Promise.all([
      dashboard.pages.home(),
      dashboard.pages.metrics({ range: "7d" }),
      dashboard.pages.users({ query: { q: "", page: 1 } }),
      dashboard.pages.user({ userId: user.id }),
      dashboard.pages.events({ query: { q: "", range: "", page: 1 } }),
      dashboard.pages.campaigns({ query: { q: "", status: "", page: 1 } }),
      dashboard.pages.campaign({ campaignId: campaign.id, query: { state: "", page: 1 }, pushSupervision, pushQuery: { kind: "outcomes", page: 1 }, pushInspectionHref: () => `/campaigns/${campaign.id}` }),
      dashboard.pages.agentRuns({ query: { page: 1 } }),
    ]);
    expect(renderToStaticMarkup(home)).toContain("Self host");
    expect(renderToStaticMarkup(metrics)).toContain("Metrics");
    expect(renderToStaticMarkup(users)).toContain("user_1");
    expect(userDetail).not.toBeNull();
    expect(renderToStaticMarkup(userDetail)).toContain("Ada");
    expect(renderToStaticMarkup(events)).toContain("activated");
    expect(renderToStaticMarkup(campaigns)).toContain("Welcome");
    expect(campaignDetail).not.toBeNull();
    expect(renderToStaticMarkup(campaignDetail)).toContain("Welcome");
    expect(renderToStaticMarkup(agentRuns)).toContain("Activation is low.");
  });
});
