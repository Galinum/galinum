import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetricsPage, type MetricsManagement } from "./metrics.js";

describe("MetricsPage", () => {
  it("loads and renders metrics through the management contract", async () => {
    const getMetrics = vi.fn(async () => ({
      evaluatedAt: Date.UTC(2026, 7, 30),
      timezone: "UTC" as const,
      totals: { impressions: 10, clicks: 2, conversions: 1, events: 4 },
      days: [{ startAt: Date.UTC(2026, 7, 30), impressions: 10, clicks: 2, conversions: 1, events: 4 }],
      topEvents: [{ name: "activated", count: 4 }],
      hasAnyActivity: true,
    }));
    const management: MetricsManagement = {
      getMetrics,
    };

    const html = renderToStaticMarkup(await MetricsPage({
      management,
      range: "7d",
      filter: <span>Range filter</span>,
    }));
    expect(html).toContain("Metrics");
    expect(html).toContain("20.0% of impressions");
    expect(html).toContain("activated");
    expect(html).toContain("Range filter");
    expect(getMetrics).toHaveBeenCalledWith("7d");
  });
});
