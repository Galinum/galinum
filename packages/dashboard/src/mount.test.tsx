import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardSession } from "@galinum/core/contract";

import { createDashboard } from "./mount.js";

describe("createDashboard", () => {
  it("opens one host-owned session for a mounted page", async () => {
    const session: DashboardSession = {
      project: { id: "project", name: "Self host" },
      viewer: { name: "Operator" },
      management: {
        getOverview: vi.fn(async () => ({ evaluatedAt: 1_000, endUsers: 1, eventsLast7d: 2, activeCampaigns: 3 })),
        listActivity: vi.fn(async () => ({ evaluatedAt: 1_000, items: [], nextCursor: null })),
        getMetrics: vi.fn(),
        getUserSummary: vi.fn(),
        listUsers: vi.fn(),
        getUser: vi.fn(),
        listUserEvents: vi.fn(),
        listUserDeliveries: vi.fn(),
        listEvents: vi.fn(),
        listCampaigns: vi.fn(),
        getCampaign: vi.fn(),
        listCampaignDeliveries: vi.fn(),
        listAgentRuns: vi.fn(),
      },
    };
    const open = vi.fn(async () => session);
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const dashboard = createDashboard({ open, Link, docsUrl: "https://docs.example" });

    const html = renderToStaticMarkup(await dashboard.pages.home());
    expect(html).toContain("Self host");
    expect(html).toContain("End users");
    expect(open).toHaveBeenCalledOnce();
  });
});
