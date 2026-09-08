import type { ActivationCoverage, ActivationEvidence, ShippingWarning } from "@galinum/core";
import type { ActivationMapping, ActivationMonitor, ActivationRequirements } from "./store.js";
import { activationDigest } from "./requirements.js";

export function presenceKey(mapping: ActivationMapping, requirementId: string): string {
  return activationDigest({ mappingId: mapping.id, repositoryId: mapping.repositoryId, environment: mapping.environment, requirementId });
}

export function reduceShippingMonitor(input: {
  previous: ActivationMonitor | null;
  requirements: ActivationRequirements;
  mappings: ActivationMapping[];
  coverage: ActivationCoverage[];
  started: boolean;
  now: number;
}): { monitor: ActivationMonitor; warnings: ShippingWarning[] } {
  const monitor: ActivationMonitor = { phase: input.started ? "launched" : "prepared", requirements: structuredClone(input.requirements),
    present: structuredClone(input.previous?.present ?? {}), missing: [...(input.previous?.missing ?? [])] };
  const missing = new Set(monitor.missing);
  const losses = new Map<string, ActivationCoverage[]>();
  for (const coverage of input.coverage) {
    const mapping = input.mappings.find((mapping) => mapping.id === coverage.mappingId);
    if (!mapping || !coverage.evidence) continue;
    const key = presenceKey(mapping, coverage.requirementId);
    if (coverage.state === "present") { monitor.present[key] = coverage.evidence; missing.delete(key); continue; }
    if (!input.started || (coverage.state !== "reverted" && !(coverage.state === "absent" && monitor.present[key]))) continue;
    if (!missing.has(key)) losses.set(mapping.id, [...(losses.get(mapping.id) ?? []), coverage]);
    missing.add(key);
  }
  const warnings = [...losses.entries()].map(([mappingId, items]): ShippingWarning => {
    const mapping = input.mappings.find((mapping) => mapping.id === mappingId)!;
    const requirementIds = items.map((item) => item.requirementId).sort();
    const evidence = items[0].evidence!;
    const reason = items.some((item) => item.state === "reverted") ? "revert" : "rollback";
    const presence = requirementIds.map((id) => monitor.present[presenceKey(mapping, id)] ?? null);
    return { id: `shipwarn_${activationDigest({ mappingId, requirementIds, evidence, presence, reason })}`, reason, createdAt: input.now,
      mappingId, mappingLabel: `${mapping.owner}/${mapping.name} · ${mapping.environment}`, requirementIds, evidence };
  });
  monitor.missing = [...missing].sort();
  return { monitor, warnings };
}

export function launchEvidence(requirements: ActivationRequirements, mappings: ActivationMapping[], coverage: ActivationCoverage[], monitor: ActivationMonitor): ActivationEvidence[] {
  const values: ActivationEvidence[] = [];
  for (const requirement of requirements.requirements) for (const mappingId of requirement.mappingIds) {
    const mapping = mappings.find((mapping) => mapping.id === mappingId);
    const current = coverage.find((item) => item.requirementId === requirement.id && item.mappingId === mappingId);
    const evidence = current?.state === "present" ? current.evidence : mapping ? monitor.present[presenceKey(mapping, requirement.id)] : null;
    if (evidence) values.push(evidence);
  }
  return [...new Map(values.map((evidence) => [`${evidence.provider}:${evidence.id}`, evidence])).values()];
}
