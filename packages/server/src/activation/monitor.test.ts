import { describe, expect, it } from "vitest";
import type { ActivationCoverage, ActivationEvidence } from "@galinum/core";
import type { ActivationMapping, ActivationMonitor, ActivationRequirements } from "./store.js";
import { launchEvidence, reduceShippingMonitor } from "./monitor.js";
const mapping: ActivationMapping = { id: "mapping", installationId: 1, repositoryId: 2, owner: "example", name: "app", environment: "Production", sourceIds: ["source"],
  scopeDescription: "Product", confirmedBy: "operator", confirmedAt: 1, version: 1, generation: 0, observed: null, snapshot: null, snapshotGeneration: null, checkedAt: null };
const requirements: ActivationRequirements = { changes: [], requirements: ["a", "b"].map((id) => ({ id, sourceId: "source", label: id, mappingIds: [mapping.id] })), sources: [{ id: "source", state: "ready" }], digest: "requirements" };
const evidence = (id: string): ActivationEvidence => ({ id, provider: "fixture", label: "Production", revision: id, url: "https://example.test/deployment", reportedAt: 1 });
const coverage = (state: ActivationCoverage["state"], id: string): ActivationCoverage[] => requirements.requirements.map((requirement) => ({ requirementId: requirement.id, mappingId: mapping.id, state, evidence: evidence(id) }));
const reduce = (previous: ActivationMonitor | null, state: ActivationCoverage["state"], id: string, started = true, mappings = [mapping]) =>
  reduceShippingMonitor({ campaignId: "campaign", previous, requirements, mappings, coverage: coverage(state, id), started, now: 100 });

describe("shipping presence and warning reduction", () => {
  it("remembers prepared presence without warning until a launch exists", () => {
    const prepared = reduce(null, "present", "one", false);
    expect(prepared.monitor.phase).toBe("prepared"); expect(prepared.warnings).toEqual([]);
    expect(reduce(prepared.monitor, "absent", "two", false).warnings).toEqual([]);
    expect(launchEvidence(requirements, [mapping], coverage("unknown", "unknown"), prepared.monitor)).toEqual([evidence("one")]);
  });
  it.each(["absent", "reverted"] as const)("groups %s loss and waits for positive restoration before another incident", (loss) => {
    const prepared = reduce(null, "present", "one");
    const first = reduce(prepared.monitor, loss, "two");
    expect(first.warnings).toHaveLength(1); expect(first.warnings[0].requirementIds).toEqual(["a", "b"]);
    const continuing = reduce(first.monitor, loss, "three"); expect(continuing.warnings).toEqual([]);
    const unknown = reduce(continuing.monitor, "unknown", "four"); expect(unknown.warnings).toEqual([]);
    expect(reduce(unknown.monitor, loss, "five").warnings).toEqual([]);
    const restored = reduce(unknown.monitor, "present", "six");
    const second = reduce(restored.monitor, loss, "two");
    expect(second.warnings).toHaveLength(1); expect(second.warnings[0].id).not.toBe(first.warnings[0].id);
  });
  it("preserves presence through a descriptive mapping edit but not a different deployment target", () => {
    const known = reduce(null, "present", "one");
    const edited = { ...mapping, version: 2, scopeDescription: "Clearer product description" };
    expect(reduce(known.monitor, "absent", "two", true, [edited]).warnings).toHaveLength(1);
    expect(reduce(known.monitor, "absent", "two", true, [{ ...edited, repositoryId: 999 }]).warnings).toEqual([]);
  });
  it("does not infer rollback from unknown evidence or absence without prior presence", () => {
    expect(reduce(null, "unknown", "one").warnings).toEqual([]);
    expect(reduce(null, "absent", "one").warnings).toEqual([]);
    expect(reduce(null, "reverted", "one").warnings).toHaveLength(1);
  });
  it("scopes an incident to its campaign and keeps the same campaign's replay identity stable", () => {
    const present = reduce(null, "present", "one").monitor;
    const base = { previous: present, requirements, mappings: [mapping], coverage: coverage("absent", "two"), started: true, now: 100 };
    const firstInput = { ...base, campaignId: "campaign-a" };
    const secondInput = { ...base, campaignId: "campaign-b" };
    const first = reduceShippingMonitor(firstInput);
    const second = reduceShippingMonitor(secondInput);
    expect(first.warnings[0].id).not.toBe(second.warnings[0].id);
    expect(reduceShippingMonitor({ ...firstInput, now: 200 }).warnings[0].id).toBe(first.warnings[0].id);
    expect(reduceShippingMonitor({ ...firstInput, previous: first.monitor, now: 200 }).warnings).toEqual([]);
    expect(second.warnings[0].requirementIds).toEqual(first.warnings[0].requirementIds);
  });

  it("requires a campaign identity before reducing warnings", () => {
    expect(() => reduceShippingMonitor({ campaignId: "", previous: null, requirements, mappings: [mapping], coverage: coverage("reverted", "one"), started: true, now: 100 }))
      .toThrow("Campaign identity is required");
  });

});
