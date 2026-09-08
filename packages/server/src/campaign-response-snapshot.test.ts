import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createProduct, MemoryProductStore } from "./local-product.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
class GatedStore extends MemoryProductStore {
  gate: { claimed: boolean; entered: ReturnType<typeof deferred<string[]>>; release: ReturnType<typeof deferred<void>> } | null = null;
  holdNextStats() {
    const gate = { claimed: false, entered: deferred<string[]>(), release: deferred<void>() };
    this.gate = gate;
    return gate;
  }
  override async campaignStatsForCampaigns(ids: string[]) {
    const gate = this.gate;
    if (gate && !gate.claimed) {
      gate.claimed = true;
      gate.entered.resolve(ids);
      await gate.release.promise;
    }
    return super.campaignStatsForCampaigns(ids);
  }
}
const changes = (letter: string) => [{ sourceId: "source", kind: "commit", sha: letter.repeat(40) }];
const definition = (name: string, letter: string, revision?: string) => ({ name, message: { title: name, presentation: "toast" },
  sourceChanges: { ...(revision === undefined ? {} : { expectedRevision: revision }), changes: changes(letter) } });

describe("campaign response definition snapshots", () => {
  it.each(["detail", "list", "create", "update"] as const)("keeps %s copy and source revision coherent across a concurrent PATCH", async (operation) => {
    const store = new GatedStore();
    const product = createProduct(store, { secretKey: "sk_snapshot", publishableKey: "pk_snapshot", operatorKey: "operator_snapshot" });
    const app = createApp(product.handlers, product.media, product.operatorHandler);
    const call = async (path: string, method = "GET", value?: unknown, operator = false) => {
      const response = await app(new Request(`http://local${path}`, { method,
        headers: { authorization: `Bearer ${operator ? "operator_snapshot" : product.secretKey}`, "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) }));
      return { status: response.status, value: await response.json() };
    };
    let gate: ReturnType<GatedStore["holdNextStats"]> | null = null;
    let pending: ReturnType<typeof call> | null = null;
    try {
      expect((await call("/operator/sources/source", "PUT", { expectedRevision: "0", installationId: 7, repositoryId: 12,
        owner: "owner", name: "repo", branch: "main", enabled: false, paused: false }, true)).status).toBe(200);
      let id: string | undefined;
      if (operation !== "create") {
        const created = await call("/api/v1/campaigns", "POST", operation === "update" ? definition("Original", "c") : definition("Copy A", "a"));
        expect(created.status).toBe(201); id = created.value.campaign.id;
      }
      gate = store.holdNextStats();
      pending = operation === "create" ? call("/api/v1/campaigns", "POST", definition("Copy A", "a"))
        : operation === "update" ? call(`/api/v1/campaigns/${id}`, "PATCH", definition("Copy A", "a", "1"))
        : call(operation === "list" ? "/api/v1/campaigns" : `/api/v1/campaigns/${id}`);
      [id] = await gate.entered.promise;
      const capturedRevision = operation === "update" ? "2" : "1";
      const concurrent = await call(`/api/v1/campaigns/${id}`, "PATCH", definition("Copy B", "b", capturedRevision));
      expect(concurrent.status).toBe(200);
      gate.release.resolve();
      const response = await pending;
      expect(response.status).toBe(operation === "create" ? 201 : 200);
      const captured = operation === "list" ? response.value.campaigns[0] : response.value.campaign;
      expect(captured).toMatchObject({ name: "Copy A", variants: [{ content: { title: "Copy A" } }],
        sourceChanges: { revision: capturedRevision, changes: changes("a") } });
      const current = await call(`/api/v1/campaigns/${id}`);
      expect(current.value.campaign).toMatchObject({ name: "Copy B", sourceChanges: {
        revision: String(Number(capturedRevision) + 1), changes: changes("b") } });
    } finally {
      gate?.release.resolve();
      await pending;
      await product.close();
    }
  });
});
