import type { ProductStoreSession } from "./local-product.js";

export type CommunicationData = Pick<ProductStoreSession,
  "queryPushUsers" | "getInAppFeedback" | "insertInAppFeedback" | "getPushRecord" | "queryPushRecords" |
  "insertPushRecord" | "savePushControl" | "pushTotals" | "lockInstallations" | "getInstallation" |
  "listInstallations" | "saveInstallation" | "getTokenOwner" | "getInstallationReplay" | "saveInstallationReplay" |
  "identifyUser" | "touchUser" | "getUserById" | "getUserByExternalId" | "insertEvent" | "loadAudienceFacts" |
  "listConversionCandidatesForUpdate" | "getGoal" | "getSegmentVersion" | "getCampaign" | "queryCampaigns" | "getOrCreateDelivery" |
  "getDeliveryForUpdate" | "saveDelivery" | "findFirstEventAtOrAfter"
>;
export type ActivityFact =
  | { kind: "identify"; userId: string; occurredAt: number }
  | { kind: "event"; userId: string; eventId: string; eventRowId: string; occurredAt: number };
export interface FirstDeliveryFact { deliveryId: string; userId: string; occurredAt: number; channel: "push" | "web_inapp" }
export interface CommunicationEffects<Data extends CommunicationData> {
  recordActivity?(data: Data, fact: ActivityFact): Promise<void>;
  recordFirstDelivery?(data: Data, fact: FirstDeliveryFact): Promise<void>;
}

export class TraitsCapacityError extends Error {}
