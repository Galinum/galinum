import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HomePage, type HomeSession } from "./home.js";

describe("HomePage", () => {
  it("loads and renders one project through the management contract", async () => {
    const getOverview = vi.fn(async () => ({
      evaluatedAt: 1_000,
      endUsers: 12,
      eventsLast7d: 34,
      activeCampaigns: 2,
    }));
    const listActivity = vi.fn(async () => ({
      evaluatedAt: 1_000,
      nextCursor: null,
      items: [
        {
          kind: "delivery" as const,
          id: "delivery",
          occurredAt: 900,
          user: { id: "user", externalUserId: "external-user" },
          campaign: { id: "campaign", name: "Welcome" },
          variant: { id: "variant", name: "A" },
        },
      ],
    }));
    const session: HomeSession = {
      project: { id: "project", name: "Acme" },
      viewer: { name: "Ada Lovelace" },
      management: {
        getOverview,
        listActivity,
      },
    };

    const html = renderToStaticMarkup(await HomePage({ session }));
    expect(html).toContain("Welcome back, Ada");
    expect(html).toContain("Acme");
    expect(html).toContain("external-user");
    expect(html).toContain("Welcome · A");
    expect(getOverview).toHaveBeenCalledOnce();
    expect(listActivity).toHaveBeenCalledWith({ limit: 10 });
  });
});
