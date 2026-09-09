import { describe, expect, it } from "vitest";
import type { ShippingWarning } from "@galinum/core";
import { MemoryActivationData } from "./memory.js";
import type { ActivationMapping, ActivationSettings, ActivationState, StockPreparation, StockSource } from "./store.js";

const evidence = { id: "deployment-1", provider: "github", label: "Production", url: "https://github.com/example/product/deployments", revision: "a".repeat(40), reportedAt: 1700000000000 };
const settings: ActivationSettings = { defaultMode: "manual", policyVersion: 4, generation: 8, nextAttemptAt: 1700000000100,
  leaseToken: "lease-1", leaseGeneration: 8, leaseExpiresAt: 1700000100000, campaignCursor: "campaign-a", lastError: "Waiting for evidence" };
const mapping: ActivationMapping = { id: "mapping-a", installationId: 7, repositoryId: 12, owner: "example", name: "product", environment: "production",
  sourceIds: ["source-a", "source-b"], scopeDescription: "Customer application", confirmedBy: "operator", confirmedAt: 1700000000000,
  version: 3, generation: 8, observed: { deploymentId: 9, sha: evidence.revision, statusId: 10, statusAt: 1700000000000, state: "success" },
  snapshot: { state: "pending", evidence: null, watermark: { statusId: 10, statusAt: 1700000000000 }, coverage: [], checkedAt: 1700000000050,
    pendingWork: true, providerState: { scan: { page: 4, records: ["one", "two"] } } }, snapshotGeneration: 8, checkedAt: 1700000000050 };
const preparation: StockPreparation = { version: 6, changes: [{ sourceId: "source-a", kind: "pull_request", number: 42, shas: [evidence.revision] }],
  approvedBy: "operator", approvedAt: 1700000000000, reviewedContentHash: "reviewed" };
const state: ActivationState = { modeOverride: "manual", version: 3, readinessError: "Channel unavailable",
  launch: { mode: "manual", startedAt: 1700000000000, contentHash: "content", requirementsDigest: "requirements", evidence: [evidence] },
  monitor: { phase: "launched", requirements: { changes: [], requirements: [], sources: [], digest: "requirements" }, present: { requirement: evidence }, missing: ["requirement"] } };
const source: StockSource = { id: "source-a", installationId: 7, repositoryId: 12, owner: "example", name: "product", branch: "main", enabled: true, paused: false, version: 1 };
const warning: ShippingWarning = { id: "incident-1", reason: "rollback", createdAt: 1700000000000, mappingId: mapping.id, mappingLabel: "Production",
  requirementIds: ["requirement-b", "requirement-a"], evidence };

async function populated() {
  const data = new MemoryActivationData();
  await data.saveSettings(settings); await data.saveControls({ paused: true, version: 5 }); await data.saveMapping(mapping);
  await data.saveState("campaign-a", state); await data.savePreparation("campaign-a", preparation); await data.saveSource(source);
  await data.insertWarning("campaign-a", warning);
  return data;
}

async function snapshot(data: MemoryActivationData) {
  return { settings: await data.settings(), controls: await data.controls(), mappings: await data.mappings(), state: await data.state("campaign-a"),
    preparation: await data.preparation("campaign-a"), sources: await data.sources(), warnings: await data.warnings("campaign-a") };
}

describe("memory activation persistence", () => {
  it("returns absent records and initial controls without inventing state", async () => {
    const data = new MemoryActivationData();
    expect(await data.settings()).toBeNull(); expect(await data.state("missing")).toBeNull(); expect(await data.preparation("missing")).toBeNull();
    expect(await data.controls()).toEqual({ paused: false, version: 0 });
    expect(await data.sources()).toEqual([]); expect(await data.mappings()).toEqual([]); expect(await data.warnings("missing")).toEqual([]);
  });

  it("round-trips prepared, approved, launched and provider checkpoint data", async () => {
    expect(await snapshot(await populated())).toEqual({ settings, controls: { paused: true, version: 5 }, mappings: [mapping], state, preparation, sources: [source], warnings: [warning] });
  });

  it("owns saved objects independently from caller mutation", async () => {
    const data = new MemoryActivationData();
    const values = structuredClone({ settings, mapping, state, preparation, source, warning });
    await data.saveSettings(values.settings); await data.saveMapping(values.mapping); await data.saveState("campaign-a", values.state);
    await data.savePreparation("campaign-a", values.preparation); await data.saveSource(values.source); await data.insertWarning("campaign-a", values.warning);
    values.settings.defaultMode = "automatic"; values.mapping.sourceIds.push("injected"); values.mapping.snapshot!.providerState = { altered: true };
    values.state.monitor!.missing.push("injected"); values.state.launch!.evidence[0].label = "mutated"; values.preparation.changes = [];
    values.source.branch = "other"; values.warning.requirementIds = [];
    expect(await data.settings()).toEqual(settings); expect(await data.mappings()).toEqual([mapping]); expect(await data.state("campaign-a")).toEqual(state);
    expect(await data.preparation("campaign-a")).toEqual(preparation); expect(await data.sources()).toEqual([source]); expect(await data.warnings("campaign-a")).toEqual([warning]);
  });

  it("does not expose mutable storage through any getter", async () => {
    const data = await populated(); const original = await snapshot(data); const returned = await snapshot(data);
    returned.settings!.generation = 0; returned.controls.paused = false; returned.mappings[0].snapshot!.providerState = { replaced: true };
    returned.mappings[0].sourceIds.splice(0); returned.state!.monitor!.present.requirement.label = "edited";
    returned.preparation!.changes.splice(0); returned.sources[0].paused = true; returned.warnings[0].requirementIds.splice(0);
    expect(await snapshot(data)).toEqual(original);
  });

  it("isolates both directions of clone writes and lets a discarded transaction leave the original untouched", async () => {
    const data = await populated(); const before = await snapshot(data); const fork = data.clone();
    expect(await snapshot(fork)).toEqual(before);
    await fork.saveSettings({ ...settings, generation: 9 }); await fork.saveControls({ paused: false, version: 6 });
    await fork.deleteMapping(mapping.id); await fork.saveState("campaign-a", { ...state, readinessError: null });
    await fork.savePreparation("campaign-a", { ...preparation, changes: [] }); await fork.saveSource({ ...source, paused: true, version: 2 });
    await fork.insertWarning("campaign-a", { ...warning, id: "incident-2" });
    expect(await snapshot(data)).toEqual(before);
    const forkBefore = await snapshot(fork);
    await data.saveMapping({ ...mapping, scopeDescription: "Changed on original" });
    await data.savePreparation("campaign-a", { ...preparation, version: 7 });
    expect(await snapshot(fork)).toEqual(forkBefore);
  });

  it("replaces mapping bindings while preserving the supplied observations and confirmation", async () => {
    const data = await populated();
    await data.saveMapping({ ...mapping, sourceIds: ["source-c", "source-b", "source-b"], version: 4 });
    expect(await data.mappings()).toEqual([{ ...mapping, sourceIds: ["source-b", "source-c"], version: 4 }]);
    await data.saveMapping({ ...mapping, sourceIds: [] }); expect((await data.mappings())[0].sourceIds).toEqual([]);
    await data.deleteMapping(mapping.id); expect(await data.mappings()).toEqual([]);
  });

  it("keeps the first warning's identity, requirements, and evidence on duplicate insertion", async () => {
    const data = await populated();
    await data.insertWarning("campaign-a", { ...warning, createdAt: 1700001000000, requirementIds: ["replacement"], evidence: { ...evidence, id: "replacement" } });
    expect(await data.warnings("campaign-a")).toEqual([warning]); expect(await data.warnings("campaign-b")).toEqual([]);
    await expect(data.insertWarning("campaign-b", warning)).rejects.toThrow("another campaign");
  });

  it("orders warning and preparation reads deterministically and excludes cursor predecessors", async () => {
    const data = await populated();
    await data.insertWarning("campaign-a", { ...warning, id: "incident-0", createdAt: warning.createdAt + 1 });
    await data.savePreparation("campaign-c", preparation); await data.savePreparation("campaign-b", preparation);
    expect((await data.warnings("campaign-a")).map(row => row.id)).toEqual(["incident-0", "incident-1"]);
    expect(await data.preparationCampaignIds("", 2)).toEqual(["campaign-a", "campaign-b"]);
    expect(await data.preparationCampaignIds("campaign-b", 2)).toEqual(["campaign-c"]); expect(await data.preparationCampaignIds("", 0)).toEqual([]);
    await expect(data.preparationCampaignIds("", -1)).rejects.toThrow("limit");
  });

  it("matches source and repository/environment uniqueness constraints", async () => {
    const data = await populated();
    await expect(data.saveMapping({ ...mapping, id: "other-mapping" })).rejects.toThrow("already exists");
    await expect(data.saveSource({ ...source, id: "other-source" })).rejects.toThrow("already exists");
    expect(await data.sources()).toEqual([source]); expect(await data.mappings()).toEqual([mapping]);
  });
});
