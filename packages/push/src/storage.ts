import type { PushPersistence, PushQuery, PushRecords, PushTotals, RecordKind } from "./types.js";
export function pushProjection<K extends RecordKind>(kind: K, record: PushRecords[K]) {
  return {
    id: record.id, kind,
    campaignId: "campaignId" in record ? record.campaignId : "",
    userId: "userId" in record ? record.userId : null,
    targetId: kind === "target" ? record.id : "targetId" in record ? record.targetId : "command" in record && record.command.kind !== "event" ? record.command.targetId : null,
    installationId: "installationId" in record ? record.installationId : null,
    isTest: "test" in record ? record.test : null,
    commandKind: "command" in record ? record.command.kind : null,
    resultKind: "result" in record ? record.result.kind : null,
    eventOrder: "order" in record ? record.order : "createdOrder" in record ? record.createdOrder : null,
    replacementKey: "replacementKey" in record ? record.replacementKey : null,
    credentialId: "credentialId" in record ? record.credentialId : null,
    goalEvent: "goalEvent" in record ? record.goalEvent : null,
    recipientId: "recipientId" in record ? record.recipientId : kind === "work" ? record.id : null,
    slotId: "slotId" in record ? record.slotId : kind === "queue" ? record.id : null,
    stateKind: "state" in record ? record.state.kind : null,
    submissionKind: "submission" in record ? record.submission : null,
    uncertain: "uncertain" in record ? record.uncertain : null,
    availableAt: "state" in record ? record.state.kind === "ready" ? record.state.at : record.state.kind === "reserved" ? record.state.until : kind === "work" && record.state.kind === "waiting" ? record.state.recheckAt : null : null,
  };
}
export function validatePushQuery(query: PushQuery) {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 || !Number.isSafeInteger(query.offset ?? 0) || (query.offset ?? 0) < 0) throw new Error("Push queries require a bounded page of 1–100 records");
}
type Projection = ReturnType<typeof pushProjection>;
const indexKey = (kind: RecordKind, name: string, value: unknown) => JSON.stringify([kind, name, value]);
export class MemoryPushRecords implements PushPersistence {
  private readonly records = new Map<string, unknown>();
  private readonly projections = new Map<string, Projection>();
  private readonly indices = new Map<string, Set<string>>();
  private readonly undo = new Map<string, { kind: RecordKind; record: unknown }>();
  clone(): MemoryPushRecords {
    const copy = new MemoryPushRecords();
    for (const [key, record] of this.records) copy.records.set(key, record);
    for (const [key, projection] of this.projections) copy.projections.set(key, projection);
    for (const [key, ids] of this.indices) copy.indices.set(key, new Set(ids));
    return copy;
  }
  begin() { this.undo.clear(); }
  commit() { this.undo.clear(); }
  rollback() { for (const [key, old] of this.undo) this.set(key, old.kind, old.record as PushRecords[RecordKind] | undefined); this.undo.clear(); }
  private keys(projection: Projection) {
    return [indexKey(projection.kind, "kind", projection.kind), ...["campaignId", "userId", "targetId", "installationId", "goalEvent", "replacementKey", "credentialId", "recipientId", "slotId", "stateKind", "uncertain"].map((name) => indexKey(projection.kind, name, projection[name as keyof Projection])), ...(["queue", "work"].includes(projection.kind) && projection.availableAt !== null ? [indexKey(projection.kind, "pending", true)] : [])];
  }
  private set(key: string, kind: RecordKind, record: PushRecords[RecordKind] | undefined) {
    const previous = this.projections.get(key);
    if (previous) for (const index of this.keys(previous)) { this.indices.get(index)?.delete(key); if (this.indices.get(index)?.size === 0) this.indices.delete(index); }
    if (record === undefined) { this.records.delete(key); this.projections.delete(key); return; }
    const projection = pushProjection(kind, record);
    this.records.set(key, structuredClone(record)); this.projections.set(key, projection);
    for (const index of this.keys(projection)) { const ids = this.indices.get(index) ?? new Set<string>(); ids.add(key); this.indices.set(index, ids); }
  }
  private matching(kind: RecordKind, query: Omit<PushQuery, "limit">) {
    const indices = [this.indices.get(indexKey(kind, "kind", kind)) ?? new Set<string>()];
    for (const field of ["campaignId", "userId", "targetId", "installationId", "goalEvent", "replacementKey", "credentialId", "recipientId", "slotId", "stateKind", "uncertain"] as const) if (query[field] !== undefined) indices.push(this.indices.get(indexKey(kind, field, query[field])) ?? new Set<string>());
    if (query.dueAt !== undefined) indices.push(this.indices.get(indexKey(kind, "pending", true)) ?? new Set<string>());
    const base = indices.reduce((a, b) => a.size < b.size ? a : b);
    return [...base].filter((key) => indices.every((index) => index.has(key)) && (query.dueAt === undefined || (this.projections.get(key)!.availableAt ?? Infinity) <= query.dueAt) && (query.createdAfter === undefined || (this.projections.get(key)!.eventOrder ?? -Infinity) > query.createdAfter) && (query.isTest === undefined || this.projections.get(key)!.isTest === query.isTest) && (!query.unconverted || !this.records.has(`conversion:${this.projections.get(key)!.id}`)) && (query.engagedBefore === undefined || ["tap", "action"].includes(this.projections.get(key)!.commandKind ?? "") && (this.projections.get(key)!.eventOrder ?? Infinity) < query.engagedBefore));
  }
  async getPushRecord<K extends RecordKind>(kind: K, id: string): Promise<PushRecords[K] | null> { return structuredClone(this.records.get(`${kind}:${id}`) as PushRecords[K] ?? null); }
  async queryPushRecords<K extends RecordKind>(kind: K, query: PushQuery): Promise<PushRecords[K][]> {
    validatePushQuery(query);
    const keys = this.matching(kind, query).filter((key) => !query.afterId || Buffer.compare(Buffer.from(this.projections.get(key)!.id), Buffer.from(query.afterId)) > 0);
    keys.sort((a, b) => (query.dueAt === undefined ? 0 : this.projections.get(a)!.availableAt! - this.projections.get(b)!.availableAt!) || Buffer.compare(Buffer.from(this.projections.get(a)!.id), Buffer.from(this.projections.get(b)!.id)));
    return keys.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit).map((key) => structuredClone(this.records.get(key) as PushRecords[K]));
  }
  async insertPushRecord<K extends RecordKind>(kind: K, record: PushRecords[K]) {
    const key = `${kind}:${record.id}`;
    if (this.records.has(key)) throw new Error("Push record already exists");
    if (!this.undo.has(key)) this.undo.set(key, { kind, record: undefined });
    this.set(key, kind, record);
  }
  async savePushControl<K extends "credential" | "clock" | "cursor" | "queue" | "scan" | "work" | "delivery">(kind: K, record: PushRecords[K]) {
    const key = `${kind}:${record.id}`;
    if (!this.undo.has(key)) this.undo.set(key, { kind, record: this.records.get(key) });
    this.set(key, kind, record);
  }
  async pushTotals(campaignId: string): Promise<PushTotals> {
    const projections = (kind: RecordKind) => this.matching(kind, { campaignId }).map((key) => this.projections.get(key)!);
    const targets = projections("target"); const slots = projections("queue").filter((row) => !row.isTest); const ids = new Set(slots.map((row) => row.id));
    const attempts = projections("attempt"); const outcomes = projections("outcome"); const observations = projections("observation"); const conversions = projections("conversion"); const work = projections("work");
    const accepted = new Set(outcomes.filter((row) => row.resultKind === "accepted" && ids.has(row.slotId!)).map((row) => row.slotId));
    const possible = new Set(outcomes.filter((row) => row.submissionKind === "possible" && ids.has(row.slotId!)).map((row) => row.slotId));
    const received = new Set(observations.filter((row) => row.commandKind === "receipt").map((row) => row.slotId));
    const submissions = (kind: string) => outcomes.filter((row) => ids.has(row.slotId!) && row.submissionKind === kind).length;
    return {
      users: { targeted: new Set(slots.map((row) => row.userId)).size, accepted: new Set(slots.filter((row) => accepted.has(row.id)).map((row) => row.userId)).size, engaged: new Set(observations.filter((row) => row.commandKind === "tap" || row.commandKind === "action").map((row) => row.userId)).size, converted: new Set(conversions.map((row) => row.userId)).size },
      devices: { targeted: slots.length, attempts: attempts.filter((row) => ids.has(row.slotId!)).length, accepted: accepted.size, receiptObserved: slots.filter((row) => received.has(row.id)).length, receiptUnknown: slots.filter((row) => (accepted.has(row.id) || possible.has(row.id)) && !received.has(row.id)).length,
        confirmedSubmissions: submissions("confirmed"), possibleSubmissions: submissions("possible"), preSendBlocks: submissions("none"), pendingOutcomes: slots.filter((row) => row.stateKind === "reserved").length, waiting: slots.filter((row) => row.stateKind === "waiting").length },
      planning: { waiting: work.filter((row) => !row.isTest && row.stateKind === "waiting").length, active: work.filter((row) => !row.isTest && row.stateKind === "active").length, closed: work.filter((row) => !row.isTest && row.stateKind === "closed").length },
      testTargets: targets.filter((row) => row.isTest).length,
      records: { recipients: work.length, slots: projections("queue").length, targets: targets.length, attempts: attempts.length, outcomes: outcomes.length, observations: observations.length, conversions: conversions.length },
    };
  }
}
