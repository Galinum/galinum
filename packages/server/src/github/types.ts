import type { ActivationEvidence, CampaignSourceChange } from "@galinum/core";

export type ShippingChange = { id: string } & CampaignSourceChange;
export type ShippingOrder = { statusAt: number; statusId: number };
export type ShippingObservation = ShippingOrder & {
  deploymentId: number;
  sha: string;
  state: "queued" | "pending" | "in_progress" | "success" | "failure" | "error" | "inactive";
};
export type ShippingSourceQualification = { state: "verified" } | { state: "unknown"; reason: string };
export type ShippingChangeCoverage = { source: ShippingSourceQualification; changeId: string; state: "present" | "absent" | "reverted" | "unknown"; reason?: string; revertSha?: string };
export type ShippingSnapshot = {
  state: "current" | "none" | "unknown" | "pending";
  evidence: ActivationEvidence | null;
  watermark: ShippingOrder | null;
  coverage: ShippingChangeCoverage[];
  coverageRevision?: string;
  checkedAt: number;
  reason?: string;
  retryAfterMs?: number;
  pendingWork?: true;
  providerState?: unknown;
};
export type ShippingProviderInput = {
  scope: { installationId: number; repositoryId: number; owner: string; name: string };
  environment: string;
  scopeRevision: string;
  sourceBranches: Record<string, string>;
  generation: number;
  activationToken?: string;
  changes: ShippingChange[];
  previous: ShippingSnapshot | null;
  observed: ShippingObservation | null;
};
export type ShippingProvider = { refresh(input: ShippingProviderInput): Promise<ShippingSnapshot> };
