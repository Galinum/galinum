import { describe, expect, it } from "vitest";
import { MemoryProductStore } from "./local-product.js";
import type { ActivationMapping, ActivationSettings, ActivationState, StockPreparation, StockSource } from "./activation/store.js";
import type { ShippingWarning } from "@galinum/core";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const settings: ActivationSettings = { defaultMode: "manual", policyVersion: 1, generation: 1, nextAttemptAt: 0,
  leaseToken: null, leaseGeneration: null, leaseExpiresAt: null, campaignCursor: "", lastError: null };
const mapping: ActivationMapping = { id: "mapping", installationId: 1, repositoryId: 2, owner: "example", name: "product", environment: "production",
  sourceIds: ["source"], scopeDescription: "Product", confirmedBy: "operator", confirmedAt: 1, version: 1, generation: 1,
  observed: null, snapshot: null, snapshotGeneration: null, checkedAt: null };
const state: ActivationState = { modeOverride: "manual", version: 1, launch: null, monitor: null, readinessError: null };
const preparation: StockPreparation = { version: 1, changes: [{ sourceId: "source", kind: "commit", sha: "a".repeat(40) }],
  approvedBy: "operator", approvedAt: 1, reviewedContentHash: "reviewed" };
const source: StockSource = { id: "source", installationId: 1, repositoryId: 2, owner: "example", name: "product", branch: "main", enabled: true, paused: false, version: 1 };
const warning: ShippingWarning = { id: "warning", reason: "rollback", createdAt: 2, mappingId: "mapping", mappingLabel: "Production", requirementIds: ["requirement"],
  evidence: { id: "deployment", provider: "github", label: "Deployment", url: "https://github.com/example/product/deployments", revision: "b".repeat(40), reportedAt: 2 } };

describe("memory root activation facade", () => {
  it("preserves every queued activation write when an unrelated product transaction publishes", async () => {
    const store = new MemoryProductStore(); const facade = store.activation;
    await facade.saveMapping({ ...mapping, id: "removed", environment: "old" });
    const entered = gate(); const resume = gate();
    const transaction = store.transaction(async (session) => {
      await session.identifyUser("transaction-user", {}, 1);
      entered.release(); await resume.promise;
    });
    await entered.promise;
    const writes = [facade.saveControls({ paused: true, version: 1 }), facade.saveSettings(settings), facade.saveMapping(mapping), facade.deleteMapping("removed"),
      facade.saveState("campaign", state), facade.savePreparation("campaign", preparation), facade.saveSource(source), facade.insertWarning("campaign", warning)];
    resume.release(); await transaction; await Promise.all(writes);
    expect(await store.getUserByExternalId("transaction-user")).not.toBeNull();
    expect(await store.activation.controls()).toEqual({ paused: true, version: 1 });
    expect(await store.activation.settings()).toEqual(settings);
    expect(await store.activation.mappings()).toEqual([mapping]);
    expect(await store.activation.state("campaign")).toEqual(state);
    expect(await store.activation.preparation("campaign")).toEqual(preparation);
    expect(await store.activation.sources()).toEqual([source]);
    expect(await store.activation.warnings("campaign")).toEqual([warning]);
    expect(await facade.preparationCampaignIds("", 10)).toEqual(["campaign"]);
  });

  it("keeps saved facade references current while hiding uncommitted writes", async () => {
    const store = new MemoryProductStore(); const facade = store.activation;
    const entered = gate(); const resume = gate();
    const transaction = store.transaction(async (session) => {
      await session.activation.saveControls({ paused: true, version: 1 });
      entered.release(); await resume.promise;
    });
    try {
      await entered.promise;
      expect(await facade.controls()).toEqual({ paused: false, version: 0 });
      resume.release(); await transaction;
      expect(store.activation).toBe(facade);
      expect(await facade.controls()).toEqual({ paused: true, version: 1 });
    } finally { resume.release(); await transaction; }
  });

  it("does not let concurrent root writers change an active read snapshot", async () => {
    const store = new MemoryProductStore(); const facade = store.activation;
    const entered = gate(); const resume = gate();
    const snapshot = store.withReadSnapshot(async (session) => {
      const before = await session.activation.controls();
      entered.release(); await resume.promise;
      return { before, after: await session.activation.controls() };
    });
    try {
      await entered.promise;
      await facade.saveControls({ paused: true, version: 1 });
      expect(await facade.controls()).toEqual({ paused: true, version: 1 });
      resume.release();
      expect(await snapshot).toEqual({ before: { paused: false, version: 0 }, after: { paused: false, version: 0 } });
    } finally { resume.release(); await snapshot; }
  });

  it("gives snapshot sessions isolated raw activation state", async () => {
    const store = new MemoryProductStore();
    await store.withReadSnapshot(async (session) => {
      expect(session.activation).not.toBe(store.activation);
      await session.activation.saveControls({ paused: true, version: 1 });
      expect(await session.activation.controls()).toEqual({ paused: true, version: 1 });
      expect(await store.activation.controls()).toEqual({ paused: false, version: 0 });
    });
    expect(await store.activation.controls()).toEqual({ paused: false, version: 0 });
  });
});
