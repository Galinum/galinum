import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EventsPage, type EventsManagement } from "./events.js";

describe("EventsPage", () => {
  it("renders event supervision through the management contract", async () => {
    const listEvents = vi.fn(async () => ({
      values: [{
        id: "event",
        name: "activated",
        props: { plan: "pro" },
        ts: 900,
        endUserId: "user",
        externalUserId: "external",
      }],
      total: 1,
      page: 1,
      pageCount: 1,
    }));
    const management = {
      listEvents,
    } satisfies EventsManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await EventsPage({
      management,
      projectName: "Acme",
      query: { q: "activated", range: "24h", page: 1 },
      controls: <span>Filters</span>,
      docsUrl: "https://docs.example",
      Link,
      now: 1_000,
    }));
    expect(html).toContain("activated");
    expect(html).toContain("external");
    expect(html).toContain("&quot;plan&quot;:&quot;pro&quot;");
    expect(html).toContain("title=\"{&quot;plan&quot;:&quot;pro&quot;}\"");
    expect(html).toContain("Filters");
    expect(listEvents).toHaveBeenCalledWith({
      q: "activated",
      page: 1,
      perPage: 50,
      since: 1_000 - 24 * 60 * 60 * 1_000,
      until: 1_000,
    });
  });

  it("shows a dash for empty properties and clamps stale pages", async () => {
    const listEvents = vi.fn(async ({ page }: { page?: number }) => ({
      values: page === 2 ? [{
        id: "event",
        name: "empty",
        props: {},
        ts: 900,
        endUserId: "user",
        externalUserId: "external",
      }] : [],
      total: 51,
      page: page ?? 1,
      pageCount: 2,
    }));
    const management = {
      listEvents,
    } satisfies EventsManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await EventsPage({
      management,
      projectName: "Acme",
      query: { q: "", range: "", page: 99_999 },
      docsUrl: "https://docs.example",
      Link,
      now: 1_000,
    }));
    expect(html).toContain("—");
    expect(listEvents).toHaveBeenNthCalledWith(1, {
      q: undefined,
      page: 10_000,
      perPage: 50,
      since: undefined,
      until: undefined,
    });
    expect(listEvents).toHaveBeenNthCalledWith(2, {
      q: undefined,
      page: 2,
      perPage: 50,
      since: undefined,
      until: undefined,
    });
  });
});
