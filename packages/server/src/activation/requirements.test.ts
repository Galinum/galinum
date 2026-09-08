import { describe, expect, it } from "vitest";
import { activationDigest, campaignContent, campaignContentHash, canonicalHash, mergeShippingSnapshot, normalizeRequirements, projectCoverage, type CampaignContentInput } from "./requirements.js";
import type { ActivationMapping, ActivationRequirements, ActivationSource } from "./store.js";
import type { ShippingSnapshot } from "../github/types.js";
const source: ActivationSource = { id: "source", installationId: 1, repositoryId: 2, owner: "example", name: "app", branch: "main", enabled: true, paused: false, available: true };
const mapping: ActivationMapping = { id: "mapping", installationId: 1, repositoryId: 2, owner: "example", name: "app", environment: "Production",
  sourceIds: ["source"], scopeDescription: "Product", confirmedBy: "operator", confirmedAt: 1, version: 1, generation: 0, observed: null, snapshot: null, snapshotGeneration: null, checkedAt: null };
function requirements(): ActivationRequirements { return { changes: [{ id: "input", kind: "commit", sourceId: "source", sha: "a".repeat(40) }],
  requirements: [{ id: "input", sourceId: "source", label: "Feature", mappingIds: ["untrusted-mapping"] }], sources: [{ id: "source", state: "ready" }], digest: "untrusted" }; }
function evidence(head = "1"): ShippingSnapshot { return { state: "current", evidence: { id: `deployment-${head}`, provider: "fixture", label: "Production", url: "https://example.test/deployment", revision: head.repeat(40), reportedAt: 1 },
  watermark: { statusAt: 1, statusId: 1 }, coverage: [{ changeId: "a", state: "present", source: { state: "verified" } }], checkedAt: 1 }; }

describe("activation requirement identities", () => {
  it("binds opaque declaration IDs to source and immutable change identity", () => {
    const result = normalizeRequirements(requirements(), [mapping], [source]);
    expect(result.changes[0].id).toBe(`source:commit:${"a".repeat(40)}`);
    expect(result.requirements[0]).toMatchObject({ id: result.changes[0].id, mappingIds: [mapping.id] });
    expect(result.digest).not.toBe("untrusted");
    const other = requirements(); if (other.changes[0].kind === "commit") other.changes[0].sha = "b".repeat(40);
    expect(normalizeRequirements(other, [mapping], [source]).changes[0].id).not.toBe(result.changes[0].id);
  });
  it("binds PR identity to its complete original set independent of order", () => {
    const input = requirements(); input.changes = [{ id: "input", kind: "pull_request", sourceId: "source", number: 4, shas: ["b".repeat(40), "a".repeat(40)] }];
    const first = normalizeRequirements(input, [mapping], [source]);
    const pull = input.changes[0];
    if (pull.kind !== "pull_request") throw new Error("Expected PR fixture");
    pull.shas.reverse();
    expect(normalizeRequirements(input, [mapping], [source])).toEqual(first);
    pull.shas.push("c".repeat(40));
    expect(normalizeRequirements(input, [mapping], [source]).changes[0].id).not.toBe(first.changes[0].id);
  });
  it("does not trust a ready declaration when source access or repository binding changed", () => {
    expect(normalizeRequirements(requirements(), [mapping], []).sources).toEqual([{ id: "source", state: "unavailable" }]);
    expect(normalizeRequirements(requirements(), [mapping], [{ ...source, paused: true }]).sources).toEqual([{ id: "source", state: "paused" }]);
    expect(normalizeRequirements(requirements(), [mapping], [{ ...source, repositoryId: 99 }]).requirements[0].mappingIds).toEqual([]);
  });
  it("retains branch identity in the digest without changing immutable change IDs", () => {
    const initial = normalizeRequirements(requirements(), [mapping], [source]);
    const rebound = normalizeRequirements(requirements(), [mapping], [{ ...source, branch: "release/next" }]);
    expect(rebound.changes).toEqual(initial.changes);
    expect(rebound.requirements).toEqual(initial.requirements);
    expect(rebound.sources).toEqual(initial.sources);
    expect(rebound.digest).not.toBe(initial.digest);
    const unrelated = { ...source, id: "unrelated", branch: "elsewhere" };
    expect(normalizeRequirements(requirements(), [mapping], [unrelated, source]).digest).toBe(initial.digest);
    expect(normalizeRequirements(requirements(), [mapping], [source, unrelated]).digest).toBe(initial.digest);
  });
  it("marks missing and contradictory declaration facts pending", () => {
    const input = requirements(); input.changes = [];
    expect(normalizeRequirements(input, [mapping], [source]).sources[0].state).toBe("pending");
    input.changes = [...requirements().changes, ...requirements().changes];
    expect(normalizeRequirements(input, [mapping], [source]).sources[0].state).toBe("pending");
  });
});

describe("deployment snapshot projection", () => {
  it.each(["unknown", "pending"] as const)("retains verified coverage through %s without exposing positive coverage until current", (state) => {
    const previous = evidence();
    const paused = mergeShippingSnapshot(previous, { state, evidence: null, watermark: previous.watermark, coverage: [], checkedAt: 2 });
    expect(paused.coverage).toEqual(previous.coverage);
    const input = requirements(); input.requirements[0].id = "a"; input.requirements[0].mappingIds = [mapping.id];
    expect(projectCoverage(input, [{ ...mapping, snapshot: paused, snapshotGeneration: 0 }])[0].state).not.toBe("present");
    const next = evidence(); next.coverage = [{ changeId: "b", state: "present", source: { state: "verified" } }];
    expect(mergeShippingSnapshot(paused, next).coverage.map((value) => value.changeId)).toEqual(["a", "b"]);
    expect(mergeShippingSnapshot(paused, evidence("2")).coverage).toEqual(evidence("2").coverage);
  });
  it("preserves contradictory fresh duplicates so projection fails safely", () => {
    const next = evidence(); next.coverage.push({ changeId: "a", state: "reverted", source: { state: "verified" } });
    const merged = mergeShippingSnapshot(evidence(), next);
    const input = requirements(); input.requirements[0] = { ...input.requirements[0], id: "a", mappingIds: [mapping.id] };
    expect(projectCoverage(input, [{ ...mapping, snapshot: merged, snapshotGeneration: 0 }])[0]).toMatchObject({ state: "unknown", reason: "Deployment coverage is duplicated." });
  });
  it("separates configured-source qualification from frozen deployed coverage", () => {
    const value = evidence();
    value.coverage = [{ changeId: "a", state: "reverted", source: { state: "unknown", reason: "Configured branch moved." } }];
    const input = requirements(); input.requirements[0] = { ...input.requirements[0], id: "a", mappingIds: [mapping.id] };
    const mappings = [{ ...mapping, snapshot: value, snapshotGeneration: 0 }];
    expect(projectCoverage(input, mappings)[0]).toMatchObject({ state: "unknown", reason: "Configured branch moved." });
    expect(projectCoverage(input, mappings, false)[0]).toMatchObject({ state: "reverted", evidence: value.evidence });
  });
  it("does not publish a successful snapshot older than the durable watermark", () => {
    const previous = evidence(); previous.watermark = { statusAt: 3, statusId: 3 };
    const merged = mergeShippingSnapshot(previous, evidence("2"));
    expect(merged.state).toBe("unknown"); expect(merged.watermark).toEqual(previous.watermark);
    expect(merged.coverage).toEqual(previous.coverage);
    expect(merged.coverageRevision).toBe(previous.evidence?.revision);
  });
});

describe("canonical campaign content", () => {
  const content: CampaignContentInput = { name: "Feature", channel: "web_inapp", goalId: null, audience: { kind: "all" }, targeting: null, pages: null,
    deliverFrom: null, deliverUntil: null, variants: [{ id: "b", name: "B", content: { body: "Second" }, weight: 40, isControl: false },
      { id: "a", name: "A", content: { title: "First" }, weight: 60, isControl: true }] };
  it("uses the public content field projection and ignores metrics and lifecycle", () => {
    const projected = campaignContent(content);
    expect(projected).toEqual({ name: "Feature", channel: "web_inapp", goalId: null, audience: { kind: "all" }, targeting: null, pages: null,
      deliverFrom: null, deliverUntil: null, variants: { a: { name: "A", content: { title: "First" }, weight: 60, isControl: true }, b: { name: "B", content: { body: "Second" }, weight: 40, isControl: false } } });
    const observed = { ...content, status: "running", startedAt: 10, stats: { sent: 50 }, variants: [...content.variants].reverse().map((variant) => ({ ...variant, stats: { sent: 25 } })) };
    expect(campaignContentHash(observed)).toBe(campaignContentHash(content));
    expect(campaignContentHash(content)).toBe(canonicalHash(projected));
    expect(campaignContentHash(content)).toBe("92c543a8b99cc02d5bbcdd39b77507f8a7c4c13843a6c96647a44ae9f776e58f");
    expect(campaignContentHash({ ...content, deliverUntil: 100 })).not.toBe(campaignContentHash(content));
  });
  it("canonicalizes object keys, omits undefined and preserves array order", () => {
    expect(canonicalHash({ z: 1, a: { x: 2 }, omitted: undefined })).toBe(activationDigest({ a: { x: 2 }, z: 1 }));
    expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
  });
});
