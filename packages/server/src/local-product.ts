import { randomBytes, randomUUID } from "node:crypto";
import {
  deliveredContent,
  evaluateExpression,
  legacyTargetingToExpression,
  LIMITS,
  pickVariant,
  referencedVocabulary,
  sortByPresentation,
  validatePages,
  validateTargeting,
  type AudienceExpression,
  type DeliveryFeedback,
  type MediaStore,
} from "@galinum/core";
import {
  audienceCapabilities,
  audienceDiagnosticsFromPresence,
  explainPreparedAudience,
  factsForUser,
  prepareAudience,
  type AudienceCapabilities,
} from "./audience.js";
import { MemoryMediaStore } from "./local-media-store.js";
import { createUploadCampaignMediaHandler } from "./media-handler.js";
import { readJsonObject, type BodyReadResult } from "./request-body.js";
import type { OperationHandlers } from "./router.js";
import type { OperationId } from "./operations.js";
import {
  ACTIVITY_LIMIT_DEFAULT,
  ACTIVITY_LIMIT_MAX,
  AGENT_RUN_INCLUDES,
  CAMPAIGN_PER_PAGE_DEFAULT,
  compareActivity,
  dayBucket,
  decodeActivityCursor,
  emptyMetricTotals,
  encodeActivityCursor,
  isAfterCursor,
  METRICS_RANGES,
  METRICS_RANGE_DEFAULT,
  metricsQuery,
  metricsResponse,
  pageCountFor,
  SEARCH_MAX_LENGTH,
  TOP_EVENT_LIMIT,
  USER_DELIVERY_PER_PAGE_DEFAULT,
  USER_SUMMARY_WINDOW_DEFAULT,
  WEEK_MS,
  type ActivityItem,
  type ActivityQuery,
  type AgentRunInclude,
  type AgentRunReferences,
  type MetricsAggregate,
  type MetricsQuery,
  type MetricsRange,
  type ProjectOverviewResponse,
  type UserDeliveriesResponse,
  type UserDeliveryQuery,
  type UserSummaryResponse,
} from "./management-contract.js";

export type JsonObject = Record<string, unknown>;
export type ProductUser = {
  id: string;
  externalId: string;
  traits: JsonObject;
  firstSeenAt: number;
  lastSeenAt: number;
};
export type ProductGoal = {
  id: string;
  name: string;
  description: string | null;
  targetEvent: string | null;
  guardrails: JsonObject | null;
  approvalMode: "require_human" | "auto";
  status: "active" | "archived";
  createdAt: number;
};
export type ProductVariant = {
  id: string;
  campaign_id: string;
  name: string;
  content_json: string;
  weight: number;
  isControl: boolean;
};
export type ProductCampaign = {
  id: string;
  name: string;
  status: "draft" | "running" | "paused" | "ended";
  channel: "web_inapp";
  goalId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  deliverFrom: number | null;
  deliverUntil: number | null;
  pages: string[] | null;
  audience: ProductCampaignAudience;
  variants: ProductVariant[];
};
type ProductAudienceDefinition = {
  schemaVersion: number;
  expressionJson: string;
  expressionHash: string;
  summary: string;
  reason: string | null;
};
export type ProductCampaignAudience =
  | { kind: "all" }
  | ({ kind: "expression"; audienceVersionId: string } & ProductAudienceDefinition)
  | ({ kind: "legacy"; audienceVersionId: null; targetingJson: string } & ProductAudienceDefinition)
  | ({
      kind: "segment";
      audienceVersionId: string;
      segmentId: string;
      segmentKey: string | null;
      segmentVersion: number;
    } & ProductAudienceDefinition)
  | { kind: "invalid"; audienceVersionId: string | null; targetingJson: string | null };
export type ProductDelivery = {
  id: string;
  campaignId: string;
  variantId: string;
  userId: string;
  state:
    | "queued"
    | "sending"
    | "retryable"
    | "frequency_capped"
    | "sent"
    | "delivered"
    | "shown"
    | "opened"
    | "clicked"
    | "dismissed"
    | "bounced"
    | "complained"
    | "unsubscribed"
    | "failed"
    | "converted";
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
export type ProductEvent = {
  id: string;
  userId: string;
  externalUserId: string;
  name: string;
  props: JsonObject | null;
  occurredAt: number;
};
export type ProductAgentRun = {
  id: string;
  kind: string;
  goalId: string | null;
  campaignId: string | null;
  input: JsonObject | unknown[] | null;
  output: JsonObject | unknown[] | null;
  rationale: string | null;
  idempotencyKey: string | null;
  createdAt: number;
};
export type ProductSegment = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  currentVersion: number;
  idempotencyKey: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};
export type ProductAudienceVersion = {
  id: string;
  segmentId: string;
  segmentVersion: number;
  schemaVersion: number;
  expressionJson: string;
  expressionHash: string;
  reason: string | null;
  agentRunId: string | null;
  createdBy: string;
  createdAt: number;
};
export type SegmentRevision = {
  name?: string;
  description?: string | null;
  updatedAt: number;
  expectedVersion?: number;
  version?: Omit<ProductAudienceVersion, "segmentId" | "segmentVersion">;
};
export type SegmentMutationResult =
  | { kind: "updated"; segment: ProductSegment; version: ProductAudienceVersion }
  | { kind: "not_found" }
  | { kind: "archived"; currentVersion: number }
  | { kind: "stale"; currentVersion: number };
export type PageResult<T> = { values: T[]; total: number };
export type UserQuery = {
  query: string | null;
  traitKey: string | null;
  traitValue: string | null;
  activeSince: number | null;
  firstSeenSince: number | null;
  offset: number;
  limit: number;
};
export type EventQuery = {
  name: string | null;
  query: string | null;
  userId: string | null;
  externalUserId: string | null;
  since: number | null;
  until: number | null;
  offset: number;
  limit: number;
};
export type AgentRunQuery = {
  kind: string | null;
  goalId: string | null;
  campaignId: string | null;
  offset: number;
  limit: number;
};
export type DeliveryQuery = {
  campaignId: string;
  state: ProductDelivery["state"] | null;
  offset: number;
  limit: number;
};
export type ConversionCounts = {
  exposedDeliveries: number;
  exposedUsers: number;
  convertedDeliveries: number;
  convertedUsers: number;
};
export type CampaignConversionSummary = {
  totals: ConversionCounts;
  variants: Map<string, ConversionCounts>;
};
export type UsageSummary = { activeUsers: number; frequencyCapped: number };
export type AudienceFactsInput = {
  afterUserId: string | null;
  limit: number;
  traitKeys: string[];
  eventNames: string[];
  evaluatedAt: number;
  maxOccurrences: number;
  eventRowBudget: number;
  userId?: string;
};
export type AudienceFactsBatch = {
  users: ProductUser[];
  eventsByUser: Map<string, ProductEvent[]>;
  nextCursor: string | null;
  overflow: boolean;
};
export type AudiencePresence = { traits: Set<string>; events: Set<string> };
export type CampaignQuery = {
  effectiveStatus: CampaignEffectiveStatus | null;
  query: string | null;
  evaluatedAt: number;
  offset: number;
  limit: number;
};
export type DeliveryStats = {
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
export type CampaignStats = { total: DeliveryStats; variants: Map<string, DeliveryStats> };

export interface ProductStoreAccess {
  identifyUser(externalId: string, traits: JsonObject, now: number): Promise<ProductUser>;
  getUserById(id: string): Promise<ProductUser | null>;
  getUserByExternalId(externalId: string): Promise<ProductUser | null>;
  loadAudienceFacts(input: AudienceFactsInput): Promise<AudienceFactsBatch>;
  audienceCapabilities(): Promise<AudienceCapabilities>;
  audiencePresence(input: { traitKeys: string[]; eventNames: string[] }): Promise<AudiencePresence>;
  queryUsers(query: UserQuery): Promise<PageResult<ProductUser>>;
  queryEvents(query: EventQuery): Promise<PageResult<ProductEvent>>;
  queryAgentRuns(query: AgentRunQuery): Promise<PageResult<ProductAgentRun>>;
  queryCampaignDeliveries(query: DeliveryQuery): Promise<PageResult<ProductDelivery>>;
  queryUserDeliveries(query: UserDeliveryQuery): Promise<UserDeliveriesResponse>;
  projectOverview(evaluatedAt: number): Promise<ProjectOverviewResponse>;
  projectActivity(query: ActivityQuery): Promise<ActivityItem[]>;
  projectMetrics(query: MetricsQuery): Promise<MetricsAggregate>;
  userSummary(startAt: number): Promise<Omit<UserSummaryResponse, "evaluatedAt" | "window" | "startAt">>;
  agentRunReferences(goalIds: string[], campaignIds: string[]): Promise<AgentRunReferences>;
  campaignEventConversionSummary(campaignId: string, eventName: string, evaluatedAt: number): Promise<CampaignConversionSummary>;
  usageSummary(start: number, end: number): Promise<UsageSummary>;
  createGoal(goal: ProductGoal): Promise<void>;
  getGoal(id: string): Promise<ProductGoal | null>;
  queryGoals(limit: number): Promise<ProductGoal[]>;
  getCampaign(id: string): Promise<ProductCampaign | null>;
  queryCampaigns(query: CampaignQuery): Promise<PageResult<ProductCampaign>>;
  campaignStatsForCampaigns(campaignIds: string[]): Promise<Map<string, CampaignStats>>;
  getOrCreateDelivery(delivery: ProductDelivery): Promise<ProductDelivery>;
  findFirstEventAtOrAfter(userId: string, name: string, occurredAt: number): Promise<ProductEvent | null>;
  getAgentRun(id: string): Promise<ProductAgentRun | null>;
  getOrCreateAgentRun(run: ProductAgentRun): Promise<{ run: ProductAgentRun; created: boolean }>;
  getSegment(idOrKey: string): Promise<ProductSegment | null>;
  querySegments(status: ProductSegment["status"] | null, limit: number): Promise<ProductSegment[]>;
  listSegmentVersions(segmentId: string): Promise<ProductAudienceVersion[]>;
  getSegmentVersion(segmentId: string, version: number): Promise<ProductAudienceVersion | null>;
}

export interface ProductStoreSession extends ProductStoreAccess {
  getGoalForUpdate(id: string): Promise<ProductGoal | null>;
  saveGoal(goal: ProductGoal): Promise<void>;
  insertEvent(event: ProductEvent): Promise<void>;
  listConversionCandidatesForUpdate(userId: string, eventName: string, occurredAt: number): Promise<ProductDelivery[]>;
  createCampaign(campaign: ProductCampaign): Promise<void>;
  getCampaignForUpdate(id: string): Promise<ProductCampaign | null>;
  saveCampaignContent(campaign: ProductCampaign): Promise<void>;
  saveCampaignLifecycle(campaign: ProductCampaign): Promise<void>;
  getDeliveryForUpdate(id: string): Promise<ProductDelivery | null>;
  saveDelivery(delivery: ProductDelivery): Promise<void>;
  createSegment(segment: ProductSegment, version: ProductAudienceVersion): Promise<
    | { kind: "created" | "replayed"; segment: ProductSegment; version: ProductAudienceVersion }
    | { kind: "key_conflict" }
  >;
  getSegmentForUpdate(idOrKey: string): Promise<ProductSegment | null>;
  reviseSegment(idOrKey: string, revision: SegmentRevision): Promise<SegmentMutationResult>;
  archiveSegment(idOrKey: string, updatedAt: number): Promise<
    | { kind: "archived"; segment: ProductSegment; version: ProductAudienceVersion }
    | { kind: "not_found" }
    | { kind: "already_archived" }
  >;
}

export interface ProductStore extends ProductStoreAccess {
  transaction<T>(work: (store: ProductStoreSession) => Promise<T>): Promise<T>;
  withReadSnapshot<T>(work: (store: ProductStoreAccess) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type LocalProductOptions = {
  projectId?: string;
  secretKey?: string;
  publishableKey?: string;
  now?: () => number;
  media?: MediaStore;
  sdkRateLimit?: { perMinute: number; perHour: number };
  managementRateLimit?: { perMinute: number; perHour: number };
  audienceUserBatchSize?: number;
  audienceEventRowBudget?: number;
};

const MANAGEMENT_BODY_BYTES = 64 * 1024;
const SDK_BODY_BYTES = 8 * 1024;
const DEFAULT_SDK_RATE_LIMIT = { perMinute: 120, perHour: 2_000 };
const DEFAULT_MANAGEMENT_RATE_LIMIT = { perMinute: 60, perHour: 1_000 };
const MAX_MERGED_TRAITS_BYTES = 64 * 1024;
export class TraitsCapacityError extends Error {}
const SDK_OPERATIONS = new Set<OperationId>(["identifyUser", "trackEvent", "getMessages", "recordDeliveryEvent"]);
const MANAGEMENT_RESOURCE_GROUP: Partial<Record<OperationId, string>> = {
  uploadCampaignMedia: "media",
  createCampaign: "campaigns",
  listCampaigns: "campaigns",
  getCampaign: "campaigns",
  updateCampaign: "campaigns",
  setCampaignStatus: "campaigns",
  listCampaignDeliveries: "campaigns",
  getCampaignEventConversions: "campaigns",
  listUsers: "users",
  getUser: "users",
  getUserSummary: "users",
  listUserEvents: "users",
  listUserDeliveries: "users",
  listEvents: "events",
  createGoal: "goals",
  listGoals: "goals",
  getGoal: "goals",
  updateGoal: "goals",
  createAgentRun: "agent-runs",
  listAgentRuns: "agent-runs",
  getAudienceCapabilities: "audiences",
  checkAudience: "audiences",
  explainAudience: "audiences",
  createSegment: "segments",
  listSegments: "segments",
  getSegment: "segments",
  updateSegment: "segments",
  archiveSegment: "segments",
  listSegmentVersions: "segments",
  getSegmentVersion: "segments",
  getUsage: "usage",
  getProjectOverview: "dashboard",
  listProjectActivity: "dashboard",
  getProjectMetrics: "dashboard",
};

function localKey(prefix: string, bytes: number) {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export function resolveProductKeys(options: Pick<LocalProductOptions, "secretKey" | "publishableKey">) {
  const secretKey = options.secretKey ?? localKey("pk_local_", 32);
  const publishableKey = options.publishableKey ?? localKey("pk_pub_local_", 24);
  if (secretKey === publishableKey) throw new Error("Secret and publishable keys must differ");
  return { secretKey, publishableKey };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function body(request: Request, maxBytes = MANAGEMENT_BODY_BYTES): Promise<BodyReadResult<JsonObject>> {
  return readJsonObject(request, maxBytes);
}

function bodyError(status: 400 | 413) {
  return json({ error: status === 413 ? "Request body is too large" : "Invalid body" }, status);
}

function bearer(request: Request) {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

const DELIVERY_STATE_PRECEDENCE: Record<ProductDelivery["state"], number> = {
  queued: 0,
  sending: 1,
  retryable: 1,
  sent: 2,
  delivered: 3,
  shown: 4,
  opened: 5,
  clicked: 6,
  dismissed: 7,
  frequency_capped: 7,
  bounced: 7,
  complained: 7,
  unsubscribed: 7,
  failed: 7,
  converted: 8,
};

function applyDeliveryFeedback(delivery: ProductDelivery, type: DeliveryFeedback, now: number) {
  delivery.shownAt ??= now;
  if (type === "clicked") delivery.clickedAt ??= now;
  if (type === "dismissed") delivery.dismissedAt ??= now;
  if (type === "converted") delivery.convertedAt ??= now;
  if (DELIVERY_STATE_PRECEDENCE[type] > DELIVERY_STATE_PRECEDENCE[delivery.state]) delivery.state = type;
}

function pageRequest(url: URL, defaultPerPage = 50): { page: number; perPage: number } | null {
  const page = Number(url.searchParams.get("page") ?? "1");
  const perPage = Number(url.searchParams.get("perPage") ?? String(defaultPerPage));
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) return null;
  return { page, perPage };
}

function searchQuery(url: URL): string | null | undefined {
  const value = url.searchParams.get("q");
  if (value === null) return null;
  if (!value || value.length > SEARCH_MAX_LENGTH) return undefined;
  return value.toLowerCase();
}

function paged<T>(values: T[], request: { page: number; perPage: number }) {
  const start = (request.page - 1) * request.perPage;
  return {
    values: values.slice(start, start + request.perPage),
    total: values.length,
    page: request.page,
    pageCount: values.length === 0 ? 0 : Math.ceil(values.length / request.perPage),
  };
}

function instant(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== "Z") {
    const [zoneHour, zoneMinute] = zone.slice(1).split(":").map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function inputInstant(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /(Z|[+-]\d{2}:\d{2})$/.test(value)) return instant(value) ?? undefined;
  return undefined;
}

function jsonCollection(value: unknown): value is JsonObject | unknown[] | null {
  return value === null || Array.isArray(value) || (typeof value === "object" && value !== null);
}

function goalView(goal: ProductGoal) {
  return {
    id: goal.id,
    name: goal.name,
    description: goal.description,
    targetEvent: goal.targetEvent,
    guardrails: goal.guardrails,
    approvalMode: goal.approvalMode,
    status: goal.status,
    createdAt: goal.createdAt,
  };
}

function userView(user: ProductUser) {
  return {
    id: user.id,
    externalUserId: user.externalId,
    traits: user.traits,
    firstSeenAt: user.firstSeenAt,
    lastSeenAt: user.lastSeenAt,
  };
}

function eventView(event: ProductEvent) {
  return {
    id: event.id,
    name: event.name,
    props: event.props,
    ts: event.occurredAt,
    endUserId: event.userId,
    externalUserId: event.externalUserId,
  };
}

function runView(run: ProductAgentRun) {
  return {
    id: run.id,
    kind: run.kind,
    goalId: run.goalId,
    campaignId: run.campaignId,
    input: run.input,
    output: run.output,
    rationale: run.rationale,
    createdAt: run.createdAt,
  };
}

function storedAudience(version: ProductAudienceVersion) {
  const prepared = prepareAudience(JSON.parse(version.expressionJson));
  if (!prepared.ok || prepared.value.hash !== version.expressionHash) {
    throw new Error(`Invalid stored audience version: ${version.id}`);
  }
  return prepared.value;
}

function segmentVersionView(version: ProductAudienceVersion) {
  const audience = storedAudience(version);
  return {
    audienceVersionId: version.id,
    version: version.segmentVersion,
    schemaVersion: version.schemaVersion,
    expressionHash: version.expressionHash,
    summary: audience.summary,
    reason: version.reason,
    agentRunId: version.agentRunId,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
  };
}

function segmentView(segment: ProductSegment, version: ProductAudienceVersion) {
  const audience = storedAudience(version);
  return {
    id: segment.id,
    key: segment.key,
    name: segment.name,
    description: segment.description,
    status: segment.status,
    currentVersion: segment.currentVersion,
    currentAudienceVersionId: version.id,
    summary: audience.summary,
    createdBy: segment.createdBy,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
  };
}

function segmentDetailView(segment: ProductSegment, version: ProductAudienceVersion) {
  const audience = storedAudience(version);
  return {
    ...segmentView(segment, version),
    schemaVersion: version.schemaVersion,
    expression: audience.expression,
    expressionHash: version.expressionHash,
    reason: version.reason,
  };
}

function campaignAudienceView(audience: ProductCampaignAudience) {
  if (audience.kind === "all") return audience;
  if (audience.kind === "invalid") return { kind: audience.kind, audienceVersionId: audience.audienceVersionId };
  const expression = JSON.parse(audience.expressionJson) as AudienceExpression;
  return {
    kind: audience.kind === "legacy" ? "expression" : audience.kind,
    audienceVersionId: audience.audienceVersionId,
    ...(audience.kind === "segment"
      ? {
          segmentId: audience.segmentId,
          segmentKey: audience.segmentKey,
          segmentVersion: audience.segmentVersion,
        }
      : {}),
    schemaVersion: audience.schemaVersion,
    expression,
    expressionHash: audience.expressionHash,
    summary: audience.summary,
    reason: audience.reason,
    ...(audience.kind === "expression" || audience.kind === "legacy" ? { legacy: audience.kind === "legacy" } : {}),
  };
}

function campaignMatches(
  campaign: ProductCampaign,
  user: ProductUser,
  events: ProductEvent[],
  evaluatedAt: number,
) {
  if (campaign.audience.kind === "all") return true;
  if (campaign.audience.kind === "invalid") return false;
  const prepared = prepareAudience(JSON.parse(campaign.audience.expressionJson));
  if (!prepared.ok || prepared.value.hash !== campaign.audience.expressionHash) return false;
  return evaluateExpression(
    prepared.value.expression.root,
    factsForUser(user, events, prepared.value.expression),
    evaluatedAt,
  );
}

function deliveryView(delivery: ProductDelivery, user: ProductUser, variant: ProductVariant) {
  return {
    id: delivery.id,
    endUserId: delivery.userId,
    externalUserId: user.externalId,
    variantId: delivery.variantId,
    variantName: variant.name,
    state: delivery.state,
    queuedAt: delivery.queuedAt,
    sentAt: delivery.sentAt,
    deliveredAt: delivery.deliveredAt,
    shownAt: delivery.shownAt,
    openedAt: delivery.openedAt,
    clickedAt: delivery.clickedAt,
    dismissedAt: delivery.dismissedAt,
    bouncedAt: delivery.bouncedAt,
    complainedAt: delivery.complainedAt,
    unsubscribedAt: delivery.unsubscribedAt,
    convertedAt: delivery.convertedAt,
  };
}

function emptyConversionCounts(): ConversionCounts {
  return { exposedDeliveries: 0, exposedUsers: 0, convertedDeliveries: 0, convertedUsers: 0 };
}

function deliveryStats(rows: ProductDelivery[]): DeliveryStats {
  return {
    sent: rows.filter((delivery) => delivery.sentAt !== null).length,
    frequencyCapped: rows.filter((delivery) => delivery.state === "frequency_capped").length,
    delivered: rows.filter((delivery) => delivery.deliveredAt !== null).length,
    shown: rows.filter((delivery) => delivery.shownAt !== null).length,
    opened: rows.filter((delivery) => delivery.openedAt !== null).length,
    clicked: rows.filter((delivery) => delivery.clickedAt !== null).length,
    dismissed: rows.filter((delivery) => delivery.dismissedAt !== null).length,
    bounced: rows.filter((delivery) => delivery.bouncedAt !== null).length,
    complained: rows.filter((delivery) => delivery.complainedAt !== null).length,
    unsubscribed: rows.filter((delivery) => delivery.unsubscribedAt !== null).length,
    converted: rows.filter((delivery) => delivery.convertedAt !== null).length,
  };
}

function emptyDeliveryStats(): DeliveryStats {
  return deliveryStats([]);
}

function retainOrdered<T>(values: T[], value: T, limit: number, compare: (left: T, right: T) => number) {
  values.push(value);
  values.sort(compare);
  if (values.length > limit) values.pop();
}

function countDelivery(stats: DeliveryStats, delivery: ProductDelivery) {
  if (delivery.sentAt !== null) stats.sent += 1;
  if (delivery.state === "frequency_capped") stats.frequencyCapped += 1;
  if (delivery.deliveredAt !== null) stats.delivered += 1;
  if (delivery.shownAt !== null) stats.shown += 1;
  if (delivery.openedAt !== null) stats.opened += 1;
  if (delivery.clickedAt !== null) stats.clicked += 1;
  if (delivery.dismissedAt !== null) stats.dismissed += 1;
  if (delivery.bouncedAt !== null) stats.bounced += 1;
  if (delivery.complainedAt !== null) stats.complained += 1;
  if (delivery.unsubscribedAt !== null) stats.unsubscribed += 1;
  if (delivery.convertedAt !== null) stats.converted += 1;
}

export type CampaignEffectiveStatus = "draft" | "scheduled" | "running" | "paused" | "expired" | "ended";
type CampaignAction = "launch" | "pause" | "end";

function effectiveStatus(campaign: ProductCampaign, now: number): CampaignEffectiveStatus {
  if ((campaign.status === "running" || campaign.status === "paused") && campaign.deliverUntil !== null && campaign.deliverUntil <= now) return "expired";
  if (campaign.status === "running" && campaign.deliverFrom !== null && campaign.deliverFrom > now) return "scheduled";
  return campaign.status;
}

const CAMPAIGN_TRANSITIONS: Record<CampaignEffectiveStatus, Partial<Record<CampaignAction, ProductCampaign["status"]>>> = {
  draft: { launch: "running", end: "ended" },
  scheduled: { pause: "paused", end: "ended" },
  running: { pause: "paused", end: "ended" },
  paused: { launch: "running", end: "ended" },
  expired: { end: "ended" },
  ended: {},
};

function transitionCampaign(campaign: ProductCampaign, action: CampaignAction, transitionedAt: number) {
  const status = CAMPAIGN_TRANSITIONS[effectiveStatus(campaign, transitionedAt)][action];
  if (!status) return null;
  return {
    ...campaign,
    status,
    startedAt: action === "launch" ? campaign.startedAt ?? transitionedAt : campaign.startedAt,
    endedAt: action === "end" ? transitionedAt : campaign.endedAt,
  };
}

const deliveryStates = new Set<ProductDelivery["state"]>([
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
]);

const SEGMENT_KEY = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

async function parseMessage(
  value: unknown,
  media: MediaStore,
  projectId: string,
): Promise<{ ok: true; content: JsonObject } | { ok: false; status: 400 | 503; error: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, status: 400, error: "Invalid message" };
  const message = value as JsonObject;
  let normalizedMedia: JsonObject | undefined;
  const title = message.title;
  const text = message.body;
  if ((typeof title !== "string" || title.length === 0) && (typeof text !== "string" || text.length === 0)) {
    return { ok: false, status: 400, error: "Message needs a title or body" };
  }
  if (title !== undefined && (typeof title !== "string" || title.length > 120)) return { ok: false, status: 400, error: "Invalid title" };
  if (text !== undefined && (typeof text !== "string" || text.length > 600)) return { ok: false, status: 400, error: "Invalid body" };
  if (message.presentation !== "toast" && message.presentation !== "modal") return { ok: false, status: 400, error: "Invalid presentation" };
  if (message.cta !== undefined) {
    if (!message.cta || typeof message.cta !== "object" || Array.isArray(message.cta)) return { ok: false, status: 400, error: "Invalid CTA" };
    const cta = message.cta as JsonObject;
    if (typeof cta.label !== "string" || !cta.label) return { ok: false, status: 400, error: "CTA label is required" };
    if (cta.url !== undefined && (typeof cta.url !== "string" || !validCtaUrl(cta.url))) return { ok: false, status: 400, error: "Invalid CTA URL" };
  }
  if (message.media !== undefined) {
    if (!message.media || typeof message.media !== "object" || Array.isArray(message.media)) return { ok: false, status: 400, error: "Invalid media" };
    const object = message.media as JsonObject;
    const reference = typeof object.url === "string" ? media.resolve(projectId, object.url) : null;
    if (!reference) return { ok: false, status: 400, error: "Media URL is not owned by this project" };
    let stored;
    try {
      stored = await media.get(reference.key);
    } catch {
      return { ok: false, status: 503, error: "Media could not be verified" };
    }
    if (!stored) return { ok: false, status: 400, error: "Media URL is not owned by this project" };
    if (object.alt !== undefined && (typeof object.alt !== "string" || object.alt.length === 0 || object.alt.length > 300)) return { ok: false, status: 400, error: "Invalid media alt text" };
    if (object.decorative !== undefined && typeof object.decorative !== "boolean") return { ok: false, status: 400, error: "Invalid decorative value" };
    const hasAlt = typeof object.alt === "string" && object.alt.length > 0 && object.alt.length <= 300;
    const decorative = object.decorative === true;
    if (hasAlt === decorative) return { ok: false, status: 400, error: "Media requires alt text or decorative true" };
    normalizedMedia = { ...object, url: reference.path };
  }
  return { ok: true, content: deliveredContent(normalizedMedia ? { ...message, media: normalizedMedia } : message) as JsonObject };
}

function publicMessageContent(value: unknown, media: MediaStore, projectId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const content = value as JsonObject;
  if (!content.media || typeof content.media !== "object" || Array.isArray(content.media)) return content;
  const object = content.media as JsonObject;
  const reference = typeof object.url === "string" ? media.resolve(projectId, object.url) : null;
  if (!reference) {
    const safe = { ...content };
    delete safe.media;
    return safe;
  }
  return { ...content, media: { ...object, url: media.publicUrl(reference.path) } };
}

function validCtaUrl(value: string) {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (value.startsWith("mailto:")) return value.length > "mailto:".length;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createProduct(store: ProductStore, options: LocalProductOptions = {}) {
  const projectId = options.projectId ?? "local";
  const { secretKey, publishableKey } = resolveProductKeys(options);
  const now = options.now ?? Date.now;
  const media = options.media ?? new MemoryMediaStore();
  const sdkRateLimit = options.sdkRateLimit ?? DEFAULT_SDK_RATE_LIMIT;
  const managementRateLimit = options.managementRateLimit ?? DEFAULT_MANAGEMENT_RATE_LIMIT;
  const audienceUserBatchSize = options.audienceUserBatchSize ?? 200;
  const audienceEventRowBudget = options.audienceEventRowBudget ?? 5_000;
  const requireKey = (request: Request, expected: string) => bearer(request) === expected;
  const rateLimitRequests = new Map<string, number[]>();
  const checkRateLimit = (bucket: string, limit: { perMinute: number; perHour: number }) => {
    const timestamp = now();
    const recent = (rateLimitRequests.get(bucket) ?? []).filter((value) => value > timestamp - 3_600_000);
    const perMinute = recent.filter((value) => value > timestamp - 60_000);
    const minuteRetry = perMinute.length >= limit.perMinute ? perMinute[perMinute.length - limit.perMinute] + 60_000 - timestamp : 0;
    const hourRetry = recent.length >= limit.perHour ? recent[recent.length - limit.perHour] + 3_600_000 - timestamp : 0;
    const retryAfter = Math.max(minuteRetry, hourRetry);
    if (retryAfter > 0) return { allowed: false as const, retryAfter: Math.max(1, Math.ceil(retryAfter / 1_000)) };
    recent.push(timestamp);
    rateLimitRequests.set(bucket, recent);
    return { allowed: true as const };
  };
  const campaignView = (campaign: ProductCampaign, stats: CampaignStats | undefined, evaluatedAt: number) => {
    const campaignStats = stats?.total ?? emptyDeliveryStats();
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      effectiveStatus: effectiveStatus(campaign, evaluatedAt),
      channel: campaign.channel,
      goalId: campaign.goalId,
      createdBy: "api",
      createdAt: campaign.createdAt,
      startedAt: campaign.startedAt,
      endedAt: campaign.endedAt,
      deliverFrom: campaign.deliverFrom,
      deliverUntil: campaign.deliverUntil,
      audience: campaignAudienceView(campaign.audience),
      targeting: campaign.audience.kind === "legacy" ? JSON.parse(campaign.audience.targetingJson) : null,
      pages: campaign.pages,
      stats: campaignStats,
      variants: campaign.variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        weight: variant.weight,
        isControl: variant.isControl,
        content: publicMessageContent(JSON.parse(variant.content_json), media, projectId),
        stats: stats?.variants.get(variant.id) ?? emptyDeliveryStats(),
      })),
    };
  };
  type ParsedCampaignAudience =
    | { kind: "unchanged" }
    | { kind: "resolved"; audience: ProductCampaignAudience }
    | { kind: "segment"; idOrKey: string; version: number | undefined };
  const parseCampaignAudience = (input: JsonObject, defaultToAll: boolean) => {
    if (input.audience !== undefined && input.targeting !== undefined) {
      return { ok: false as const, status: 400, error: "audience and targeting are mutually exclusive" };
    }
    if (input.targeting !== undefined && input.targeting !== null) {
      const validated = validateTargeting(JSON.stringify(input.targeting));
      if (!validated.ok) return { ok: false as const, status: 400, error: validated.error };
      const expression = legacyTargetingToExpression(validated.targeting);
      if (!expression) return { ok: true as const, value: { kind: "resolved", audience: { kind: "all" } } satisfies ParsedCampaignAudience };
      const prepared = prepareAudience(expression);
      if (!prepared.ok) return { ok: false as const, status: 400, error: "Invalid targeting" };
      return {
        ok: true as const,
        value: {
          kind: "resolved",
          audience: {
            kind: "expression",
            audienceVersionId: `aud_${randomUUID()}`,
            schemaVersion: prepared.value.expression.version,
            expressionJson: JSON.stringify(prepared.value.expression),
            expressionHash: prepared.value.hash,
            summary: prepared.value.summary,
            reason: "Imported from deprecated targeting",
          },
        } satisfies ParsedCampaignAudience,
      };
    }
    if (input.audience === undefined || input.audience === null) {
      return {
        ok: true as const,
        value: input.audience === null || input.targeting === null || defaultToAll
          ? { kind: "resolved", audience: { kind: "all" } } satisfies ParsedCampaignAudience
          : { kind: "unchanged" } satisfies ParsedCampaignAudience,
      };
    }
    if (typeof input.audience !== "object" || Array.isArray(input.audience)) {
      return { ok: false as const, status: 400, error: "Invalid audience" };
    }
    const audienceInput = input.audience as JsonObject;
    if (audienceInput.kind === "all") {
      return { ok: true as const, value: { kind: "resolved", audience: { kind: "all" } } satisfies ParsedCampaignAudience };
    }
    if (audienceInput.kind === "expression") {
      if (audienceInput.reason !== undefined && (typeof audienceInput.reason !== "string" || audienceInput.reason.length > 500)) {
        return { ok: false as const, status: 400, error: "Invalid audience reason" };
      }
      const prepared = prepareAudience(audienceInput.expression);
      if (!prepared.ok) return { ok: false as const, status: 400, error: "Invalid audience expression" };
      return {
        ok: true as const,
        value: {
          kind: "resolved",
          audience: {
            kind: "expression",
            audienceVersionId: `aud_${randomUUID()}`,
            schemaVersion: prepared.value.expression.version,
            expressionJson: JSON.stringify(prepared.value.expression),
            expressionHash: prepared.value.hash,
            summary: prepared.value.summary,
            reason: typeof audienceInput.reason === "string" ? audienceInput.reason : null,
          },
        } satisfies ParsedCampaignAudience,
      };
    }
    if (audienceInput.kind === "segment" && typeof audienceInput.segment === "string" && audienceInput.segment) {
      if (audienceInput.reason !== undefined) return { ok: false as const, status: 400, error: "Segment audiences cannot set reason" };
      if (audienceInput.version !== undefined && (!Number.isSafeInteger(audienceInput.version) || (audienceInput.version as number) < 1)) {
        return { ok: false as const, status: 400, error: "Invalid segment version" };
      }
      return { ok: true as const, value: { kind: "segment", idOrKey: audienceInput.segment, version: audienceInput.version as number | undefined } satisfies ParsedCampaignAudience };
    }
    return { ok: false as const, status: 400, error: "Invalid audience" };
  };
  const resolveCampaignAudience = async (input: ParsedCampaignAudience, transaction: ProductStoreSession) => {
    if (input.kind === "unchanged") return { ok: true as const, audience: null };
    if (input.kind === "resolved") return { ok: true as const, audience: input.audience };
    const segment = await transaction.getSegmentForUpdate(input.idOrKey);
    if (!segment) return { ok: false as const, status: 404, error: "Segment not found" };
    if (segment.status === "archived") return { ok: false as const, status: 409, error: "Segment is archived" };
    const versionNumber = input.version ?? segment.currentVersion;
    const version = await transaction.getSegmentVersion(segment.id, versionNumber);
    if (!version) return { ok: false as const, status: 404, error: "Segment version not found" };
    const prepared = storedAudience(version);
    return {
      ok: true as const,
      audience: {
        kind: "segment",
        audienceVersionId: version.id,
        segmentId: segment.id,
        segmentKey: segment.key,
        segmentVersion: version.segmentVersion,
        schemaVersion: version.schemaVersion,
        expressionJson: version.expressionJson,
        expressionHash: version.expressionHash,
        summary: prepared.summary,
        reason: version.reason,
      } satisfies ProductCampaignAudience,
    };
  };
  type ParsedVariantPatch = {
    id: string | null;
    name: string | undefined;
    content: JsonObject | undefined;
    weight: number | undefined;
    isControl: boolean | undefined;
  };
  const variantError = (error: string, status: 400 | 503 = 400) => ({ ok: false as const, status, error });
  const parseVariantPatches = async (value: unknown) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) return variantError("Invalid variants");
    const patches: ParsedVariantPatch[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return variantError("Invalid variant");
      const patch = raw as JsonObject;
      if (patch.id !== undefined && (typeof patch.id !== "string" || !patch.id)) return variantError("Invalid variant id");
      if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name || patch.name.length > 40)) return variantError("Invalid variant name");
      if (patch.weight !== undefined && (!Number.isInteger(patch.weight) || (patch.weight as number) < 0 || (patch.weight as number) > 100)) return variantError("Invalid variant weight");
      if (patch.isControl !== undefined && typeof patch.isControl !== "boolean") return variantError("Invalid control value");
      if (patch.id === undefined && patch.message === undefined) return variantError("New variants require message");
      const message = patch.message === undefined ? undefined : await parseMessage(patch.message, media, projectId);
      if (message && !message.ok) return variantError(message.error, message.status);
      patches.push({
        id: typeof patch.id === "string" ? patch.id : null,
        name: typeof patch.name === "string" ? patch.name : undefined,
        content: message?.ok ? message.content : undefined,
        weight: typeof patch.weight === "number" ? patch.weight : undefined,
        isControl: typeof patch.isControl === "boolean" ? patch.isControl : undefined,
      });
    }
    return { ok: true as const, patches };
  };
  const applyVariantPatches = (campaign: ProductCampaign, patches: ParsedVariantPatch[]) => {
    for (const patch of patches) {
      const existing = patch.id === null ? null : campaign.variants.find((candidate) => candidate.id === patch.id);
      if (patch.id !== null && !existing) return { ok: false as const, error: "Variant not found" };
      if (!existing) {
        campaign.variants.push({
          id: `var_${randomUUID()}`,
          campaign_id: campaign.id,
          name: patch.name ?? `Variant ${campaign.variants.length + 1}`,
          content_json: JSON.stringify(patch.content),
          weight: patch.weight ?? 1,
          isControl: patch.isControl ?? false,
        });
        continue;
      }
      if (patch.name !== undefined) existing.name = patch.name;
      if (patch.content !== undefined) existing.content_json = JSON.stringify(patch.content);
      if (patch.weight !== undefined) existing.weight = patch.weight;
      if (patch.isControl !== undefined) existing.isControl = patch.isControl;
    }
    if (campaign.variants.length > 10) return { ok: false as const, error: "Invalid variants" };
    if (!campaign.variants.some((variant) => variant.weight > 0) || campaign.variants.filter((variant) => variant.isControl).length > 1) {
      return { ok: false as const, error: "Invalid variant allocation" };
    }
    return { ok: true as const };
  };
  const loadFactsWithinBudget = async (
    snapshot: ProductStoreAccess,
    input: Omit<AudienceFactsInput, "limit">,
    initialLimit: number,
  ): Promise<{ ok: true; batch: AudienceFactsBatch } | { ok: false }> => {
    let limit = initialLimit;
    while (limit >= 1) {
      const batch = await snapshot.loadAudienceFacts({ ...input, limit });
      if (!batch.overflow) return { ok: true, batch };
      if (limit === 1) return { ok: false };
      limit = Math.max(1, Math.floor(limit / 2));
    }
    return { ok: false };
  };
  const capacityResponse = () => json({ error: "Audience facts exceed local evaluation capacity" }, 503);

  const rawHandlers: OperationHandlers = {
    uploadCampaignMedia: createUploadCampaignMediaHandler({ projectId, secretKey, media }),

    async identifyUser(request) {
      if (!requireKey(request, publishableKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request, SDK_BODY_BYTES);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.userId !== "string" || !input.userId || input.userId.length > 256) return json({ error: "userId is required" }, 400);
      const userId = input.userId;
      if (input.traits !== undefined && (!input.traits || typeof input.traits !== "object" || Array.isArray(input.traits))) return json({ error: "Invalid traits" }, 400);
      const traits = input.traits === undefined ? {} : input.traits as JsonObject;
      if (Buffer.byteLength(JSON.stringify(traits)) > 4096) return json({ error: "Invalid traits" }, 400);
      try {
        await store.transaction((transaction) => transaction.identifyUser(userId, traits, now()));
      } catch (error) {
        if (error instanceof TraitsCapacityError) return json({ error: "Merged traits are too large" }, 413);
        throw error;
      }
      return json({ ok: true });
    },

    async trackEvent(request) {
      if (!requireKey(request, publishableKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request, SDK_BODY_BYTES);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.userId !== "string" || !input.userId || input.userId.length > 256 || typeof input.event !== "string" || !input.event || input.event.length > 80) return json({ error: "userId and event are required" }, 400);
      const userId = input.userId;
      const eventName = input.event;
      const props = input.props && typeof input.props === "object" && !Array.isArray(input.props) ? input.props as JsonObject : null;
      if (input.props !== undefined && props === null) return json({ error: "Invalid props" }, 400);
      if (Buffer.byteLength(JSON.stringify(props)) > 4096) return json({ error: "Invalid props" }, 400);
      const occurredAt = now();
      await store.transaction(async (transaction) => {
        const user = await transaction.identifyUser(userId, {}, occurredAt);
        await transaction.insertEvent({ id: `evt_${randomUUID()}`, userId: user.id, externalUserId: user.externalId, name: eventName, props, occurredAt });
        const candidates = await transaction.listConversionCandidatesForUpdate(user.id, eventName, occurredAt);
        for (const delivery of candidates) {
          delivery.state = "converted";
          delivery.convertedAt = occurredAt;
          await transaction.saveDelivery(delivery);
        }
      });
      return json({ ok: true });
    },

    async createGoal(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.name !== "string" || !input.name || input.name.length > 80) return json({ error: "name is required" }, 400);
      if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.length > 1000)) return json({ error: "Invalid description" }, 400);
      if (input.targetEvent !== undefined && input.targetEvent !== null && (typeof input.targetEvent !== "string" || !input.targetEvent || input.targetEvent.length > 80)) return json({ error: "Invalid targetEvent" }, 400);
      if (input.guardrails !== undefined && input.guardrails !== null && (typeof input.guardrails !== "object" || Array.isArray(input.guardrails))) return json({ error: "Invalid guardrails" }, 400);
      if (Buffer.byteLength(JSON.stringify(input.guardrails ?? null)) > 4096) return json({ error: "guardrails is too large" }, 413);
      if (input.approvalMode !== undefined && input.approvalMode !== "require_human" && input.approvalMode !== "auto") return json({ error: "Invalid approvalMode" }, 400);
      const goal: ProductGoal = {
        id: `goal_${randomUUID()}`,
        name: input.name,
        description: typeof input.description === "string" ? input.description : null,
        targetEvent: typeof input.targetEvent === "string" ? input.targetEvent : null,
        guardrails: input.guardrails && typeof input.guardrails === "object" && !Array.isArray(input.guardrails) ? input.guardrails as JsonObject : null,
        approvalMode: input.approvalMode === "auto" ? "auto" : "require_human",
        status: "active",
        createdAt: now(),
      };
      await store.createGoal(goal);
      return json({ goal: goalView(goal) }, 201);
    },

    async listGoals(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      return json({ goals: (await store.queryGoals(100)).map(goalView) });
    },

    async getGoal(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const goal = await store.getGoal(params.id);
      return goal ? json({ goal: goalView(goal) }) : json({ error: "Goal not found" }, 404);
    },

    async updateGoal(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (input.name !== undefined && (typeof input.name !== "string" || !input.name || input.name.length > 80)) return json({ error: "Invalid name" }, 400);
      if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.length > 1000)) return json({ error: "Invalid description" }, 400);
      if (input.targetEvent !== undefined && input.targetEvent !== null && (typeof input.targetEvent !== "string" || !input.targetEvent || input.targetEvent.length > 80)) return json({ error: "Invalid targetEvent" }, 400);
      if (input.guardrails !== undefined && input.guardrails !== null && (typeof input.guardrails !== "object" || Array.isArray(input.guardrails))) return json({ error: "Invalid guardrails" }, 400);
      if (input.guardrails !== undefined && Buffer.byteLength(JSON.stringify(input.guardrails)) > 4096) return json({ error: "guardrails is too large" }, 413);
      if (input.approvalMode !== undefined && input.approvalMode !== "require_human" && input.approvalMode !== "auto") return json({ error: "Invalid approvalMode" }, 400);
      if (input.status !== undefined && input.status !== "active" && input.status !== "archived") return json({ error: "Invalid status" }, 400);
      const goal = await store.transaction(async (transaction) => {
        const current = await transaction.getGoalForUpdate(params.id);
        if (!current) return null;
        if (typeof input.name === "string") current.name = input.name;
        if (input.description !== undefined) current.description = input.description as string | null;
        if (input.targetEvent !== undefined) current.targetEvent = input.targetEvent as string | null;
        if (input.guardrails !== undefined) current.guardrails = input.guardrails as JsonObject | null;
        if (input.approvalMode === "require_human" || input.approvalMode === "auto") current.approvalMode = input.approvalMode;
        if (input.status === "active" || input.status === "archived") current.status = input.status;
        await transaction.saveGoal(current);
        return current;
      });
      return goal ? json({ goal: goalView(goal) }) : json({ error: "Goal not found" }, 404);
    },

    async listAgentRuns(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const pagination = pageRequest(url);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const kind = url.searchParams.get("kind");
      const goalId = url.searchParams.get("goalId");
      const campaignId = url.searchParams.get("campaignId");
      const include = url.searchParams.get("include");
      if (include !== null && !AGENT_RUN_INCLUDES.includes(include as AgentRunInclude)) return json({ error: "Invalid include" }, 400);
      const page = await store.queryAgentRuns({
        kind,
        goalId,
        campaignId,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      });
      const references = include === null ? null : await store.agentRunReferences(
        [...new Set(page.values.map((run) => run.goalId).filter((value) => value !== null))],
        [...new Set(page.values.map((run) => run.campaignId).filter((value) => value !== null))],
      );
      return json({
        runs: page.values.map(runView),
        total: page.total,
        page: pagination.page,
        pageCount: pageCountFor(page.total, pagination.perPage),
        ...(references ? { references } : {}),
      });
    },

    async createAgentRun(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.kind !== "string" || !input.kind || input.kind.length > 64) return json({ error: "kind is required" }, 400);
      const runInput = input.input === undefined ? null : input.input;
      const runOutput = input.output === undefined ? null : input.output;
      if (!jsonCollection(runInput) || !jsonCollection(runOutput)) return json({ error: "input and output must be JSON collections" }, 400);
      if (Buffer.byteLength(JSON.stringify(runInput)) > 16_384 || Buffer.byteLength(JSON.stringify(runOutput)) > 16_384) return json({ error: "input or output is too large" }, 413);
      if (input.rationale !== undefined && input.rationale !== null && (typeof input.rationale !== "string" || input.rationale.length > 4000)) return json({ error: "Invalid rationale" }, 400);
      if (input.goalId !== undefined && input.goalId !== null && (typeof input.goalId !== "string" || !input.goalId)) return json({ error: "Invalid goalId" }, 400);
      if (input.campaignId !== undefined && input.campaignId !== null && (typeof input.campaignId !== "string" || !input.campaignId)) return json({ error: "Invalid campaignId" }, 400);
      if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 128)) return json({ error: "Invalid idempotencyKey" }, 400);
      const goalId = typeof input.goalId === "string" ? input.goalId : null;
      const campaignId = typeof input.campaignId === "string" ? input.campaignId : null;
      if ((goalId && !await store.getGoal(goalId)) || (campaignId && !await store.getCampaign(campaignId))) return json({ error: "Referenced goal or campaign not found" }, 400);
      const result = await store.getOrCreateAgentRun({
        id: `run_${randomUUID()}`,
        kind: input.kind,
        goalId,
        campaignId,
        input: runInput,
        output: runOutput,
        rationale: typeof input.rationale === "string" ? input.rationale : null,
        idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : null,
        createdAt: now(),
      });
      return json({ run: runView(result.run) }, result.created ? 201 : 200);
    },

    async getAudienceCapabilities(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      return store.withReadSnapshot(async (snapshot) => json({ capabilities: await snapshot.audienceCapabilities() }));
    },

    async checkAudience(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if ((input.expression === undefined) === (input.segment === undefined)) {
        return json({ error: "Provide exactly one of expression or segment" }, 400);
      }
      const sampleLimit = input.sampleLimit === undefined ? 10 : input.sampleLimit;
      if (!Number.isSafeInteger(sampleLimit) || (sampleLimit as number) < 0 || (sampleLimit as number) > 25) {
        return json({ error: "sampleLimit must be an integer from 0 to 25" }, 400);
      }
      const sampleLimitValue = sampleLimit as number;
      if (input.expression !== undefined && input.version !== undefined) return json({ error: "version requires segment" }, 400);
      if (input.expression === undefined && (typeof input.segment !== "string" || !input.segment)) return json({ error: "Invalid segment" }, 400);
      return store.withReadSnapshot(async (snapshot) => {
        let prepared;
        let segmentContext: { id: string; key: string; version: number } | undefined;
        if (input.expression !== undefined) prepared = prepareAudience(input.expression);
        else {
          const segment = await snapshot.getSegment(input.segment as string);
          const versionNumber = input.version === undefined ? segment?.currentVersion : input.version;
          if (!segment || !Number.isSafeInteger(versionNumber) || (versionNumber as number) < 1) return json({ error: "Segment not found" }, 404);
          const version = await snapshot.getSegmentVersion(segment.id, versionNumber as number);
          if (!version) return json({ error: "Segment version not found" }, 404);
          prepared = { ok: true as const, value: storedAudience(version) };
          segmentContext = { id: segment.id, key: segment.key, version: version.segmentVersion };
        }
        if (!prepared.ok) return json({ error: "Invalid audience expression", diagnostics: prepared.diagnostics }, 400);
        const evaluatedAt = now();
        const vocabulary = referencedVocabulary(prepared.value.expression.root);
        let cursor: string | null = null;
        let totalUsers = 0;
        let matchedCount = 0;
        const samples: Array<{ id: string; value: JsonObject; lastSeenAt: number }> = [];
        while (true) {
          const loaded = await loadFactsWithinBudget(snapshot, {
            afterUserId: cursor,
            traitKeys: [...vocabulary.traits], eventNames: [...vocabulary.events], evaluatedAt,
            maxOccurrences: LIMITS.maxEvaluatedEventOccurrences, eventRowBudget: audienceEventRowBudget,
          }, audienceUserBatchSize);
          if (!loaded.ok) return capacityResponse();
          for (const user of loaded.batch.users) {
            totalUsers += 1;
            const facts = factsForUser(user, loaded.batch.eventsByUser.get(user.id) ?? [], prepared.value.expression);
            if (!evaluateExpression(prepared.value.expression.root, facts, evaluatedAt)) continue;
            matchedCount += 1;
            const value = {
              externalUserId: user.externalId, firstSeenAt: user.firstSeenAt, lastSeenAt: user.lastSeenAt,
              traits: user.traits,
              events: Object.fromEntries([...vocabulary.events].map((name) => [name, facts.events.filter((event) => event.name === name).length])),
            };
            samples.push({ id: user.id, value, lastSeenAt: user.lastSeenAt });
            samples.sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id));
            if (samples.length > sampleLimitValue) samples.pop();
          }
          cursor = loaded.batch.nextCursor;
          if (cursor === null) break;
        }
        const presence = await snapshot.audiencePresence({ traitKeys: [...vocabulary.traits], eventNames: [...vocabulary.events] });
        return json({
          expression: prepared.value.expression, expressionHash: prepared.value.hash, summary: prepared.value.summary,
          diagnostics: [...prepared.value.diagnostics, ...audienceDiagnosticsFromPresence(prepared.value.expression.root, presence, matchedCount)],
          evaluatedAt, countType: "exact", matchedCount, totalUsers, samples: samples.map((sample) => sample.value),
          ...(segmentContext ? { segment: segmentContext } : {}),
        });
      });
    },

    async explainAudience(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if ((input.expression === undefined) === (input.segment === undefined)) {
        return json({ error: "Provide exactly one of expression or segment" }, 400);
      }
      if (typeof input.userId !== "string" || !input.userId) {
        return json({ error: "userId is required" }, 400);
      }
      const requestedUserId = input.userId;
      if (input.expression !== undefined && input.version !== undefined) return json({ error: "version requires segment" }, 400);
      if (input.expression === undefined && (typeof input.segment !== "string" || !input.segment)) return json({ error: "Invalid segment" }, 400);
      return store.withReadSnapshot(async (snapshot) => {
        let prepared;
        let segmentContext: { id: string; key: string; version: number } | undefined;
        if (input.expression !== undefined) prepared = prepareAudience(input.expression);
        else {
          const segment = await snapshot.getSegment(input.segment as string);
          const versionNumber = input.version === undefined ? segment?.currentVersion : input.version;
          if (!segment || !Number.isSafeInteger(versionNumber) || (versionNumber as number) < 1) return json({ error: "Segment not found" }, 404);
          const version = await snapshot.getSegmentVersion(segment.id, versionNumber as number);
          if (!version) return json({ error: "Segment version not found" }, 404);
          prepared = { ok: true as const, value: storedAudience(version) };
          segmentContext = { id: segment.id, key: segment.key, version: version.segmentVersion };
        }
        if (!prepared.ok) return json({ error: "Invalid audience expression", diagnostics: prepared.diagnostics }, 400);
        const user = await snapshot.getUserById(requestedUserId) ?? await snapshot.getUserByExternalId(requestedUserId);
        if (!user) return json({ error: "User not found" }, 404);
        const evaluatedAt = now();
        const vocabulary = referencedVocabulary(prepared.value.expression.root);
        const loaded = await loadFactsWithinBudget(snapshot, {
          afterUserId: null, userId: user.id, traitKeys: [...vocabulary.traits], eventNames: [...vocabulary.events], evaluatedAt,
          maxOccurrences: LIMITS.maxEvaluatedEventOccurrences, eventRowBudget: audienceEventRowBudget,
        }, 1);
        if (!loaded.ok) return capacityResponse();
        return json({
          ...explainPreparedAudience(prepared.value, loaded.batch.users[0], loaded.batch.eventsByUser.get(user.id) ?? [], evaluatedAt),
          ...(segmentContext ? { segment: segmentContext } : {}),
        });
      });
    },

    async createSegment(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.key !== "string" || input.key.length > 64 || !SEGMENT_KEY.test(input.key) || input.key.startsWith("seg_")) {
        return json({ error: "Invalid segment key" }, 400);
      }
      if (typeof input.name !== "string" || !input.name || input.name.length > 80) {
        return json({ error: "Invalid segment name" }, 400);
      }
      if (input.description !== undefined && input.description !== null && (typeof input.description !== "string" || input.description.length > 1000)) {
        return json({ error: "Invalid description" }, 400);
      }
      if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500)) {
        return json({ error: "Invalid reason" }, 400);
      }
      if (input.agentRunId !== undefined && input.agentRunId !== null && (typeof input.agentRunId !== "string" || !input.agentRunId)) {
        return json({ error: "Invalid agentRunId" }, 400);
      }
      if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || !input.idempotencyKey || input.idempotencyKey.length > 128)) {
        return json({ error: "Invalid idempotencyKey" }, 400);
      }
      const prepared = prepareAudience(input.expression);
      if (!prepared.ok) {
        return json({ error: "Invalid audience expression", diagnostics: prepared.diagnostics }, 400);
      }
      const agentRunId = typeof input.agentRunId === "string" ? input.agentRunId : null;
      if (agentRunId && !await store.getAgentRun(agentRunId)) {
        return json({ error: "Agent run not found" }, 400);
      }
      const createdAt = now();
      const segment: ProductSegment = {
        id: `seg_${randomUUID()}`,
        key: input.key,
        name: input.name,
        description: typeof input.description === "string" ? input.description : null,
        status: "active",
        currentVersion: 1,
        idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : null,
        createdBy: "api",
        createdAt,
        updatedAt: createdAt,
      };
      const version: ProductAudienceVersion = {
        id: `aud_${randomUUID()}`,
        segmentId: segment.id,
        segmentVersion: 1,
        schemaVersion: prepared.value.expression.version,
        expressionJson: JSON.stringify(prepared.value.expression),
        expressionHash: prepared.value.hash,
        reason: typeof input.reason === "string" ? input.reason : null,
        agentRunId,
        createdBy: "api",
        createdAt,
      };
      const result = await store.transaction((transaction) => transaction.createSegment(segment, version));
      if (result.kind === "key_conflict") return json({ error: "Segment key already exists" }, 409);
      return json({ segment: segmentDetailView(result.segment, result.version) }, result.kind === "created" ? 201 : 200);
    },

    async listSegments(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const status = new URL(request.url).searchParams.get("status");
      if (status !== null && status !== "active" && status !== "archived") {
        return json({ error: "Invalid status" }, 400);
      }
      const segments = await store.querySegments(status, 100);
      const views = await Promise.all(segments.map(async (segment) => {
        const version = await store.getSegmentVersion(segment.id, segment.currentVersion);
        if (!version) throw new Error(`Missing current audience version for segment: ${segment.id}`);
        return segmentView(segment, version);
      }));
      return json({ segments: views });
    },

    async getSegment(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const segment = await store.getSegment(params.id);
      if (!segment) return json({ error: "Segment not found" }, 404);
      const version = await store.getSegmentVersion(segment.id, segment.currentVersion);
      if (!version) throw new Error(`Missing current audience version for segment: ${segment.id}`);
      return json({ segment: segmentDetailView(segment, version) });
    },

    async updateSegment(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      const hasName = input.name !== undefined;
      const hasDescription = input.description !== undefined;
      const hasExpression = input.expression !== undefined;
      if (!hasName && !hasDescription && !hasExpression) return json({ error: "No segment changes provided" }, 400);
      if (hasName && (typeof input.name !== "string" || !input.name || input.name.length > 80)) {
        return json({ error: "Invalid segment name" }, 400);
      }
      if (hasDescription && input.description !== null && (typeof input.description !== "string" || input.description.length > 1000)) {
        return json({ error: "Invalid description" }, 400);
      }
      if (hasExpression) {
        if (!Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
          return json({ error: "expectedVersion is required with expression" }, 400);
        }
        if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 500)) {
          return json({ error: "Invalid reason" }, 400);
        }
        if (input.agentRunId !== undefined && input.agentRunId !== null && (typeof input.agentRunId !== "string" || !input.agentRunId)) {
          return json({ error: "Invalid agentRunId" }, 400);
        }
      } else if (input.expectedVersion !== undefined || input.reason !== undefined || input.agentRunId !== undefined) {
        return json({ error: "Version fields require expression" }, 400);
      }
      const prepared = hasExpression ? prepareAudience(input.expression) : null;
      if (prepared && !prepared.ok) {
        return json({ error: "Invalid audience expression", diagnostics: prepared.diagnostics }, 400);
      }
      const agentRunId = hasExpression && typeof input.agentRunId === "string" ? input.agentRunId : null;
      if (agentRunId && !await store.getAgentRun(agentRunId)) {
        return json({ error: "Agent run not found" }, 400);
      }
      const updatedAt = now();
      const result = await store.transaction((transaction) => transaction.reviseSegment(params.id, {
        ...(hasName ? { name: input.name as string } : {}),
        ...(hasDescription ? { description: input.description as string | null } : {}),
        updatedAt,
        ...(prepared && prepared.ok ? {
          expectedVersion: input.expectedVersion as number,
          version: {
            id: `aud_${randomUUID()}`,
            schemaVersion: prepared.value.expression.version,
            expressionJson: JSON.stringify(prepared.value.expression),
            expressionHash: prepared.value.hash,
            reason: typeof input.reason === "string" ? input.reason : null,
            agentRunId,
            createdBy: "api",
            createdAt: updatedAt,
          },
        } : {}),
      }));
      if (result.kind === "not_found") return json({ error: "Segment not found" }, 404);
      if (result.kind === "stale") {
        return json({ error: "Stale expectedVersion", currentVersion: result.currentVersion }, 409);
      }
      if (result.kind === "archived") {
        return json({ error: "Archived segments cannot be revised", currentVersion: result.currentVersion }, 409);
      }
      return json({ segment: segmentDetailView(result.segment, result.version) });
    },

    async archiveSegment(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const result = await store.transaction((transaction) => transaction.archiveSegment(params.id, now()));
      if (result.kind === "not_found") return json({ error: "Segment not found" }, 404);
      if (result.kind === "already_archived") return json({ error: "Segment is already archived" }, 409);
      return json({ segment: segmentDetailView(result.segment, result.version) });
    },

    async listSegmentVersions(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const segment = await store.getSegment(params.id);
      if (!segment) return json({ error: "Segment not found" }, 404);
      return json({
        segmentId: segment.id,
        versions: (await store.listSegmentVersions(segment.id)).map(segmentVersionView),
      });
    },

    async getSegmentVersion(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const segment = await store.getSegment(params.id);
      const versionNumber = Number(params.version);
      if (!segment || !Number.isSafeInteger(versionNumber) || versionNumber < 1) {
        return json({ error: "Segment version not found" }, 404);
      }
      const version = await store.getSegmentVersion(segment.id, versionNumber);
      if (!version) return json({ error: "Segment version not found" }, 404);
      return json({
        segmentId: segment.id,
        version: { ...segmentVersionView(version), expression: storedAudience(version).expression },
      });
    },

    async createCampaign(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (typeof input.name !== "string" || !input.name || input.name.length > 80) return json({ error: "name is required" }, 400);
      if (input.channel !== undefined && input.channel !== "web_inapp") return json({ error: "The local adapter currently supports web_inapp" }, 400);
      if (input.goalId !== undefined && input.goalId !== null && (typeof input.goalId !== "string" || !input.goalId)) return json({ error: "Goal not found" }, 400);
      if (input.launch !== undefined && typeof input.launch !== "boolean") return json({ error: "Invalid launch value" }, 400);
      if ((input.message === undefined) === (input.variants === undefined)) return json({ error: "Provide exactly one of message or variants" }, 400);
      const pages = validatePages(input.pages);
      if (!pages.ok) return json({ error: pages.error }, 400);
      const audienceInput = parseCampaignAudience(input, true);
      if (!audienceInput.ok) return json({ error: audienceInput.error }, audienceInput.status);
      const deliverFrom = input.deliverFrom === undefined ? null : inputInstant(input.deliverFrom);
      const deliverUntil = input.deliverUntil === undefined ? null : inputInstant(input.deliverUntil);
      if (deliverFrom === undefined || deliverUntil === undefined) return json({ error: "Invalid delivery window" }, 400);
      const id = `cmp_${randomUUID()}`;
      const rawVariants = input.message !== undefined
        ? [{ name: "A", message: input.message, weight: 1, isControl: true }]
        : input.variants;
      const parsedVariants = await parseVariantPatches(rawVariants);
      if (!parsedVariants.ok) return json({ error: parsedVariants.error }, parsedVariants.status);
      if (parsedVariants.patches.some((variant) => variant.id !== null)) return json({ error: "New variants cannot set id" }, 400);
      const variants = parsedVariants.patches.map((variant, index): ProductVariant => ({
          id: `var_${randomUUID()}`,
          campaign_id: id,
          name: variant.name ?? String.fromCharCode(65 + index),
          content_json: JSON.stringify(variant.content),
          weight: variant.weight ?? 1,
          isControl: variant.isControl === true || (variant.isControl === undefined && index === 0),
        }));
      if (!variants.some((variant) => variant.weight > 0) || variants.filter((variant) => variant.isControl).length > 1) return json({ error: "Invalid variant allocation" }, 400);
      const result = await store.transaction(async (transaction) => {
        const createdAt = now();
        if ((deliverFrom !== null && deliverUntil !== null && deliverFrom >= deliverUntil) || (deliverUntil !== null && deliverUntil <= createdAt)) {
          return { ok: false as const, status: 400, error: "Invalid delivery window" };
        }
        const goalId = typeof input.goalId === "string" ? input.goalId : null;
        if (goalId && !await transaction.getGoal(goalId)) return { ok: false as const, status: 400, error: "Goal not found" };
        const audience = await resolveCampaignAudience(audienceInput.value, transaction);
        if (!audience.ok) return audience;
        if (!audience.audience) throw new Error("Create campaign audience cannot be unchanged");
        const campaign: ProductCampaign = {
          id,
          name: input.name as string,
          status: input.launch === true ? "running" : "draft",
          channel: "web_inapp",
          goalId,
          createdAt,
          startedAt: input.launch === true ? createdAt : null,
          endedAt: null,
          deliverFrom,
          deliverUntil,
          pages: pages.pages,
          audience: audience.audience,
          variants,
        };
        await transaction.createCampaign(campaign);
        return { ok: true as const, campaign };
      });
      if (!result.ok) return json({ error: result.error }, result.status);
      const evaluatedAt = now();
      const stats = await store.campaignStatsForCampaigns([result.campaign.id]);
      return json({ campaign: campaignView(result.campaign, stats.get(result.campaign.id), evaluatedAt) }, 201);
    },

    async listCampaigns(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const status = url.searchParams.get("status");
      const allowed = new Set(["draft", "scheduled", "running", "paused", "expired", "ended"]);
      if (status && !allowed.has(status)) return json({ error: "Invalid status" }, 400);
      const pagination = pageRequest(url, CAMPAIGN_PER_PAGE_DEFAULT);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const query = searchQuery(url);
      if (query === undefined) return json({ error: "Invalid q" }, 400);
      const evaluatedAt = now();
      const page = await store.queryCampaigns({
        effectiveStatus: status as CampaignEffectiveStatus | null,
        query,
        evaluatedAt,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      });
      const stats = await store.campaignStatsForCampaigns(page.values.map((campaign) => campaign.id));
      return json({
        campaigns: page.values.map((campaign) => campaignView(campaign, stats.get(campaign.id), evaluatedAt)),
        total: page.total,
        page: pagination.page,
        pageCount: pageCountFor(page.total, pagination.perPage),
        evaluatedAt,
      });
    },

    async getCampaign(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const campaign = await store.getCampaign(params.id);
      if (!campaign) return json({ error: "Campaign not found" }, 404);
      const evaluatedAt = now();
      const stats = await store.campaignStatsForCampaigns([campaign.id]);
      return json({ campaign: campaignView(campaign, stats.get(campaign.id), evaluatedAt), evaluatedAt });
    },

    async updateCampaign(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const input = parsed.value;
      if (input.name !== undefined && (typeof input.name !== "string" || !input.name || input.name.length > 80)) return json({ error: "Invalid name" }, 400);
      const pages = input.pages === undefined ? null : validatePages(input.pages);
      if (pages && !pages.ok) return json({ error: pages.error }, 400);
      if (input.goalId !== undefined && input.goalId !== null && (typeof input.goalId !== "string" || !input.goalId)) return json({ error: "Goal not found" }, 400);
      const audienceInput = parseCampaignAudience(input, false);
      if (!audienceInput.ok) return json({ error: audienceInput.error }, audienceInput.status);
      const deliverFromInput = input.deliverFrom === undefined ? undefined : inputInstant(input.deliverFrom);
      const deliverUntilInput = input.deliverUntil === undefined ? undefined : inputInstant(input.deliverUntil);
      if (deliverFromInput === undefined && input.deliverFrom !== undefined) return json({ error: "Invalid delivery window" }, 400);
      if (deliverUntilInput === undefined && input.deliverUntil !== undefined) return json({ error: "Invalid delivery window" }, 400);
      if (input.message !== undefined && input.variants !== undefined) return json({ error: "message and variants are mutually exclusive" }, 400);
      const message = input.message === undefined ? null : await parseMessage(input.message, media, projectId);
      if (message && !message.ok) return json({ error: message.error }, message.status);
      const variantPatches = input.variants === undefined ? null : await parseVariantPatches(input.variants);
      if (variantPatches && !variantPatches.ok) return json({ error: variantPatches.error }, variantPatches.status);
      const result = await store.transaction(async (transaction) => {
        const campaign = await transaction.getCampaignForUpdate(params.id);
        if (!campaign) return { ok: false as const, status: 404, error: "Campaign not found" };
        if (typeof input.name === "string") campaign.name = input.name;
        if (pages?.ok) campaign.pages = pages.pages;
        if (input.goalId !== undefined) {
          const goalId = input.goalId as string | null;
          if (goalId && !await transaction.getGoal(goalId)) return { ok: false as const, status: 400, error: "Goal not found" };
          campaign.goalId = goalId;
        }
        const audience = await resolveCampaignAudience(audienceInput.value, transaction);
        if (!audience.ok) return audience;
        if (audience.audience) campaign.audience = audience.audience;
        const deliverFrom = input.deliverFrom === undefined ? campaign.deliverFrom : deliverFromInput as number | null;
        const deliverUntil = input.deliverUntil === undefined ? campaign.deliverUntil : deliverUntilInput as number | null;
        if (
          (deliverFrom !== null && deliverUntil !== null && deliverFrom >= deliverUntil)
          || (input.deliverUntil !== undefined && deliverUntil !== null && deliverUntil <= now())
        ) {
          return { ok: false as const, status: 400, error: "Invalid delivery window" };
        }
        campaign.deliverFrom = deliverFrom;
        campaign.deliverUntil = deliverUntil;
        if (message?.ok) {
          if (campaign.variants.length !== 1) return { ok: false as const, status: 400, error: "A single campaign variant is required" };
          campaign.variants[0].content_json = JSON.stringify(message.content);
        }
        if (variantPatches?.ok) {
          const applied = applyVariantPatches(campaign, variantPatches.patches);
          if (!applied.ok) return { ok: false as const, status: 400, error: applied.error };
        }
        await transaction.saveCampaignContent(campaign);
        return { ok: true as const, campaign };
      });
      if (!result.ok) return json({ error: result.error }, result.status);
      const evaluatedAt = now();
      const stats = await store.campaignStatsForCampaigns([result.campaign.id]);
      return json({ campaign: campaignView(result.campaign, stats.get(result.campaign.id), evaluatedAt) });
    },

    async setCampaignStatus(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request);
      if (!parsed.ok) return bodyError(parsed.status);
      const action = parsed.value.action;
      if (action !== "launch" && action !== "pause" && action !== "end") return json({ error: "Invalid action" }, 400);
      const campaign = await store.transaction(async (transaction) => {
        const current = await transaction.getCampaignForUpdate(params.id);
        if (!current) return null;
        const transitionedAt = now();
        const status = effectiveStatus(current, transitionedAt);
        const transitioned = action === "launch" && current.deliverUntil !== null && current.deliverUntil <= transitionedAt
          ? null
          : transitionCampaign(current, action, transitionedAt);
        if (!transitioned) return { error: `Cannot ${action} a ${status} campaign.` } as const;
        await transaction.saveCampaignLifecycle(transitioned);
        return transitioned;
      });
      if (!campaign) return json({ error: "Campaign not found" }, 404);
      if ("error" in campaign) return json({ error: campaign.error }, 409);
      return json({ id: campaign.id, status: campaign.status });
    },

    async listCampaignDeliveries(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const campaign = await store.getCampaign(params.id);
      if (!campaign) return json({ error: "Campaign not found" }, 404);
      const url = new URL(request.url);
      const pagination = pageRequest(url);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const state = url.searchParams.get("state");
      if (state && !deliveryStates.has(state as ProductDelivery["state"])) return json({ error: "Invalid state" }, 400);
      const page = await store.queryCampaignDeliveries({
        campaignId: campaign.id,
        state: state as ProductDelivery["state"] | null,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      });
      const views = (await Promise.all(page.values.map(async (delivery) => {
        const user = await store.getUserById(delivery.userId);
        const variant = campaign.variants.find((candidate) => candidate.id === delivery.variantId);
        return user && variant ? deliveryView(delivery, user, variant) : null;
      }))).filter((value) => value !== null);
      return json({
        deliveries: views,
        total: page.total,
        page: pagination.page,
        pageCount: page.total === 0 ? 0 : Math.ceil(page.total / pagination.perPage),
      });
    },

    async getCampaignEventConversions(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const campaign = await store.getCampaign(params.id);
      if (!campaign) return json({ error: "Campaign not found" }, 404);
      const url = new URL(request.url);
      const eventName = url.searchParams.get("event");
      if (!eventName || eventName.length > 80) return json({ error: "event is required" }, 400);
      const evaluatedAt = now();
      const summary = await store.campaignEventConversionSummary(campaign.id, eventName, evaluatedAt);
      return json({
        campaignId: campaign.id,
        event: eventName,
        evaluatedAt,
        exposure: "shownAt",
        totals: summary.totals,
        variants: campaign.variants.map((variant) => ({
          variantId: variant.id,
          variantName: variant.name,
          ...(summary.variants.get(variant.id) ?? emptyConversionCounts()),
        })),
      });
    },

    async listUsers(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const pagination = pageRequest(url);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const traitKey = url.searchParams.get("traitKey");
      const traitValue = url.searchParams.get("traitValue");
      if ((traitKey === null) !== (traitValue === null)) return json({ error: "traitKey and traitValue are required together" }, 400);
      const activeRaw = url.searchParams.get("activeSince");
      const firstRaw = url.searchParams.get("firstSeenSince");
      const activeSince = activeRaw === null ? null : instant(activeRaw);
      const firstSeenSince = firstRaw === null ? null : instant(firstRaw);
      if ((activeRaw !== null && activeSince === null) || (firstRaw !== null && firstSeenSince === null)) return json({ error: "Invalid timestamp" }, 400);
      const query = url.searchParams.get("q")?.toLowerCase();
      const page = await store.queryUsers({
        query: query ?? null,
        traitKey,
        traitValue,
        activeSince,
        firstSeenSince,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      });
      return json({
        users: page.values.map(userView),
        total: page.total,
        page: pagination.page,
        pageCount: page.total === 0 ? 0 : Math.ceil(page.total / pagination.perPage),
      });
    },

    async getUser(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const user = await store.getUserById(params.id) ?? await store.getUserByExternalId(params.id);
      return user ? json({ user: userView(user) }) : json({ error: "User not found" }, 404);
    },

    async getUserSummary(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const window = new URL(request.url).searchParams.get("window") ?? USER_SUMMARY_WINDOW_DEFAULT;
      if (window !== USER_SUMMARY_WINDOW_DEFAULT) return json({ error: "window must be 7d" }, 400);
      const evaluatedAt = now();
      const startAt = evaluatedAt - WEEK_MS;
      const counts = await store.withReadSnapshot((snapshot) => snapshot.userSummary(startAt));
      return json({ evaluatedAt, window, startAt, ...counts } satisfies UserSummaryResponse);
    },

    async listUserEvents(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const pagination = pageRequest(url);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const user = await store.getUserById(params.id) ?? await store.getUserByExternalId(params.id);
      if (!user) return json({ error: "User not found" }, 404);
      const page = await store.queryEvents({
        name: null,
        query: null,
        userId: user.id,
        externalUserId: null,
        since: null,
        until: null,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      });
      return json({
        events: page.values.map(eventView),
        total: page.total,
        page: pagination.page,
        pageCount: pageCountFor(page.total, pagination.perPage),
      });
    },

    async listUserDeliveries(request, { params }) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const pagination = pageRequest(url, USER_DELIVERY_PER_PAGE_DEFAULT);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const user = await store.getUserById(params.id) ?? await store.getUserByExternalId(params.id);
      if (!user) return json({ error: "User not found" }, 404);
      return json(await store.queryUserDeliveries({
        userId: user.id,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      }) satisfies UserDeliveriesResponse);
    },

    async getProjectOverview(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const evaluatedAt = now();
      return json(await store.withReadSnapshot((snapshot) => snapshot.projectOverview(evaluatedAt)) satisfies ProjectOverviewResponse);
    },

    async listProjectActivity(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? String(ACTIVITY_LIMIT_DEFAULT));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > ACTIVITY_LIMIT_MAX) return json({ error: "Invalid limit" }, 400);
      const cursorRaw = url.searchParams.get("cursor");
      const after = cursorRaw === null ? null : decodeActivityCursor(cursorRaw);
      if (cursorRaw !== null && after === null) return json({ error: "Invalid cursor" }, 400);
      const evaluatedAt = now();
      const candidates = await store.withReadSnapshot((snapshot) =>
        snapshot.projectActivity({ limit: limit + 1, after }),
      );
      const items = candidates.slice(0, limit);
      const last = items.at(-1);
      return json({
        items,
        nextCursor: candidates.length > limit && last ? encodeActivityCursor({ occurredAt: last.occurredAt, kind: last.kind, id: last.id }) : null,
        evaluatedAt,
      });
    },

    async getProjectMetrics(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const range = new URL(request.url).searchParams.get("range") ?? METRICS_RANGE_DEFAULT;
      if (!Object.hasOwn(METRICS_RANGES, range)) return json({ error: "range must be one of: 7d, 30d, 90d" }, 400);
      const evaluatedAt = now();
      const query = metricsQuery(range as MetricsRange, evaluatedAt);
      const aggregate = await store.withReadSnapshot((snapshot) => snapshot.projectMetrics(query));
      return json(metricsResponse(aggregate, query, evaluatedAt));
    },

    async listEvents(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const pagination = pageRequest(url);
      if (!pagination) return json({ error: "Invalid pagination" }, 400);
      const sinceRaw = url.searchParams.get("since");
      const untilRaw = url.searchParams.get("until");
      const since = sinceRaw === null ? null : instant(sinceRaw);
      const until = untilRaw === null ? null : instant(untilRaw);
      if ((sinceRaw !== null && since === null) || (untilRaw !== null && until === null) || (since !== null && until !== null && since > until)) return json({ error: "Invalid timestamp" }, 400);
      const name = url.searchParams.get("name");
      const query = searchQuery(url);
      if (query === undefined) return json({ error: "Invalid q" }, 400);
      if (name !== null && query !== null) return json({ error: "q and name are mutually exclusive" }, 400);
      const userId = url.searchParams.get("userId");
      const externalUserId = url.searchParams.get("externalUserId");
      const page = await store.queryEvents({
        name,
        query,
        userId,
        externalUserId,
        since,
        until,
        offset: (pagination.page - 1) * pagination.perPage,
        limit: pagination.perPage,
      });
      return json({
        events: page.values.map(eventView),
        total: page.total,
        page: pagination.page,
        pageCount: pageCountFor(page.total, pagination.perPage),
      });
    },

    async getMessages(request) {
      if (!requireKey(request, publishableKey)) return json({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const externalId = url.searchParams.get("userId");
      if (!externalId) return json({ error: "userId is required" }, 400);
      const evaluatedAt = now();
      const facts = await store.withReadSnapshot(async (snapshot) => {
        const { values: campaigns } = await snapshot.queryCampaigns({ effectiveStatus: "running", query: null, evaluatedAt, offset: 0, limit: 101 });
        if (campaigns.length > 100) return { kind: "candidates" as const };
        const user = await snapshot.getUserByExternalId(externalId);
        if (!user) return { kind: "missing" as const };
        const eventNames = new Set<string>();
        const traitKeys = new Set<string>();
        for (const campaign of campaigns) {
          if (campaign.audience.kind === "all" || campaign.audience.kind === "invalid") continue;
          const vocabulary = referencedVocabulary((JSON.parse(campaign.audience.expressionJson) as AudienceExpression).root);
          vocabulary.events.forEach((name) => eventNames.add(name));
          vocabulary.traits.forEach((key) => traitKeys.add(key));
        }
        const loaded = await loadFactsWithinBudget(snapshot, {
          afterUserId: null, userId: user.id, traitKeys: [...traitKeys], eventNames: [...eventNames], evaluatedAt,
          maxOccurrences: LIMITS.maxEvaluatedEventOccurrences, eventRowBudget: audienceEventRowBudget,
        }, 1);
        if (!loaded.ok) return { kind: "overflow" as const };
        return { kind: "loaded" as const, campaigns, user: loaded.batch.users[0], events: loaded.batch.eventsByUser.get(user.id) ?? [] };
      });
      if (facts.kind === "candidates") return json({ error: "Too many eligible campaigns to evaluate safely" }, 503);
      if (facts.kind === "missing") return json({ messages: [] });
      if (facts.kind === "overflow") return capacityResponse();
      const { campaigns, user, events: userEvents } = facts;
      const messages = [];
      for (const campaign of campaigns) {
        if (campaign.pages !== null && url.searchParams.get("pages") !== "1") continue;
        if (!await campaignMatches(campaign, user, userEvents, evaluatedAt)) continue;
        const assigned = pickVariant(user.id, campaign.id, campaign.variants);
        if (!assigned) continue;
        const delivery = await store.getOrCreateDelivery({
          id: `del_${randomUUID()}`,
          campaignId: campaign.id,
          variantId: assigned.id,
          userId: user.id,
          state: "queued",
          queuedAt: evaluatedAt,
          sentAt: null,
          deliveredAt: null,
          shownAt: null,
          openedAt: null,
          clickedAt: null,
          dismissedAt: null,
          bouncedAt: null,
          complainedAt: null,
          unsubscribedAt: null,
          convertedAt: null,
        });
        if (!["queued", "shown"].includes(delivery.state)) continue;
        const variant = campaign.variants.find((candidate) => candidate.id === delivery.variantId);
        if (!variant) continue;
        messages.push({
          deliveryId: delivery.id,
          campaignId: campaign.id,
          variantId: variant.id,
          ...(url.searchParams.get("pages") === "1" ? { pages: campaign.pages } : {}),
          content: publicMessageContent(JSON.parse(variant.content_json), media, projectId),
        });
      }
      return json({ messages: sortByPresentation(messages) });
    },

    async recordDeliveryEvent(request, { params }) {
      if (!requireKey(request, publishableKey)) return json({ error: "Unauthorized" }, 401);
      const parsed = await body(request, SDK_BODY_BYTES);
      if (!parsed.ok) return bodyError(parsed.status);
      const type = parsed.value.type;
      if (!new Set(["shown", "clicked", "dismissed", "converted"]).has(String(type))) return json({ error: "Invalid type" }, 400);
      const occurredAt = now();
      const found = await store.transaction(async (transaction) => {
        const delivery = await transaction.getDeliveryForUpdate(params.id);
        if (!delivery) return false;
        const firstExposure = delivery.shownAt === null;
        applyDeliveryFeedback(delivery, type as DeliveryFeedback, occurredAt);
        if (type === "shown" && firstExposure) {
          const campaign = await transaction.getCampaign(delivery.campaignId);
          const goal = campaign?.goalId ? await transaction.getGoal(campaign.goalId) : null;
          if (goal?.targetEvent) {
            const prior = await transaction.findFirstEventAtOrAfter(delivery.userId, goal.targetEvent, occurredAt);
            if (prior) {
              delivery.state = "converted";
              delivery.convertedAt = prior.occurredAt;
            }
          }
        }
        await transaction.saveDelivery(delivery);
        return true;
      });
      return found ? json({ ok: true }) : json({ error: "Delivery not found" }, 404);
    },

    async getUsage(request) {
      if (!requireKey(request, secretKey)) return json({ error: "Unauthorized" }, 401);
      const evaluatedAt = new Date(now());
      const start = Date.UTC(evaluatedAt.getUTCFullYear(), evaluatedAt.getUTCMonth(), 1);
      const end = Date.UTC(evaluatedAt.getUTCFullYear(), evaluatedAt.getUTCMonth() + 1, 1);
      const { activeUsers, frequencyCapped } = await store.usageSummary(start, end);
      return json({
        serving: "ok",
        emailServing: "paused",
        billable: false,
        period: {
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          boundary: "calendar_month",
        },
        activeUsers,
        frequencyCapped,
        estimatedSpendUsd: 0,
        spendCapUsd: null,
        projects: [{ id: projectId, name: projectId, activeUsers, frequencyCapped }],
      });
    },
  };

  const handlers: OperationHandlers = {};
  for (const operationId of Object.keys(rawHandlers) as OperationId[]) {
    const handler = rawHandlers[operationId]!;
    handlers[operationId] = async (request, context) => {
      const sdk = SDK_OPERATIONS.has(operationId);
      const expectedKey = sdk ? publishableKey : secretKey;
      if (!requireKey(request, expectedKey)) return handler(request, context);
      const group = sdk ? operationId : MANAGEMENT_RESOURCE_GROUP[operationId] ?? operationId;
      const result = checkRateLimit(`${sdk ? "sdk" : "management"}:${group}`, sdk ? sdkRateLimit : managementRateLimit);
      if (!result.allowed) {
        return Response.json(
          { error: "Too many requests" },
          { status: 429, headers: { "Retry-After": String(result.retryAfter) } },
        );
      }
      return handler(request, context);
    };
  }

  return { projectId, secretKey, publishableKey, handlers, media, close: () => store.close() };
}

export class MemoryProductStore implements ProductStore {
  private readonly users = new Map<string, ProductUser>();
  private readonly usersById = new Map<string, ProductUser>();
  private readonly goals = new Map<string, ProductGoal>();
  private readonly campaigns = new Map<string, ProductCampaign>();
  private readonly deliveries = new Map<string, ProductDelivery>();
  private readonly deliveryByCampaignUser = new Map<string, string>();
  private readonly events: ProductEvent[] = [];
  private readonly agentRuns: ProductAgentRun[] = [];
  private readonly agentRunByIdempotencyKey = new Map<string, ProductAgentRun>();
  private readonly segments = new Map<string, ProductSegment>();
  private readonly segmentByKey = new Map<string, string>();
  private readonly segmentByIdempotencyKey = new Map<string, string>();
  private readonly audienceVersions = new Map<string, ProductAudienceVersion[]>();
  private transactionTail = Promise.resolve();

  async transaction<T>(work: (store: ProductStoreSession) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work(this);
    } finally {
      release();
    }
  }

  async withReadSnapshot<T>(work: (store: ProductStoreAccess) => Promise<T>) {
    return this.transaction(work);
  }

  async identifyUser(externalId: string, traits: JsonObject, now: number) {
    const previous = this.users.get(externalId);
    const user: ProductUser = {
      id: previous?.id ?? `eu_${randomUUID()}`,
      externalId,
      traits: { ...(previous?.traits ?? {}), ...traits },
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    if (Buffer.byteLength(JSON.stringify(user.traits)) > MAX_MERGED_TRAITS_BYTES) throw new TraitsCapacityError();
    const stored = structuredClone(user);
    this.users.set(externalId, stored);
    this.usersById.set(user.id, stored);
    return structuredClone(user);
  }

  async getUserById(id: string) {
    const user = this.usersById.get(id);
    return user ? structuredClone(user) : null;
  }

  async getUserByExternalId(externalId: string) {
    const user = this.users.get(externalId);
    return user ? structuredClone(user) : null;
  }

  async insertEvent(event: ProductEvent) {
    this.events.push(structuredClone(event));
  }

  async loadAudienceFacts(input: AudienceFactsInput): Promise<AudienceFactsBatch> {
    const traitKeys = new Set(input.traitKeys);
    const selected: ProductUser[] = [];
    if (input.userId) {
      const user = this.usersById.get(input.userId);
      if (user && (input.afterUserId === null || user.id > input.afterUserId)) selected.push(user);
    } else {
      for (const user of this.users.values()) {
        if (input.afterUserId !== null && user.id <= input.afterUserId) continue;
        retainOrdered(selected, user, input.limit + 1, (left, right) => left.id.localeCompare(right.id));
      }
    }
    const hasMore = selected.length > input.limit;
    const users = selected.slice(0, input.limit).map((user) => ({
      ...structuredClone(user),
      traits: Object.fromEntries(Object.entries(user.traits).filter(([key]) => traitKeys.has(key))),
    }));
    const userIds = new Set(users.map((user) => user.id));
    const names = new Set(input.eventNames);
    const partitions = new Map<string, ProductEvent[]>();
    for (const event of this.events) {
      if (!userIds.has(event.userId) || !names.has(event.name) || event.occurredAt > input.evaluatedAt) continue;
      const key = `${event.userId}\0${event.name}`;
      const values = partitions.get(key) ?? [];
      retainOrdered(values, event, input.maxOccurrences, (left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
      partitions.set(key, values);
    }
    let eventCount = 0;
    const eventsByUser = new Map<string, ProductEvent[]>();
    for (const events of partitions.values()) {
      for (const event of events) {
        eventCount += 1;
        if (eventCount > input.eventRowBudget) break;
        const values = eventsByUser.get(event.userId) ?? [];
        values.push(structuredClone(event));
        eventsByUser.set(event.userId, values);
      }
      if (eventCount > input.eventRowBudget) break;
    }
    return { users, eventsByUser, nextCursor: hasMore ? users.at(-1)?.id ?? null : null, overflow: eventCount > input.eventRowBudget };
  }

  async audienceCapabilities() {
    return audienceCapabilities(this.users.values(), this.events.values());
  }

  async audiencePresence(input: { traitKeys: string[]; eventNames: string[] }) {
    const requestedTraits = new Set(input.traitKeys);
    const requestedEvents = new Set(input.eventNames);
    const traits = new Set<string>();
    const events = new Set<string>();
    for (const user of this.users.values()) {
      for (const key of requestedTraits) if (Object.hasOwn(user.traits, key)) traits.add(key);
    }
    for (const event of this.events) if (requestedEvents.has(event.name)) events.add(event.name);
    return { traits, events };
  }

  async queryUsers(query: UserQuery) {
    const values: ProductUser[] = [];
    let total = 0;
    for (const user of this.users.values()) {
      if (
        query.query &&
        !user.externalId.toLowerCase().includes(query.query) &&
        !JSON.stringify(user.traits).toLowerCase().includes(query.query)
      ) continue;
      if (query.traitKey !== null) {
        const value = user.traits[query.traitKey];
        if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || String(value) !== query.traitValue) continue;
      }
      if (query.activeSince !== null && user.lastSeenAt < query.activeSince) continue;
      if (query.firstSeenSince !== null && user.firstSeenAt < query.firstSeenSince) continue;
      total += 1;
      retainOrdered(values, user, query.offset + query.limit, (left, right) => right.lastSeenAt - left.lastSeenAt || left.id.localeCompare(right.id));
    }
    return { values: structuredClone(values.slice(query.offset)), total };
  }

  async queryEvents(query: EventQuery) {
    const values: ProductEvent[] = [];
    let total = 0;
    for (const event of this.events) {
      if (query.name && event.name !== query.name) continue;
      if (query.query && !event.name.toLowerCase().includes(query.query)) continue;
      if (query.userId && event.userId !== query.userId) continue;
      if (query.externalUserId && event.externalUserId !== query.externalUserId) continue;
      if (query.since !== null && event.occurredAt < query.since) continue;
      if (query.until !== null && event.occurredAt > query.until) continue;
      total += 1;
      retainOrdered(values, event, query.offset + query.limit, (left, right) => right.occurredAt - left.occurredAt || left.id.localeCompare(right.id));
    }
    return { values: structuredClone(values.slice(query.offset)), total };
  }

  async listConversionCandidatesForUpdate(userId: string, eventName: string, occurredAt: number) {
    const candidates: ProductDelivery[] = [];
    for (const delivery of this.deliveries.values()) {
      if (delivery.userId !== userId || delivery.shownAt === null || delivery.shownAt > occurredAt || delivery.convertedAt !== null) continue;
      const campaign = this.campaigns.get(delivery.campaignId);
      const goal = campaign?.goalId ? this.goals.get(campaign.goalId) : null;
      if (goal?.targetEvent !== eventName) continue;
      candidates.push(structuredClone(delivery));
    }
    return candidates;
  }

  async createGoal(goal: ProductGoal) {
    this.goals.set(goal.id, structuredClone(goal));
  }

  async getGoal(id: string) {
    const goal = this.goals.get(id);
    return goal ? structuredClone(goal) : null;
  }

  async getGoalForUpdate(id: string) {
    return this.getGoal(id);
  }

  async queryGoals(limit: number) {
    const values: ProductGoal[] = [];
    for (const goal of this.goals.values()) {
      retainOrdered(values, goal, limit, (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    }
    return structuredClone(values);
  }

  async saveGoal(goal: ProductGoal) {
    this.goals.set(goal.id, structuredClone(goal));
  }

  async createCampaign(campaign: ProductCampaign) {
    this.campaigns.set(campaign.id, structuredClone(campaign));
  }

  async getCampaign(id: string) {
    const campaign = this.campaigns.get(id);
    return campaign ? structuredClone(campaign) : null;
  }

  async getCampaignForUpdate(id: string) {
    return this.getCampaign(id);
  }

  async queryCampaigns(query: CampaignQuery) {
    const values: ProductCampaign[] = [];
    let total = 0;
    for (const campaign of this.campaigns.values()) {
      if (query.effectiveStatus !== null && effectiveStatus(campaign, query.evaluatedAt) !== query.effectiveStatus) continue;
      if (query.query && !campaign.name.toLowerCase().includes(query.query)) continue;
      total += 1;
      retainOrdered(values, campaign, query.offset + query.limit, (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    }
    return { values: structuredClone(values.slice(query.offset)), total };
  }

  async campaignStatsForCampaigns(campaignIds: string[]) {
    const ids = new Set(campaignIds);
    const result = new Map<string, CampaignStats>();
    for (const campaignId of campaignIds) {
      const campaign = this.campaigns.get(campaignId);
      result.set(campaignId, {
        total: emptyDeliveryStats(),
        variants: new Map((campaign?.variants ?? []).map((variant) => [variant.id, emptyDeliveryStats()])),
      });
    }
    for (const delivery of this.deliveries.values()) {
      if (!ids.has(delivery.campaignId)) continue;
      const stats = result.get(delivery.campaignId)!;
      countDelivery(stats.total, delivery);
      const variant = stats.variants.get(delivery.variantId);
      if (variant) countDelivery(variant, delivery);
    }
    return result;
  }

  async saveCampaignContent(campaign: ProductCampaign) {
    const current = this.campaigns.get(campaign.id);
    if (!current) return;
    this.campaigns.set(campaign.id, structuredClone({
      ...campaign,
      status: current.status,
      startedAt: current.startedAt,
      endedAt: current.endedAt,
    }));
  }

  async saveCampaignLifecycle(campaign: ProductCampaign) {
    const current = this.campaigns.get(campaign.id);
    if (!current) return;
    this.campaigns.set(campaign.id, structuredClone({
      ...current,
      status: campaign.status,
      startedAt: campaign.startedAt,
      endedAt: campaign.endedAt,
    }));
  }

  async getOrCreateDelivery(delivery: ProductDelivery) {
    const key = `${delivery.campaignId}:${delivery.userId}`;
    const existingId = this.deliveryByCampaignUser.get(key);
    if (existingId) return structuredClone(this.deliveries.get(existingId)!);
    this.deliveries.set(delivery.id, structuredClone(delivery));
    this.deliveryByCampaignUser.set(key, delivery.id);
    return structuredClone(delivery);
  }

  async getDeliveryForUpdate(id: string) {
    const delivery = this.deliveries.get(id);
    return delivery ? structuredClone(delivery) : null;
  }

  async saveDelivery(delivery: ProductDelivery) {
    this.deliveries.set(delivery.id, structuredClone(delivery));
  }

  async findFirstEventAtOrAfter(userId: string, name: string, occurredAt: number) {
    const event = this.events.find((candidate) => candidate.userId === userId && candidate.name === name && candidate.occurredAt >= occurredAt);
    return event ? structuredClone(event) : null;
  }

  async queryCampaignDeliveries(query: DeliveryQuery) {
    const values: ProductDelivery[] = [];
    let total = 0;
    for (const delivery of this.deliveries.values()) {
      if (delivery.campaignId !== query.campaignId || (query.state !== null && delivery.state !== query.state)) continue;
      total += 1;
      retainOrdered(values, delivery, query.offset + query.limit, (left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id));
    }
    return { values: structuredClone(values.slice(query.offset)), total };
  }

  async queryUserDeliveries(query: UserDeliveryQuery) {
    const values: ProductDelivery[] = [];
    let total = 0;
    for (const delivery of this.deliveries.values()) {
      if (delivery.userId !== query.userId) continue;
      const campaign = this.campaigns.get(delivery.campaignId);
      if (!campaign?.variants.some((variant) => variant.id === delivery.variantId)) continue;
      total += 1;
      retainOrdered(values, delivery, query.offset + query.limit, (left, right) => right.queuedAt - left.queuedAt || right.id.localeCompare(left.id));
    }
    const perPage = query.limit;
    return {
      deliveries: values.slice(query.offset).map((delivery) => {
        const campaign = this.campaigns.get(delivery.campaignId)!;
        const variant = campaign.variants.find((candidate) => candidate.id === delivery.variantId)!;
        return {
          id: delivery.id,
          campaignId: campaign.id,
          campaignName: campaign.name,
          variantId: variant.id,
          variantName: variant.name,
          state: delivery.state,
          queuedAt: delivery.queuedAt,
        };
      }),
      total,
      page: Math.floor(query.offset / perPage) + 1,
      pageCount: pageCountFor(total, perPage),
    };
  }

  async projectOverview(evaluatedAt: number) {
    let eventsLast7d = 0;
    for (const event of this.events) {
      if (event.occurredAt >= evaluatedAt - WEEK_MS && event.occurredAt <= evaluatedAt) {
        eventsLast7d += 1;
      }
    }
    let activeCampaigns = 0;
    for (const campaign of this.campaigns.values()) if (campaign.status === "running") activeCampaigns += 1;
    return { evaluatedAt, endUsers: this.users.size, eventsLast7d, activeCampaigns };
  }

  async projectActivity(query: ActivityQuery) {
    const items: ActivityItem[] = [];
    for (const delivery of this.deliveries.values()) {
      const campaign = this.campaigns.get(delivery.campaignId);
      const variant = campaign?.variants.find((candidate) => candidate.id === delivery.variantId);
      const user = this.usersById.get(delivery.userId);
      if (!campaign || !variant || !user) continue;
      const item: ActivityItem = {
        kind: "delivery",
        id: delivery.id,
        occurredAt: delivery.queuedAt,
        user: { id: user.id, externalUserId: user.externalId },
        campaign: { id: campaign.id, name: campaign.name },
        variant: { id: variant.id, name: variant.name },
      };
      if (isAfterCursor(item, query.after)) retainOrdered(items, item, query.limit, compareActivity);
    }
    for (const user of this.users.values()) {
      const item: ActivityItem = {
        kind: "user",
        id: user.id,
        occurredAt: user.firstSeenAt,
        user: { id: user.id, externalUserId: user.externalId },
      };
      if (isAfterCursor(item, query.after)) retainOrdered(items, item, query.limit, compareActivity);
    }
    return structuredClone(items);
  }

  async projectMetrics(query: MetricsQuery) {
    const buckets = new Map<number, ReturnType<typeof emptyMetricTotals>>();
    const bucketFor = (instant: number) => {
      const bucket = dayBucket(instant);
      const existing = buckets.get(bucket);
      if (existing) return existing;
      const created = emptyMetricTotals();
      buckets.set(bucket, created);
      return created;
    };
    let hasAnyDelivery = false;
    for (const delivery of this.deliveries.values()) {
      if (!this.campaigns.has(delivery.campaignId)) continue;
      if (delivery.queuedAt <= query.until) hasAnyDelivery = true;
      if (delivery.shownAt !== null && delivery.shownAt >= query.since && delivery.shownAt <= query.until) bucketFor(delivery.shownAt).impressions += 1;
      if (delivery.clickedAt !== null && delivery.clickedAt >= query.since && delivery.clickedAt <= query.until) bucketFor(delivery.clickedAt).clicks += 1;
      if (delivery.convertedAt !== null && delivery.convertedAt >= query.since && delivery.convertedAt <= query.until) bucketFor(delivery.convertedAt).conversions += 1;
    }
    const counts = new Map<string, number>();
    for (const event of this.events) {
      if (event.occurredAt < query.since || event.occurredAt > query.until) continue;
      bucketFor(event.occurredAt).events += 1;
      counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
    }
    const topEvents = [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, TOP_EVENT_LIMIT);
    return { buckets, topEvents, hasAnyDelivery };
  }

  async userSummary(startAt: number) {
    let activeUsers = 0;
    let newUsers = 0;
    for (const user of this.users.values()) {
      if (user.lastSeenAt >= startAt) activeUsers += 1;
      if (user.firstSeenAt >= startAt) newUsers += 1;
    }
    return { totalUsers: this.users.size, activeUsers, newUsers };
  }

  async agentRunReferences(goalIds: string[], campaignIds: string[]) {
    const goals: Record<string, string> = {};
    for (const id of goalIds) {
      const goal = this.goals.get(id);
      if (goal) goals[id] = goal.name;
    }
    const campaigns: Record<string, string> = {};
    for (const id of campaignIds) {
      const campaign = this.campaigns.get(id);
      if (campaign) campaigns[id] = campaign.name;
    }
    return { goals, campaigns };
  }

  async getAgentRun(id: string) {
    const run = this.agentRuns.find((candidate) => candidate.id === id);
    return run ? structuredClone(run) : null;
  }

  async queryAgentRuns(query: AgentRunQuery) {
    const values: ProductAgentRun[] = [];
    let total = 0;
    for (const run of this.agentRuns) {
      if (query.kind && run.kind !== query.kind) continue;
      if (query.goalId && run.goalId !== query.goalId) continue;
      if (query.campaignId && run.campaignId !== query.campaignId) continue;
      total += 1;
      retainOrdered(values, run, query.offset + query.limit, (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    }
    return { values: structuredClone(values.slice(query.offset)), total };
  }

  async campaignEventConversionSummary(campaignId: string, eventName: string, evaluatedAt: number) {
    const latestEvent = new Map<string, number>();
    for (const event of this.events) {
      if (event.name !== eventName || event.occurredAt > evaluatedAt) continue;
      latestEvent.set(event.userId, Math.max(latestEvent.get(event.userId) ?? -Infinity, event.occurredAt));
    }
    const campaign = this.campaigns.get(campaignId);
    const totals = emptyConversionCounts();
    const variants = new Map((campaign?.variants ?? []).map((variant) => [variant.id, emptyConversionCounts()]));
    const exposedUsers = new Set<string>();
    const convertedUsers = new Set<string>();
    const variantExposed = new Map<string, Set<string>>();
    const variantConverted = new Map<string, Set<string>>();
    for (const delivery of this.deliveries.values()) {
      if (delivery.campaignId !== campaignId || delivery.shownAt === null || delivery.shownAt > evaluatedAt) continue;
      totals.exposedDeliveries += 1;
      exposedUsers.add(delivery.userId);
      const variant = variants.get(delivery.variantId);
      if (variant) {
        variant.exposedDeliveries += 1;
        const users = variantExposed.get(delivery.variantId) ?? new Set<string>(); users.add(delivery.userId); variantExposed.set(delivery.variantId, users);
      }
      if ((latestEvent.get(delivery.userId) ?? -Infinity) < delivery.shownAt) continue;
      totals.convertedDeliveries += 1;
      convertedUsers.add(delivery.userId);
      if (variant) {
        variant.convertedDeliveries += 1;
        const users = variantConverted.get(delivery.variantId) ?? new Set<string>(); users.add(delivery.userId); variantConverted.set(delivery.variantId, users);
      }
    }
    totals.exposedUsers = exposedUsers.size;
    totals.convertedUsers = convertedUsers.size;
    for (const [variantId, counts] of variants) {
      counts.exposedUsers = variantExposed.get(variantId)?.size ?? 0;
      counts.convertedUsers = variantConverted.get(variantId)?.size ?? 0;
    }
    return { totals, variants };
  }

  async usageSummary(start: number, end: number) {
    const activeUserIds = new Set<string>();
    for (const user of this.users.values()) if (user.lastSeenAt >= start && user.lastSeenAt < end) activeUserIds.add(user.id);
    let frequencyCapped = 0;
    for (const delivery of this.deliveries.values()) {
      if (delivery.shownAt !== null && delivery.shownAt >= start && delivery.shownAt < end) activeUserIds.add(delivery.userId);
      if (this.campaigns.has(delivery.campaignId) && delivery.state === "frequency_capped" && delivery.queuedAt >= start && delivery.queuedAt < end) frequencyCapped += 1;
    }
    return {
      activeUsers: activeUserIds.size,
      frequencyCapped,
    };
  }

  async getOrCreateAgentRun(run: ProductAgentRun) {
    if (run.idempotencyKey) {
      const existing = this.agentRunByIdempotencyKey.get(run.idempotencyKey);
      if (existing) return { run: structuredClone(existing), created: false };
      this.agentRunByIdempotencyKey.set(run.idempotencyKey, structuredClone(run));
    }
    this.agentRuns.push(structuredClone(run));
    return { run: structuredClone(run), created: true };
  }

  async createSegment(segment: ProductSegment, version: ProductAudienceVersion) {
    if (segment.idempotencyKey !== null) {
      const existingId = this.segmentByIdempotencyKey.get(segment.idempotencyKey);
      if (existingId) {
        const existing = this.segments.get(existingId)!;
        return {
          kind: "replayed" as const,
          segment: structuredClone(existing),
          version: structuredClone((this.audienceVersions.get(existing.id) ?? []).find(
            (candidate) => candidate.segmentVersion === existing.currentVersion,
          )!),
        };
      }
    }
    if (this.segmentByKey.has(segment.key)) return { kind: "key_conflict" as const };
    this.segments.set(segment.id, structuredClone(segment));
    this.segmentByKey.set(segment.key, segment.id);
    if (segment.idempotencyKey !== null) this.segmentByIdempotencyKey.set(segment.idempotencyKey, segment.id);
    this.audienceVersions.set(segment.id, [structuredClone(version)]);
    return { kind: "created" as const, segment: structuredClone(segment), version: structuredClone(version) };
  }

  async getSegment(idOrKey: string) {
    const id = this.segments.has(idOrKey) ? idOrKey : this.segmentByKey.get(idOrKey);
    const segment = id ? this.segments.get(id) : null;
    return segment ? structuredClone(segment) : null;
  }

  async getSegmentForUpdate(idOrKey: string) {
    return this.getSegment(idOrKey);
  }

  async querySegments(status: ProductSegment["status"] | null, limit: number) {
    const values: ProductSegment[] = [];
    for (const segment of this.segments.values()) {
      if (status !== null && segment.status !== status) continue;
      retainOrdered(values, segment, limit, (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    }
    return structuredClone(values);
  }

  async reviseSegment(idOrKey: string, revision: SegmentRevision): Promise<SegmentMutationResult> {
    const segment = await this.getSegment(idOrKey);
    if (!segment) return { kind: "not_found" };
    if (revision.version && segment.status === "archived") {
      return { kind: "archived", currentVersion: segment.currentVersion };
    }
    if (revision.version && segment.currentVersion !== revision.expectedVersion) {
      return { kind: "stale", currentVersion: segment.currentVersion };
    }
    const updated = structuredClone(segment);
    if (revision.name !== undefined) updated.name = revision.name;
    if (revision.description !== undefined) updated.description = revision.description;
    updated.updatedAt = revision.updatedAt;
    let version = (this.audienceVersions.get(segment.id) ?? []).find(
      (candidate) => candidate.segmentVersion === segment.currentVersion,
    )!;
    if (revision.version) {
      version = {
        ...revision.version,
        segmentId: updated.id,
        segmentVersion: updated.currentVersion + 1,
      };
      this.audienceVersions.set(updated.id, [...(this.audienceVersions.get(updated.id) ?? []), structuredClone(version)]);
      updated.currentVersion = version.segmentVersion;
    }
    this.segments.set(updated.id, structuredClone(updated));
    return { kind: "updated", segment: structuredClone(updated), version: structuredClone(version) };
  }

  async archiveSegment(idOrKey: string, updatedAt: number) {
    const segment = await this.getSegment(idOrKey);
    if (!segment) return { kind: "not_found" as const };
    if (segment.status === "archived") return { kind: "already_archived" as const };
    const archived = { ...segment, status: "archived" as const, updatedAt };
    const version = (this.audienceVersions.get(segment.id) ?? []).find(
      (candidate) => candidate.segmentVersion === segment.currentVersion,
    )!;
    this.segments.set(archived.id, structuredClone(archived));
    return { kind: "archived" as const, segment: structuredClone(archived), version: structuredClone(version) };
  }

  async listSegmentVersions(segmentId: string) {
    return structuredClone(this.audienceVersions.get(segmentId) ?? [])
      .sort((left, right) => right.segmentVersion - left.segmentVersion);
  }

  async getSegmentVersion(segmentId: string, version: number) {
    const audience = (this.audienceVersions.get(segmentId) ?? []).find(
      (candidate) => candidate.segmentVersion === version,
    );
    return audience ? structuredClone(audience) : null;
  }

  async close() {}
}

export function createLocalProduct(options: LocalProductOptions = {}) {
  return createProduct(new MemoryProductStore(), options);
}
