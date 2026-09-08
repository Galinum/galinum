import type { AudienceExpression } from "@galinum/core";
import type { ProductCampaignAudience } from "./local-product.js";
export function campaignAudienceView(audience: ProductCampaignAudience) {
  if (audience.kind === "all") return audience;
  if (audience.kind === "invalid") return { kind: audience.kind, audienceVersionId: audience.audienceVersionId };
  const expression = JSON.parse(audience.expressionJson) as AudienceExpression;
  return {
    kind: audience.kind === "legacy" ? "expression" : audience.kind,
    audienceVersionId: audience.audienceVersionId,
    ...(audience.kind === "segment"
      ? {
          segmentId: audience.segmentId,
          segmentKey: audience.segmentKey,
          segmentVersion: audience.segmentVersion,
        }
      : {}),
    schemaVersion: audience.schemaVersion,
    expression,
    expressionHash: audience.expressionHash,
    summary: audience.summary,
    reason: audience.reason,
    ...(audience.kind === "expression" || audience.kind === "legacy" ? { legacy: audience.kind === "legacy" } : {}),
  };
}
