import type { ReactNode } from "react";
import { Megaphone } from "lucide-react";
import type { EffectiveCampaignStatus } from "@galinum/core/contract";
import type { DashboardLink, DashboardManagement } from "./dashboard-types.js";
import { PageHeader } from "./components/page-header.js";
import { formatStat } from "./components/stat-tile.js";
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

export const effectiveCampaignStatuses = [
  "draft",
  "scheduled",
  "running",
  "paused",
  "expired",
  "ended",
] as const satisfies readonly EffectiveCampaignStatus[];

export type CampaignsManagement = DashboardManagement<"listCampaigns">;
export type CampaignsPageProps = {
  management: CampaignsManagement;
  query: { q: string; status: EffectiveCampaignStatus | ""; page: number };
  controls?: ReactNode;
  docsUrl: string;
  Link: DashboardLink;
  renderPagination?: (page: { page: number; pageCount: number; total: number }) => ReactNode;
};

const statusStyles: Record<EffectiveCampaignStatus, string> = {
  running: "bg-primary/10 text-primary",
  scheduled: "border border-primary/30 text-primary",
  draft: "border border-border text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
  expired: "bg-muted text-muted-foreground/70",
  ended: "bg-muted text-muted-foreground/70 line-through decoration-transparent",
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export async function CampaignsPage({
  management,
  query,
  controls,
  docsUrl,
  Link,
  renderPagination,
}: CampaignsPageProps) {
  if (query.q.length > 200) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Campaigns" description="Campaign messages across channels, and how they perform." />
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
        <Card className="items-center py-12 text-sm text-destructive">
          Search must be 200 characters or fewer.
        </Card>
      </div>
    );
  }
  const campaigns = await management.listCampaigns({
    q: query.q || undefined,
    status: query.status || undefined,
    page: Math.min(Math.max(1, query.page), 10_000),
    perPage: 100,
  });
  if (campaigns.pageCount > 0 && query.page > campaigns.pageCount) {
    return CampaignsPage({
      management,
      query: { ...query, page: campaigns.pageCount },
      controls,
      docsUrl,
      Link,
      renderPagination,
    });
  }
  const filtering = query.q.length > 0 || query.status.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Campaigns" description="Campaign messages across channels, and how they perform." />

      {(campaigns.values.length > 0 || filtering) && controls && (
        <div className="flex flex-wrap items-center gap-2">{controls}</div>
      )}

      {campaigns.values.length === 0 && filtering ? (
        <Card className="items-center py-12 text-sm text-muted-foreground">No campaigns match your filters.</Card>
      ) : campaigns.values.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Megaphone /></EmptyMedia>
            <EmptyTitle>No campaigns yet</EmptyTitle>
            <EmptyDescription>
              Campaigns appear here when your agent creates them. Connect your agent to get started.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" nativeButton={false} render={<a href={docsUrl} target="_blank" rel="noreferrer" />}>
              Connect your agent
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <Card className="divide-y py-0">
            {campaigns.values.map((campaign) => {
              const window = deliveryWindowLabel(
                campaign.effectiveStatus,
                campaign.deliverFrom,
                campaign.deliverUntil,
              );
              return (
                <Link
                  key={campaign.id}
                  href={`/campaigns/${campaign.id}`}
                  className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/50"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{campaign.name}</span>
                      <CampaignStatusBadge status={campaign.effectiveStatus} />
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {campaign.channel === "email" ? "Email" : "Web in-app"} · Created {dateFormat.format(campaign.createdAt)}
                      {window ? ` · ${window}` : ""}
                    </span>
                  </div>
                  <dl className="flex items-center gap-6 text-sm">
                    <StatCell
                      label={campaign.channel === "email" ? "Sent" : "Impressions"}
                      value={campaign.channel === "email" ? campaign.stats.sent : campaign.stats.shown}
                    />
                    <StatCell label="Clicks" value={campaign.stats.clicked} />
                    <StatCell
                      label={campaign.channel === "email" ? "Delivered" : "Conversions"}
                      value={campaign.channel === "email" ? campaign.stats.delivered : campaign.stats.converted}
                    />
                  </dl>
                </Link>
              );
            })}
          </Card>
          {renderPagination?.(campaigns)}
        </>
      )}
    </div>
  );
}

export function CampaignStatusBadge({ status }: { status: EffectiveCampaignStatus }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center rounded-4xl px-2 text-xs font-medium capitalize ${statusStyles[status]}`}>
      {status}
    </span>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{formatStat(value)}</dd>
    </div>
  );
}

const instantFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function formatInstant(timestamp: number) {
  return `${instantFormat.format(timestamp)} UTC`;
}

export function deliveryWindowLabel(
  status: EffectiveCampaignStatus,
  deliverFrom: number | null,
  deliverUntil: number | null,
) {
  if (status === "expired") return deliverUntil === null ? null : `Expired ${formatInstant(deliverUntil)}`;
  if (status === "scheduled" && deliverFrom !== null) {
    return deliverUntil === null
      ? `Starts ${formatInstant(deliverFrom)}`
      : `Starts ${formatInstant(deliverFrom)} · expires ${formatInstant(deliverUntil)}`;
  }
  if (status === "running" || status === "paused") {
    return deliverUntil === null ? null : `Expires ${formatInstant(deliverUntil)}`;
  }
  if (status === "draft") {
    const parts = [];
    if (deliverFrom !== null) parts.push(`starts ${formatInstant(deliverFrom)}`);
    if (deliverUntil !== null) parts.push(`expires ${formatInstant(deliverUntil)}`);
    return parts.length === 0 ? null : `Window: ${parts.join(" · ")}`;
  }
  return null;
}
