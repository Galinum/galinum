import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsersPage, type UsersManagement } from "./users.js";

describe("UsersPage", () => {
  it("renders user supervision through the management contract", async () => {
    const listUsers = vi.fn(async () => ({
      values: [{
        id: "user",
        externalUserId: "external",
        traits: { email: "ada@example.com", $browser: "Firefox" },
        firstSeenAt: 100,
        lastSeenAt: 900,
      }],
      total: 1,
      page: 1,
      pageCount: 1,
    }));
    const management = {
      getUserSummary: vi.fn(async () => ({
        evaluatedAt: 1_000,
        window: "7d" as const,
        startAt: 0,
        totalUsers: 1,
        activeUsers: 1,
        newUsers: 1,
      })),
      listUsers,
    } satisfies UsersManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await UsersPage({
      management,
      projectName: "Acme",
      query: { q: "ada", page: 1 },
      controls: <span>Search</span>,
      docsUrl: "https://docs.example",
      Link,
      renderPagination: ({ total }) => <span>{total} user</span>,
    }));
    expect(html).toContain("external");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Firefox");
    expect(html).toContain("Search");
    expect(listUsers).toHaveBeenCalledWith({ q: "ada", page: 1, perPage: 25 });
  });

  it("clamps stale pages and reloads the last page", async () => {
    const listUsers = vi.fn(async ({ page }: { page?: number }) => ({
      values: [],
      total: 30,
      page: page ?? 1,
      pageCount: 2,
    }));
    const management = {
      getUserSummary: vi.fn(async () => ({
        evaluatedAt: 1_000,
        window: "7d" as const,
        startAt: 0,
        totalUsers: 30,
        activeUsers: 0,
        newUsers: 0,
      })),
      listUsers,
    } satisfies UsersManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    await UsersPage({
      management,
      projectName: "Acme",
      query: { q: "", page: 99_999 },
      docsUrl: "https://docs.example",
      Link,
    });
    expect(listUsers).toHaveBeenNthCalledWith(1, { q: undefined, page: 10_000, perPage: 25 });
    expect(listUsers).toHaveBeenNthCalledWith(2, { q: undefined, page: 2, perPage: 25 });
  });
});
