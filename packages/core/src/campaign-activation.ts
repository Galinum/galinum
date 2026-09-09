import type { LaunchReadiness } from "./campaign-effects.js";

export type LaunchMode = "automatic" | "manual";
export type { CampaignSourceChange, CampaignSourceChanges } from "./management-contract.js";
export type ActivationEvidence = { id: string; provider: string; label: string; url: string; revision: string; reportedAt: number };
export type ActivationCoverage = { requirementId: string; mappingId: string; mappingLabel?: string; state: "present" | "absent" | "reverted" | "unknown" | "pending"; evidence: ActivationEvidence | null; reason?: string };
export type ActivationRequirement = { id: string; sourceId: string; label: string; mappingIds: string[] };
export type ActivationBlockerCode = "manual" | "approval" | "no_sources" | "mapping" | "source_pending" | "source_paused" | "source_unavailable" | "project_paused" | "withdrawn" | "deployment" | "evidence_unknown" | "reverted" | "expired" | "readiness";
export type ActivationBlocker = { code: ActivationBlockerCode; sourceId?: string; requirementId?: string; mappingId?: string; detail?: string };
export type ActivationAssessment = { state: "not_initial" | "waiting" | "eligible"; blockers: ActivationBlocker[] };
export type ActivationInput = {
  status: "draft" | "running" | "paused" | "ended";
  startedAt: number | null;
  defaultMode: LaunchMode;
  override: LaunchMode | null;
  approved: boolean;
  withdrawn: boolean;
  projectPaused: boolean;
  readiness: LaunchReadiness;
  sources: { id: string; state: "ready" | "pending" | "paused" | "unavailable" }[];
  requirements: ActivationRequirement[];
  coverage: ActivationCoverage[];
  deliverUntil: number | null;
  now: number;
};
export type ActivationReceipt = { mode: LaunchMode; startedAt: number; contentHash: string; requirementsDigest: string; evidence: ActivationEvidence[] };
export type ShippingWarning = { id: string; reason: "rollback" | "revert"; createdAt: number; mappingId: string; mappingLabel: string; requirementIds: string[]; evidence: ActivationEvidence };
export type CampaignActivationView = {
  campaignId: string;
  revision: string;
  defaultMode: LaunchMode;
  override: LaunchMode | null;
  effectiveMode: LaunchMode;
  approval: "approved" | "pending" | "unavailable";
  assessment: ActivationAssessment;
  requirements: ActivationRequirement[];
  coverage: ActivationCoverage[];
  lastCheckedAt: number | null;
  launch: ActivationReceipt | null;
  warnings: ShippingWarning[];
};
export type LaunchPolicy = { defaultMode: LaunchMode; revision: string };

export function assessAutomaticActivation(input: ActivationInput): ActivationAssessment {
  if (input.status !== "draft" || input.startedAt !== null) {
    return { state: "not_initial", blockers: [] };
  }

  const blockers: ActivationBlocker[] = [];
  if ((input.override ?? input.defaultMode) === "manual") blockers.push({ code: "manual" });
  if (!input.approved) blockers.push({ code: "approval" });
  if (input.withdrawn) blockers.push({ code: "withdrawn" });
  if (input.projectPaused) blockers.push({ code: "project_paused" });
  if (input.readiness?.ok !== true) {
    blockers.push({ code: "readiness", detail: input.readiness?.error ?? "Launch readiness has not been verified." });
  }
  if (input.sources.length === 0 || input.requirements.length === 0) {
    blockers.push({ code: "no_sources" });
  }

  for (const source of input.sources) {
    if (source.state === "pending") blockers.push({ code: "source_pending", sourceId: source.id });
    if (source.state === "paused") blockers.push({ code: "source_paused", sourceId: source.id });
    if (source.state === "unavailable") blockers.push({ code: "source_unavailable", sourceId: source.id });
  }

  const sourceIds = new Set(input.sources.map((source) => source.id));
  for (const requirement of input.requirements) {
    const scope = { sourceId: requirement.sourceId, requirementId: requirement.id };
    if (!sourceIds.has(requirement.sourceId)) {
      blockers.push({ code: "source_unavailable", ...scope });
    }
    if (requirement.mappingIds.length === 0) blockers.push({ code: "mapping", ...scope });
    for (const mappingId of new Set(requirement.mappingIds)) {
      const mapped = { ...scope, mappingId };
      if (!mappingId) {
        blockers.push({ code: "mapping", ...mapped });
        continue;
      }
      const coverage = input.coverage.filter((entry) =>
        entry.requirementId === requirement.id && entry.mappingId === mappingId);
      if (coverage.length !== 1) {
        blockers.push({ code: "evidence_unknown", ...mapped,
          detail: coverage.length === 0 ? "Coverage is missing." : "Coverage is duplicated." });
        continue;
      }
      const entry = coverage[0];
      const detail = entry.reason === undefined ? {} : { detail: entry.reason };
      if (entry.state === "unknown" || (entry.state === "present" && entry.evidence === null)) {
        blockers.push({ code: "evidence_unknown", ...mapped, ...detail });
      } else if (entry.state === "reverted") {
        blockers.push({ code: "reverted", ...mapped, ...detail });
      } else if (entry.state === "absent" || entry.state === "pending") {
        blockers.push({ code: "deployment", ...mapped, ...detail });
      }
    }
  }

  if (!Number.isFinite(input.now) || (input.deliverUntil !== null &&
    (!Number.isFinite(input.deliverUntil) || input.now >= input.deliverUntil))) {
    blockers.push({ code: "expired" });
  }
  return { state: blockers.length === 0 ? "eligible" : "waiting", blockers };
}
