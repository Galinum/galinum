import { validateExpression } from "@galinum/core";
import type {
  ActivityItem,
  ActivityListInput,
  AgentRun,
  AgentRunListInput,
  AgentRunListResult,
  AgentRunReferences,
  CampaignAudience,
  CampaignDelivery,
  CampaignDeliveryListInput,
  CampaignDeliveryListResult,
  CampaignDetail,
  CampaignDetailResult,
  CampaignListInput,
  CampaignListResult,
  CampaignMessageContent,
  CampaignStats,
  CampaignStatusChange,
  CampaignStatusAction,
  CampaignSummary,
  EndUser,
  EventListInput,
  MetricDay,
  MetricsRange,
  MetricTotals,
  ManagementReader,
  ManagementClient,
  PageResult,
  ProjectActivityResponse,
  ProjectMetricsResponse,
  ProjectOverviewResponse,
  TopEvent,
  TrackedEvent,
  UserListInput,
  UserDelivery,
  UserDeliveriesResponse,
  PageInput,
  UserSummaryResponse,
} from "@galinum/core/contract";
import { CAMPAIGN_DELIVERY_STATES } from "@galinum/core/contract";

export type ManagementExecutor = (request: Request) => Promise<Response>;

export class ManagementClientError extends Error {
  constructor(
    public readonly kind: "request_failed" | "invalid_response",
    public readonly status: number,
    public readonly detail: string | null = null,
  ) {
    super(detail ?? kind);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function totals(value: unknown): MetricTotals | null {
  const item = record(value);
  if (!item) return null;
  return integer(item.impressions) && integer(item.clicks) && integer(item.conversions) && integer(item.events)
    ? {
        impressions: item.impressions,
        clicks: item.clicks,
        conversions: item.conversions,
        events: item.events,
      }
    : null;
}

function activityItem(value: unknown): ActivityItem | null {
  const item = record(value);
  const user = record(item?.user);
  if (!item || !user || !integer(item.occurredAt) || typeof item.id !== "string") return null;
  if (typeof user.id !== "string" || typeof user.externalUserId !== "string") return null;
  if (item.kind === "user") {
    return { kind: "user", id: item.id, occurredAt: item.occurredAt, user: { id: user.id, externalUserId: user.externalUserId } };
  }
  const campaign = record(item.campaign);
  const variant = record(item.variant);
  if (
    item.kind !== "delivery" ||
    !campaign ||
    !variant ||
    typeof campaign.id !== "string" ||
    typeof campaign.name !== "string" ||
    typeof variant.id !== "string" ||
    typeof variant.name !== "string"
  ) return null;
  return {
    kind: "delivery",
    id: item.id,
    occurredAt: item.occurredAt,
    user: { id: user.id, externalUserId: user.externalUserId },
    campaign: { id: campaign.id, name: campaign.name },
    variant: { id: variant.id, name: variant.name },
  };
}

function jsonCollection(value: unknown): value is Record<string, unknown> | unknown[] | null {
  return value === null || Array.isArray(value) || record(value) !== null;
}

function agentRun(value: unknown): AgentRun | null {
  const item = record(value);
  return item &&
    typeof item.id === "string" &&
    typeof item.kind === "string" &&
    (item.goalId === null || typeof item.goalId === "string") &&
    (item.campaignId === null || typeof item.campaignId === "string") &&
    jsonCollection(item.input) &&
    jsonCollection(item.output) &&
    (item.rationale === null || typeof item.rationale === "string") &&
    integer(item.createdAt)
    ? {
        id: item.id,
        kind: item.kind,
        goalId: item.goalId,
        campaignId: item.campaignId,
        input: item.input,
        output: item.output,
        rationale: item.rationale,
        createdAt: item.createdAt,
      }
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  const item = record(value);
  return item && Object.values(item).every((entry) => typeof entry === "string")
    ? item as Record<string, string>
    : null;
}

function agentRunReferences(value: unknown): AgentRunReferences | null {
  const item = record(value);
  const goals = stringRecord(item?.goals);
  const campaigns = stringRecord(item?.campaigns);
  return item && goals && campaigns ? { goals, campaigns } : null;
}

function agentRuns(value: unknown): AgentRunListResult | null {
  const item = record(value);
  const result = page(value, "runs", agentRun);
  if (!item || !result) return null;
  const references = item.references === undefined ? null : agentRunReferences(item.references);
  return item.references !== undefined && references === null
    ? null
    : { ...result, references };
}

function overview(value: unknown): ProjectOverviewResponse | null {
  const item = record(value);
  return item && integer(item.evaluatedAt) && integer(item.endUsers) && integer(item.eventsLast7d) && integer(item.activeCampaigns)
    ? {
        evaluatedAt: item.evaluatedAt,
        endUsers: item.endUsers,
        eventsLast7d: item.eventsLast7d,
        activeCampaigns: item.activeCampaigns,
      }
    : null;
}

function activity(value: unknown): ProjectActivityResponse | null {
  const item = record(value);
  if (!item || !Array.isArray(item.items) || !integer(item.evaluatedAt)) return null;
  if (item.nextCursor !== null && typeof item.nextCursor !== "string") return null;
  const items = item.items.map(activityItem);
  return items.some((entry) => entry === null)
    ? null
    : {
        items: items as ActivityItem[],
        nextCursor: item.nextCursor,
        evaluatedAt: item.evaluatedAt,
      };
}

function metrics(value: unknown): ProjectMetricsResponse | null {
  const item = record(value);
  if (!item || !integer(item.evaluatedAt) || item.timezone !== "UTC" || typeof item.hasAnyActivity !== "boolean") return null;
  const metricTotals = totals(item.totals);
  if (!metricTotals || !Array.isArray(item.days) || !Array.isArray(item.topEvents)) return null;
  const days = item.days.map((value): MetricDay | null => {
    const day = record(value);
    const counts = totals(value);
    return day && counts && integer(day.startAt) ? { startAt: day.startAt, ...counts } : null;
  });
  const topEvents = item.topEvents.map((value): TopEvent | null => {
    const event = record(value);
    return event && typeof event.name === "string" && integer(event.count)
      ? { name: event.name, count: event.count }
      : null;
  });
  return days.some((entry) => entry === null) || topEvents.some((entry) => entry === null)
    ? null
    : {
        evaluatedAt: item.evaluatedAt,
        timezone: "UTC",
        totals: metricTotals,
        days: days as MetricDay[],
        topEvents: topEvents as TopEvent[],
        hasAnyActivity: item.hasAnyActivity,
      };
}

function userSummary(value: unknown): UserSummaryResponse | null {
  const item = record(value);
  return item &&
    integer(item.evaluatedAt) &&
    item.window === "7d" &&
    integer(item.startAt) &&
    integer(item.totalUsers) &&
    integer(item.activeUsers) &&
    integer(item.newUsers)
    ? {
        evaluatedAt: item.evaluatedAt,
        window: "7d",
        startAt: item.startAt,
        totalUsers: item.totalUsers,
        activeUsers: item.activeUsers,
        newUsers: item.newUsers,
      }
    : null;
}

function endUser(value: unknown): EndUser | null {
  const item = record(value);
  const traits = record(item?.traits);
  return item &&
    typeof item.id === "string" &&
    typeof item.externalUserId === "string" &&
    traits &&
    integer(item.firstSeenAt) &&
    integer(item.lastSeenAt)
    ? {
        id: item.id,
        externalUserId: item.externalUserId,
        traits,
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
      }
    : null;
}

function endUserResult(value: unknown): EndUser | null {
  return endUser(record(value)?.user);
}

function userDelivery(value: unknown): UserDelivery | null {
  const item = record(value);
  return item &&
    typeof item.id === "string" &&
    typeof item.campaignId === "string" &&
    typeof item.campaignName === "string" &&
    typeof item.variantId === "string" &&
    typeof item.variantName === "string" &&
    typeof item.state === "string" &&
    campaignDeliveryStates.has(item.state as UserDelivery["state"]) &&
    integer(item.queuedAt)
    ? {
        id: item.id,
        campaignId: item.campaignId,
        campaignName: item.campaignName,
        variantId: item.variantId,
        variantName: item.variantName,
        state: item.state as UserDelivery["state"],
        queuedAt: item.queuedAt,
      }
    : null;
}

function userDeliveries(value: unknown): UserDeliveriesResponse | null {
  const result = page(value, "deliveries", userDelivery);
  return result
    ? {
        deliveries: result.values,
        total: result.total,
        page: result.page,
        pageCount: result.pageCount,
      }
    : null;
}

function trackedEvent(value: unknown): TrackedEvent | null {
  const item = record(value);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    !integer(item.ts) ||
    typeof item.endUserId !== "string" ||
    typeof item.externalUserId !== "string"
  ) return null;
  const props = item.props === null ? null : record(item.props);
  if (props === null && item.props !== null) return null;
  return {
    id: item.id,
    name: item.name,
    props,
    ts: item.ts,
    endUserId: item.endUserId,
    externalUserId: item.externalUserId,
  };
}

function page<T>(value: unknown, key: string, parse: (value: unknown) => T | null): PageResult<T> | null {
  const item = record(value);
  const values = item?.[key];
  if (!item || !Array.isArray(values) || !integer(item.total) || !integer(item.page) || !integer(item.pageCount)) return null;
  const parsed = values.map(parse);
  return parsed.some((entry) => entry === null)
    ? null
    : { values: parsed as T[], total: item.total, page: item.page, pageCount: item.pageCount };
}

const campaignStatuses = new Set(["draft", "running", "paused", "ended"]);
const effectiveStatuses = new Set([...campaignStatuses, "scheduled", "expired"]);
const campaignChannels = new Set(["web_inapp", "email"]);
const campaignDeliveryStates = new Set(CAMPAIGN_DELIVERY_STATES);

function campaignStats(value: unknown): CampaignStats | null {
  const item = record(value);
  if (!item) return null;
  const fields = [
    "sent",
    "frequencyCapped",
    "delivered",
    "shown",
    "opened",
    "clicked",
    "dismissed",
    "bounced",
    "complained",
    "unsubscribed",
    "converted",
  ] as const;
  if (fields.some((field) => !integer(item[field]))) return null;
  return Object.fromEntries(fields.map((field) => [field, item[field]])) as CampaignStats;
}

function campaignSummary(value: unknown): CampaignSummary | null {
  const item = record(value);
  const stats = campaignStats(item?.stats);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.status !== "string" ||
    !campaignStatuses.has(item.status) ||
    typeof item.effectiveStatus !== "string" ||
    !effectiveStatuses.has(item.effectiveStatus) ||
    typeof item.channel !== "string" ||
    !campaignChannels.has(item.channel) ||
    (item.goalId !== null && typeof item.goalId !== "string") ||
    typeof item.createdBy !== "string" ||
    !integer(item.createdAt) ||
    (item.startedAt !== null && !integer(item.startedAt)) ||
    (item.endedAt !== null && !integer(item.endedAt)) ||
    (item.deliverFrom !== null && !integer(item.deliverFrom)) ||
    (item.deliverUntil !== null && !integer(item.deliverUntil)) ||
    !stats
  ) return null;
  return {
    id: item.id,
    name: item.name,
    status: item.status as CampaignSummary["status"],
    effectiveStatus: item.effectiveStatus as CampaignSummary["effectiveStatus"],
    channel: item.channel as CampaignSummary["channel"],
    goalId: item.goalId,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    deliverFrom: item.deliverFrom,
    deliverUntil: item.deliverUntil,
    stats,
  };
}

function campaigns(value: unknown): CampaignListResult | null {
  const item = record(value);
  const result = page(value, "campaigns", campaignSummary);
  return item && result && integer(item.evaluatedAt)
    ? { ...result, evaluatedAt: item.evaluatedAt }
    : null;
}

function messageContent(value: unknown, channel: CampaignDetail["channel"]): CampaignMessageContent | null {
  const item = record(value);
  if (!item) return null;
  const stringFields = ["title", "subject", "previewText", "body"] as const;
  if (stringFields.some((field) => item[field] !== undefined && typeof item[field] !== "string")) return null;
  if (item.presentation !== undefined && item.presentation !== "toast" && item.presentation !== "modal") return null;
  if (channel === "email" && (typeof item.subject !== "string" || typeof item.body !== "string")) return null;

  const cta = item.cta === undefined ? undefined : record(item.cta);
  if (item.cta !== undefined && (!cta || typeof cta.label !== "string" || (cta.url !== undefined && typeof cta.url !== "string"))) {
    return null;
  }
  const media = item.media === undefined ? undefined : record(item.media);
  if (
    item.media !== undefined &&
    (!media ||
      typeof media.url !== "string" ||
      (media.alt !== undefined && typeof media.alt !== "string") ||
      (media.decorative !== undefined && typeof media.decorative !== "boolean"))
  ) return null;

  return item as CampaignMessageContent;
}

function campaignAudience(value: unknown): CampaignAudience | null {
  const item = record(value);
  if (!item || typeof item.kind !== "string") return null;
  if (item.kind === "all") return { kind: "all" };
  if (item.kind === "invalid") {
    return item.audienceVersionId === null || typeof item.audienceVersionId === "string"
      ? { kind: "invalid", audienceVersionId: item.audienceVersionId }
      : null;
  }
  if (item.kind !== "expression" && item.kind !== "segment") return null;
  const validated = validateExpression(item.expression);
  if (
    !validated.ok ||
    typeof item.schemaVersion !== "number" ||
    !Number.isSafeInteger(item.schemaVersion) ||
    typeof item.expressionHash !== "string" ||
    typeof item.summary !== "string" ||
    (item.reason !== null && typeof item.reason !== "string")
  ) return null;
  const definition = {
    schemaVersion: item.schemaVersion,
    expression: validated.expression,
    expressionHash: item.expressionHash,
    summary: item.summary,
    reason: item.reason,
  };
  if (item.kind === "expression") {
    return (item.audienceVersionId === null || typeof item.audienceVersionId === "string") && typeof item.legacy === "boolean"
      ? { kind: "expression", audienceVersionId: item.audienceVersionId, legacy: item.legacy, ...definition }
      : null;
  }
  return typeof item.audienceVersionId === "string" &&
    typeof item.segmentId === "string" &&
    (item.segmentKey === null || typeof item.segmentKey === "string") &&
    integer(item.segmentVersion)
    ? {
        kind: "segment",
        audienceVersionId: item.audienceVersionId,
        segmentId: item.segmentId,
        segmentKey: item.segmentKey,
        segmentVersion: item.segmentVersion,
        ...definition,
      }
    : null;
}

function campaignDetail(value: unknown): CampaignDetail | null {
  const item = record(value);
  const summary = campaignSummary(value);
  const audience = campaignAudience(item?.audience);
  if (!item || !summary || !audience || !Array.isArray(item.variants)) return null;
  const targeting = item.targeting === null ? null : record(item.targeting);
  if (targeting === null && item.targeting !== null) return null;
  if (item.pages !== null && (!Array.isArray(item.pages) || item.pages.some((entry) => typeof entry !== "string"))) return null;
  const variants = item.variants.map((value) => {
    const variant = record(value);
    const stats = campaignStats(variant?.stats);
    const content = messageContent(variant?.content, summary.channel);
    return variant &&
      typeof variant.id === "string" &&
      typeof variant.name === "string" &&
      typeof variant.weight === "number" &&
      Number.isFinite(variant.weight) &&
      typeof variant.isControl === "boolean" &&
      content &&
      stats
      ? {
          id: variant.id,
          name: variant.name,
          weight: variant.weight,
          isControl: variant.isControl,
          content,
          stats,
        }
      : null;
  });
  return variants.some((entry) => entry === null)
    ? null
    : {
        ...summary,
        audience,
        targeting,
        pages: item.pages as string[] | null,
        variants: variants as CampaignDetail["variants"],
      };
}

function campaignDetailResult(value: unknown): CampaignDetailResult | null {
  const item = record(value);
  const campaign = campaignDetail(item?.campaign);
  return item && campaign && integer(item.evaluatedAt) ? { campaign, evaluatedAt: item.evaluatedAt } : null;
}

function nullableIntegerField(item: Record<string, unknown>, field: string) {
  const value = item[field];
  return value === null || integer(value) ? value : undefined;
}

function campaignDelivery(value: unknown): CampaignDelivery | null {
  const item = record(value);
  if (!item) return null;
  const timestampFields = [
    "sentAt",
    "deliveredAt",
    "shownAt",
    "openedAt",
    "clickedAt",
    "dismissedAt",
    "bouncedAt",
    "complainedAt",
    "unsubscribedAt",
    "convertedAt",
  ] as const;
  const timestamps = Object.fromEntries(timestampFields.map((field) => [field, nullableIntegerField(item, field)]));
  if (
    typeof item.id !== "string" ||
    typeof item.endUserId !== "string" ||
    typeof item.externalUserId !== "string" ||
    typeof item.variantId !== "string" ||
    typeof item.variantName !== "string" ||
    typeof item.state !== "string" ||
    !campaignDeliveryStates.has(item.state as CampaignDelivery["state"]) ||
    !integer(item.queuedAt) ||
    Object.values(timestamps).some((timestamp) => timestamp === undefined)
  ) return null;
  return {
    id: item.id,
    endUserId: item.endUserId,
    externalUserId: item.externalUserId,
    variantId: item.variantId,
    variantName: item.variantName,
    state: item.state as CampaignDelivery["state"],
    queuedAt: item.queuedAt,
    ...timestamps as Pick<CampaignDelivery, (typeof timestampFields)[number]>,
  };
}

function campaignDeliveries(value: unknown): CampaignDeliveryListResult | null {
  return page(value, "deliveries", campaignDelivery);
}

function query(input: object) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined) params.set(name, String(value));
  }
  return params.size === 0 ? "" : "?" + params;
}

async function call<T>(
  execute: ManagementExecutor,
  origin: string,
  path: string,
  parse: (value: unknown) => T | null,
  init?: RequestInit,
): Promise<T> {
  const response = await execute(new Request(new URL(path, origin), init));
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = record(value)?.error;
    throw new ManagementClientError(
      "request_failed",
      response.status,
      typeof detail === "string" ? detail : null,
    );
  }
  const parsed = parse(value);
  if (parsed === null) throw new ManagementClientError("invalid_response", response.status);
  return parsed;
}

async function optionalCall<T>(
  execute: ManagementExecutor,
  origin: string,
  path: string,
  parse: (value: unknown) => T | null,
): Promise<T | null> {
  try {
    return await call(execute, origin, path, parse);
  } catch (error) {
    if (error instanceof ManagementClientError && error.status === 404) return null;
    throw error;
  }
}

function campaignStatusChange(value: unknown): CampaignStatusChange | null {
  const item = record(value);
  return item &&
    typeof item.id === "string" &&
    typeof item.status === "string" &&
    ["running", "paused", "ended"].includes(item.status)
    ? { id: item.id, status: item.status as CampaignStatusChange["status"] }
    : null;
}

export function createManagementClient(
  execute: ManagementExecutor,
  origin = "http://galinum.local",
): ManagementClient {
  return {
    getOverview: () => call(execute, origin, "/api/v1/overview", overview),
    listActivity(input: ActivityListInput = {}) {
      const params = new URLSearchParams();
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.after !== undefined) params.set("cursor", input.after);
      const query = params.size === 0 ? "" : "?" + params;
      return call(execute, origin, "/api/v1/activity" + query, activity);
    },
    getMetrics(range: MetricsRange = "30d") {
      return call(execute, origin, "/api/v1/metrics?range=" + range, metrics);
    },
    getUserSummary: () => call(execute, origin, "/api/v1/users/summary", userSummary),
    listUsers(input: UserListInput = {}) {
      return call(
        execute,
        origin,
        "/api/v1/users" + query(input),
        (value) => page(value, "users", endUser),
      );
    },
    getUser(id: string) {
      return optionalCall(
        execute,
        origin,
        "/api/v1/users/" + encodeURIComponent(id),
        endUserResult,
      );
    },
    listUserEvents(id: string, input: PageInput = {}) {
      return call(
        execute,
        origin,
        "/api/v1/users/" + encodeURIComponent(id) + "/events" + query(input),
        (value) => page(value, "events", trackedEvent),
      );
    },
    listUserDeliveries(id: string, input: PageInput = {}) {
      return call(
        execute,
        origin,
        "/api/v1/users/" + encodeURIComponent(id) + "/deliveries" + query(input),
        userDeliveries,
      );
    },
    listEvents(input: EventListInput = {}) {
      return call(
        execute,
        origin,
        "/api/v1/events" + query(input),
        (value) => page(value, "events", trackedEvent),
      );
    },
    listCampaigns(input: CampaignListInput = {}) {
      return call(execute, origin, "/api/v1/campaigns" + query(input), campaigns);
    },
    listAgentRuns(input: AgentRunListInput = {}) {
      return call(execute, origin, "/api/v1/agent-runs" + query(input), agentRuns);
    },
    getCampaign(id: string) {
      return optionalCall(
        execute,
        origin,
        "/api/v1/campaigns/" + encodeURIComponent(id),
        campaignDetailResult,
      );
    },
    listCampaignDeliveries(id: string, input: CampaignDeliveryListInput = {}) {
      return call(
        execute,
        origin,
        "/api/v1/campaigns/" + encodeURIComponent(id) + "/deliveries" + query(input),
        campaignDeliveries,
      );
    },
    setCampaignStatus(id: string, action: CampaignStatusAction) {
      return call(
        execute,
        origin,
        "/api/v1/campaigns/" + encodeURIComponent(id) + "/status",
        campaignStatusChange,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
    },
  };
}
