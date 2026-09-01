import type { ReactNode } from "react";
import { resolvePresentation } from "@galinum/core";
import {
  CAMPAIGN_DELIVERY_STATES,
  type CampaignDeliveryState,
  type CampaignDetail,
  type CampaignMessageContent,
  type CampaignVariant,
} from "@galinum/core/contract";
import { DeliveryStateBadge } from "./components/delivery-state-badge.js";
import type { DashboardLink, DashboardManagement } from "./dashboard-types.js";
import { CampaignStatusBadge, deliveryWindowLabel } from "./campaigns.js";
import { PageHeader } from "./components/page-header.js";
import { StatTile } from "./components/stat-tile.js";
import { relativeTime } from "./relative-time.js";
import { Card, CardContent, CardHeader } from "./ui/card.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table.js";

export type CampaignMessageRenderer = (input: {
  campaign: CampaignDetail;
  variant: CampaignVariant;
}) => ReactNode | Promise<ReactNode>;

export type CampaignDetailManagement = DashboardManagement<
  "getCampaign" | "listCampaignDeliveries"
>;
export type CampaignDetailPageProps = {
  management: CampaignDetailManagement;
  campaignId: string;
  projectName: string;
  query: { state: CampaignDeliveryState | ""; page: number };
  Link: DashboardLink;
  renderActions?: (input: { campaign: CampaignDetail; windowElapsed: boolean }) => ReactNode;
  deliveryControls?: ReactNode;
  renderPagination?: (page: { page: number; pageCount: number; total: number }) => ReactNode;
  renderMessage?: CampaignMessageRenderer;
};

export async function CampaignDetailPage({
  management,
  campaignId,
  projectName,
  query,
  Link,
  renderActions,
  deliveryControls,
  renderPagination,
  renderMessage = ({ campaign, variant }) => (
    <StoredMessagePreview content={variant.content} channel={campaign.channel} />
  ),
}: CampaignDetailPageProps): Promise<ReactNode | null> {
  const detail = await management.getCampaign(campaignId);
  if (!detail) return null;
  const { campaign, evaluatedAt } = detail;
  const feed = await management.listCampaignDeliveries(campaign.id, {
    state: query.state || undefined,
    page: Math.min(Math.max(1, query.page), 10_000),
    perPage: 25,
  });
  if (feed.pageCount > 0 && query.page > feed.pageCount) {
    return CampaignDetailPage({
      management,
      campaignId,
      projectName,
      query: { ...query, page: feed.pageCount },
      Link,
      renderActions,
      deliveryControls,
      renderPagination,
      renderMessage,
    });
  }

  const email = campaign.channel === "email";
  const ctrBase = email ? campaign.stats.delivered : campaign.stats.shown;
  const ctr = ctrBase > 0
    ? `${((campaign.stats.clicked / ctrBase) * 100).toFixed(1)}% click-through`
    : email ? "No deliveries yet" : "No impressions yet";
  const windowLabel = deliveryWindowLabel(
    campaign.effectiveStatus,
    campaign.deliverFrom,
    campaign.deliverUntil,
  );
  const windowElapsed = campaign.deliverUntil !== null && campaign.deliverUntil <= evaluatedAt;
  const previews = await Promise.all(campaign.variants.map((variant) => renderMessage({ campaign, variant })));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {campaign.name}
            <CampaignStatusBadge status={campaign.effectiveStatus} />
          </span>
        }
        description={`${projectName} · Created ${dateFormat.format(campaign.createdAt)}${
          campaign.startedAt ? ` · Launched ${dateFormat.format(campaign.startedAt)}` : ""
        }${windowLabel ? ` · ${windowLabel}` : ""}`}
        actions={renderActions?.({ campaign, windowElapsed })}
      />

      {email ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5 xl:grid-cols-9">
          <StatTile label="Sent" value={campaign.stats.sent} />
          <StatTile label="Capped" value={campaign.stats.frequencyCapped} />
          <StatTile label="Delivered" value={campaign.stats.delivered} hint={ctr} />
          <StatTile label="Opened" value={campaign.stats.opened} />
          <StatTile label="Clicked" value={campaign.stats.clicked} />
          <StatTile label="Bounced" value={campaign.stats.bounced} />
          <StatTile label="Complaints" value={campaign.stats.complained} />
          <StatTile label="Unsubscribed" value={campaign.stats.unsubscribed} />
          <StatTile label="Conversions" value={campaign.stats.converted} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Impressions" value={campaign.stats.shown} hint={ctr} />
          <StatTile label="Clicks" value={campaign.stats.clicked} />
          <StatTile label="Dismissed" value={campaign.stats.dismissed} />
          <StatTile label="Conversions" value={campaign.stats.converted} />
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">{campaign.variants.length > 1 ? "Variants" : "Message"}</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {campaign.variants.map((variant, index) => (
            <Card key={variant.id}>
              {campaign.variants.length > 1 && (
                <CardHeader className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">
                    Variant {variant.name}
                    {variant.isControl && <span className="ml-2 text-xs font-normal text-muted-foreground">control</span>}
                  </h3>
                  <span className="text-xs text-muted-foreground">weight {variant.weight}</span>
                </CardHeader>
              )}
              <CardContent className="flex flex-col gap-4">
                {previews[index]}
                <dl className="flex flex-wrap gap-5 text-sm text-muted-foreground">
                  {(email
                    ? ["sent", "frequencyCapped", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "converted"]
                    : ["shown", "clicked", "dismissed", "converted"]
                  ).map((field) => (
                    <VariantStat
                      key={field}
                      label={field === "frequencyCapped" ? "capped" : field}
                      value={variant.stats[field as keyof typeof variant.stats]}
                    />
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Audience</h2>
        {campaign.audience.kind === "segment" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              Segment <span className="font-mono text-xs">{campaign.audience.segmentKey ?? campaign.audience.segmentId}</span>{" "}
              · version {campaign.audience.segmentVersion}
            </p>
            <p className="text-sm text-muted-foreground">{campaign.audience.summary}</p>
            <JsonBlock value={campaign.audience.expression.root} />
          </div>
        ) : campaign.audience.kind === "expression" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{campaign.audience.summary}</p>
            <JsonBlock value={campaign.audience.expression.root} />
          </div>
        ) : campaign.audience.kind === "invalid" ? (
          <p className="text-sm text-destructive">
            The stored audience cannot be read. This campaign currently delivers to nobody. Replace its audience through the API.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            All users. Each user {email ? "receives" : "sees"} this message once.
          </p>
        )}
      </section>

      {!email && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Pages</h2>
          {campaign.pages === null ? (
            <p className="text-sm text-muted-foreground">Every page. The message can appear on any screen of your product.</p>
          ) : campaign.pages.length === 0 ? (
            <p className="text-sm text-destructive">
              The stored page patterns cannot be read. This campaign currently renders on no page. Replace its pages through the API.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {campaign.pages.map((pattern) => (
                <li key={pattern} className="rounded-lg border bg-muted/40 px-2.5 py-1 font-mono text-xs">{pattern}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Deliveries</h2>
          {(feed.total > 0 || query.state.length > 0) && deliveryControls}
        </div>
        {feed.values.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {query.state
              ? `No ${query.state.replaceAll("_", " ")} deliveries.`
              : email
                ? "No deliveries yet. The email worker sends to eligible users in bounded batches."
                : "No deliveries yet. They appear once eligible users load your app."}
          </p>
        ) : (
          <>
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">User</TableHead>
                    {campaign.variants.length > 1 && <TableHead>Variant</TableHead>}
                    <TableHead>Status</TableHead>
                    <TableHead className="pr-5 text-right">Queued</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="ph-no-capture">
                  {feed.values.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell className="pl-5">
                        <Link href={`/users/${delivery.endUserId}`} className="block max-w-56 truncate font-medium hover:underline">
                          {delivery.externalUserId}
                        </Link>
                      </TableCell>
                      {campaign.variants.length > 1 && <TableCell className="text-muted-foreground">{delivery.variantName}</TableCell>}
                      <TableCell><DeliveryStateBadge state={delivery.state} /></TableCell>
                      <TableCell className="pr-5 text-right whitespace-nowrap text-muted-foreground">
                        {relativeTime(delivery.queuedAt, evaluatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            {renderPagination?.(feed)}
          </>
        )}
      </section>
    </div>
  );
}

export const campaignDeliveryStates = CAMPAIGN_DELIVERY_STATES;

const dateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function StoredMessagePreview({ content, channel }: { content: CampaignMessageContent; channel: CampaignDetail["channel"] }) {
  if (channel === "email") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
        <p><span className="text-muted-foreground">Subject:</span> {content.subject}</p>
        {content.previewText && <p className="text-muted-foreground">{content.previewText}</p>}
        <p className="whitespace-pre-wrap">{content.body}</p>
      </div>
    );
  }
  return resolvePresentation(content) === "modal" ? <ModalPreview content={content} /> : <ToastPreview content={content} />;
}

function ToastPreview({ content }: { content: CampaignMessageContent }) {
  const empty = !content.title && !content.body && !content.cta && !content.media?.url;
  return (
    <div className="relative w-full max-w-80 rounded-xl border bg-card p-4 text-card-foreground shadow-lg">
      <span aria-hidden className="absolute top-2 right-3 text-lg text-muted-foreground/60">×</span>
      {empty ? <p className="text-sm text-muted-foreground">Your message will appear here.</p> : (
        <>
          {content.media?.url && <img src={content.media.url} alt={content.media.decorative ? "" : (content.media.alt ?? "")} className="mb-2.5 size-12 rounded-lg object-cover" />}
          {content.title && <strong className="mb-1 block text-sm">{content.title}</strong>}
          {content.body && <p className="mb-3 text-sm text-muted-foreground">{content.body}</p>}
          {content.cta?.label && <span className="inline-block rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground">{content.cta.label}</span>}
        </>
      )}
    </div>
  );
}

function ModalPreview({ content }: { content: CampaignMessageContent }) {
  return (
    <div className="flex w-full max-w-96 items-center justify-center rounded-xl bg-foreground/50 p-5">
      <div className="relative w-full overflow-hidden rounded-xl bg-card text-card-foreground shadow-2xl">
        <span aria-hidden className="absolute top-2 right-2 z-10 flex size-6 items-center justify-center rounded-full bg-black/55 text-xs text-white">×</span>
        {content.media?.url && <img src={content.media.url} alt={content.media.decorative ? "" : (content.media.alt ?? "")} className="max-h-44 w-full object-cover" />}
        <div className={content.media?.url ? "flex flex-col gap-1.5 p-4" : "flex flex-col gap-1.5 p-4 pt-8"}>
          {content.title && <strong className="text-sm">{content.title}</strong>}
          {content.body && <p className="text-sm text-muted-foreground">{content.body}</p>}
          {content.cta?.label && <span className="mt-1.5 block rounded-lg bg-primary px-3.5 py-2 text-center text-sm font-semibold text-primary-foreground">{content.cta.label}</span>}
        </div>
      </div>
    </div>
  );
}

function VariantStat({ label, value }: { label: string; value: number }) {
  return <div className="flex items-baseline gap-1.5"><dd className="font-medium text-foreground tabular-nums">{value}</dd><dt>{label}</dt></div>;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="w-fit max-w-full overflow-x-auto rounded-xl border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}
