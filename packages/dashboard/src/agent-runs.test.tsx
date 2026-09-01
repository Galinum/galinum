import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgentRunsPage, type AgentRunsManagement } from "./agent-runs.js";

describe("AgentRunsPage", () => {
  it("renders named decisions and host-owned controls", async () => {
    const listAgentRuns = vi.fn(async () => ({
      values: [{
        id: "run",
        kind: "proposal",
        goalId: "goal",
        campaignId: "campaign",
        input: { observation: "low activation" },
        output: { campaignId: "campaign" },
        rationale: "Try a clearer message.",
        createdAt: 900,
      }],
      total: 1,
      page: 1,
      pageCount: 1,
      references: {
        goals: { goal: "Activation" },
        campaigns: { campaign: "Welcome" },
      },
    }));
    const management = { listAgentRuns } satisfies AgentRunsManagement;
    const Link = ({ href, children, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a>;
    const html = renderToStaticMarkup(await AgentRunsPage({
      management,
      projectName: "Project",
      query: { page: 1 },
      Link,
      docsUrl: "https://docs.example",
      privateControls: <span>Private safety controls</span>,
      renderProposed: () => <span>Proposed campaign preview</span>,
      renderPagination: ({ total }) => <span>{total} run</span>,
      now: 1_000,
    }));

    expect(html).toContain("Private safety controls");
    expect(html).toContain("proposal");
    expect(html).toContain("Activation");
    expect(html).toContain("Welcome");
    expect(html).toContain("Try a clearer message.");
    expect(html).toContain("Proposed campaign preview");
    expect(html).toContain("Input JSON");
    expect(html).toContain("1 run");
    expect(listAgentRuns).toHaveBeenCalledWith({ page: 1, perPage: 25, include: "names" });
  });
});
