import type { CampaignChannel } from "./channels.js";

export interface CampaignEffects {
  launchReadiness(projectId: string, channel: CampaignChannel): Promise<
    { ok: true } | { ok: false; error: string }
  >;
  verifyMedia(executor: object, projectId: string, urls: string[]): Promise<void>;
}
