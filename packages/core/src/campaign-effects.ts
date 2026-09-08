import type { CampaignChannel } from "./channels.js";

export type LaunchReadiness = { ok: true } | { ok: false; error: string };

export interface CampaignEffects {
  launchReadiness(projectId: string, channel: CampaignChannel): Promise<LaunchReadiness>;
  verifyMedia(executor: object, projectId: string, urls: string[]): Promise<void>;
}
