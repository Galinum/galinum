import { describe, expect, it, vi } from "vitest";
import { MemoryActivationData } from "./memory.js";
import { parseSourceChanges, preparedSources, saveSourceChanges } from "./stock.js";

const source = { id: "source", installationId: 7, repositoryId: 12, owner: "owner", name: "repo", branch: "main", enabled: true, paused: false, version: 1 };
const changes = [{ sourceId: "source", kind: "commit", sha: "a".repeat(40) }];
describe("shared stock preparation command", () => {
  it("rejects a source-owned campaign before persistence access", async () => {
    const data = new MemoryActivationData();
    const read = vi.spyOn(data, "preparation"); const write = vi.spyOn(data, "savePreparation");
    await expect(saveSourceChanges(data, "campaign", { expectedRevision: "0", changes }, { create: false, owner: "source" })).rejects.toMatchObject({ status: 409 });
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    await saveSourceChanges(data, "campaign", undefined, { create: false, owner: "source" });
    expect(read).not.toHaveBeenCalled();
  });

  it("retains the sole approval while replacing exact stock requirements", async () => {
    const data = new MemoryActivationData(); await data.saveSource(source);
    await saveSourceChanges(data, "campaign", { changes }, { create: true, owner: "stock" });
    const preparation = (await data.preparation("campaign"))!;
    await data.savePreparation("campaign", { ...preparation, approvedAt: 1, approvedBy: "operator", reviewedContentHash: "reviewed" });
    await saveSourceChanges(data, "campaign", { expectedRevision: "1", changes: [] }, { create: false, owner: "stock" });
    expect(await preparedSources(data, "campaign")).toEqual({ revision: "2", changes: [] });
    expect(await data.preparation("campaign")).toMatchObject({ approvedAt: 1, approvedBy: "operator", reviewedContentHash: "reviewed" });
    await expect(saveSourceChanges(data, "campaign", { expectedRevision: "1", changes }, { create: false, owner: "stock" })).rejects.toMatchObject({ status: 409 });
    expect(await preparedSources(data, "campaign")).toEqual({ revision: "2", changes: [] });
  });

  it("accepts only PR change sets representable by the GitHub provider", () => {
    const shas = Array.from({ length: 251 }, (_, index) => index.toString(16).padStart(40, "0"));
    const change = { sourceId: "source", kind: "pull_request", number: 1, shas };
    expect(() => parseSourceChanges({ changes: [change] })).toThrow("Invalid sourceChanges");
    expect(parseSourceChanges({ changes: [{ ...change, shas: shas.slice(0, 250) }] }).changes).toHaveLength(1);
  });

  it("rejects forged fields and duplicate exact changes", () => {
    expect(() => parseSourceChanges({ changes, approvedBy: "forged" })).toThrow("Invalid sourceChanges");
    expect(() => parseSourceChanges({ changes: [...changes, ...changes] })).toThrow("Duplicate source change");
  });
});
