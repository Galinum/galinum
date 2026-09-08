import type {
  AgentRuns,
  AudienceVersions,
  Campaigns,
  Deliveries,
  EndUsers,
  Events,
  Goals,
  Segments,
  Variants
} from "@galinum/core";
import { legacyTargetingToExpression, validateTargeting } from "@galinum/core";
import { type PushSettings } from "@galinum/push";
import {
  type Selectable
} from "kysely";
import { prepareAudience } from "./audience.js";
import {
  type JsonObject,
  type ProductAgentRun,
  type ProductAudienceVersion,
  type ProductCampaign,
  type ProductCampaignAudience,
  type ProductDelivery,
  type ProductEvent,
  type ProductGoal,
  type ProductSegment,
  type ProductUser,
  type ProductVariant
} from "./local-product.js";

type CampaignRow = Selectable<Campaigns>;
type AgentRunRow = Selectable<AgentRuns>;
type AudienceVersionRow = Selectable<AudienceVersions>;
type DeliveryRow = Selectable<Deliveries>;
type DeliveryRecord = Pick<
  DeliveryRow,
  | "id"
  | "campaign_id"
  | "variant_id"
  | "end_user_id"
  | "state"
  | "queued_at"
  | "sent_at"
  | "delivered_at"
  | "shown_at"
  | "opened_at"
  | "clicked_at"
  | "dismissed_at"
  | "bounced_at"
  | "complained_at"
  | "unsubscribed_at"
  | "converted_at"
>;
type EventRow = Selectable<Events>;
type GoalRow = Selectable<Goals>;
type SegmentRow = Selectable<Segments>;
type UserRow = Selectable<EndUsers>;
type VariantRow = Selectable<Variants>;

export function integer(value: number | string | bigint) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid bigint value: ${value}`);
  return parsed;
}

export function objectJson(value: string | null): JsonObject {
  if (value === null) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as JsonObject;
}

export function collectionJson(value: string | null): JsonObject | unknown[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Expected a JSON collection");
  return parsed as JsonObject | unknown[];
}

export function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export function pagesJson(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((page) => typeof page === "string")) throw new Error("Expected pages_json to contain strings");
  return parsed;
}

export function campaignStatus(value: string): ProductCampaign["status"] {
  if (value === "draft" || value === "running" || value === "paused" || value === "ended") return value;
  throw new Error(`Invalid campaign status: ${value}`);
}

export function deliveryState(value: string): ProductDelivery["state"] {
  if ([
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
  ].includes(value)) return value as ProductDelivery["state"];
  throw new Error(`Invalid delivery state: ${value}`);
}

export function goalStatus(value: string): ProductGoal["status"] {
  if (value === "active" || value === "archived") return value;
  throw new Error(`Invalid goal status: ${value}`);
}

export function userFromRow(row: UserRow): ProductUser {
  return {
    id: row.id,
    externalId: row.external_user_id,
    traits: objectJson(row.traits_json),
    firstSeenAt: integer(row.first_seen_at),
    lastSeenAt: integer(row.last_seen_at),
  };
}

export function goalFromRow(row: GoalRow): ProductGoal {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    targetEvent: row.target_event,
    guardrails: row.guardrails_json === null ? null : objectJson(row.guardrails_json),
    approvalMode: row.approval_mode === "auto" ? "auto" : "require_human",
    status: goalStatus(row.status),
    createdAt: integer(row.created_at),
  };
}

export function variantFromRow(row: VariantRow): ProductVariant {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    name: row.name,
    content_json: row.content_json,
    weight: row.weight,
    isControl: row.is_control,
  };
}

export function campaignFromRow(row: CampaignRow, variants: ProductVariant[]): ProductCampaign {
  if (row.channel !== "web_inapp" && row.channel !== "push") throw new Error(`Unsupported campaign channel: ${row.channel}`);
  return {
    id: row.id,
    name: row.name,
    status: campaignStatus(row.status),
    channel: row.channel,
    ...(row.channel === "push" ? { push: row.push_json ? JSON.parse(row.push_json) as PushSettings : null } : {}),
    goalId: row.goal_id,
    createdAt: integer(row.created_at),
    startedAt: row.started_at === null ? null : integer(row.started_at),
    endedAt: row.ended_at === null ? null : integer(row.ended_at),
    deliverFrom: row.deliver_from === null ? null : integer(row.deliver_from),
    deliverUntil: row.deliver_until === null ? null : integer(row.deliver_until),
    pages: pagesJson(row.pages_json),
    audience: row.audience_version_id !== null
      ? { kind: "invalid", audienceVersionId: row.audience_version_id, targetingJson: null }
      : row.targeting_json !== null
        ? legacyCampaignAudience(row.targeting_json)
        : { kind: "all" },
    variants,
  };
}

export function legacyCampaignAudience(targetingJson: string): ProductCampaignAudience {
  const validated = validateTargeting(targetingJson);
  if (!validated.ok) return { kind: "invalid", audienceVersionId: null, targetingJson };
  const expression = legacyTargetingToExpression(validated.targeting);
  if (!expression) return { kind: "all" };
  const prepared = prepareAudience(expression);
  if (!prepared.ok) return { kind: "invalid", audienceVersionId: null, targetingJson };
  return {
    kind: "legacy",
    audienceVersionId: null,
    targetingJson,
    schemaVersion: prepared.value.expression.version,
    expressionJson: JSON.stringify(prepared.value.expression),
    expressionHash: prepared.value.hash,
    reason: null,
    summary: prepared.value.summary,
  };
}

export function campaignAudienceFromRow(
  version: AudienceVersionRow,
  segment: SegmentRow | null,
): ProductCampaignAudience {
  let prepared;
  try {
    prepared = prepareAudience(JSON.parse(version.expression_json));
  } catch {
    return { kind: "invalid", audienceVersionId: version.id, targetingJson: null };
  }
  if (!prepared.ok || prepared.value.hash !== version.expression_hash || prepared.value.expression.version !== version.schema_version) {
    return { kind: "invalid", audienceVersionId: version.id, targetingJson: null };
  }
  const definition = {
    schemaVersion: version.schema_version,
    expressionJson: version.expression_json,
    expressionHash: version.expression_hash,
    reason: version.reason,
    summary: prepared.value.summary,
  };
  if (version.segment_id === null) return { kind: "expression", audienceVersionId: version.id, ...definition };
  if (!segment || version.segment_version === null) {
    return { kind: "invalid", audienceVersionId: version.id, targetingJson: null };
  }
  return {
    kind: "segment",
    audienceVersionId: version.id,
    segmentId: version.segment_id,
    segmentKey: segment.key,
    segmentVersion: version.segment_version,
    ...definition,
  };
}

export function campaignAudienceColumns(audience: ProductCampaignAudience) {
  if (audience.kind === "expression" || audience.kind === "segment") {
    return { targeting_json: null, audience_version_id: audience.audienceVersionId };
  }
  if (audience.kind === "legacy") {
    return { targeting_json: audience.targetingJson, audience_version_id: null };
  }
  if (audience.kind === "invalid") {
    return { targeting_json: audience.targetingJson, audience_version_id: audience.audienceVersionId };
  }
  return { targeting_json: null, audience_version_id: null };
}

export function deliveryFromRow(row: DeliveryRecord): ProductDelivery {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    variantId: row.variant_id,
    userId: row.end_user_id,
    state: deliveryState(row.state),
    queuedAt: integer(row.queued_at),
    sentAt: row.sent_at === null ? null : integer(row.sent_at),
    deliveredAt: row.delivered_at === null ? null : integer(row.delivered_at),
    shownAt: row.shown_at === null ? null : integer(row.shown_at),
    openedAt: row.opened_at === null ? null : integer(row.opened_at),
    clickedAt: row.clicked_at === null ? null : integer(row.clicked_at),
    dismissedAt: row.dismissed_at === null ? null : integer(row.dismissed_at),
    bouncedAt: row.bounced_at === null ? null : integer(row.bounced_at),
    complainedAt: row.complained_at === null ? null : integer(row.complained_at),
    unsubscribedAt: row.unsubscribed_at === null ? null : integer(row.unsubscribed_at),
    convertedAt: row.converted_at === null ? null : integer(row.converted_at),
  };
}

export function eventFromRow(row: EventRow, externalUserId: string): ProductEvent {
  return {
    id: row.id,
    userId: row.end_user_id,
    externalUserId,
    name: row.name,
    props: row.props_json === null ? null : objectJson(row.props_json),
    occurredAt: integer(row.ts),
  };
}

export function agentRunFromRow(row: AgentRunRow): ProductAgentRun {
  return {
    id: row.id,
    kind: row.kind,
    goalId: row.goal_id,
    campaignId: row.campaign_id,
    input: collectionJson(row.input_json),
    output: collectionJson(row.output_json),
    rationale: row.rationale,
    idempotencyKey: row.idempotency_key,
    createdAt: integer(row.created_at),
  };
}

export function segmentFromRow(row: SegmentRow): ProductSegment {
  if (row.status !== "active" && row.status !== "archived") {
    throw new Error(`Invalid segment status: ${row.status}`);
  }
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: row.current_version,
    idempotencyKey: row.idempotency_key,
    createdBy: row.created_by,
    createdAt: integer(row.created_at),
    updatedAt: integer(row.updated_at),
  };
}

export function audienceVersionFromRow(row: AudienceVersionRow): ProductAudienceVersion {
  if (row.segment_id === null || row.segment_version === null) {
    throw new Error(`Expected segment audience version: ${row.id}`);
  }
  return {
    id: row.id,
    segmentId: row.segment_id,
    segmentVersion: row.segment_version,
    schemaVersion: row.schema_version,
    expressionJson: row.expression_json,
    expressionHash: row.expression_hash,
    reason: row.reason,
    agentRunId: row.agent_run_id,
    createdBy: row.created_by,
    createdAt: integer(row.created_at),
  };
}
