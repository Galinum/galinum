import { assertCommunicationSchema } from "./schema-readiness.js";
import { lockProject } from "./project-fence.js";
import { createPostgresActivationData } from "./activation/postgres.js";
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
import {
  Kysely,
  PostgresDialect,
  sql,
  type Selectable,
  type Transaction,
} from "kysely";
import { Pool } from "pg";
import {
  audienceCapabilities as buildAudienceCapabilities,
  MAX_CAPABILITY_EVENTS,
  MAX_CAPABILITY_TRAITS,
  type AudienceCapabilities,
} from "./audience.js";
import {
  createProduct,
  resolveProductKeys,
  type AgentRunQuery,
  type AudiencePresence,
  type CampaignConversionSummary,
  type CampaignStats,
  type ConversionCounts,
  type DeliveryQuery,
  type EventQuery,
  type LocalProductOptions,
  type ProductAgentRun,
  type ProductAudienceVersion,
  type ProductCampaign,
  type ProductGoal,
  type ProductSegment,
  type ProductStore,
  type ProductStoreAccess,
  type ProductStoreSession,
  type SegmentMutationResult,
  type SegmentRevision,
  type UserQuery
} from "./local-product.js";
import {
  compareActivity,
  DAY_MS,
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
  type UserDelivery,
  type UserDeliveryQuery
} from "./management-contract.js";

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

import { PostgresCommunicationData, type CommunicationDB } from "./postgres-communications.js";
import { agentRunFromRow, audienceVersionFromRow, campaignAudienceColumns, containsPattern, deliveryFromRow, eventFromRow, goalFromRow, integer, segmentFromRow, userFromRow } from "./postgres-product-rows.js";
class PostgresProductSession extends PostgresCommunicationData implements ProductStoreSession {
  readonly activation: ReturnType<typeof createPostgresActivationData>;
  constructor(protected readonly productDatabase: Database, projectId: string) {
    super(productDatabase.$pickTables<keyof CommunicationDB>(), projectId);
    this.activation = createPostgresActivationData(productDatabase.$pickTables<keyof ProductDB>(), projectId);
  }
  async listActivationCampaignIds(after: string, limit: number) {
    const rows = await this.productDatabase.selectFrom("campaigns").select("id").where("project_id", "=", this.projectId)
      .where("id", ">", after).orderBy("id").limit(limit).execute();
    return rows.map((row) => row.id);
  }
  async queryUsers(input: UserQuery) {
    const filtered = () => {
      let query = this.productDatabase.selectFrom("end_users").where("project_id", "=", this.projectId);
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

  async audiencePresence(input: { traitKeys: string[]; eventNames: string[] }): Promise<AudiencePresence> {
    const traits = new Set<string>();
    const events = new Set<string>();
    if (input.traitKeys.length > 0) {
      const result = await sql<{ key: string }>`
        select distinct keys.key
        from end_users u
        cross join lateral jsonb_object_keys(coalesce(u.traits_json, '{}')::jsonb) keys(key)
        where u.project_id = ${this.projectId} and keys.key in (${sql.join(input.traitKeys)})
      `.execute(this.productDatabase);
      result.rows.forEach((row) => traits.add(row.key));
    }
    if (input.eventNames.length > 0) {
      const rows = await this.productDatabase.selectFrom("events").select("name").distinct()
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
    `.execute(this.productDatabase);
    type EventRowSummary = { name: string; users: string; occurrences: string; last_seen_at: number | string };
    const eventResult = await sql<EventRowSummary>`
      select name, count(distinct end_user_id) as users, count(*) as occurrences, max(ts) as last_seen_at
      from events where project_id = ${this.projectId}
      group by name order by users desc, name asc limit ${MAX_CAPABILITY_EVENTS + 1}
    `.execute(this.productDatabase);
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
    `.execute(this.productDatabase);
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
      let query = this.productDatabase
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

  async createGoal(goal: ProductGoal) {
    await this.productDatabase.insertInto("goals").values({
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

  async getGoalForUpdate(id: string) {
    const row = await this.productDatabase
      .selectFrom("goals")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    return row ? goalFromRow(row) : null;
  }

  async queryGoals(limit: number) {
    const rows = await this.productDatabase
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
    await this.productDatabase
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
      await this.productDatabase.insertInto("audience_versions").values({
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
    await this.productDatabase.insertInto("campaigns").values({
      id: campaign.id,
      project_id: this.projectId,
      goal_id: campaign.goalId,
      name: campaign.name,
      channel: campaign.channel,
      push_json: campaign.push ? JSON.stringify(campaign.push) : null,
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
    await this.productDatabase.insertInto("variants").values(campaign.variants.map((variant) => ({
      id: variant.id,
      campaign_id: variant.campaign_id,
      name: variant.name,
      content_json: variant.content_json,
      weight: variant.weight,
      is_control: variant.isControl,
    }))).execute();
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
    `.execute(this.productDatabase);
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
      await this.productDatabase.insertInto("audience_versions").values({
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
    await this.productDatabase
      .updateTable("campaigns")
      .set({
        name: campaign.name,
        push_json: campaign.push ? JSON.stringify(campaign.push) : null,
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
      const updated = await this.productDatabase
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
      await this.productDatabase.insertInto("variants").values({
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
    await this.productDatabase
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

  async queryCampaignDeliveries(input: DeliveryQuery) {
    const filtered = () => {
      let query = this.productDatabase
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
    const filtered = () => this.productDatabase
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
      this.productDatabase.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).executeTakeFirstOrThrow(),
      this.productDatabase.selectFrom("events").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId)
        .where("ts", ">=", evaluatedAt - WEEK_MS)
        .where("ts", "<=", evaluatedAt)
        .executeTakeFirstOrThrow(),
      this.productDatabase.selectFrom("campaigns").select(({ fn }) => fn.countAll().as("count"))
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
    let deliveryQuery = this.productDatabase
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
    let userQuery = this.productDatabase
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
      `.execute(this.productDatabase);
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
    `.execute(this.productDatabase);
    for (const row of eventRows.rows) bucketFor(integer(row.bucket)).events += integer(row.count);
    const topEventRows = await this.productDatabase
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
    const anyDelivery = await this.productDatabase
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
      this.productDatabase.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).executeTakeFirstOrThrow(),
      this.productDatabase.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).where("last_seen_at", ">=", startAt).executeTakeFirstOrThrow(),
      this.productDatabase.selectFrom("end_users").select(({ fn }) => fn.countAll().as("count"))
        .where("project_id", "=", this.projectId).where("first_seen_at", ">=", startAt).executeTakeFirstOrThrow(),
    ]);
    return { totalUsers: integer(total.count), activeUsers: integer(active.count), newUsers: integer(fresh.count) };
  }

  async agentRunReferences(goalIds: string[], campaignIds: string[]): Promise<AgentRunReferences> {
    const goalRows = goalIds.length === 0 ? [] : await this.productDatabase.selectFrom("goals").select(["id", "name"])
      .where("project_id", "=", this.projectId).where("id", "in", goalIds).execute();
    const campaignRows = campaignIds.length === 0 ? [] : await this.productDatabase.selectFrom("campaigns").select(["id", "name"])
      .where("project_id", "=", this.projectId).where("id", "in", campaignIds).execute();
    return {
      goals: Object.fromEntries(goalRows.map((row) => [row.id, row.name])),
      campaigns: Object.fromEntries(campaignRows.map((row) => [row.id, row.name])),
    };
  }

  async getAgentRun(id: string) {
    const row = await this.productDatabase.selectFrom("agent_runs").selectAll()
      .where("project_id", "=", this.projectId).where("id", "=", id).executeTakeFirst();
    return row ? agentRunFromRow(row) : null;
  }

  async queryAgentRuns(input: AgentRunQuery) {
    const filtered = () => {
      let query = this.productDatabase.selectFrom("agent_runs").where("project_id", "=", this.projectId);
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
    `.execute(this.productDatabase);
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
        union
        select user_id from inapp_feedback where project_id = ${this.projectId} and type = 'shown' and acknowledged_at >= ${start} and acknowledged_at < ${end}
      ) active_users
    `.execute(this.productDatabase);
    const capped = await this.productDatabase
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
    let insert = this.productDatabase
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
    const existing = await this.productDatabase
      .selectFrom("agent_runs")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("idempotency_key", "=", run.idempotencyKey!)
      .executeTakeFirstOrThrow();
    return { run: agentRunFromRow(existing), created: false };
  }

  async createSegment(segment: ProductSegment, version: ProductAudienceVersion) {
    const inserted = await this.productDatabase
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
      const existing = await this.productDatabase
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
    await this.productDatabase.insertInto("audience_versions").values({
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
    const row = await this.productDatabase
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
    const row = await this.productDatabase
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
    let query = this.productDatabase
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
    const row = await this.productDatabase
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
      await this.productDatabase.insertInto("audience_versions").values({
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
    await this.productDatabase
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
    const row = await this.productDatabase
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
    await this.productDatabase
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
    const rows = await this.productDatabase
      .selectFrom("audience_versions")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("segment_id", "=", segmentId)
      .orderBy("segment_version", "desc")
      .execute();
    return rows.map(audienceVersionFromRow);
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
    return this.rootDatabase.transaction().execute(async (transaction) => {
      await lockProject(transaction, this.projectId);
      return work(new PostgresProductSession(transaction, this.projectId));
    });
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

export async function createPostgresProductStore(options: PostgresProductOptions) {
  const projectId = options.projectId ?? "local";
  const database = new Kysely<ServerProductDB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: options.connectionString }),
    }),
  });
  try {
    try {
      const versions = await database.selectFrom("product_schema_versions").select("version").execute();
      if (versions.length !== 1 || versions[0].version !== "activation-1") throw new Error("Unsupported schema version");
    } catch {
      throw new Error("Unsupported product schema. Apply packages/server/migrations/activation-1.sql before starting the server.");
    }
    await assertCommunicationSchema(database);
    await database
      .insertInto("projects")
      .values({ id: projectId, name: projectId, created_at: (options.now ?? Date.now)() })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    return new PostgresProductStore(database, projectId);
  } catch (error) {
    await database.destroy();
    throw error;
  }
}

export async function createPostgresProduct(options: PostgresProductOptions) {
  const keys = resolveProductKeys(options);
  return createProduct(await createPostgresProductStore(options), { ...options, ...keys });
}
