import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { validateCredential } from "./providers.js";
import type { PushHost, PushTransaction, PushCommand, PushCredential, CredentialRecord, DeviceTarget, Observation } from "./types.js";
import { PushError, digest, nextOrder } from "./identity.js";
export { PushError, digest } from "./identity.js";
import { createRecovery } from "./recovery.js";
export async function recordPushEvent(tx: PushTransaction, userId: string, name: string, eventId: string, now: number, productEventId = eventId, fingerprint = digest({ userId, name, props: null })) {
  const prior = await tx.getPushRecord("event", eventId);
  if (prior) { if (prior.userId !== userId || prior.name !== name || prior.fingerprint !== fingerprint) throw new PushError(409, "Event replay conflict"); return false; }
  const order = await nextOrder(tx);
  await tx.insertPushRecord("event", { id: eventId, campaignId: "", userId, name, order, receivedAt: now, productEventId, fingerprint });
  let afterId: string | undefined;
  for (;;) {
    const deliveries = await tx.queryPushRecords("delivery", { userId, goalEvent: name, isTest: false, unconverted: true, afterId, limit: 100 });
    for (const delivery of deliveries) {
      const [engagement] = await tx.queryPushRecords("observation", { campaignId: delivery.campaignId, userId, engagedBefore: order, limit: 1 });
      if (!engagement) continue;
      await tx.insertPushRecord("conversion", { id: delivery.id, campaignId: delivery.campaignId, deliveryId: delivery.id, userId, eventId: productEventId, engagementId: engagement.id, order, convertedAt: now });
      await tx.converted(delivery.id, now);
    }
    if (deliveries.length < 100) break;
    afterId = deliveries.at(-1)!.id;
  }

  return true;
}
export function createPushEngine<Tx extends PushTransaction>(host: PushHost<Tx>) {
  const now = host.now ?? Date.now;
  const transaction = <T>(work: (tx: Tx) => Promise<T>) => host.store.transaction(async (tx) => { await tx.lockInstallations(); return work(tx); });
  const scope = (id: string) => `${host.projectId}:${id}`;
  async function configure(input: { appId: string; platform: "ios" | "android"; environment: "development" | "production"; expectedRevision: number; credential: PushCredential }) {
    if (!host.vault) throw new PushError(503, "Configure persistent push encryption first");
    let credential: PushCredential;
    try { credential = validateCredential(input.credential); } catch { throw new PushError(400, "Invalid push credential"); }
    if ((input.platform === "ios") !== (credential.provider === "apns") || credential.provider === "apns" && credential.topic !== input.appId) throw new PushError(400, "Credential app mismatch");
    const id = digest([input.appId, input.platform, input.environment]);
    return transaction(async (tx) => {
      const prior = await tx.getPushRecord("credential", id);
      if ((prior?.revision ?? 0) !== input.expectedRevision) throw new PushError(409, "Credential revision conflict");
      const record: CredentialRecord = { id, appId: input.appId, platform: input.platform, environment: input.environment, revision: input.expectedRevision + 1, encrypted: host.vault!.seal(credential, scope(id)), validation: "local_valid" };
      await tx.savePushControl("credential", record);
      const { encrypted: _, ...view } = record; return view;
    });
  }
  const { plan, dispatch, reconcileDue } = createRecovery(host, transaction);
  async function observe(installationId: string, capability: string, bindingGeneration: number, commands: PushCommand[]) {
    return transaction(async (tx) => {
      const installation = await tx.getInstallation(installationId);
      if (!installation || !timingSafeEqual(createHash("sha256").update(capability).digest(), Buffer.from(installation.capabilityVerifier, "hex"))) throw new PushError(401, "Unauthorized");
      if (installation.bindingGeneration !== bindingGeneration || !installation.userId) throw new PushError(409, "Binding changed");
      const user = await tx.recipient(installation.userId);
      if (!user) throw new PushError(409, "User unavailable");
      const cursorId = digest([installationId, bindingGeneration]);
      const cursor = await tx.getPushRecord("cursor", cursorId) ?? { id: cursorId, sequence: 0 };
      const fresh: { command: PushCommand; id: string; target: DeviceTarget | null }[] = [];
      const seen = new Set<string>();
      for (const command of commands) {
        const id = digest([cursorId, command.id]);
        if (seen.has(command.id)) throw new PushError(409, "Duplicate command in batch"); seen.add(command.id);
        const prior = await tx.getPushRecord("observation", id);
        if (prior) { if (prior.digest !== digest(command)) throw new PushError(409, "Observation replay conflict"); continue; }
        if (command.sequence !== cursor.sequence + 1) throw new PushError(409, "Observation sequence gap");
        let target: DeviceTarget | null = null;
        if (command.kind !== "event") {
          target = await tx.getPushRecord("target", command.targetId!);
          const attempt = await tx.getPushRecord("attempt", command.attemptId!);
          const outcome = await tx.getPushRecord("outcome", command.attemptId!);
          if (!target || target.installationId !== installationId || target.bindingGeneration !== bindingGeneration || target.externalId !== installation.userId || attempt?.targetId !== target.id || !outcome || !["accepted", "unknown"].includes(outcome.result.kind)) throw new PushError(409, "Observation does not reference a submitted target");
          if (command.kind === "action" && !target.content.actions?.some((action) => action.id === command.actionId)) throw new PushError(400, "Action was not sent");
        }
        if (command.kind === "event") {
          const priorEvent = await tx.getPushRecord("event", command.eventId);
          if (priorEvent && priorEvent.fingerprint !== digest({ userId: user.id, name: command.event, props: command.props ?? null })) throw new PushError(409, "Event replay conflict");
        }
        fresh.push({ command, id, target }); cursor.sequence++;
      }
      for (const { command, id, target } of fresh) {
        const observation: Observation = { slotId: target?.slotId ?? null, id, campaignId: target?.test ? "" : target?.campaignId ?? "", installationId, bindingGeneration, sequence: command.sequence, command, digest: digest(command), userId: user.id, order: await nextOrder(tx), receivedAt: now() };
        await tx.insertPushRecord("observation", observation);
        if (command.kind === "event") await tx.event(user, command.event, command.eventId, now(), command.props ?? null);
      }
      await tx.savePushControl("cursor", cursor);
      return { acknowledgedThrough: cursor.sequence };
    });
  }
  async function inspect(campaignId: string, page = 1, perPage = 25) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 || !Number.isSafeInteger((page - 1) * perPage)) throw new PushError(400, "Invalid pagination");
    return transaction(async (tx) => {
      if (!await tx.campaign(campaignId, now())) throw new PushError(404, "Push campaign not found");
      const query = { campaignId, offset: (page - 1) * perPage, limit: perPage };
      const recipients = await tx.queryPushRecords("work", query);
      const slots = await tx.queryPushRecords("queue", query);
      const targets = await tx.queryPushRecords("target", query);
      const attempts = await tx.queryPushRecords("attempt", query);
      const outcomes = await tx.queryPushRecords("outcome", query);
      const observations = await tx.queryPushRecords("observation", query);
      const conversions = await tx.queryPushRecords("conversion", query);
      const totals = await tx.pushTotals(campaignId);
      return { page, perPage, evaluatedAt: now(), pageCounts: Object.fromEntries(Object.entries(totals.records).map(([kind, count]) => [kind, Math.max(1, Math.ceil(count / perPage))])), ...totals, recipients: recipients.map(({ inputFingerprint: _, admission: _admission, ...recipient }) => recipient), slots, targets: targets.map(({ tokenScope: _, ...target }) => target), attempts: attempts.map(({ fence: _, ...attempt }) => attempt), outcomes, observations, conversions };
    });
  }
  async function processDue(campaignId?: string) {
    await reconcileDue(campaignId);
    const queue = await transaction((tx) => tx.queryPushRecords("queue", { campaignId, dueAt: now(), limit: 100 }));
    for (const entry of queue) { if (!entry.targetId) throw new Error("Ready slot has no target"); await dispatch(entry.targetId); }
    return { processed: queue.length };
  }
  return {
    configure, plan, dispatch, observe, inspect, processDue,
    async runCampaign(campaignId: string) { await plan(campaignId); await processDue(campaignId); return inspect(campaignId); },
    async test(campaignId: string, installationId: string, requestId: string) { const ids = await plan(campaignId, installationId, requestId); for (const id of ids) await dispatch(id); return { targetIds: ids }; },
    async getTest(campaignId: string, requestId: string) { return transaction(async (tx) => {
      const record = await tx.getPushRecord("test", digest([campaignId, requestId]));
      if (!record) throw new PushError(404, "Push test not found");
      const attempts = []; const outcomes = [];
      for (const targetId of record.targetIds) {
        attempts.push(...await tx.queryPushRecords("attempt", { targetId, limit: 100 }));
        outcomes.push(...await tx.queryPushRecords("outcome", { targetId, limit: 100 }));
      }
      return { requestId, installationId: record.installationId, targetIds: record.targetIds, attempts: attempts.map(({ fence: _, ...attempt }) => attempt), outcomes };
    }); },
    credentials: (afterId?: string) => transaction(async (tx) => {
      const records = await tx.queryPushRecords("credential", { afterId, limit: 100 });
      return { credentials: records.map(({ encrypted: _, ...view }) => view), nextCursor: records.length === 100 ? records.at(-1)!.id : null };
    }),
  };
}
