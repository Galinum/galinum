import type { LaunchReadiness, MediaStore } from "@galinum/core";
import type { CredentialVault } from "@galinum/push";
import { campaignDefinitionReadiness } from "./activation/readiness.js";
import { configuredPushReadiness } from "./push-readiness.js";
import { campaignAudienceView } from "./campaign-audience-view.js";
import type { CommunicationData } from "./communication-data.js";
import type { ProductCampaign } from "./local-product.js";
export async function campaignReadiness(store: Pick<CommunicationData, "getGoal" | "getSegmentVersion" | "getCampaign" | "getPushRecord">, campaign: ProductCampaign, media: MediaStore, projectId: string, vault: CredentialVault | null = null): Promise<LaunchReadiness> {
  try {
    return await campaignDefinitionReadiness(projectId, {
      ...(campaign.channel === "push" ? { pushJson: JSON.stringify(campaign.push) } : {}),
      name: campaign.name, channel: campaign.channel, pages: campaign.pages, deliverFrom: campaign.deliverFrom, deliverUntil: campaign.deliverUntil,
      goalId: campaign.goalId, audience: campaignAudienceView(campaign.audience),
      ...(campaign.audience.kind === "legacy" ? { legacyTargetingJson: campaign.audience.targetingJson } : {}),
      variants: campaign.variants.map((variant) => ({ id: variant.id, name: variant.name, contentJson: variant.content_json, weight: variant.weight, isControl: variant.isControl })),
    }, {
      async getGoal(scope, id) {
        if (scope !== projectId) return null;
        const goal = await store.getGoal(id);
        return goal ? { projectId, id: goal.id } : null;
      },
      async getAudienceVersion(scope, reference) {
        if (scope !== projectId) return null;
        if (reference.segmentId !== null && reference.segmentVersion !== null) {
          const version = await store.getSegmentVersion(reference.segmentId, reference.segmentVersion);
          return version ? { projectId, ...version } : null;
        }
        const current = await store.getCampaign(campaign.id);
        const audience = current?.audience;
        return audience?.kind === "expression" && audience.audienceVersionId === reference.id ? { projectId, id: audience.audienceVersionId,
          segmentId: null, segmentVersion: null, schemaVersion: audience.schemaVersion, expressionJson: audience.expressionJson, expressionHash: audience.expressionHash } : null;
      },
      async getMedia(scope, url) {
        if (scope !== projectId) return null;
        const reference = media.resolve(projectId, url);
        if (!reference) return null;
        const stored = await media.get(reference.key);
        return stored && stored.key === reference.key ? { projectId, url } : null;
      },
      async channelReadiness(scope, channel) {
        if (scope !== projectId) return { ok: false, error: "Project not found." };
        if (channel === "web_inapp") return { ok: true };
        if (channel === "push") return configuredPushReadiness(store, campaign, vault, projectId);
        return { ok: false, error: "Unsupported campaign channel." };
      },
    });
  } catch { return { ok: false, error: "Campaign definition could not be verified." }; }
}
