import type { CampaignChannel } from "./channels.js";

export interface DeliveryEffects {
  mayDeliver(projectId: string, channel: CampaignChannel, now: number): Promise<boolean>;
  recordExposure(input: {
    projectId: string;
    channel: CampaignChannel;
    deliveryId: string;
    endUserId: string;
    occurredAt: number;
  }, executor?: object): Promise<() => Promise<void>>;
}
