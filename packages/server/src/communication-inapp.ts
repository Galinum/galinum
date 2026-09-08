import { matchesPages } from "@galinum/contracts/entry";
import { InAppError, LIMITS, referencedVocabulary, type AudienceExpression, type DeliveryFeedback, type InAppTransaction, type MediaStore } from "@galinum/core";
import { randomUUID } from "node:crypto";
import { campaignMatches } from "./audience.js";
import type { CommunicationData, CommunicationEffects } from "./communication-data.js";
import type { JsonObject, ProductDelivery, ProductEvent } from "./local-product.js";
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
  if (type === "shown") delivery.shownAt ??= now;
  if (type === "clicked") delivery.clickedAt ??= now;
  if (type === "dismissed") delivery.dismissedAt ??= now;
  if (type === "converted") delivery.convertedAt ??= now;
  if (DELIVERY_STATE_PRECEDENCE[type] > DELIVERY_STATE_PRECEDENCE[delivery.state]) delivery.state = type;
}

export function publicMessageContent(value: unknown, media: MediaStore, projectId: string) {
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

export function inAppTransaction<Data extends CommunicationData>(tx: Data, media: MediaStore, projectId: string, effects: CommunicationEffects<Data> = {}) {
      const adapter: InAppTransaction & { data: Data } = {
        data: tx,
        getInAppFeedback: (id) => tx.getInAppFeedback(id),
        insertInAppFeedback: (record) => tx.insertInAppFeedback(record),
        user: (externalId) => tx.getUserByExternalId(externalId),
        async candidates(userId, path, evaluatedAt) {
          const page = await tx.queryCampaigns({ channel: "web_inapp", effectiveStatus: "running", query: null, evaluatedAt, offset: 0, limit: 101 });
          if (page.values.length > 100) throw new InAppError(503, "Too many eligible campaigns");
          const user = await tx.getUserById(userId);
          if (!user) return [];
          const eligible = [];
          for (const campaign of page.values) {
            if (!matchesPages(campaign.pages, path)) continue;
            let events: ProductEvent[] = [];
            if (campaign.audience.kind !== "all" && campaign.audience.kind !== "invalid") {
              const names = referencedVocabulary((JSON.parse(campaign.audience.expressionJson) as AudienceExpression).root).events;
              if (names.size) {
                const facts = await tx.loadAudienceFacts({ userId, afterUserId: null, limit: 1, traitKeys: [], eventNames: [...names], evaluatedAt, maxOccurrences: LIMITS.maxEvaluatedEventOccurrences, eventRowBudget: names.size * LIMITS.maxEvaluatedEventOccurrences });
                if (facts.overflow) throw new InAppError(503, "Audience facts unavailable");
                events = facts.eventsByUser.get(userId) ?? [];
              }
            }
            if (campaignMatches(campaign, user, events, evaluatedAt)) eligible.push(campaign);
          }
          return eligible;
        },
        delivery: (campaign, userId, variantId, queuedAt) => tx.getOrCreateDelivery({
          id: "del_" + randomUUID(), campaignId: campaign.id, userId, variantId, state: "queued", queuedAt,
          sentAt: null, deliveredAt: null, shownAt: null, openedAt: null, clickedAt: null, dismissedAt: null,
          bouncedAt: null, complainedAt: null, unsubscribedAt: null, convertedAt: null,
        }),
        getDelivery: (id) => tx.getDeliveryForUpdate(id),
        isInApp: async (id) => (await tx.getCampaign(id))?.channel === "web_inapp",
        content: (value) => publicMessageContent(JSON.parse(value), media, projectId),
        async saveFeedback(id, type, timestamp) {
          const delivery = await tx.getDeliveryForUpdate(id);
          if (!delivery) throw new InAppError(404, "Delivery not found");
          const firstExposure = delivery.shownAt === null;
          applyDeliveryFeedback(delivery, type, timestamp);
          if (type === "shown" && firstExposure) {
            const campaign = await tx.getCampaign(delivery.campaignId);
            const goal = campaign?.goalId ? await tx.getGoal(campaign.goalId) : null;
            if (goal?.targetEvent) {
              const event = await tx.findFirstEventAtOrAfter(delivery.userId, goal.targetEvent, timestamp);
              if (event) { delivery.state = "converted"; delivery.convertedAt = event.occurredAt; }
            }
          }
          await tx.saveDelivery(delivery);
          if (type === "shown" && firstExposure) await effects.recordFirstDelivery?.(tx, { deliveryId: id, userId: delivery.userId, occurredAt: timestamp, channel: "web_inapp" });
        },
      };
  return adapter;
}
