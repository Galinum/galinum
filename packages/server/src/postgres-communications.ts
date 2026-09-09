import type {
  AgentRuns,
  AudienceVersions,
  Campaigns,
  Deliveries,
  EndUsers,
  Events,
  Goals, InAppFeedbackRecord, ProductDB,
  Segments,
  Variants
} from "@galinum/core";
import { pushProjection, validatePushQuery, type PushQuery, type PushRecords, type PushTotals, type RecordKind } from "@galinum/push";
import type { Transaction } from "kysely";
import {
  Kysely,
  sql,
  type Selectable
} from "kysely";
import { randomUUID } from "node:crypto";
import { TraitsCapacityError } from "./communication-data.js";
import { INSTALLATION_REPLAY_LIMIT, type InstallationRecord, type InstallationReplay } from "./installations.js";
import {
  type AudienceFactsBatch,
  type AudienceFactsInput,
  type CampaignQuery,
  type JsonObject,
  type ProductCampaign,
  type ProductDelivery,
  type ProductEvent,
  type ProductVariant
} from "./local-product.js";
import { audienceVersionFromRow } from "./postgres-product-rows.js";
import { lockProject } from "./project-fence.js";

import type { CommunicationData } from "./communication-data.js";
import { campaignAudienceFromRow, campaignFromRow, containsPattern, deliveryFromRow, eventFromRow, goalFromRow, integer, userFromRow, variantFromRow } from "./postgres-product-rows.js";
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

export type CommunicationDB = Pick<ProductDB, "end_users" | "events" | "campaigns" | "variants" | "goals" | "audience_versions" | "segments" | "deliveries" | "installations" | "installation_requests" | "push_records" | "inapp_feedback">;
export class PostgresCommunicationData implements CommunicationData {
  constructor(protected readonly database: Kysely<CommunicationDB>, readonly projectId: string) {}
  async queryPushUsers(afterId: string | null, limit: number) {
    if (limit < 1 || limit > 101) throw new Error("Invalid user page");
    let query = this.database.selectFrom("end_users").selectAll().where("project_id", "=", this.projectId);
    if (afterId !== null) query = query.where(sql<boolean>`id collate "C" > ${afterId}`);
    return (await query.orderBy(sql`id collate "C"`).limit(limit).execute()).map(userFromRow);
  }
  async getInAppFeedback(id: string): Promise<InAppFeedbackRecord | null> {
    const row = await this.database.selectFrom("inapp_feedback").selectAll().where("project_id", "=", this.projectId).where("id", "=", id).executeTakeFirst();
    return row ? { id: row.id, deliveryId: row.delivery_id, userId: row.user_id, externalId: row.external_id, type: row.type as InAppFeedbackRecord["type"], acknowledgedAt: integer(row.acknowledged_at) } : null;
  }
  async insertInAppFeedback(record: InAppFeedbackRecord) {
    await this.database.insertInto("inapp_feedback").values({ project_id: this.projectId, id: record.id, delivery_id: record.deliveryId, user_id: record.userId, external_id: record.externalId, type: record.type, acknowledged_at: record.acknowledgedAt }).execute();
  }
  async getPushRecord<K extends RecordKind>(kind: K, id: string): Promise<PushRecords[K] | null> {
    const row = await this.database.selectFrom("push_records").select("body_json").where("project_id", "=", this.projectId).where("kind", "=", kind).where("id", "=", id).executeTakeFirst();
    return row ? JSON.parse(row.body_json) as PushRecords[K] : null;
  }
  async queryPushRecords<K extends RecordKind>(kind: K, input: PushQuery): Promise<PushRecords[K][]> {
    validatePushQuery(input);
    let query = this.database.selectFrom("push_records").select("body_json").where("project_id", "=", this.projectId).where("kind", "=", kind);
    const columns = { campaignId: "campaign_id", userId: "user_id", targetId: "target_id", installationId: "installation_id", goalEvent: "goal_event", replacementKey: "replacement_key", credentialId: "credential_id", recipientId: "recipient_id", slotId: "slot_id", stateKind: "state_kind" } as const;
    for (const key of Object.keys(columns) as (keyof typeof columns)[]) if (input[key] !== undefined) query = query.where(columns[key], "=", input[key]!);
    if (input.uncertain !== undefined) query = query.where("is_uncertain", "=", input.uncertain);
    if (input.createdAfter !== undefined) query = query.where("event_order", ">", input.createdAfter);
    if (input.isTest !== undefined) query = query.where("is_test", "=", input.isTest);
    if (input.afterId !== undefined) query = query.where(sql<boolean>`id collate "C" > ${input.afterId}`);
    if (input.dueAt !== undefined) query = query.where("available_at", "<=", input.dueAt).orderBy("available_at");
    if (input.engagedBefore !== undefined) query = query.where(sql<boolean>`kind = 'observation' and command_kind in ('tap','action')`).where("event_order", "<", input.engagedBefore);
    if (input.unconverted) query = query.where(sql<boolean>`kind = 'delivery' and is_test = false and not exists (select 1 from push_records c where c.project_id = push_records.project_id and c.kind = 'conversion' and c.id = push_records.id)`);
    return (await query.orderBy(sql`id collate "C"`).offset(input.offset ?? 0).limit(input.limit).execute()).map((row) => JSON.parse(row.body_json) as PushRecords[K]);
  }
  private pushValues<K extends RecordKind>(kind: K, record: PushRecords[K]) {
    const p = pushProjection(kind, record);
    return { project_id: this.projectId, kind, id: record.id, campaign_id: p.campaignId, user_id: p.userId, target_id: p.targetId, installation_id: p.installationId, is_test: p.isTest, command_kind: p.commandKind, result_kind: p.resultKind, available_at: p.availableAt, event_order: p.eventOrder, goal_event: p.goalEvent, replacement_key: p.replacementKey, credential_id: p.credentialId, recipient_id: p.recipientId, slot_id: p.slotId, state_kind: p.stateKind, submission_kind: p.submissionKind, is_uncertain: p.uncertain, body_json: JSON.stringify(record) };
  }
  async insertPushRecord<K extends RecordKind>(kind: K, record: PushRecords[K]) {
    await this.database.insertInto("push_records").values(this.pushValues(kind, record)).execute();
  }
  async savePushControl<K extends "credential" | "clock" | "cursor" | "queue" | "scan" | "work" | "delivery">(kind: K, record: PushRecords[K]) {
    const values = this.pushValues(kind, record);
    await this.database.insertInto("push_records").values(values).onConflict((conflict) => conflict.columns(["project_id", "kind", "id"]).doUpdateSet(values)).execute();
  }
  async pushTotals(campaignId: string): Promise<PushTotals> {
    const scoped = sql`project_id = ${this.projectId} and campaign_id = ${campaignId}`;
    const counts = await sql<{ kind: string; total: string }>`select kind, count(*) as total from push_records where ${scoped} group by kind`.execute(this.database);
    const totals = new Map(counts.rows.map((row) => [row.kind, integer(row.total)]));
    const summary = await sql<Record<string, string>>`
      with slots as (select id, user_id, state_kind from push_records where ${scoped} and kind = 'queue' and is_test = false),
      outcomes as (select o.* from push_records o join slots s on s.id = o.slot_id where o.project_id = ${this.projectId} and o.kind = 'outcome'),
      accepted as (select distinct slot_id from outcomes where result_kind = 'accepted'),
      possible as (select distinct slot_id from outcomes where submission_kind = 'possible'),
      received as (select distinct slot_id from push_records where ${scoped} and kind = 'observation' and command_kind = 'receipt')
      select
        (select count(distinct user_id) from slots) as users_targeted,
        (select count(distinct s.user_id) from slots s join accepted a on a.slot_id = s.id) as users_accepted,
        (select count(distinct user_id) from push_records where ${scoped} and kind = 'observation' and command_kind in ('tap','action')) as users_engaged,
        (select count(distinct user_id) from push_records where ${scoped} and kind = 'conversion') as users_converted,
        (select count(*) from slots) as targeted,
        (select count(*) from push_records a join slots s on s.id = a.slot_id where a.project_id = ${this.projectId} and a.kind = 'attempt') as attempts,
        (select count(*) from accepted) as accepted,
        (select count(*) from slots s join received r on r.slot_id = s.id) as received,
        (select count(*) from slots s where (exists(select 1 from accepted a where a.slot_id = s.id) or exists(select 1 from possible p where p.slot_id = s.id)) and not exists(select 1 from received r where r.slot_id = s.id)) as unknown,
        (select count(*) from outcomes where submission_kind = 'confirmed') as confirmed,
        (select count(*) from outcomes where submission_kind = 'possible') as possible,
        (select count(*) from outcomes where submission_kind = 'none') as blocked,
        (select count(*) from slots where state_kind = 'reserved') as pending,
        (select count(*) from slots where state_kind = 'waiting') as waiting,
        (select count(*) from push_records where ${scoped} and kind = 'target' and is_test = true) as tests,
        (select count(*) from push_records where ${scoped} and kind = 'work' and is_test = false and state_kind = 'waiting') as work_waiting,
        (select count(*) from push_records where ${scoped} and kind = 'work' and is_test = false and state_kind = 'active') as work_active,
        (select count(*) from push_records where ${scoped} and kind = 'work' and is_test = false and state_kind = 'closed') as work_closed
    `.execute(this.database);
    const n = (key: string) => integer(summary.rows[0][key]);
    return {
      users: { targeted: n("users_targeted"), accepted: n("users_accepted"), engaged: n("users_engaged"), converted: n("users_converted") },
      devices: { targeted: n("targeted"), attempts: n("attempts"), accepted: n("accepted"), receiptObserved: n("received"), receiptUnknown: n("unknown"), confirmedSubmissions: n("confirmed"), possibleSubmissions: n("possible"), preSendBlocks: n("blocked"), pendingOutcomes: n("pending"), waiting: n("waiting") },
      planning: { waiting: n("work_waiting"), active: n("work_active"), closed: n("work_closed") },
      testTargets: n("tests"),
      records: { recipients: totals.get("work") ?? 0, slots: totals.get("queue") ?? 0, targets: totals.get("target") ?? 0, attempts: totals.get("attempt") ?? 0, outcomes: totals.get("outcome") ?? 0, observations: totals.get("observation") ?? 0, conversions: totals.get("conversion") ?? 0 },
    };
  }

  async lockInstallations() {
    await lockProject(this.database, this.projectId);
  }
  async getInstallation(id: string) {
    const row = await this.database.selectFrom("installations").select("state_json").where("project_id", "=", this.projectId).where("id", "=", id).executeTakeFirst();
    return row ? JSON.parse(row.state_json) as InstallationRecord : null;
  }
  async listInstallations(userId: string | null, offset: number, limit: number) {
    let query = this.database.selectFrom("installations").where("project_id", "=", this.projectId);
    if (userId !== null) query = query.where(sql<string>`state_json::jsonb->>'userId'`, "=", userId);
    const count = await query.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow();
    const rows = await query.select("state_json").orderBy(sql`id collate "C"`, "asc").offset(offset).limit(limit).execute();
    return { values: rows.map((row) => JSON.parse(row.state_json) as InstallationRecord), total: Number(count.total) };
  }
  async saveInstallation(installation: InstallationRecord) {
    await this.database.insertInto("installations").values({ project_id: this.projectId, id: installation.id, token_scope: installation.tokenScope, state_json: JSON.stringify(installation) })
      .onConflict((conflict) => conflict.columns(["project_id", "id"]).doUpdateSet({ token_scope: installation.tokenScope, state_json: JSON.stringify(installation) })).execute();
  }
  async getTokenOwner(scope: string) {
    const row = await this.database.selectFrom("installations").select("state_json").where("project_id", "=", this.projectId).where("token_scope", "=", scope).executeTakeFirst();
    return row ? JSON.parse(row.state_json) as InstallationRecord : null;
  }
  async getInstallationReplay(id: string, requestId: string) {
    const row = await this.database.selectFrom("installation_requests").select("replay_json").where("project_id", "=", this.projectId).where("installation_id", "=", id).where("request_id", "=", requestId).executeTakeFirst();
    return row ? JSON.parse(row.replay_json) as InstallationReplay : null;
  }
  async saveInstallationReplay(id: string, requestId: string, replay: InstallationReplay) {
    await this.database.insertInto("installation_requests").values({ project_id: this.projectId, installation_id: id, request_id: requestId, replay_json: JSON.stringify(replay) }).execute();
    const expired = this.database.selectFrom("installation_requests").select("request_id")
      .where("project_id", "=", this.projectId).where("installation_id", "=", id)
      .orderBy(sql`(replay_json::jsonb->'state'->>'revision')::bigint`, "desc").offset(INSTALLATION_REPLAY_LIMIT);
    await this.database.deleteFrom("installation_requests").where("project_id", "=", this.projectId)
      .where("installation_id", "=", id).where("request_id", "in", expired).execute();
  }

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

  async getGoal(id: string) {
    const row = await this.database
      .selectFrom("goals")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? goalFromRow(row) : null;
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
      if (input.afterId != null) query = query.where(sql<boolean>`id collate "C" > ${input.afterId}`);
      if (input.channel !== undefined) query = query.where("channel", "=", input.channel);
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
    const selected = filtered().selectAll();
    const ordered = input.afterId !== undefined ? selected.orderBy(sql`id collate "C"`) : selected.orderBy("created_at", "desc").orderBy("id", "desc");
    const rows = await ordered.offset(input.offset).limit(input.limit).execute();
    return { values: await this.hydrateCampaignRows(rows), total: integer(count.count) };
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

  async getSegmentVersion(segmentId: string, version: number) {
    const row = await this.database
      .selectFrom("audience_versions")
      .selectAll()
      .where("project_id", "=", this.projectId)
      .where("segment_id", "=", segmentId)
      .where("segment_version", "=", version)
      .executeTakeFirst();
    return row ? audienceVersionFromRow(row) : null;
  }  async touchUser(id: string, now: number) {
    await this.database.updateTable("end_users").set({ last_seen_at: now }).where("project_id", "=", this.projectId).where("id", "=", id).execute();
  }
}

export class PostgresCommunicationTransaction extends PostgresCommunicationData {
  constructor(transaction: Transaction<CommunicationDB>, projectId: string) {
    if (!transaction.isTransaction) throw new Error("A communication transaction requires a transaction executor");
    super(transaction, projectId);
  }
}
