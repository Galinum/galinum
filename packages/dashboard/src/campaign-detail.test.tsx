import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CampaignDetailPage, type CampaignDetailManagement } from "./campaign-detail.js";

const stats = {
  sent: 0,
  frequencyCapped: 0,
  delivered: 0,
  shown: 3,
  opened: 0,
  clicked: 1,
  dismissed: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  converted: 1,
};

const detail = {
  campaign: {
    id: "campaign",
    name: "Welcome",
    status: "running" as const,
    effectiveStatus: "running" as const,
    channel: "web_inapp" as const,
    goalId: null,
    createdBy: "api",
    createdAt: 100,
    startedAt: 200,
    endedAt: null,
    deliverFrom: null,
    deliverUntil: 2_000,
    audience: { kind: "all" as const },
    targeting: null,
    pages: ["/dashboard"],
    stats,
    variants: [{
      id: "variant",
      name: "A",
      weight: 1,
      isControl: false,
      content: { presentation: "toast" as const, title: "Hello" },
      stats,
    }],
  },
  evaluatedAt: 1_000,
};

describe("CampaignDetailPage", () => {
  it("renders management detail and host-owned adapters", async () => {
    const getCampaign = vi.fn(async () => detail);
    const listCampaignDeliveries = vi.fn(async () => ({
      values: [{
        id: "delivery",
        endUserId: "user",
        externalUserId: "external",
        variantId: "variant",
        variantName: "A",
        state: "shown" as const,
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
    }));
    const management = {
      getCampaign,
      listCampaignDeliveries,
    } satisfies CampaignDetailManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;

    const html = renderToStaticMarkup(await CampaignDetailPage({
      management,
      campaignId: "campaign",
      projectName: "Project",
      query: { state: "", page: 1 },
      Link,
      renderActions: () => <span>Safety controls</span>,
      deliveryControls: <span>Delivery filter</span>,
      renderMessage: () => <span>Host preview</span>,
    }));

    expect(html).toContain("Welcome");
    expect(html).toContain("Safety controls");
    expect(html).toContain("Host preview");
    expect(html).toContain("Delivery filter");
    expect(html).toContain("external");
    expect(html).toContain("/dashboard");
    expect(getCampaign).toHaveBeenCalledWith("campaign");
    expect(listCampaignDeliveries).toHaveBeenCalledWith("campaign", {
      state: undefined,
      page: 1,
      perPage: 25,
    });
  });

  it("returns null for an unknown campaign without listing deliveries", async () => {
    const listCampaignDeliveries = vi.fn();
    const management = {
      getCampaign: vi.fn(async () => null),
      listCampaignDeliveries,
    } satisfies CampaignDetailManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;

    await expect(CampaignDetailPage({
      management,
      campaignId: "missing",
      projectName: "Project",
      query: { state: "", page: 1 },
      Link,
    })).resolves.toBeNull();
    expect(listCampaignDeliveries).not.toHaveBeenCalled();
  });
});
