import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CampaignsPage, type CampaignsManagement } from "./campaigns.js";

const emptyStats = {
  sent: 0,
  frequencyCapped: 0,
  delivered: 0,
  shown: 10,
  opened: 0,
  clicked: 2,
  dismissed: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  converted: 1,
};

describe("CampaignsPage", () => {
  it("renders campaign supervision through the management contract", async () => {
    const listCampaigns = vi.fn(async () => ({
      values: [{
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
        stats: emptyStats,
      }],
      total: 1,
      page: 1,
      pageCount: 1,
      evaluatedAt: 1_000,
    }));
    const management = {
      listCampaigns,
    } satisfies CampaignsManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await CampaignsPage({
      management,
      query: { q: "welcome", status: "running", page: 1 },
      controls: <span>Filters</span>,
      docsUrl: "https://docs.example",
      Link,
    }));
    expect(html).toContain("Welcome");
    expect(html).toContain("running");
    expect(html).toContain("Impressions");
    expect(html).toContain("Filters");
    expect(listCampaigns).toHaveBeenCalledWith({
      q: "welcome",
      status: "running",
      page: 1,
      perPage: 100,
    });
  });

  it("keeps correction controls visible without calling the API for an overlong search", async () => {
    const listCampaigns = vi.fn();
    const management = {
      listCampaigns,
    } satisfies CampaignsManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await CampaignsPage({
      management,
      query: { q: "x".repeat(201), status: "", page: 1 },
      controls: <span>Filters</span>,
      docsUrl: "https://docs.example",
      Link,
    }));
    expect(html).toContain("Filters");
    expect(html).toContain("200 characters or fewer");
    expect(listCampaigns).not.toHaveBeenCalled();
  });
});
