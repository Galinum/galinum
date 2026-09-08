import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductDB, ShippingWarning } from "@galinum/core";
import { createPostgresActivationData, PublicSqlActivationData } from "./postgres.js";
import { reduceShippingMonitor } from "./monitor.js";
import type { ActivationMapping, ActivationRequirements, ActivationSettings, ActivationState, StockPreparation, StockSource } from "./store.js";

type TestDB = ProductDB & { projects: { id: string; name: string; created_at: number } };
function publicTables(executor: Kysely<TestDB> | Transaction<TestDB>): Kysely<ProductDB> {
  return executor as unknown as Kysely<ProductDB>;
}
const timestamp = 1700000000000;
const evidence = { id: "deployment-1", provider: "github", label: "Production", url: "https://github.com/example/product/deployments", revision: "a".repeat(40), reportedAt: timestamp };
const settings: ActivationSettings = { defaultMode: "manual", policyVersion: 4, generation: 8, nextAttemptAt: timestamp + 100,
  leaseToken: "lease", leaseGeneration: 8, leaseExpiresAt: timestamp + 1000, campaignCursor: "cursor", lastError: "Provider unavailable" };
const state: ActivationState = { modeOverride: "automatic", version: 5, readinessError: "Not ready",
  launch: { mode: "automatic", startedAt: timestamp, contentHash: "content", requirementsDigest: "requirements", evidence: [evidence] },
  monitor: { phase: "launched", requirements: { changes: [], requirements: [], sources: [], digest: "requirements" }, present: { required: evidence }, missing: ["required"] } };
const preparation: StockPreparation = { version: 6, changes: [{ sourceId: "source", kind: "pull_request", number: 42, shas: [evidence.revision] }],
  approvedBy: "operator", approvedAt: timestamp, reviewedContentHash: "reviewed" };
const source = (id: string): StockSource => ({ id, installationId: 7, repositoryId: 12, owner: "example", name: "product", branch: "main", enabled: true, paused: false, version: 1 });
const mapping = (id: string, sourceIds: string[] = []): ActivationMapping => ({ id, installationId: 7, repositoryId: 12, owner: "example", name: "product",
  environment: "production", sourceIds, scopeDescription: "Whole application", confirmedBy: "operator", confirmedAt: timestamp, version: 5, generation: 8,
  observed: { deploymentId: 9, sha: evidence.revision, statusId: 10, statusAt: timestamp, state: "success" },
  snapshot: { state: "pending", evidence: null, watermark: { statusAt: timestamp, statusId: 10 }, coverage: [], checkedAt: timestamp + 1,
    pendingWork: true, providerState: { scan: { page: 3, ids: [1, 2] }, proofs: { retained: { present: true } } } }, snapshotGeneration: 8, checkedAt: timestamp + 1 });
const warning = (id: string): ShippingWarning => ({ id, reason: "rollback", createdAt: timestamp, mappingId: "mapping", mappingLabel: "Production",
  requirementIds: ["requirement-b", "requirement-a"], evidence });

describe.runIf(process.env.RUN_DB_INTEGRATION === "1")("public SQL activation persistence", () => {
  const applicationName = `activation-persistence-${randomUUID()}`;
  let database: Kysely<TestDB>;
  let a: PublicSqlActivationData;
  let b: PublicSqlActivationData;
  let projectA: string;
  let projectB: string;
  let campaignA: string;
  let campaignB: string;
  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    database = new Kysely<TestDB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, application_name: applicationName }) }) });
    await database.selectFrom("product_schema_versions").select("version").where("version", "=", "activation-1").executeTakeFirstOrThrow();
  });
  beforeEach(async () => {
    projectA = `test_activation_a_${randomUUID()}`; projectB = `test_activation_b_${randomUUID()}`;
    campaignA = `campaign-${projectA}-a`; campaignB = `campaign-${projectB}-a`;
    await database.insertInto("projects").values([projectA, projectB].map(id => ({ id, name: "Activation persistence fixture", created_at: timestamp }))).execute();
    await database.insertInto("campaigns").values([{ id: campaignA, project_id: projectA, name: "A", created_at: timestamp }, { id: campaignB, project_id: projectB, name: "B", created_at: timestamp }]).execute();
    a = createPostgresActivationData(publicTables(database), projectA); b = new PublicSqlActivationData(publicTables(database), projectB);
  });
  afterEach(async () => {
    if (!projectA || !projectB) return;
    await database.deleteFrom("campaigns").where("project_id", "in", [projectA, projectB]).execute();
    await database.deleteFrom("projects").where("id", "in", [projectA, projectB]).execute();
  });
  afterAll(async () => { if (database) await database.destroy(); });

  it("returns nullable records and schema-default versions without inventing settings", async () => {
    expect(await a.settings()).toBeNull(); expect(await a.state(campaignA)).toBeNull(); expect(await a.preparation(campaignA)).toBeNull();
    expect(await a.controls()).toEqual({ paused: false, version: 0 }); expect(await a.mappings()).toEqual([]); expect(await a.sources()).toEqual([]);
    await database.insertInto("project_launch_settings").values({ project_id: projectA }).execute();
    await database.insertInto("campaign_activation_state").values({ project_id: projectA, campaign_id: campaignA }).execute();
    await database.insertInto("campaign_shipping_preparations").values({ project_id: projectA, campaign_id: campaignA }).execute();
    const id = randomUUID();
    await database.insertInto("shipping_sources").values({ id, project_id: projectA, installation_id: 7, repo_id: 12, repo_name: "example/product", branch: "main" }).execute();
    expect(await a.settings()).toEqual({ defaultMode: "automatic", policyVersion: 0, generation: 0, nextAttemptAt: 0,
      leaseToken: null, leaseGeneration: null, leaseExpiresAt: null, campaignCursor: "", lastError: null });
    expect(await a.state(campaignA)).toEqual({ modeOverride: null, version: 0, launch: null, monitor: null, readinessError: null });
    expect(await a.preparation(campaignA)).toEqual({ version: 0, changes: [], approvedBy: null, approvedAt: null, reviewedContentHash: null });
    expect(await a.sources()).toEqual([source(id)]);
  });

  it("round-trips every settings, state, control and preparation field with bigint conversion", async () => {
    await a.saveSettings(settings); await a.saveState(campaignA, state); await a.saveControls({ paused: true, version: 9 }); await a.savePreparation(campaignA, preparation);
    expect(await a.settings()).toEqual(settings); expect(await a.state(campaignA)).toEqual(state);
    expect(await a.controls()).toEqual({ paused: true, version: 9 }); expect(await a.preparation(campaignA)).toEqual(preparation);
    expect(await b.settings()).toBeNull(); expect(await b.state(campaignA)).toBeNull(); expect(await b.preparation(campaignA)).toBeNull();
    const cleared = { ...settings, leaseToken: null, leaseGeneration: null, leaseExpiresAt: null, lastError: null };
    await a.saveSettings(cleared); await a.saveState(campaignA, { modeOverride: null, version: 6, launch: null, monitor: null, readinessError: null });
    await a.savePreparation(campaignA, { ...preparation, version: 7, approvedBy: null, approvedAt: null, reviewedContentHash: null });
    expect(await a.settings()).toEqual(cleared); expect((await a.state(campaignA))?.launch).toBeNull(); expect((await a.preparation(campaignA))?.approvedAt).toBeNull();
  });

  it("atomically replaces source bindings and preserves confirmation and provider data", async () => {
    const id = randomUUID(); const original = mapping(id, ["source-a", "source-b"]);
    await a.saveMapping(original); expect(await a.mappings()).toEqual([original]);
    const updated = { ...original, sourceIds: ["source-c", "source-b", "source-b"], version: 6, owner: "renamed", scopeDescription: "Confirmed new label" };
    await a.saveMapping(updated); expect(await a.mappings()).toEqual([{ ...updated, sourceIds: ["source-b", "source-c"] }]);
    const stored = await database.selectFrom("github_deployment_mappings").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(stored.repo_name).toBe("renamed/product"); expect(stored.observed_json).toBe(JSON.stringify(original.observed));
    expect(stored.snapshot_json).toBe(JSON.stringify(original.snapshot)); expect(stored.confirmed_by).toBe("operator");
    await a.saveMapping({ ...original, sourceIds: [] }); expect((await a.mappings())[0].sourceIds).toEqual([]);
    await a.deleteMapping(id); expect(await a.mappings()).toEqual([]);
    expect(await database.selectFrom("github_deployment_mapping_sources").selectAll().where("mapping_id", "=", id).execute()).toEqual([]);
  });

  it.each([{ sourceIds: ["last"] }, { sourceIds: [] }])("serializes concurrent exact source replacement $sourceIds", async ({ sourceIds }) => {
    const id = randomUUID(); const original = mapping(id, ["original"]);
    await a.saveMapping(original);
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = database.transaction().execute(async transaction => {
      await createPostgresActivationData(publicTables(transaction), projectA).saveMapping({ ...original, sourceIds: ["first"], version: 6 });
      entered(); await gate;
    });
    await ready;
    const second = a.saveMapping({ ...original, sourceIds, version: 7 });
    let waiting = false;
    try {
      const deadline = Date.now() + 3000;
      while (!waiting && Date.now() < deadline) {
        const result = await sql<{ waiting: boolean }>`select exists(select 1 from pg_stat_activity where application_name = ${applicationName} and wait_event_type = 'Lock') as waiting`.execute(database);
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release(); await first; await second; }
    expect(waiting).toBe(true);
    expect((await a.mappings())[0]).toMatchObject({ version: 7, sourceIds });
  });

  it("enlists every write in the caller's transaction and rolls back the whole unit", async () => {
    const id = randomUUID(); await a.saveMapping(mapping(id, ["original"]));
    await expect(database.transaction().execute(async transaction => {
      const data = createPostgresActivationData(publicTables(transaction), projectA);
      await data.saveSettings(settings); await data.saveState(campaignA, state); await data.saveControls({ paused: true, version: 1 });
      await data.savePreparation(campaignA, preparation); await data.saveSource(source(randomUUID()));
      await data.insertWarning(campaignA, warning(randomUUID())); await data.saveMapping({ ...mapping(id), sourceIds: ["replacement"] });
      throw new Error("Rollback fixture");
    })).rejects.toThrow("Rollback fixture");
    expect(await a.settings()).toBeNull(); expect(await a.state(campaignA)).toBeNull(); expect(await a.preparation(campaignA)).toBeNull();
    expect(await a.controls()).toEqual({ paused: false, version: 0 }); expect(await a.sources()).toEqual([]); expect(await a.warnings(campaignA)).toEqual([]);
    expect(await a.mappings()).toEqual([mapping(id, ["original"])]);
    await database.transaction().execute(async transaction => { await createPostgresActivationData(publicTables(transaction), projectA).saveSettings(settings); });
    expect(await a.settings()).toEqual(settings);
  });

  it("rejects another project's mapping, binding and source replacements", async () => {
    const foreignMapping = mapping(randomUUID(), ["foreign-source"]); const foreignSource = source(randomUUID());
    await b.saveMapping(foreignMapping); await b.saveSource(foreignSource);
    await expect(a.saveMapping({ ...foreignMapping, sourceIds: ["injected"], scopeDescription: "Overwritten" })).rejects.toThrow("another project");
    await expect(a.saveSource({ ...foreignSource, branch: "overwritten" })).rejects.toThrow("another project");
    await a.deleteMapping(foreignMapping.id);
    expect(await a.mappings()).toEqual([]); expect(await a.sources()).toEqual([]);
    expect(await b.mappings()).toEqual([foreignMapping]); expect(await b.sources()).toEqual([foreignSource]);
  });

  it("cannot attach activation data to a foreign campaign", async () => {
    await b.saveState(campaignB, state); await b.savePreparation(campaignB, preparation);
    await expect(a.saveState(campaignB, { ...state, version: 9 })).rejects.toThrow();
    await expect(a.savePreparation(campaignB, { ...preparation, version: 9 })).rejects.toThrow();
    await expect(a.insertWarning(campaignB, warning(randomUUID()))).rejects.toThrow();
    expect(await a.state(campaignB)).toBeNull(); expect(await a.preparation(campaignB)).toBeNull(); expect(await a.warnings(campaignB)).toEqual([]);
    expect(await b.state(campaignB)).toEqual(state); expect(await b.preparation(campaignB)).toEqual(preparation);
  });

  it("deduplicates concurrent warning inserts without rewriting evidence or requirements", async () => {
    const original = warning(randomUUID());
    await Promise.all(Array.from({ length: 6 }, () => a.insertWarning(campaignA, original)));
    await a.insertWarning(campaignA, { ...original, createdAt: timestamp + 1, requirementIds: ["new"], evidence: { ...evidence, revision: "b".repeat(40) } });
    expect(await a.warnings(campaignA)).toEqual([original]);
    await expect(b.insertWarning(campaignB, original)).rejects.toThrow("another campaign or project");
    expect(await b.warnings(campaignB)).toEqual([]);
  });

  it("persists identical warning incidents for two campaigns in one project and keeps replay idempotent", async () => {
    const otherCampaign = `${campaignA}-shared-change`;
    await database.insertInto("campaigns").values({ id: otherCampaign, project_id: projectA, name: "Same product change", created_at: timestamp }).execute();
    const sharedMapping = mapping(randomUUID(), ["source"]);
    const requirements: ActivationRequirements = {
      changes: [{ id: "change", sourceId: "source", kind: "commit", sha: evidence.revision }],
      requirements: [{ id: "change", sourceId: "source", label: "Shared change", mappingIds: [sharedMapping.id] }],
      sources: [{ id: "source", state: "ready" }], digest: "shared-requirements",
    };
    const reduce = (campaignId: string, now: number) => {
      const base = { campaignId, previous: null, requirements, mappings: [sharedMapping], started: true, now: timestamp,
        coverage: [{ requirementId: "change", mappingId: sharedMapping.id, state: "present" as const, evidence }] };
      const present = reduceShippingMonitor(base);
      return reduceShippingMonitor({ ...base, previous: present.monitor, now,
        coverage: [{ ...base.coverage[0], state: "absent", evidence: { ...evidence, id: "rollback", revision: "b".repeat(40), reportedAt: timestamp + 1 } }] });
    };
    const first = reduce(campaignA, timestamp + 1).warnings[0];
    const second = reduce(otherCampaign, timestamp + 1).warnings[0];
    await database.transaction().execute(async transaction => {
      const data = createPostgresActivationData(publicTables(transaction), projectA);
      await data.insertWarning(campaignA, first);
      await data.insertWarning(otherCampaign, second);
    });
    expect(first.id).not.toBe(second.id);
    expect(await a.warnings(campaignA)).toEqual([first]);
    expect(await a.warnings(otherCampaign)).toEqual([second]);
    const replayFirst = reduce(campaignA, timestamp + 1000).warnings[0];
    const replaySecond = reduce(otherCampaign, timestamp + 1000).warnings[0];
    expect(replayFirst.id).toBe(first.id); expect(replaySecond.id).toBe(second.id);
    await a.insertWarning(campaignA, replayFirst); await a.insertWarning(otherCampaign, replaySecond);
    expect(await a.warnings(campaignA)).toEqual([first]);
    expect(await a.warnings(otherCampaign)).toEqual([second]);
  });

  it("retains an older warning id and requirements when its incident key already exists", async () => {
    const incoming = warning(randomUUID()); const original = { ...incoming, id: randomUUID(), requirementIds: ["retained-b", "retained-a"] };
    await database.insertInto("campaign_shipping_warnings").values({ id: original.id, project_id: projectA, campaign_id: campaignA,
      incident_key: incoming.id, warning_json: JSON.stringify(original), created_at: original.createdAt }).execute();
    await a.insertWarning(campaignA, incoming); await a.insertWarning(campaignA, original);
    expect(await a.warnings(campaignA)).toEqual([original]);
  });

  it("preserves source versions and scopes preparation cursor pages", async () => {
    const original = source(randomUUID()); await a.saveSource(original);
    const updated = { ...original, owner: "new-owner", name: "renamed", enabled: false, paused: true, version: 8 };
    await a.saveSource(updated); expect(await a.sources()).toEqual([updated]); expect(await b.sources()).toEqual([]);
    const second = `${campaignA}-next`;
    await database.insertInto("campaigns").values({ id: second, project_id: projectA, name: "Later", created_at: timestamp }).execute();
    await a.savePreparation(campaignA, preparation); await a.savePreparation(second, preparation); await b.savePreparation(campaignB, preparation);
    expect(await a.preparationCampaignIds("", 1)).toEqual([campaignA]); expect(await a.preparationCampaignIds(campaignA, 2)).toEqual([second]);
    expect(await b.preparationCampaignIds("", 10)).toEqual([campaignB]); expect(await a.preparationCampaignIds("", 0)).toEqual([]);
    await expect(a.preparationCampaignIds("", -1)).rejects.toThrow("limit");
  });

  it("does not leave a partial mapping replacement when a binding violates a constraint", async () => {
    const original = mapping(randomUUID(), ["original"]); await a.saveMapping(original);
    await expect(a.saveMapping({ ...original, sourceIds: [null as unknown as string], scopeDescription: "Must roll back" })).rejects.toThrow();
    expect(await a.mappings()).toEqual([original]);
  });
});
