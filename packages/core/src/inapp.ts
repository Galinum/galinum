import type { InAppDecisionInput, InAppFeedbackInput } from "@galinum/contracts";
export type { InAppDecisionInput } from "@galinum/contracts";
import { pickVariant, sortByPresentation, type VariantAssignment } from "./messages.js";

export type InAppFeedback = InAppFeedbackInput["type"];
export interface InAppDelivery {
  id: string; campaignId: string; userId: string; variantId: string; state: string;
  shownAt: number | null; clickedAt: number | null; dismissedAt: number | null; convertedAt: number | null;
}
export interface InAppCandidate { id: string; pages: string[] | null; variants: VariantAssignment[] }
export interface InAppFeedbackRecord { id: string; deliveryId: string; userId: string; externalId: string; type: InAppFeedback; acknowledgedAt: number }
export interface InAppPersistence {
  getInAppFeedback(id: string): Promise<InAppFeedbackRecord | null>;
  insertInAppFeedback(record: InAppFeedbackRecord): Promise<void>;
}
export interface InAppTransaction extends InAppPersistence {
  user(externalId: string): Promise<{ id: string } | null>;
  candidates(userId: string, path: string, now: number): Promise<InAppCandidate[]>;
  delivery(campaign: InAppCandidate, userId: string, variantId: string, now: number): Promise<InAppDelivery>;
  getDelivery(id: string): Promise<InAppDelivery | null>;
  isInApp(campaignId: string): Promise<boolean>;
  content(json: string): unknown;
  saveFeedback(id: string, type: InAppFeedback, now: number): Promise<void>;
}
export interface InAppHost<Tx extends InAppTransaction = InAppTransaction> {
  projectId: string;
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  mayServe(tx: Tx, userId: string, now: number): Promise<boolean>;
  recordExposure(tx: Tx, fact: { id: string; projectId: string; userId: string; deliveryId: string; shownAt: number }): Promise<void>;
  now(): number;
}
export class InAppError extends Error { constructor(public status: number, message: string) { super(message); } }
export function createInAppService<Tx extends InAppTransaction>(host: InAppHost<Tx>) {
  return {
    decide(input: InAppDecisionInput) {
      return host.transaction(async (tx) => {
        const evaluatedAt = host.now();
        const result = { userId: input.userId, entryId: input.entryId, requestId: input.requestId, evaluatedAt };
        const user = await tx.user(input.userId);
        const messages = [];
        if (user && await host.mayServe(tx, user.id, evaluatedAt)) {
          for (const campaign of await tx.candidates(user.id, input.path, evaluatedAt)) {
            const assigned = pickVariant(user.id, campaign.id, campaign.variants);
            if (!assigned) continue;
            const delivery = await tx.delivery(campaign, user.id, assigned.id, evaluatedAt);
            if (delivery.clickedAt !== null || delivery.dismissedAt !== null || delivery.convertedAt !== null || !["queued", "shown"].includes(delivery.state)) continue;
            const variant = campaign.variants.find((v) => v.id === delivery.variantId);
            if (variant) messages.push({ deliveryId: delivery.id, campaignId: campaign.id, variantId: variant.id, pages: campaign.pages, content: tx.content(variant.content_json) });
          }
        }
        return { ...result, messages: sortByPresentation(messages) };
      });
    },
    feedback(deliveryId: string, userId: string, type: InAppFeedback, feedbackId: string) {
      return host.transaction(async (tx) => {
        const prior = await tx.getInAppFeedback(feedbackId);
        if (prior && (prior.externalId !== userId || prior.deliveryId !== deliveryId || prior.type !== type)) throw new InAppError(409, "Feedback replay conflict");
        const user = await tx.user(userId);
        const delivery = await tx.getDelivery(deliveryId);
        if (!delivery || !await tx.isInApp(delivery.campaignId)) throw new InAppError(404, "Delivery not found");
        if (!user || delivery.userId !== user.id) throw new InAppError(409, "Delivery identity conflict");
        if (type !== "shown" && delivery.shownAt === null) throw new InAppError(409, "Shown acknowledgement required");
        const acknowledgedAt = prior?.acknowledgedAt ?? host.now();
        if (!prior) {
          await tx.insertInAppFeedback({ id: feedbackId, externalId: userId, userId: user.id, deliveryId, type, acknowledgedAt });
          await tx.saveFeedback(deliveryId, type, acknowledgedAt);
          if (type === "shown") await host.recordExposure(tx, { id: feedbackId, projectId: host.projectId, userId: user.id, deliveryId, shownAt: acknowledgedAt });
        }
        return { userId, deliveryId, type, receiptId: feedbackId, acknowledgedAt };
      });
    },
  };
}
