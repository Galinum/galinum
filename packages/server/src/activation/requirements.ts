import { createHash } from "node:crypto";
import type { ActivationCoverage } from "@galinum/core";
import type { ActivationMapping, ActivationRequirements, ActivationSource } from "./store.js";
import type { ShippingSnapshot } from "../github/types.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function canonicalHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export const activationDigest = canonicalHash;
export type CampaignContentInput = {
  name: string; channel: string; goalId: string | null; audience: unknown; targeting: unknown; pages: string[] | null;
  deliverFrom: number | null; deliverUntil: number | null;
  variants: { id: string; name: string; content: unknown; weight: number; isControl: boolean }[];
};
export function campaignContent(campaign: CampaignContentInput) {
  return {
    name: campaign.name, channel: campaign.channel, goalId: campaign.goalId,
    audience: campaign.audience, targeting: campaign.targeting, pages: campaign.pages,
    deliverFrom: campaign.deliverFrom, deliverUntil: campaign.deliverUntil,
    variants: Object.fromEntries([...campaign.variants].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((variant) =>
      [variant.id, { name: variant.name, content: variant.content, weight: variant.weight, isControl: variant.isControl }])),
  };
}
export function campaignContentHash(campaign: CampaignContentInput): string { return canonicalHash(campaignContent(campaign)); }

export function mappingMatchesSource(mapping: ActivationMapping, source: ActivationSource): boolean {
  return mapping.sourceIds.includes(source.id) && mapping.installationId === source.installationId &&
    mapping.repositoryId === source.repositoryId && mapping.owner === source.owner && mapping.name === source.name;
}

export function sourceCatalogBindings(sourceIds: string[], catalog: ActivationSource[]): ActivationSource[] {
  const selected = new Set(sourceIds);
  return catalog.filter((source) => selected.has(source.id)).map((source) => ({ id: source.id,
    installationId: source.installationId, repositoryId: source.repositoryId, owner: source.owner, name: source.name,
    branch: source.branch, enabled: source.enabled, paused: source.paused, available: source.available }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
}

export function normalizeRequirements(input: ActivationRequirements, mappings: ActivationMapping[], catalog: ActivationSource[]): ActivationRequirements {
  const ids = [...new Set([...input.sources.map((source) => source.id), ...input.changes.map((change) => change.sourceId),
    ...input.requirements.map((requirement) => requirement.sourceId)])].sort();
  const severity = { ready: 0, pending: 1, paused: 2, unavailable: 3 };
  const sources = ids.map((id): ActivationRequirements["sources"][number] => {
    const current = catalog.filter((source) => source.id === id);
    const states = input.sources.filter((source) => source.id === id).map((source) =>
      source.state in severity ? source.state : "pending" as const);
    let state = states.length ? states.reduce((a, b) => severity[a] >= severity[b] ? a : b) : "pending" as const;
    if (current.length !== 1 || !current[0].enabled || !current[0].available) state = "unavailable";
    else if (current[0].paused && severity[state] < severity.paused) state = "paused";
    return { id, state };
  });
  const changes = structuredClone(input.changes).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const change of changes) {
    const valid = change.id.length > 0 && (change.kind === "commit" ? /^[a-f0-9]{40}$/.test(change.sha)
      : Number.isSafeInteger(change.number) && change.number > 0 && change.shas.length > 0 && change.shas.every((sha) => /^[a-f0-9]{40}$/.test(sha)));
    if (change.kind === "pull_request") change.shas = [...new Set(change.shas)].sort();
    const declarations = input.requirements.filter((requirement) => requirement.id === change.id && requirement.sourceId === change.sourceId);
    if (!valid || declarations.length !== 1 || changes.filter((other) => other.id === change.id).length !== 1) {
      const source = sources.find((source) => source.id === change.sourceId);
      if (source?.state === "ready") source.state = "pending";
    }
  }
  const requirements = input.requirements.map((requirement) => {
    if (changes.filter((change) => change.id === requirement.id && change.sourceId === requirement.sourceId).length !== 1) {
      const source = sources.find((source) => source.id === requirement.sourceId);
      if (source?.state === "ready") source.state = "pending";
    }
    const source = catalog.find((source) => source.id === requirement.sourceId);
    return { ...requirement, mappingIds: source ? mappings.filter((mapping) => mappingMatchesSource(mapping, source)).map((mapping) => mapping.id).sort() : [] };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const change of changes) {
    const original = change.id;
    change.id = change.kind === "commit" ? `${change.sourceId}:commit:${change.sha}`
      : `${change.sourceId}:pr:${change.number}:${activationDigest(change.shas)}`;
    for (const requirement of requirements) if (requirement.id === original && requirement.sourceId === change.sourceId) requirement.id = change.id;
  }
  changes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  requirements.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { changes, requirements, sources, digest: activationDigest({ changes, requirements, sources, bindings: sourceCatalogBindings(ids, catalog) }) };
}

export function projectCoverage(requirements: ActivationRequirements, mappings: ActivationMapping[], requireVerifiedSource = true): ActivationCoverage[] {
  return requirements.requirements.flatMap((requirement) => requirement.mappingIds.map((mappingId): ActivationCoverage => {
    const mapping = mappings.find((mapping) => mapping.id === mappingId);
    const identity = { requirementId: requirement.id, mappingId, mappingLabel: mapping ? `${mapping.owner}/${mapping.name} · ${mapping.environment}` : "Unresolved deployment" };
    const value = mapping?.snapshot;
    if (!mapping || !value || mapping.snapshotGeneration !== mapping.generation) return { ...identity, state: "pending", evidence: null, reason: "Deployment evidence is being checked." };
    const matches = value.coverage.filter((coverage) => coverage.changeId === requirement.id);
    if (value.state !== "current" || matches.length !== 1) return { ...identity,
      state: value.state === "none" || value.state === "pending" ? "pending" : "unknown", evidence: value.evidence,
      reason: matches.length > 1 ? "Deployment coverage is duplicated." : value.reason ?? "Current deployment coverage is not verified." };
    const coverage = matches[0];
    if (requireVerifiedSource && coverage.source?.state !== "verified") return { ...identity, state: "unknown", evidence: value.evidence,
      reason: coverage.source?.state === "unknown" ? coverage.source.reason : "Source changes are not verified on the configured branch." };
    return { ...identity, state: coverage.state, evidence: value.evidence, ...(coverage.reason ? { reason: coverage.reason } : {}) };
  }));
}

export function mergeShippingSnapshot(previous: ShippingSnapshot | null, incoming: ShippingSnapshot): ShippingSnapshot {
  const next = structuredClone(incoming);
  if (previous?.watermark && (!next.watermark || previous.watermark.statusAt > next.watermark.statusAt ||
    (previous.watermark.statusAt === next.watermark.statusAt && previous.watermark.statusId > next.watermark.statusId))) {
    if (next.state === "current") { next.state = "unknown"; next.reason = "Deployment evidence is older than the last verified observation."; }
    next.watermark = previous.watermark;
  }
  const revision = previous?.coverageRevision ?? previous?.evidence?.revision;
  if (next.state === "current" && next.evidence) {
    if (revision === next.evidence.revision) {
      const updated = new Set(next.coverage.map((coverage) => coverage.changeId));
      next.coverage = [...(previous?.coverage ?? []).filter((coverage) => !updated.has(coverage.changeId)), ...next.coverage];
    }
    next.coverageRevision = next.evidence.revision;
  } else if (revision) {
    next.coverage = structuredClone(previous?.coverage ?? []);
    next.coverageRevision = revision;
  }
  return next;
}
