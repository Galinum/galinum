export const CHANNELS = {
  push: { conversion: "engagement_order", openStates: ["queued", "sending", "retryable"] },
  web_inapp: {
    exposureColumn: "shown_at",
    openStates: ["queued", "shown"],
  },
  email: {
    exposureColumn: "delivered_at",
    openStates: ["sending", "retryable"],
  },
} as const;

export type CampaignChannel = keyof typeof CHANNELS;
export type ExposureColumn = typeof CHANNELS.web_inapp.exposureColumn | typeof CHANNELS.email.exposureColumn;

export const CAMPAIGN_CHANNELS = Object.keys(CHANNELS) as CampaignChannel[];

export function isCampaignChannel(value: unknown): value is CampaignChannel {
  return typeof value === "string" && CAMPAIGN_CHANNELS.includes(value as CampaignChannel);
}
