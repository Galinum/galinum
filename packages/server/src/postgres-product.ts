import { randomUUID } from "node:crypto";
import type {
  AgentRuns,
  AudienceVersions,
  Campaigns,
  Deliveries,
  EndUsers,
  Events,
  Goals,
  ProductDB,
  Segments,
  Variants,
} from "@galinum/core";
import { legacyTargetingToExpression, validateTargeting } from "@galinum/core";
import {
  Kysely,
  PostgresDialect,
  sql,
  type Selectable,
  type Transaction,
} from "kysely";
import { Pool } from "pg";
import {
  createProduct,
  resolveProductKeys,
  type AgentRunQuery,
  type AudienceFactsBatch,
  type AudienceFactsInput,
  type AudiencePresence,
  type CampaignQuery,
  type CampaignStats,
  type CampaignConversionSummary,
  type ConversionCounts,
  type DeliveryQuery,
  type EventQuery,
  type JsonObject,
  type LocalProductOptions,
  type ProductCampaign,
  type ProductCampaignAudience,
  type ProductAgentRun,
  type ProductAudienceVersion,
  type ProductDelivery,
  type ProductEvent,
  type ProductGoal,
  type ProductStore,
  type ProductStoreAccess,
  type ProductStoreSession,
  type ProductSegment,
  type ProductUser,
  type ProductVariant,
  type UserQuery,
  type SegmentMutationResult,
  type SegmentRevision,
  TraitsCapacityError,
} from "./local-product.js";
import { prepareAudience } from "./audience.js";
import {
  compareActivity,
  DAY_MS,
  dayBucket,
  emptyMetricTotals,
  isAfterCursor,
  pageCountFor,
  TOP_EVENT_LIMIT,
  WEEK_MS,
  type ActivityItem,
  type ActivityQuery,
  type AgentRunReferences,
  type MetricsAggregate,
  type MetricsQuery,
  type MetricTotals,
  type UserDeliveryQuery,
  type UserDelivery,
} from "./management-contract.js";
import {
  audienceCapabilities as buildAudienceCapabilities,
  MAX_CAPABILITY_EVENTS,
  MAX_CAPABILITY_TRAITS,
  type AudienceCapabilities,
} from "./audience.js";

type Projects = {
  id: string;
  name: string;
  created_at: number;
};
type ServerProductDB = ProductDB & { projects: Projects };
type Database = Kysely<ServerProductDB> | Transaction<ServerProductDB>;
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

export type PostgresProductOptions = LocalProductOptions & {
  connectionString: string;
};

function integer(value: number | string | bigint) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid bigint value: ${value}`);
  return parsed;
}

function objectJson(value: string | null): JsonObject {
  if (value === null) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as JsonObject;
}

function collectionJson(value: string | null): JsonObject | unknown[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") throw new Error("Expected a JSON collection");
  return parsed as JsonObject | unknown[];
}

function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function pagesJson(value: string | null): string[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((page) => typeof page === "string")) throw new Error("Expected pages_json to contain strings");
  return parsed;
}

function campaignStatus(value: string): ProductCampaign["status"] {
  if (value === "draft" || value === "running" || value === "paused" || value === "ended") return value;
  throw new Error(`Invalid campaign status: ${value}`);
}

function deliveryState(value: string): ProductDelivery["state"] {
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

function goalStatus(value: string): ProductGoal["status"] {
  if (value === "active" || value === "archived") return value;
  throw new Error(`Invalid goal status: ${value}`);
}

function userFromRow(row: UserRow): ProductUser {
  return {
    id: row.id,
    externalId: row.external_user_id,
    traits: objectJson(row.traits_json),
    firstSeenAt: integer(row.first_seen_at),
    lastSeenAt: integer(row.last_seen_at),
  };
}

function goalFromRow(row: GoalRow): ProductGoal {
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

function variantFromRow(row: VariantRow): ProductVariant {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    name: row.name,
    content_json: row.content_json,
    weight: row.weight,
    isControl: row.is_control,
  };
}

function campaignFromRow(row: CampaignRow, variants: ProductVariant[]): ProductCampaign {
  if (row.channel !== "web_inapp") throw new Error(`Unsupported campaign channel: ${row.channel}`);
  return {
    id: row.id,
    name: row.name,
    status: campaignStatus(row.status),
    channel: row.channel,
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

function legacyCampaignAudience(targetingJson: string): ProductCampaignAudience {
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

function campaignAudienceFromRow(
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

function campaignAudienceColumns(audience: ProductCampaignAudience) {
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

function deliveryFromRow(row: DeliveryRecord): ProductDelivery {
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

function eventFromRow(row: EventRow, externalUserId: string): ProductEvent {
  return {
    id: row.id,
    userId: row.end_user_id,
    externalUserId,
    name: row.name,
    props: row.props_json === null ? null : objectJson(row.props_json),
    occurredAt: integer(row.ts),
  };
}

function agentRunFromRow(row: AgentRunRow): ProductAgentRun {
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

function segmentFromRow(row: SegmentRow): ProductSegment {
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

function audienceVersionFromRow(row: AudienceVersionRow): ProductAudienceVersion {
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

class PostgresProductSession implements ProductStoreSession {
  constructor(
    protected readonly database: Database,
    protected readonly projectId: string,
  ) {}

  async identifyUser(externalId: string, traits: JsonObject, now: number) {
    const row = await this.database
      .insertInto("end_users")
      .values({
        id: `eu_${randomUUID()}`,
        project_id: this.projectId,
        external_user_id: externalId,
        traits_json: JSON.stringify(traits),
        first_seen_at: now,
        last_seen_at: now,
      })
      .onConflict((conflict) => conflict
        .columns(["project_id", "external_user_id"])
        .doUpdateSet({
          last_seen_at: now,
          traits_json: sql<string>`(
            coalesce(end_users.traits_json, '{}')::jsonb
            || excluded.traits_json::jsonb
          )::text`,
        })
        .where(sql<boolean>`octet_length((coalesce(end_users.traits_json, '{}')::jsonb || excluded.traits_json::jsonb)::text) <= ${64 * 1024}`))
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new TraitsCapacityError();
    return userFromRow(row);
  }

  async getUserById(id: string) {
    const row = await this.database
      .selectFrom("end_users")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? userFromRow(row) : null;
  }

  async getUserByExternalId(externalId: string) {
    const row = await this.database
      .selectFrom("end_users")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("external_user_id", "=", externalId)
      .executeTakeFirst();
    return row ? userFromRow(row) : null;
  }

  async queryUsers(input: UserQuery) {
    const filtered = () => {
      let query = this.database.selectFrom("end_users").where("project_id", "=", this.projectId);
      if (input.query) {
        const pattern = containsPattern(input.query);
        query = query.where(sql<boolean>`(
          external_user_id ilike ${pattern} escape '\\'
          or coalesce(traits_json, '{}') ilike ${pattern} escape '\\'
        )`);
      }
      if (input.traitKey !== null) {
        query = query.where(sql<boolean>`
          jsonb_typeof(coalesce(traits_json, '{}')::jsonb -> ${input.traitKey}) in ('string', 'number', 'boolean')
          and coalesce(traits_json, '{}')::jsonb ->> ${input.traitKey} = ${input.traitValue}
        `);
      }
      if (input.activeSince !== null) query = query.where("last_seen_at", ">=", input.activeSince);
      if (input.firstSeenSince !== null) query = query.where("first_seen_at", ">=", input.firstSeenSince);
      return query;
    };
    const count = await filtered().select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const rows = await filtered()
      .selectAll()
      .orderBy("last_seen_at", "desc")
      .orderBy("id")
      .offset(input.offset)
      .limit(input.limit)
      .execute();
    return { values: rows.map(userFromRow), total: integer(count.count) };
  }

  async insertEvent(event: ProductEvent) {
    await this.database.insertInto("events").values({
      id: event.id,
      project_id: this.projectId,
      end_user_id: event.userId,
      name: event.name,
      props_json: event.props === null ? null : JSON.stringify(event.props),
      ts: event.occurredAt,
    }).execute();
  }

  async loadAudienceFacts(input: AudienceFactsInput): Promise<AudienceFactsBatch> {
    let usersQuery = this.database
      .selectFrom("end_users")
      .selectAll()
      .where("project_id", "=", this.projectId);
    if (input.userId) usersQuery = usersQuery.where("id", "=", input.userId);
    if (input.afterUserId !== null) usersQuery = usersQuery.where("id", ">", input.afterUserId);
    const userRows = await usersQuery.orderBy("id").limit(input.limit + 1).execute();
    const hasMore = userRows.length > input.limit;
    const selected = userRows.slice(0, input.limit);
    const traitKeys = new Set(input.traitKeys);
    const users = selected.map((row) => {
      const user = userFromRow(row);
      user.traits = Object.fromEntries(Object.entries(user.traits).filter(([key]) => traitKeys.has(key)));
      return user;
    });
    if (users.length === 0 || input.eventNames.length === 0) {
      return { users, eventsByUser: new Map(), nextCursor: hasMore ? users.at(-1)?.id ?? null : null, overflow: false };
    }
    type RankedEvent = EventRow & { row_number: string };
    const userIds = users.map((user) => user.id);
    const result = await sql<RankedEvent>`
      select * from (
        select e.*, row_number() over (
          partition by e.end_user_id, e.name
          order by e.ts desc, e.id asc
        ) as row_number
        from events e
        where e.project_id = ${this.projectId}
          and e.end_user_id in (${sql.join(userIds)})
          and e.name in (${sql.join(input.eventNames)})
          and e.ts <= ${input.evaluatedAt}
      ) ranked
      where row_number <= ${input.maxOccurrences}
      order by end_user_id asc, name asc, ts desc, id asc
      limit ${input.eventRowBudget + 1}
    `.execute(this.database);
    const overflow = result.rows.length > input.eventRowBudget;
    const externalById = new Map(users.map((user) => [user.id, user.externalId]));
    const eventsByUser = new Map<string, ProductEvent[]>();
    for (const row of result.rows.slice(0, input.eventRowBudget)) {
      const values = eventsByUser.get(row.end_user_id) ?? [];
      values.push(eventFromRow(row, externalById.get(row.end_user_id)!));
      eventsByUser.set(row.end_user_id, values);
    }
    return { users, eventsByUser, nextCursor: hasMore ? users.at(-1)?.id ?? null : null, overflow };
  }

  async audiencePresence(input: { traitKeys: string[]; eventNames: string[] }): Promise<AudiencePresence> {
    const traits = new Set<string>();
    const events = new Set<string>();
    if (input.traitKeys.length > 0) {
      const result = await sql<{ key: string }>`
        select distinct keys.key
        from end_users u
        cross join lateral jsonb_object_keys(coalesce(u.traits_json, '{}')::jsonb) keys(key)
        where u.project_id = ${this.projectId} and keys.key in (${sql.join(input.traitKeys)})
      `.execute(this.database);
      result.rows.forEach((row) => traits.add(row.key));
    }
    if (input.eventNames.length > 0) {
      const rows = await this.database.selectFrom("events").select("name").distinct()
        .where("project_id", "=", this.projectId).where("name", "in", input.eventNames).execute();
      rows.forEach((row) => events.add(row.name));
    }
    return { traits, events };
  }

  async audienceCapabilities(): Promise<AudienceCapabilities> {
    type TraitRow = { key: string; users: string; types: Record<string, number>; representative: boolean; values: string[] | null };
    const traitResult = await sql<TraitRow>`
      with expanded as (
        select u.id, entry.key, entry.value, jsonb_typeof(entry.value) as type
        from end_users u
        cross join lateral jsonb_each(coalesce(u.traits_json, '{}')::jsonb) entry
        where u.project_id = ${this.projectId}
      ), grouped as (
        select key, type, count(*) as type_count from expanded group by key, type
      ), totals as (
        select key, count(*) as users,
          bool_and(type = 'string' and length(value #>> '{}') <= 256) as representative
        from expanded group by key
      )
      select t.key, t.users, t.representative,
        (select array(select distinct value #>> '{}' from expanded e where e.key = t.key and e.type = 'string' order by 1 limit 21)) as values,
        (select jsonb_object_agg(g.type, g.type_count) from grouped g where g.key = t.key) as types
      from totals t order by t.users desc, t.key asc limit ${MAX_CAPABILITY_TRAITS + 1}
    `.execute(this.database);
    type EventRowSummary = { name: string; users: string; occurrences: string; last_seen_at: number | string };
    const eventResult = await sql<EventRowSummary>`
      select name, count(distinct end_user_id) as users, count(*) as occurrences, max(ts) as last_seen_at
      from events where project_id = ${this.projectId}
      group by name order by users desc, name asc limit ${MAX_CAPABILITY_EVENTS + 1}
    `.execute(this.database);
    const eventNames = eventResult.rows.slice(0, MAX_CAPABILITY_EVENTS).map((row) => row.name);
    type PropertyRow = { event_name: string; key: string; types: Record<string, number>; occurrences: string; rank: string };
    const propertyResult = eventNames.length === 0 ? { rows: [] as PropertyRow[] } : await sql<PropertyRow>`
      with expanded as (
        select e.name as event_name, entry.key, jsonb_typeof(entry.value) as type
        from events e cross join lateral jsonb_each(coalesce(e.props_json, '{}')::jsonb) entry
        where e.project_id = ${this.projectId} and e.name in (${sql.join(eventNames)})
      ), grouped as (
        select event_name, key, type, count(*) as count from expanded group by event_name, key, type
      ), properties as (
        select event_name, key, sum(count) as occurrences, jsonb_object_agg(type, count) as types
        from grouped group by event_name, key
      )
      select * from (
        select *, row_number() over (partition by event_name order by occurrences desc, key asc) as rank
        from properties
      ) ranked where rank <= 51
    `.execute(this.database);
    const propertiesByEvent = new Map<string, PropertyRow[]>();
    for (const row of propertyResult.rows) {
      const values = propertiesByEvent.get(row.event_name) ?? [];
      values.push(row);
      propertiesByEvent.set(row.event_name, values);
    }
    const base = buildAudienceCapabilities([], []);
    return {
      ...base,
      traits: traitResult.rows.slice(0, MAX_CAPABILITY_TRAITS).map((row) => ({
        key: row.key,
        types: row.types,
        users: integer(row.users),
        ...(row.representative && (row.values?.length ?? 0) <= 20 ? { values: row.values ?? [] } : {}),
      })),
      traitsTruncated: traitResult.rows.length > MAX_CAPABILITY_TRAITS,
      events: eventResult.rows.slice(0, MAX_CAPABILITY_EVENTS).map((row) => {
        const properties = propertiesByEvent.get(row.name) ?? [];
        return {
          name: row.name,
          users: integer(row.users),
          occurrences: integer(row.occurrences),
          lastSeenAt: integer(row.last_seen_at),
          properties: properties.filter((property) => integer(property.rank) <= 50).map((property) => ({ key: property.key, types: property.types })),
          propertiesTruncated: properties.length > 50,
        };
      }),
      eventsTruncated: eventResult.rows.length > MAX_CAPABILITY_EVENTS,
    };
  }

  async queryEvents(input: EventQuery) {
    const filtered = () => {
      let query = this.database
        .selectFrom("events")
        .innerJoin("end_users", "end_users.id", "events.end_user_id")
        .where("events.project_id", "=", this.projectId)
        .where("end_users.project_id", "=", this.projectId);
      if (input.name) query = query.where("events.name", "=", input.name);
      if (input.query) query = query.where(sql<boolean>`events.name ilike ${containsPattern(input.query)} escape '\\'`);
      if (input.userId) query = query.where("events.end_user_id", "=", input.userId);
      if (input.externalUserId) query = query.where("end_users.external_user_id", "=", input.externalUserId);
      if (input.since !== null) query = query.where("events.ts", ">=", input.since);
      if (input.until !== null) query = query.where("events.ts", "<=", input.until);
      return query;
    };
    const count = await filtered().select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const rows = await filtered()
      .selectAll("events")
      .select("end_users.external_user_id")
      .orderBy("events.ts", "desc")
      .orderBy("events.id")
      .offset(input.offset)
      .limit(input.limit)
      .execute();
    return { values: rows.map((row) => eventFromRow(row, row.external_user_id)), total: integer(count.count) };
  }

  async listConversionCandidatesForUpdate(userId: string, eventName: string, occurredAt: number) {
    const rows = await this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .leftJoin("goals", "goals.id", "campaigns.goal_id")
      .selectAll("deliveries")
      .select("goals.target_event")
      .where("campaigns.project_id", "=", this.projectId)
      .where("deliveries.end_user_id", "=", userId)
      .where("goals.target_event", "=", eventName)
      .where("deliveries.shown_at", "is not", null)
      .where("deliveries.shown_at", "<=", occurredAt)
      .where("deliveries.converted_at", "is", null)
      .forUpdate("deliveries")
      .execute();
    return rows.map(deliveryFromRow);
  }

  async createGoal(goal: ProductGoal) {
    await this.database.insertInto("goals").values({
      id: goal.id,
      project_id: this.projectId,
      name: goal.name,
      description: goal.description,
      target_event: goal.targetEvent,
      guardrails_json: goal.guardrails === null ? null : JSON.stringify(goal.guardrails),
      approval_mode: goal.approvalMode,
      status: goal.status,
      created_at: goal.createdAt,
    }).execute();
  }

  async getGoal(id: string) {
    const row = await this.database
      .selectFrom("goals")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? goalFromRow(row) : null;
  }

  async getGoalForUpdate(id: string) {
    const row = await this.database
      .selectFrom("goals")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    return row ? goalFromRow(row) : null;
  }

  async queryGoals(limit: number) {
    const rows = await this.database
      .selectFrom("goals")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
    return rows.map(goalFromRow);
  }

  async saveGoal(goal: ProductGoal) {
    await this.database
      .updateTable("goals")
      .set({
        name: goal.name,
        description: goal.description,
        target_event: goal.targetEvent,
        guardrails_json: goal.guardrails === null ? null : JSON.stringify(goal.guardrails),
        approval_mode: goal.approvalMode,
        status: goal.status,
      })
      .where("project_id", "=", this.projectId)
      .where("id", "=", goal.id)
      .executeTakeFirst();
  }

  async createCampaign(campaign: ProductCampaign) {
    if (campaign.audience.kind === "expression") {
      await this.database.insertInto("audience_versions").values({
        id: campaign.audience.audienceVersionId,
        project_id: this.projectId,
        segment_id: null,
        segment_version: null,
        schema_version: campaign.audience.schemaVersion,
        expression_json: campaign.audience.expressionJson,
        expression_hash: campaign.audience.expressionHash,
        reason: campaign.audience.reason,
        agent_run_id: null,
        created_by: "api",
        created_at: campaign.createdAt,
      }).execute();
    }
    const audienceColumns = campaignAudienceColumns(campaign.audience);
    await this.database.insertInto("campaigns").values({
      id: campaign.id,
      project_id: this.projectId,
      goal_id: campaign.goalId,
      name: campaign.name,
      channel: campaign.channel,
      status: campaign.status,
      ...audienceColumns,
      pages_json: campaign.pages === null ? null : JSON.stringify(campaign.pages),
      hypothesis: null,
      created_by: "api",
      created_at: campaign.createdAt,
      started_at: campaign.startedAt,
      ended_at: campaign.endedAt,
      deliver_from: campaign.deliverFrom,
      deliver_until: campaign.deliverUntil,
    }).execute();
    await this.database.insertInto("variants").values(campaign.variants.map((variant) => ({
      id: variant.id,
      campaign_id: variant.campaign_id,
      name: variant.name,
      content_json: variant.content_json,
      weight: variant.weight,
      is_control: variant.isControl,
    }))).execute();
  }

  private async hydrateCampaignRows(rows: CampaignRow[]) {
    if (rows.length === 0) return [];
    const variants = await this.database.selectFrom("variants").selectAll()
      .where("campaign_id", "in", rows.map((row) => row.id)).orderBy("id").execute();
    const variantsByCampaign = new Map<string, ProductVariant[]>();
    for (const row of variants) {
      const values = variantsByCampaign.get(row.campaign_id) ?? [];
      values.push(variantFromRow(row));
      variantsByCampaign.set(row.campaign_id, values);
    }
    const versionIds = rows.map((row) => row.audience_version_id).filter((value): value is string => value !== null);
    const versions = versionIds.length === 0 ? [] : await this.database.selectFrom("audience_versions").selectAll()
      .where("project_id", "=", this.projectId).where("id", "in", versionIds).execute();
    const segmentIds = versions.map((version) => version.segment_id).filter((value): value is string => value !== null);
    const segments = segmentIds.length === 0 ? [] : await this.database.selectFrom("segments").selectAll()
      .where("project_id", "=", this.projectId).where("id", "in", segmentIds).execute();
    const versionsById = new Map(versions.map((version) => [version.id, version]));
    const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
    return rows.map((row) => {
      const campaign = campaignFromRow(row, variantsByCampaign.get(row.id) ?? []);
      if (row.audience_version_id !== null) {
        const version = versionsById.get(row.audience_version_id);
        campaign.audience = version
          ? campaignAudienceFromRow(version, version.segment_id ? segmentsById.get(version.segment_id) ?? null : null)
          : { kind: "invalid", audienceVersionId: row.audience_version_id, targetingJson: null };
      }
      return campaign;
    });
  }

  private async loadCampaigns(id?: string, status?: ProductCampaign["status"], lock = false) {
    let query = this.database
      .selectFrom("campaigns")
      .selectAll()
      .where("project_id", "=", this.projectId);
    if (id) query = query.where("id", "=", id);
    if (status) query = query.where("status", "=", status);
    query = query.orderBy("created_at");
    if (lock) query = query.forUpdate();
    const rows = await query.execute();
    return this.hydrateCampaignRows(rows);
  }

  async getCampaign(id: string) {
    return (await this.loadCampaigns(id))[0] ?? null;
  }

  async getCampaignForUpdate(id: string) {
    return (await this.loadCampaigns(id, undefined, true))[0] ?? null;
  }

  async queryCampaigns(input: CampaignQuery) {
    const at = input.evaluatedAt;
    const filtered = () => {
      let query = this.database.selectFrom("campaigns").where("project_id", "=", this.projectId);
      if (input.query) query = query.where(sql<boolean>`name ilike ${containsPattern(input.query)} escape '\\'`);
      if (input.effectiveStatus === "draft") query = query.where("status", "=", "draft");
      if (input.effectiveStatus === "ended") query = query.where("status", "=", "ended");
      if (input.effectiveStatus === "expired") {
        query = query.where("status", "in", ["running", "paused"]).where("deliver_until", "is not", null).where("deliver_until", "<=", at);
      }
      if (input.effectiveStatus === "scheduled") {
        query = query.where("status", "=", "running")
          .where((eb) => eb.or([eb("deliver_until", "is", null), eb("deliver_until", ">", at)]))
          .where("deliver_from", "is not", null).where("deliver_from", ">", at);
      }
      if (input.effectiveStatus === "running") {
        query = query.where("status", "=", "running")
          .where((eb) => eb.or([eb("deliver_until", "is", null), eb("deliver_until", ">", at)]))
          .where((eb) => eb.or([eb("deliver_from", "is", null), eb("deliver_from", "<=", at)]));
      }
      if (input.effectiveStatus === "paused") {
        query = query.where("status", "=", "paused")
          .where((eb) => eb.or([eb("deliver_until", "is", null), eb("deliver_until", ">", at)]));
      }
      return query;
    };
    const count = await filtered().select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const rows = await filtered()
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .offset(input.offset)
      .limit(input.limit)
      .execute();
    return { values: await this.hydrateCampaignRows(rows), total: integer(count.count) };
  }

  async campaignStatsForCampaigns(campaignIds: string[]) {
    if (campaignIds.length === 0) return new Map<string, CampaignStats>();
    type StatsRow = {
      campaign_id: string;
      variant_id: string;
      sent: string;
      frequency_capped: string;
      delivered: string;
      shown: string;
      opened: string;
      clicked: string;
      dismissed: string;
      bounced: string;
      complained: string;
      unsubscribed: string;
      converted: string;
    };
    const result = await sql<StatsRow>`
      select c.id as campaign_id, v.id as variant_id,
        count(d.id) filter (where d.sent_at is not null) as sent,
        count(d.id) filter (where d.state = 'frequency_capped') as frequency_capped,
        count(d.id) filter (where d.delivered_at is not null) as delivered,
        count(d.id) filter (where d.shown_at is not null) as shown,
        count(d.id) filter (where d.opened_at is not null) as opened,
        count(d.id) filter (where d.clicked_at is not null) as clicked,
        count(d.id) filter (where d.dismissed_at is not null) as dismissed,
        count(d.id) filter (where d.bounced_at is not null) as bounced,
        count(d.id) filter (where d.complained_at is not null) as complained,
        count(d.id) filter (where d.unsubscribed_at is not null) as unsubscribed,
        count(d.id) filter (where d.converted_at is not null) as converted
      from campaigns c join variants v on v.campaign_id = c.id
      left join deliveries d on d.campaign_id = c.id and d.variant_id = v.id
      where c.project_id = ${this.projectId} and c.id in (${sql.join(campaignIds)})
      group by c.id, v.id
    `.execute(this.database);
    const resultMap = new Map<string, CampaignStats>();
    for (const row of result.rows) {
      const values = {
        sent: integer(row.sent), frequencyCapped: integer(row.frequency_capped), delivered: integer(row.delivered),
        shown: integer(row.shown), opened: integer(row.opened), clicked: integer(row.clicked), dismissed: integer(row.dismissed),
        bounced: integer(row.bounced), complained: integer(row.complained), unsubscribed: integer(row.unsubscribed), converted: integer(row.converted),
      };
      const campaign = resultMap.get(row.campaign_id) ?? { total: { sent: 0, frequencyCapped: 0, delivered: 0, shown: 0, opened: 0, clicked: 0, dismissed: 0, bounced: 0, complained: 0, unsubscribed: 0, converted: 0 }, variants: new Map() };
      campaign.variants.set(row.variant_id, values);
      for (const key of Object.keys(values) as (keyof typeof values)[]) campaign.total[key] += values[key];
      resultMap.set(row.campaign_id, campaign);
    }
    return resultMap;
  }

  async saveCampaignContent(campaign: ProductCampaign) {
    if (campaign.audience.kind === "expression") {
      await this.database.insertInto("audience_versions").values({
        id: campaign.audience.audienceVersionId,
        project_id: this.projectId,
        segment_id: null,
        segment_version: null,
        schema_version: campaign.audience.schemaVersion,
        expression_json: campaign.audience.expressionJson,
        expression_hash: campaign.audience.expressionHash,
        reason: campaign.audience.reason,
        agent_run_id: null,
        created_by: "api",
        created_at: campaign.createdAt,
      }).onConflict((conflict) => conflict.column("id").doNothing()).execute();
    }
    const audienceColumns = campaignAudienceColumns(campaign.audience);
    await this.database
      .updateTable("campaigns")
      .set({
        name: campaign.name,
        goal_id: campaign.goalId,
        pages_json: campaign.pages === null ? null : JSON.stringify(campaign.pages),
        deliver_from: campaign.deliverFrom,
        deliver_until: campaign.deliverUntil,
        ...audienceColumns,
      })
      .where("project_id", "=", this.projectId)
      .where("id", "=", campaign.id)
      .executeTakeFirst();
    for (const variant of campaign.variants) {
      const updated = await this.database
        .updateTable("variants")
        .set({
          name: variant.name,
          content_json: variant.content_json,
          weight: variant.weight,
          is_control: variant.isControl,
        })
        .where("campaign_id", "=", campaign.id)
        .where("id", "=", variant.id)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) continue;
      await this.database.insertInto("variants").values({
        id: variant.id,
        campaign_id: campaign.id,
        name: variant.name,
        content_json: variant.content_json,
        weight: variant.weight,
        is_control: variant.isControl,
      }).execute();
    }
  }

  async saveCampaignLifecycle(campaign: ProductCampaign) {
    await this.database
      .updateTable("campaigns")
      .set({
        status: campaign.status,
        started_at: campaign.startedAt,
        ended_at: campaign.endedAt,
      })
      .where("project_id", "=", this.projectId)
      .where("id", "=", campaign.id)
      .executeTakeFirst();
  }

  async getOrCreateDelivery(delivery: ProductDelivery) {
    const inserted = await this.database
      .insertInto("deliveries")
      .values({
        id: delivery.id,
        campaign_id: delivery.campaignId,
        variant_id: delivery.variantId,
        end_user_id: delivery.userId,
        provider_message_id: null,
        state: delivery.state,
        queued_at: delivery.queuedAt,
        send_attempted_at: null,
        sent_at: delivery.sentAt,
        delivered_at: delivery.deliveredAt,
        shown_at: delivery.shownAt,
        opened_at: delivery.openedAt,
        clicked_at: delivery.clickedAt,
        dismissed_at: delivery.dismissedAt,
        bounced_at: delivery.bouncedAt,
        complained_at: delivery.complainedAt,
        unsubscribed_at: delivery.unsubscribedAt,
        converted_at: delivery.convertedAt,
      })
      .onConflict((conflict) => conflict.columns(["campaign_id", "end_user_id"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return deliveryFromRow(inserted);
    const existing = await this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .selectAll("deliveries")
      .where("campaigns.project_id", "=", this.projectId)
      .where("deliveries.campaign_id", "=", delivery.campaignId)
      .where("deliveries.end_user_id", "=", delivery.userId)
      .executeTakeFirstOrThrow();
    return deliveryFromRow(existing);
  }

  async getDeliveryForUpdate(id: string) {
    const row = await this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .selectAll("deliveries")
      .where("campaigns.project_id", "=", this.projectId)
      .where("deliveries.id", "=", id)
      .forUpdate("deliveries")
      .executeTakeFirst();
    return row ? deliveryFromRow(row) : null;
  }

  async saveDelivery(delivery: ProductDelivery) {
    const projectCampaigns = this.database
      .selectFrom("campaigns")
      .select("id")
      .where("project_id", "=", this.projectId);
    await this.database
      .updateTable("deliveries")
      .set({
        state: delivery.state,
        sent_at: delivery.sentAt,
        delivered_at: delivery.deliveredAt,
        shown_at: delivery.shownAt,
        opened_at: delivery.openedAt,
        clicked_at: delivery.clickedAt,
        dismissed_at: delivery.dismissedAt,
        bounced_at: delivery.bouncedAt,
        complained_at: delivery.complainedAt,
        unsubscribed_at: delivery.unsubscribedAt,
        converted_at: delivery.convertedAt,
      })
      .where("id", "=", delivery.id)
      .where("campaign_id", "in", projectCampaigns)
      .executeTakeFirst();
  }

  async findFirstEventAtOrAfter(userId: string, name: string, occurredAt: number) {
    const row = await this.database
      .selectFrom("events")
      .innerJoin("end_users", "end_users.id", "events.end_user_id")
      .selectAll("events")
      .select("end_users.external_user_id")
      .where("events.project_id", "=", this.projectId)
      .where("end_users.project_id", "=", this.projectId)
      .where("events.end_user_id", "=", userId)
      .where("events.name", "=", name)
      .where("events.ts", ">=", occurredAt)
      .orderBy("events.ts")
      .executeTakeFirst();
    return row ? eventFromRow(row, row.external_user_id) : null;
  }

  async queryCampaignDeliveries(input: DeliveryQuery) {
    const filtered = () => {
      let query = this.database
        .selectFrom("deliveries")
        .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
        .where("campaigns.project_id", "=", this.projectId)
        .where("deliveries.campaign_id", "=", input.campaignId);
      if (input.state !== null) query = query.where("deliveries.state", "=", input.state);
      return query;
    };
    const count = await filtered().select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const rows = await filtered()
      .selectAll("deliveries")
      .orderBy("deliveries.queued_at", "desc")
      .orderBy("deliveries.id", "desc")
      .offset(input.offset)
      .limit(input.limit)
      .execute();
    return { values: rows.map(deliveryFromRow), total: integer(count.count) };
  }

  async queryUserDeliveries(input: UserDeliveryQuery) {
    const filtered = () => this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .innerJoin("variants", "variants.id", "deliveries.variant_id")
      .where("campaigns.project_id", "=", this.projectId)
      .where("deliveries.end_user_id", "=", input.userId);
    const count = await filtered().select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const rows = await filtered()
      .select([
        "deliveries.id as id",
        "deliveries.state as state",
        "deliveries.queued_at as queued_at",
        "campaigns.id as campaign_id",
        "campaigns.name as campaign_name",
        "variants.id as variant_id",
        "variants.name as variant_name",
      ])
      .orderBy("deliveries.queued_at", "desc")
      .orderBy("deliveries.id", "desc")
      .offset(input.offset)
      .limit(input.limit)
      .execute();
    const total = integer(count.count);
    return {
      deliveries: rows.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        variantId: row.variant_id,
        variantName: row.variant_name,
        state: row.state as UserDelivery["state"],
        queuedAt: integer(row.queued_at),
      })),
      total,
      page: Math.floor(input.offset / input.limit) + 1,
      pageCount: pageCountFor(total, input.limit),
    };
  }

  async projectOverview(evaluatedAt: number) {
    const [users, events, campaigns] = await Promise.all([
      this.database.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).executeTakeFirstOrThrow(),
      this.database.selectFrom("events").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId)
        .where("ts", ">=", evaluatedAt - WEEK_MS)
        .where("ts", "<=", evaluatedAt)
        .executeTakeFirstOrThrow(),
      this.database.selectFrom("campaigns").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).where("status", "=", "running").executeTakeFirstOrThrow(),
    ]);
    return {
      evaluatedAt,
      endUsers: integer(users.count),
      eventsLast7d: integer(events.count),
      activeCampaigns: integer(campaigns.count),
    };
  }

  async projectActivity(input: ActivityQuery): Promise<ActivityItem[]> {
    const after = input.after;
    let deliveryQuery = this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .innerJoin("variants", "variants.id", "deliveries.variant_id")
      .innerJoin("end_users", "end_users.id", "deliveries.end_user_id")
      .select([
        "deliveries.id as id",
        "deliveries.queued_at as occurred_at",
        "end_users.id as user_id",
        "end_users.external_user_id as external_user_id",
        "campaigns.id as campaign_id",
        "campaigns.name as campaign_name",
        "variants.id as variant_id",
        "variants.name as variant_name",
      ])
      .where("campaigns.project_id", "=", this.projectId);
    if (after !== null) {
      deliveryQuery = deliveryQuery.where((eb) => eb.or([
        eb("deliveries.queued_at", "<", after.occurredAt),
        ...(after.kind === "delivery"
          ? [eb.and([eb("deliveries.queued_at", "=", after.occurredAt), eb("deliveries.id", "<", after.id)])]
          : []),
      ]));
    }
    const deliveryRows = await deliveryQuery
      .orderBy("deliveries.queued_at", "desc")
      .orderBy("deliveries.id", "desc")
      .limit(input.limit)
      .execute();
    let userQuery = this.database
      .selectFrom("end_users")
      .select(["id", "external_user_id", "first_seen_at"])
      .where("project_id", "=", this.projectId);
    if (after !== null) {
      userQuery = userQuery.where((eb) => eb.or([
        eb("first_seen_at", "<", after.occurredAt),
        after.kind === "delivery"
          ? eb("first_seen_at", "=", after.occurredAt)
          : eb.and([eb("first_seen_at", "=", after.occurredAt), eb("id", "<", after.id)]),
      ]));
    }
    const userRows = await userQuery
      .orderBy("first_seen_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit)
      .execute();
    const items: ActivityItem[] = [
      ...deliveryRows.map((row) => ({
        kind: "delivery" as const,
        id: row.id,
        occurredAt: integer(row.occurred_at),
        user: { id: row.user_id, externalUserId: row.external_user_id },
        campaign: { id: row.campaign_id, name: row.campaign_name },
        variant: { id: row.variant_id, name: row.variant_name },
      })),
      ...userRows.map((row) => ({
        kind: "user" as const,
        id: row.id,
        occurredAt: integer(row.first_seen_at),
        user: { id: row.id, externalUserId: row.external_user_id },
      })),
    ];
    return items.filter((item) => isAfterCursor(item, after)).sort(compareActivity).slice(0, input.limit);
  }

  async projectMetrics(input: MetricsQuery): Promise<MetricsAggregate> {
    const buckets = new Map<number, MetricTotals>();
    const bucketFor = (bucket: number) => {
      const existing = buckets.get(bucket);
      if (existing) return existing;
      const created = emptyMetricTotals();
      buckets.set(bucket, created);
      return created;
    };
    type BucketRow = { bucket: string | number; count: string };
    const deliveryBuckets = async (column: "shown_at" | "clicked_at" | "converted_at") => {
      const result = await sql<BucketRow>`
        select floor(d.${sql.raw(column)} / ${DAY_MS}) as bucket, count(*) as count
        from deliveries d join campaigns c on c.id = d.campaign_id
        where c.project_id = ${this.projectId}
          and d.${sql.raw(column)} >= ${input.since}
          and d.${sql.raw(column)} <= ${input.until}
        group by 1
      `.execute(this.database);
      return result.rows;
    };
    const [impressions, clicks, conversions] = await Promise.all([
      deliveryBuckets("shown_at"),
      deliveryBuckets("clicked_at"),
      deliveryBuckets("converted_at"),
    ]);
    for (const row of impressions) bucketFor(integer(row.bucket)).impressions += integer(row.count);
    for (const row of clicks) bucketFor(integer(row.bucket)).clicks += integer(row.count);
    for (const row of conversions) bucketFor(integer(row.bucket)).conversions += integer(row.count);
    const eventRows = await sql<BucketRow>`
      select floor(ts / ${DAY_MS}) as bucket, count(*) as count
      from events
      where project_id = ${this.projectId}
        and ts >= ${input.since}
        and ts <= ${input.until}
      group by 1
    `.execute(this.database);
    for (const row of eventRows.rows) bucketFor(integer(row.bucket)).events += integer(row.count);
    const topEventRows = await this.database
      .selectFrom("events")
      .select(({ fn }) => ["name", fn.countAll().as("count")] as const)
      .where("project_id", "=", this.projectId)
      .where("ts", ">=", input.since)
      .where("ts", "<=", input.until)
      .groupBy("name")
      .orderBy("count", "desc")
      .orderBy("name", "asc")
      .limit(TOP_EVENT_LIMIT)
      .execute();
    const anyDelivery = await this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .select("deliveries.id")
      .where("campaigns.project_id", "=", this.projectId)
      .where("deliveries.queued_at", "<=", input.until)
      .limit(1)
      .executeTakeFirst();
    return {
      buckets,
      topEvents: topEventRows.map((row) => ({ name: row.name, count: integer(row.count) })),
      hasAnyDelivery: anyDelivery !== undefined,
    };
  }

  async userSummary(startAt: number) {
    const [total, active, fresh] = await Promise.all([
      this.database.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).executeTakeFirstOrThrow(),
      this.database.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).where("last_seen_at", ">=", startAt).executeTakeFirstOrThrow(),
      this.database.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).where("first_seen_at", ">=", startAt).executeTakeFirstOrThrow(),
    ]);
    return { totalUsers: integer(total.count), activeUsers: integer(active.count), newUsers: integer(fresh.count) };
  }

  async agentRunReferences(goalIds: string[], campaignIds: string[]): Promise<AgentRunReferences> {
    const goalRows = goalIds.length === 0 ? [] : await this.database.selectFrom("goals").select(["id", "name"])
      .where("project_id", "=", this.projectId).where("id", "in", goalIds).execute();
    const campaignRows = campaignIds.length === 0 ? [] : await this.database.selectFrom("campaigns").select(["id", "name"])
      .where("project_id", "=", this.projectId).where("id", "in", campaignIds).execute();
    return {
      goals: Object.fromEntries(goalRows.map((row) => [row.id, row.name])),
      campaigns: Object.fromEntries(campaignRows.map((row) => [row.id, row.name])),
    };
  }

  async getAgentRun(id: string) {
    const row = await this.database.selectFrom("agent_runs").selectAll()
      .where("project_id", "=", this.projectId).where("id", "=", id).executeTakeFirst();
    return row ? agentRunFromRow(row) : null;
  }

  async queryAgentRuns(input: AgentRunQuery) {
    const filtered = () => {
      let query = this.database.selectFrom("agent_runs").where("project_id", "=", this.projectId);
      if (input.kind) query = query.where("kind", "=", input.kind);
      if (input.goalId) query = query.where("goal_id", "=", input.goalId);
      if (input.campaignId) query = query.where("campaign_id", "=", input.campaignId);
      return query;
    };
    const count = await filtered().select(({ fn }) => fn.countAll().as("count")).executeTakeFirstOrThrow();
    const rows = await filtered()
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id")
      .offset(input.offset)
      .limit(input.limit)
      .execute();
    return { values: rows.map(agentRunFromRow), total: integer(count.count) };
  }

  async campaignEventConversionSummary(campaignId: string, eventName: string, evaluatedAt: number): Promise<CampaignConversionSummary> {
    type SummaryRow = {
      variant_id: string;
      exposed_deliveries: string;
      exposed_users: string;
      converted_deliveries: string;
      converted_users: string;
    };
    const result = await sql<SummaryRow>`
      select
        d.variant_id,
        count(*) filter (where d.shown_at is not null and d.shown_at <= ${evaluatedAt}) as exposed_deliveries,
        count(distinct d.end_user_id) filter (where d.shown_at is not null and d.shown_at <= ${evaluatedAt}) as exposed_users,
        count(*) filter (
          where d.shown_at is not null
            and d.shown_at <= ${evaluatedAt}
            and exists (
              select 1 from events e
              where e.project_id = ${this.projectId}
                and e.end_user_id = d.end_user_id
                and e.name = ${eventName}
                and e.ts >= d.shown_at
                and e.ts <= ${evaluatedAt}
            )
        ) as converted_deliveries,
        count(distinct d.end_user_id) filter (
          where d.shown_at is not null
            and d.shown_at <= ${evaluatedAt}
            and exists (
              select 1 from events e
              where e.project_id = ${this.projectId}
                and e.end_user_id = d.end_user_id
                and e.name = ${eventName}
                and e.ts >= d.shown_at
                and e.ts <= ${evaluatedAt}
            )
        ) as converted_users
      from deliveries d
      join campaigns c on c.id = d.campaign_id
      where c.project_id = ${this.projectId} and d.campaign_id = ${campaignId}
      group by d.variant_id
    `.execute(this.database);
    const variants = new Map<string, ConversionCounts>();
    const totals = { exposedDeliveries: 0, exposedUsers: 0, convertedDeliveries: 0, convertedUsers: 0 };
    for (const row of result.rows) {
      const counts = {
        exposedDeliveries: integer(row.exposed_deliveries),
        exposedUsers: integer(row.exposed_users),
        convertedDeliveries: integer(row.converted_deliveries),
        convertedUsers: integer(row.converted_users),
      };
      variants.set(row.variant_id, counts);
      totals.exposedDeliveries += counts.exposedDeliveries;
      totals.exposedUsers += counts.exposedUsers;
      totals.convertedDeliveries += counts.convertedDeliveries;
      totals.convertedUsers += counts.convertedUsers;
    }
    return { totals, variants };
  }

  async usageSummary(start: number, end: number) {
    const active = await sql<{ count: string }>`
      select count(*) as count from (
        select id from end_users
        where project_id = ${this.projectId} and last_seen_at >= ${start} and last_seen_at < ${end}
        union
        select d.end_user_id from deliveries d
        join campaigns c on c.id = d.campaign_id
        where c.project_id = ${this.projectId} and d.shown_at >= ${start} and d.shown_at < ${end}
      ) active_users
    `.execute(this.database);
    const capped = await this.database
      .selectFrom("deliveries")
      .innerJoin("campaigns", "campaigns.id", "deliveries.campaign_id")
      .select(({ fn }) => fn.countAll().as("count"))
      .where("campaigns.project_id", "=", this.projectId)
      .where("deliveries.state", "=", "frequency_capped")
      .where("deliveries.queued_at", ">=", start)
      .where("deliveries.queued_at", "<", end)
      .executeTakeFirstOrThrow();
    return { activeUsers: integer(active.rows[0].count), frequencyCapped: integer(capped.count) };
  }

  async getOrCreateAgentRun(run: ProductAgentRun) {
    let insert = this.database
      .insertInto("agent_runs")
      .values({
        id: run.id,
        project_id: this.projectId,
        goal_id: run.goalId,
        campaign_id: run.campaignId,
        kind: run.kind,
        input_json: run.input === null ? null : JSON.stringify(run.input),
        output_json: run.output === null ? null : JSON.stringify(run.output),
        rationale: run.rationale,
        idempotency_key: run.idempotencyKey,
        created_at: run.createdAt,
      });
    if (run.idempotencyKey) {
      insert = insert.onConflict((conflict) => conflict
        .columns(["project_id", "idempotency_key"])
        .where("idempotency_key", "is not", null)
        .doNothing());
    }
    const inserted = await insert.returningAll().executeTakeFirst();
    if (inserted) return { run: agentRunFromRow(inserted), created: true };
    const existing = await this.database
      .selectFrom("agent_runs")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("idempotency_key", "=", run.idempotencyKey!)
      .executeTakeFirstOrThrow();
    return { run: agentRunFromRow(existing), created: false };
  }

  async createSegment(segment: ProductSegment, version: ProductAudienceVersion) {
    const inserted = await this.database
      .insertInto("segments")
      .values({
        id: segment.id,
        project_id: this.projectId,
        key: segment.key,
        name: segment.name,
        description: segment.description,
        status: segment.status,
        current_version: segment.currentVersion,
        idempotency_key: segment.idempotencyKey,
        created_by: segment.createdBy,
        created_at: segment.createdAt,
        updated_at: segment.updatedAt,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!inserted) {
      if (segment.idempotencyKey === null) return { kind: "key_conflict" as const };
      const existing = await this.database
        .selectFrom("segments")
        .selectAll()
        .where("project_id", "=", this.projectId)
        .where("idempotency_key", "=", segment.idempotencyKey)
        .executeTakeFirst();
      if (!existing) return { kind: "key_conflict" as const };
      const existingSegment = segmentFromRow(existing);
      const existingVersion = await this.getSegmentVersion(existingSegment.id, existingSegment.currentVersion);
      if (!existingVersion) throw new Error(`Missing current audience version for segment: ${existingSegment.id}`);
      return { kind: "replayed" as const, segment: existingSegment, version: existingVersion };
    }
    await this.database.insertInto("audience_versions").values({
      id: version.id,
      project_id: this.projectId,
      segment_id: version.segmentId,
      segment_version: version.segmentVersion,
      schema_version: version.schemaVersion,
      expression_json: version.expressionJson,
      expression_hash: version.expressionHash,
      reason: version.reason,
      agent_run_id: version.agentRunId,
      created_by: version.createdBy,
      created_at: version.createdAt,
    }).execute();
    return { kind: "created" as const, segment: segmentFromRow(inserted), version };
  }

  async getSegment(idOrKey: string) {
    const row = await this.database
      .selectFrom("segments")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where((expression) => expression.or([
        expression("id", "=", idOrKey),
        expression("key", "=", idOrKey),
      ]))
      .executeTakeFirst();
    return row ? segmentFromRow(row) : null;
  }

  async getSegmentForUpdate(idOrKey: string) {
    const row = await this.database
      .selectFrom("segments")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where((expression) => expression.or([
        expression("id", "=", idOrKey),
        expression("key", "=", idOrKey),
      ]))
      .forUpdate()
      .executeTakeFirst();
    return row ? segmentFromRow(row) : null;
  }

  async querySegments(status: ProductSegment["status"] | null, limit: number) {
    let query = this.database
      .selectFrom("segments")
      .selectAll()
      .where("project_id", "=", this.projectId);
    if (status !== null) query = query.where("status", "=", status);
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
      .limit(limit)
      .execute();
    return rows.map(segmentFromRow);
  }

  async reviseSegment(idOrKey: string, revision: SegmentRevision): Promise<SegmentMutationResult> {
    const row = await this.database
      .selectFrom("segments")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where((expression) => expression.or([
        expression("id", "=", idOrKey),
        expression("key", "=", idOrKey),
      ]))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { kind: "not_found" };
    const segment = segmentFromRow(row);
    if (revision.version && segment.status === "archived") {
      return { kind: "archived", currentVersion: segment.currentVersion };
    }
    if (revision.version && segment.currentVersion !== revision.expectedVersion) {
      return { kind: "stale", currentVersion: segment.currentVersion };
    }
    let version = await this.getSegmentVersion(segment.id, segment.currentVersion);
    if (!version) throw new Error(`Missing current audience version for segment: ${segment.id}`);
    if (revision.version) {
      version = {
        ...revision.version,
        segmentId: segment.id,
        segmentVersion: segment.currentVersion + 1,
      };
      await this.database.insertInto("audience_versions").values({
        id: version.id,
        project_id: this.projectId,
        segment_id: version.segmentId,
        segment_version: version.segmentVersion,
        schema_version: version.schemaVersion,
        expression_json: version.expressionJson,
        expression_hash: version.expressionHash,
        reason: version.reason,
        agent_run_id: version.agentRunId,
        created_by: version.createdBy,
        created_at: version.createdAt,
      }).execute();
      segment.currentVersion = version.segmentVersion;
    }
    if (revision.name !== undefined) segment.name = revision.name;
    if (revision.description !== undefined) segment.description = revision.description;
    segment.updatedAt = revision.updatedAt;
    await this.database
      .updateTable("segments")
      .set({
        name: segment.name,
        description: segment.description,
        current_version: segment.currentVersion,
        updated_at: segment.updatedAt,
      })
      .where("project_id", "=", this.projectId)
      .where("id", "=", segment.id)
      .executeTakeFirstOrThrow();
    return { kind: "updated", segment, version };
  }

  async archiveSegment(idOrKey: string, updatedAt: number) {
    const row = await this.database
      .selectFrom("segments")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where((expression) => expression.or([
        expression("id", "=", idOrKey),
        expression("key", "=", idOrKey),
      ]))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return { kind: "not_found" as const };
    const segment = segmentFromRow(row);
    if (segment.status === "archived") return { kind: "already_archived" as const };
    segment.status = "archived";
    segment.updatedAt = updatedAt;
    await this.database
      .updateTable("segments")
      .set({ status: segment.status, updated_at: segment.updatedAt })
      .where("project_id", "=", this.projectId)
      .where("id", "=", segment.id)
      .executeTakeFirstOrThrow();
    const version = await this.getSegmentVersion(segment.id, segment.currentVersion);
    if (!version) throw new Error(`Missing current audience version for segment: ${segment.id}`);
    return { kind: "archived" as const, segment, version };
  }

  async listSegmentVersions(segmentId: string) {
    const rows = await this.database
      .selectFrom("audience_versions")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("segment_id", "=", segmentId)
      .orderBy("segment_version", "desc")
      .execute();
    return rows.map(audienceVersionFromRow);
  }

  async getSegmentVersion(segmentId: string, version: number) {
    const row = await this.database
      .selectFrom("audience_versions")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("segment_id", "=", segmentId)
      .where("segment_version", "=", version)
      .executeTakeFirst();
    return row ? audienceVersionFromRow(row) : null;
  }
}

class PostgresProductStore extends PostgresProductSession implements ProductStore {
  constructor(
    private readonly rootDatabase: Kysely<ServerProductDB>,
    projectId: string,
  ) {
    super(rootDatabase, projectId);
  }

  async transaction<T>(work: (store: ProductStoreSession) => Promise<T>) {
    return this.rootDatabase.transaction().execute((transaction) => work(new PostgresProductSession(transaction, this.projectId)));
  }

  async withReadSnapshot<T>(work: (store: ProductStoreAccess) => Promise<T>) {
    return this.rootDatabase.transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute((transaction) => work(new PostgresProductSession(transaction, this.projectId)));
  }

  async close() {
    await this.rootDatabase.destroy();
  }
}

export async function createPostgresProduct(options: PostgresProductOptions) {
  const projectId = options.projectId ?? "local";
  const keys = resolveProductKeys(options);
  const database = new Kysely<ServerProductDB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: options.connectionString }),
    }),
  });
  try {
    await database
      .insertInto("projects")
      .values({ id: projectId, name: projectId, created_at: (options.now ?? Date.now)() })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    return createProduct(new PostgresProductStore(database, projectId), { ...options, ...keys, projectId });
  } catch (error) {
    await database.destroy();
    throw error;
  }
}
