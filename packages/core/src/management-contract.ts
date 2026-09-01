import type { AudienceExpression } from "./audience/expression.js";

export const ACTIVITY_LIMIT_DEFAULT = 10;
export const ACTIVITY_LIMIT_MAX = 50;
export const CAMPAIGN_PER_PAGE_DEFAULT = 100;
export const USER_DELIVERY_PER_PAGE_DEFAULT = 20;
export const SEARCH_MAX_LENGTH = 200;
export const TOP_EVENT_LIMIT = 8;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export const METRICS_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type MetricsRange = keyof typeof METRICS_RANGES;
export const METRICS_RANGE_DEFAULT: MetricsRange = "30d";

export type UserSummaryWindow = "7d";
export const USER_SUMMARY_WINDOW_DEFAULT: UserSummaryWindow = "7d";

export type AgentRunInclude = "names";
export const AGENT_RUN_INCLUDES: readonly AgentRunInclude[] = ["names"];

export type ProjectOverviewResponse = {
  evaluatedAt: number;
  endUsers: number;
  eventsLast7d: number;
  activeCampaigns: number;
};

export type ActivityUserRef = { id: string; externalUserId: string };
export type ActivityItem =
  | {
      kind: "delivery";
      id: string;
      occurredAt: number;
      user: ActivityUserRef;
      campaign: { id: string; name: string };
      variant: { id: string; name: string };
    }
  | { kind: "user"; id: string; occurredAt: number; user: ActivityUserRef };

export type ActivityCursor = { occurredAt: number; kind: ActivityItem["kind"]; id: string };
export type ActivityQuery = { limit: number; after: ActivityCursor | null };
export type ProjectActivityResponse = {
  items: ActivityItem[];
  nextCursor: string | null;
  evaluatedAt: number;
};

export type MetricTotals = { impressions: number; clicks: number; conversions: number; events: number };
export type MetricDay = MetricTotals & { startAt: number };
export type TopEvent = { name: string; count: number };
export type ProjectMetricsResponse = {
  evaluatedAt: number;
  timezone: "UTC";
  totals: MetricTotals;
  days: MetricDay[];
  topEvents: TopEvent[];
  hasAnyActivity: boolean;
};
export type MetricsQuery = {
  since: number;
  until: number;
  firstBucket: number;
  lastBucket: number;
};
export type MetricsAggregate = {
  buckets: Map<number, MetricTotals>;
  topEvents: TopEvent[];
  hasAnyDelivery: boolean;
};

export type UserSummaryResponse = {
  evaluatedAt: number;
  window: UserSummaryWindow;
  startAt: number;
  totalUsers: number;
  activeUsers: number;
  newUsers: number;
};

export type UserDelivery = {
  id: string;
  campaignId: string;
  campaignName: string;
  variantId: string;
  variantName: string;
  state: CampaignDeliveryState;
  queuedAt: number;
};
export type UserDeliveryQuery = { userId: string; offset: number; limit: number };
export type UserDeliveriesResponse = {
  deliveries: UserDelivery[];
  total: number;
  page: number;
  pageCount: number;
};
export type PageInput = { page?: number; perPage?: number };

export type AgentRunReferences = { goals: Record<string, string>; campaigns: Record<string, string> };
export type AgentRun = {
  id: string;
  kind: string;
  goalId: string | null;
  campaignId: string | null;
  input: Record<string, unknown> | unknown[] | null;
  output: Record<string, unknown> | unknown[] | null;
  rationale: string | null;
  createdAt: number;
};
export type AgentRunListInput = PageInput & {
  kind?: string;
  goalId?: string;
  campaignId?: string;
  include?: AgentRunInclude;
};
export type AgentRunListResult = PageResult<AgentRun> & {
  references: AgentRunReferences | null;
};

export type ActivityListInput = { limit?: number; after?: string };

export type EndUser = {
  id: string;
  externalUserId: string;
  traits: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type TrackedEvent = {
  id: string;
  name: string;
  props: Record<string, unknown> | null;
  ts: number;
  endUserId: string;
  externalUserId: string;
};

export type PageResult<T> = {
  values: T[];
  total: number;
  page: number;
  pageCount: number;
};

export type UserListInput = PageInput & { q?: string };
export type EventListInput = PageInput & {
  q?: string;
  page?: number;
  perPage?: number;
  since?: number;
  until?: number;
};

export type CampaignStatus = "draft" | "running" | "paused" | "ended";
export type EffectiveCampaignStatus = CampaignStatus | "scheduled" | "expired";
export type CampaignChannel = "web_inapp" | "email";

export type CampaignStats = {
  sent: number;
  frequencyCapped: number;
  delivered: number;
  shown: number;
  opened: number;
  clicked: number;
  dismissed: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  converted: number;
};

export type CampaignSummary = {
  id: string;
  name: string;
  status: CampaignStatus;
  effectiveStatus: EffectiveCampaignStatus;
  channel: CampaignChannel;
  goalId: string | null;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  deliverFrom: number | null;
  deliverUntil: number | null;
  stats: CampaignStats;
};

export type CampaignListInput = PageInput & {
  q?: string;
  status?: EffectiveCampaignStatus;
  page?: number;
  perPage?: number;
};

export type CampaignListResult = PageResult<CampaignSummary> & { evaluatedAt: number };

export type CampaignMessageMedia = {
  url: string;
  alt?: string;
  decorative?: boolean;
};

export type CampaignMessageContent = {
  [key: string]: unknown;
  presentation?: "toast" | "modal";
  title?: string;
  subject?: string;
  previewText?: string;
  body?: string;
  cta?: { label: string; url?: string };
  media?: CampaignMessageMedia;
};

type CampaignAudienceDefinition = {
  audienceVersionId: string | null;
  schemaVersion: number;
  expression: AudienceExpression;
  expressionHash: string;
  summary: string;
  reason: string | null;
};

export type CampaignAudience =
  | { kind: "all" }
  | ({ kind: "expression"; legacy: boolean } & CampaignAudienceDefinition)
  | {
      kind: "invalid";
      audienceVersionId: string | null;
    }
  | ({
      kind: "segment";
      audienceVersionId: string;
      segmentId: string;
      segmentKey: string | null;
      segmentVersion: number;
    } & Omit<CampaignAudienceDefinition, "audienceVersionId">);

export type CampaignVariant = {
  id: string;
  name: string;
  weight: number;
  isControl: boolean;
  content: CampaignMessageContent;
  stats: CampaignStats;
};

export type CampaignDetail = CampaignSummary & {
  audience: CampaignAudience;
  targeting: Record<string, unknown> | null;
  pages: string[] | null;
  variants: CampaignVariant[];
};

export type CampaignDetailResult = {
  campaign: CampaignDetail;
  evaluatedAt: number;
};

export const CAMPAIGN_DELIVERY_STATES = [
  "queued",
  "sending",
  "retryable",
  "frequency_capped",
  "sent",
  "delivered",
  "shown",
  "opened",
  "clicked",
  "dismissed",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "converted",
] as const;
export type CampaignDeliveryState = (typeof CAMPAIGN_DELIVERY_STATES)[number];

export type CampaignDelivery = {
  id: string;
  endUserId: string;
  externalUserId: string;
  variantId: string;
  variantName: string;
  state: CampaignDeliveryState;
  queuedAt: number;
  sentAt: number | null;
  deliveredAt: number | null;
  shownAt: number | null;
  openedAt: number | null;
  clickedAt: number | null;
  dismissedAt: number | null;
  bouncedAt: number | null;
  complainedAt: number | null;
  unsubscribedAt: number | null;
  convertedAt: number | null;
};

export type CampaignDeliveryListInput = {
  state?: CampaignDeliveryState;
  page?: number;
  perPage?: number;
};

export type CampaignDeliveryListResult = PageResult<CampaignDelivery>;
export type CampaignStatusAction = "launch" | "pause" | "end";
export type CampaignStatusChange = {
  id: string;
  status: Exclude<CampaignStatus, "draft">;
};

export type DashboardProject = { id: string; name: string };
export type DashboardViewer = { name: string };

export type DashboardSession = {
  project: DashboardProject;
  viewer: DashboardViewer;
  management: ManagementReader;
};

export interface ManagementReader {
  getOverview(): Promise<ProjectOverviewResponse>;
  listActivity(input?: ActivityListInput): Promise<ProjectActivityResponse>;
  getMetrics(range?: MetricsRange): Promise<ProjectMetricsResponse>;
  getUserSummary(): Promise<UserSummaryResponse>;
  listUsers(input?: UserListInput): Promise<PageResult<EndUser>>;
  getUser(id: string): Promise<EndUser | null>;
  listUserEvents(id: string, input?: PageInput): Promise<PageResult<TrackedEvent>>;
  listUserDeliveries(
    id: string,
    input?: PageInput,
  ): Promise<UserDeliveriesResponse>;
  listEvents(input?: EventListInput): Promise<PageResult<TrackedEvent>>;
  listCampaigns(input?: CampaignListInput): Promise<CampaignListResult>;
  listAgentRuns(input?: AgentRunListInput): Promise<AgentRunListResult>;
  getCampaign(id: string): Promise<CampaignDetailResult | null>;
  listCampaignDeliveries(
    id: string,
    input?: CampaignDeliveryListInput,
  ): Promise<CampaignDeliveryListResult>;
}

export interface ManagementClient extends ManagementReader {
  setCampaignStatus(id: string, action: CampaignStatusAction): Promise<CampaignStatusChange>;
}

export function pageCountFor(total: number, perPage: number) {
  return total === 0 ? 0 : Math.ceil(total / perPage);
}

export function dayBucket(instant: number) {
  return Math.floor(instant / DAY_MS);
}

export function metricsQuery(range: MetricsRange, evaluatedAt: number): MetricsQuery {
  const lastBucket = dayBucket(evaluatedAt);
  const firstBucket = lastBucket - METRICS_RANGES[range] + 1;
  return { since: firstBucket * DAY_MS, until: evaluatedAt, firstBucket, lastBucket };
}

export function emptyMetricTotals(): MetricTotals {
  return { impressions: 0, clicks: 0, conversions: 0, events: 0 };
}

export function metricsResponse(
  aggregate: MetricsAggregate,
  query: MetricsQuery,
  evaluatedAt: number,
): ProjectMetricsResponse {
  const totals = emptyMetricTotals();
  for (const bucket of aggregate.buckets.values()) {
    totals.impressions += bucket.impressions;
    totals.clicks += bucket.clicks;
    totals.conversions += bucket.conversions;
    totals.events += bucket.events;
  }
  const days: MetricDay[] = [];
  for (let bucket = query.firstBucket; bucket <= query.lastBucket; bucket += 1) {
    days.push({ startAt: bucket * DAY_MS, ...(aggregate.buckets.get(bucket) ?? emptyMetricTotals()) });
  }
  return {
    evaluatedAt,
    timezone: "UTC",
    totals,
    days,
    topEvents: aggregate.topEvents,
    hasAnyActivity: aggregate.hasAnyDelivery || totals.events > 0 || totals.impressions > 0,
  };
}

export function compareActivity(left: ActivityCursor, right: ActivityCursor) {
  return (
    right.occurredAt - left.occurredAt ||
    left.kind.localeCompare(right.kind) ||
    right.id.localeCompare(left.id)
  );
}

export function isAfterCursor(item: ActivityCursor, cursor: ActivityCursor | null) {
  return cursor === null || compareActivity(cursor, item) < 0;
}
