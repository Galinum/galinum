import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { AgentRun } from "@galinum/core/contract";
import { PageHeader } from "./components/page-header.js";
import { dateTimeFormat } from "./date-time.js";
import type { DashboardLink, DashboardManagement } from "./dashboard-types.js";
import { relativeTime } from "./relative-time.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty.js";

export type AgentRunsManagement = DashboardManagement<"listAgentRuns">;
export type AgentRunsPageProps = {
  management: AgentRunsManagement;
  projectName: string;
  query: { page: number };
  Link: DashboardLink;
  docsUrl: string;
  privateControls?: ReactNode;
  campaignIdsForRun?: (run: AgentRun) => string[];
  renderProposed?: (run: AgentRun) => ReactNode;
  renderPagination?: (page: { page: number; pageCount: number; total: number }) => ReactNode;
  now?: number;
};

export async function AgentRunsPage({
  management,
  projectName,
  query,
  Link,
  docsUrl,
  privateControls,
  campaignIdsForRun = (run) => run.campaignId ? [run.campaignId] : [],
  renderProposed,
  renderPagination,
  now = Date.now(),
}: AgentRunsPageProps) {
  const data = await management.listAgentRuns({
    page: Math.min(Math.max(1, query.page), 10_000),
    perPage: 25,
    include: "names",
  });
  if (data.pageCount > 0 && query.page > data.pageCount) {
    return AgentRunsPage({
      management,
      projectName,
      query: { page: data.pageCount },
      Link,
      docsUrl,
      privateControls,
      campaignIdsForRun,
      renderProposed,
      renderPagination,
      now,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agent"
        description={`Every decision an agent logged for ${projectName}, newest first.`}
      />
      {privateControls}
      {data.total === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
            <EmptyTitle>Nothing from your agent yet</EmptyTitle>
            <EmptyDescription>
              When an agent works on {projectName}, every decision it logs appears here with its reasoning.
              Point it at <code className="font-mono text-xs">POST /api/v1/agent-runs</code> to start the feed.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<a href={docsUrl} target="_blank" rel="noreferrer" />}>Read the docs</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <Card className="divide-y overflow-hidden py-0">
            {data.values.map((run) => {
              const goalName = run.goalId ? data.references?.goals[run.goalId] : undefined;
              const campaigns = campaignIdsForRun(run).flatMap((id) => {
                const name = data.references?.campaigns[id];
                return name ? [{ id, name }] : [];
              });
              return (
                <article key={run.id} className="flex flex-col gap-3 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <RunKindBadge kind={run.kind} />
                    {run.goalId && goalName && (
                      <span className="text-xs text-muted-foreground">Goal: <span className="text-foreground">{goalName}</span></span>
                    )}
                    {campaigns.map((campaign) => (
                      <Link key={campaign.id} href={`/campaigns/${campaign.id}`} className="max-w-56 truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
                        Campaign: <span className="text-foreground">{campaign.name}</span>
                      </Link>
                    ))}
                    <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground" title={dateTimeFormat.format(run.createdAt)}>
                      {relativeTime(run.createdAt, now)}
                    </span>
                  </div>
                  {run.rationale ? (
                    <p className="text-sm leading-relaxed whitespace-pre-line">{run.rationale}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No rationale provided.</p>
                  )}
                  {renderProposed?.(run)}
                  {(run.input !== null || run.output !== null) && (
                    <div className="flex flex-col gap-2">
                      {run.input !== null && <JsonDetails label="Input JSON" value={run.input} />}
                      {run.output !== null && <JsonDetails label="Output JSON" value={run.output} />}
                    </div>
                  )}
                </article>
              );
            })}
          </Card>
          {renderPagination?.(data)}
        </>
      )}
    </div>
  );
}

type RunKindFamily = "analyze" | "propose" | "launch" | "evaluate";
const kindStems: [string, RunKindFamily][] = [
  ["analyz", "analyze"],
  ["observ", "analyze"],
  ["propos", "propose"],
  ["launch", "launch"],
  ["evaluat", "evaluate"],
  ["iterat", "evaluate"],
];
const kindStyles: Record<RunKindFamily, string> = {
  analyze: "border border-border text-muted-foreground",
  propose: "bg-primary/10 text-primary",
  launch: "bg-primary text-primary-foreground",
  evaluate: "bg-muted text-muted-foreground",
};

function RunKindBadge({ kind }: { kind: string }) {
  const normalized = kind.trim().toLowerCase();
  const family = kindStems.find(([stem]) => normalized.startsWith(stem))?.[1];
  return (
    <span className={`inline-flex h-5 max-w-40 shrink-0 items-center truncate rounded-4xl px-2 text-xs font-medium lowercase ${family ? kindStyles[family] : "bg-muted text-muted-foreground"}`} title={kind}>
      {kind}
    </span>
  );
}

function JsonDetails({ label, value }: { label: string; value: Record<string, unknown> | unknown[] }) {
  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">{label}</summary>
      <pre className="ph-no-capture mt-2 overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
