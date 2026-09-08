import type { LaunchReadiness } from "@galinum/core";
import { digest, validateCredential, validatePushContent, validatePushSettings, type CredentialVault } from "@galinum/push";
import type { CommunicationData } from "./communication-data.js";
import type { ProductCampaign } from "./local-product.js";

export async function configuredPushReadiness(data: Pick<CommunicationData, "getPushRecord">, campaign: ProductCampaign, vault: CredentialVault | null, projectId: string): Promise<LaunchReadiness> {
  if (!vault) return { ok: false, error: "Persistent push encryption is not configured." };
  if (!validatePushSettings(campaign.push)) return { ok: false, error: "Invalid push settings." };
  const contents = campaign.variants.map((variant) => JSON.parse(variant.content_json));
  if (!contents.every(validatePushContent)) return { ok: false, error: "Invalid push content." };
  const missing = new Set(contents.map((_, index) => index).filter((index) => campaign.variants[index].weight > 0));
  for (const platform of ["ios", "android"] as const) for (const environment of ["development", "production"] as const) {
    const record = await data.getPushRecord("credential", digest([campaign.push.appId, platform, environment]));
    if (!record || record.appId !== campaign.push.appId || record.platform !== platform || record.environment !== environment || record.validation !== "local_valid") continue;
    try {
      const credential = validateCredential(vault.open(record.encrypted, `${projectId}:${record.id}`));
      if (platform === "ios" ? credential.provider !== "apns" || credential.topic !== campaign.push.appId : credential.provider !== "fcm") continue;
      for (const index of missing) {
        const content = contents[index];
        if (platform === "android" ? !!content.android : !content.actions?.length || !!content.ios?.categoryId) missing.delete(index);
      }
      if (missing.size === 0) return { ok: true };
    } catch { }
  }
  return { ok: false, error: "No usable push credential matches this app and content platforms." };
}
