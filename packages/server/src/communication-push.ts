import { LIMITS, referencedVocabulary, type AudienceExpression } from "@galinum/core";
import { digest, recordPushEvent, type PushContent, type PushTransaction, type Recipient } from "@galinum/push";
import { randomUUID } from "node:crypto";
import { campaignMatches } from "./audience.js";
import type { JsonObject } from "./local-product.js";

import type { CommunicationData, CommunicationEffects } from "./communication-data.js";
export function pushTransaction<Data extends CommunicationData>(session: Data, effects: CommunicationEffects<Data> = {}) {
  const adapter: PushTransaction & { data: Data } = {
    data: session,
    lockInstallations: () => session.lockInstallations(),
    getInstallation: (id) => session.getInstallation(id),
    listInstallations: (...args) => session.listInstallations(...args),
    saveInstallation: (record) => session.saveInstallation(record),
    getPushRecord: (...args) => session.getPushRecord(...args),
    queryPushRecords: (...args) => session.queryPushRecords(...args),
    pushTotals: (campaignId) => session.pushTotals(campaignId),
    insertPushRecord: (...args) => session.insertPushRecord(...args),
    savePushControl: (...args) => session.savePushControl(...args),
    recipient: (externalId) => session.getUserByExternalId(externalId),
    event: async (user, name, id, now, props) => { await recordServerEvent(session, user, name, id, now, props, effects); },
    async campaign(id, now) {
      const campaign = await session.getCampaign(id);
      if (campaign?.channel !== "push" || !campaign.push) return null;
      const goal = campaign.goalId ? await session.getGoal(campaign.goalId) : null;
      return { id, ended: campaign.status === "ended", goalId: campaign.goalId, active: campaign.status === "running" && (campaign.deliverFrom === null || campaign.deliverFrom <= now) && (campaign.deliverUntil === null || campaign.deliverUntil > now), from: campaign.deliverFrom, until: campaign.deliverUntil, fingerprint: digest({ variants: campaign.variants, push: campaign.push, audience: campaign.audience, goal: campaign.goalId, from: campaign.deliverFrom, until: campaign.deliverUntil }), settings: campaign.push, goalEvent: goal?.targetEvent ?? null, variants: campaign.variants.map((variant) => ({ id: variant.id, weight: variant.weight, content: JSON.parse(variant.content_json) as PushContent })) };
    },
    async recipients(campaign, now, userId) {
      const source = await session.getCampaign(campaign.id);
      const user = await session.getUserById(userId);
      if (!source || !user) return [];
      if (source.audience.kind === "all") return [user];
      if (source.audience.kind === "invalid") return [];
      const vocabulary = referencedVocabulary((JSON.parse(source.audience.expressionJson) as AudienceExpression).root);
      if (vocabulary.events.size === 0) return campaignMatches(source, user, [], now) ? [user] : [];
      const facts = await session.loadAudienceFacts({ userId: user.id, afterUserId: null, limit: 1, traitKeys: [...vocabulary.traits], eventNames: [...vocabulary.events], evaluatedAt: now, maxOccurrences: LIMITS.maxEvaluatedEventOccurrences, eventRowBudget: vocabulary.events.size * LIMITS.maxEvaluatedEventOccurrences });
      if (facts.overflow) throw new Error("Audience fact bound exceeded");
      return campaignMatches(source, user, facts.eventsByUser.get(user.id) ?? [], now) ? [user] : [];
    },
    async recipientPage(campaign, now, afterId, limit) {
      const users = await session.queryPushUsers(afterId, limit + 1);
      const recipients: Recipient[] = users.slice(0, limit);
      return { recipients, nextCursor: users.length > limit ? users[limit - 1].id : null };
    },
    async userDelivery(campaignId, userId, variantId, now) {
      const delivery = await session.getOrCreateDelivery({ id: `del_${randomUUID()}`, campaignId, userId, variantId, state: "queued", queuedAt: now, sentAt: null, deliveredAt: null, shownAt: null, openedAt: null, clickedAt: null, dismissedAt: null, bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: null });
      return { id: delivery.id, variantId: delivery.variantId };
    },
    async accepted(id, now) {
      const delivery = await session.getDeliveryForUpdate(id);
      if (!delivery) throw new Error("Push delivery is missing");
      const first = delivery.sentAt === null;
      delivery.sentAt = delivery.sentAt === null ? now : Math.min(delivery.sentAt, now);
      if (["queued", "sending", "retryable"].includes(delivery.state)) delivery.state = "sent";
      await session.saveDelivery(delivery);
      if (first) await effects.recordFirstDelivery?.(session, { deliveryId: id, userId: delivery.userId, occurredAt: now, channel: "push" });
    },
    async converted(id, now) {
      const delivery = await session.getDeliveryForUpdate(id);
      if (delivery && delivery.convertedAt === null) { delivery.convertedAt = now; delivery.state = "converted"; await session.saveDelivery(delivery); }
    },
  };
  return adapter;
}
export async function recordServerEvent<Data extends CommunicationData>(session: Data, user: Pick<Recipient, "id" | "externalId">, name: string, id: string, now: number, props: JsonObject | null, effects: CommunicationEffects<Data> = {}) {
  const productEventId = `evt_${randomUUID()}`;
  if (!await recordPushEvent(pushTransaction(session), user.id, name, id, now, productEventId, digest({ userId: user.id, name, props }))) {
    const prior = await session.getPushRecord("event", id);
    if (!prior) throw new Error("Canonical event is missing");
    return { kind: "replay" as const, eventRowId: prior.productEventId, occurredAt: prior.receivedAt };
  }
  await session.touchUser(user.id, now);
  await session.insertEvent({ id: productEventId, userId: user.id, externalUserId: user.externalId, name, props, occurredAt: now });
  await effects.recordActivity?.(session, { kind: "event", userId: user.id, eventId: id, eventRowId: productEventId, occurredAt: now });
  const candidates = await session.listConversionCandidatesForUpdate(user.id, name, now);
  for (const delivery of candidates) {
    if ((await session.getCampaign(delivery.campaignId))?.channel === "push") continue;
    delivery.state = "converted"; delivery.convertedAt = now; await session.saveDelivery(delivery);
  }
  return { kind: "inserted" as const, eventRowId: productEventId, occurredAt: now };
}
