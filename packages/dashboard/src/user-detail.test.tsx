import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UserDetailPage, type UserDetailManagement } from "./user-detail.js";

function management(overrides: Partial<UserDetailManagement> = {}) {
  return {
    getUser: vi.fn(async () => ({
      id: "user",
      externalUserId: "external",
      traits: { name: "Ada", plan: "pro", $browser: "Safari" },
      firstSeenAt: 100,
      lastSeenAt: 900,
    })),
    listUserEvents: vi.fn(async () => ({
      values: [{
        id: "event",
        name: "activated",
        props: { source: "app" },
        ts: 800,
        endUserId: "user",
        externalUserId: "external",
      }],
      total: 1,
      page: 1,
      pageCount: 1,
    })),
    listUserDeliveries: vi.fn(async () => ({
      deliveries: [{
        id: "delivery",
        campaignId: "campaign",
        campaignName: "Welcome",
        variantId: "variant",
        variantName: "A",
        state: "shown" as const,
        queuedAt: 700,
      }],
      total: 1,
      page: 1,
      pageCount: 1,
    })),
    ...overrides,
  } satisfies UserDetailManagement;
}

describe("UserDetailPage", () => {
  it("renders user supervision through management reads and host adapters", async () => {
    const reader = management();
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await UserDetailPage({
      management: reader,
      userId: "user",
      projectName: "Project",
      Link,
      renderCopy: () => <span>Copy ID</span>,
      renderProperties: (value) => <span>Properties: {JSON.stringify(value)}</span>,
    }));

    expect(html).toContain("external");
    expect(html).toContain("Ada");
    expect(html).toContain("Project");
    expect(html).toContain("pro");
    expect(html).toContain("Safari");
    expect(html).toContain("Copy ID");
    expect(html).toContain("Welcome");
    expect(html).toContain("activated");
    expect(html).toContain("Properties:");
    expect(reader.listUserEvents).toHaveBeenCalledWith("user", { page: 1, perPage: 20 });
    expect(reader.listUserDeliveries).toHaveBeenCalledWith("user", { page: 1, perPage: 20 });
  });

  it("returns null without nested reads for an unknown user", async () => {
    const listUserEvents = vi.fn();
    const listUserDeliveries = vi.fn();
    const reader = management({
      getUser: vi.fn(async () => null),
      listUserEvents,
      listUserDeliveries,
    });
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;

    await expect(UserDetailPage({
      management: reader,
      userId: "missing",
      projectName: "Project",
      Link,
    })).resolves.toBeNull();
    expect(listUserEvents).not.toHaveBeenCalled();
    expect(listUserDeliveries).not.toHaveBeenCalled();
  });
});
