import { lockProject } from "../project-fence.js";
import type { ProductDB, ShippingWarning } from "@galinum/core";
import { sql, type Kysely } from "kysely";
import type { ActivationMapping, ActivationSettings, ActivationState, ProductActivationData, ActivationPersistence, PreparationPersistence, StockPreparation, StockProjectControls, StockSource } from "./store.js";

function repository(repoName: string): { owner: string; name: string } {
  const [owner, name, extra] = repoName.split("/");
  if (!owner || !name || extra !== undefined) throw new Error("Invalid stored repository identity");
  return { owner, name };
}
function nullableNumber(value: number | string | null): number | null { return value === null ? null : Number(value); }
function parseJson<T>(value: string | null): T | null { return value === null ? null : JSON.parse(value) as T; }
function json(value: unknown): string | null { return value === null ? null : JSON.stringify(value); }
function launchMode(value: string): ActivationSettings["defaultMode"] {
  if (value !== "automatic" && value !== "manual") throw new Error("Invalid stored launch mode");
  return value;
}

export type ActivationSessionDB = Pick<ProductDB, "project_launch_settings" | "github_deployment_mappings" | "github_deployment_mapping_sources" | "campaign_activation_state" | "campaign_shipping_warnings" | "campaign_shipping_preparations">;
export type ActivationSessionData = ActivationPersistence & Pick<PreparationPersistence, "preparation" | "savePreparation" | "preparationCampaignIds">;
export class PublicSqlActivationSessionData implements ActivationSessionData {
  constructor(private readonly executor: Kysely<ActivationSessionDB>, private readonly projectId: string) {
    if (!projectId) throw new Error("Activation persistence requires a project id");
  }

  async settings(): Promise<ActivationSettings | null> {
    const row = await this.executor.selectFrom("project_launch_settings").selectAll().where("project_id", "=", this.projectId).executeTakeFirst();
    return row ? { defaultMode: launchMode(row.default_mode), policyVersion: Number(row.policy_version), generation: Number(row.generation),
      nextAttemptAt: Number(row.next_attempt_at), leaseToken: row.lease_token, leaseGeneration: nullableNumber(row.lease_generation),
      leaseExpiresAt: nullableNumber(row.lease_expires_at), campaignCursor: row.campaign_cursor, lastError: row.last_error } : null;
  }

  async saveSettings(value: ActivationSettings): Promise<void> {
    const fields = { default_mode: value.defaultMode, policy_version: value.policyVersion, generation: value.generation, next_attempt_at: value.nextAttemptAt,
      lease_token: value.leaseToken, lease_generation: value.leaseGeneration, lease_expires_at: value.leaseExpiresAt, campaign_cursor: value.campaignCursor, last_error: value.lastError };
    await this.executor.insertInto("project_launch_settings").values({ project_id: this.projectId, ...fields })
      .onConflict(conflict => conflict.column("project_id").doUpdateSet(fields)).execute();
  }

  async mappings(): Promise<ActivationMapping[]> {
    const rows = await this.executor.selectFrom("github_deployment_mappings").selectAll().select(sql<string[]>`ARRAY(
      SELECT source_id FROM github_deployment_mapping_sources
      WHERE project_id = ${this.projectId} AND mapping_id = github_deployment_mappings.id ORDER BY source_id
    )`.as("source_ids")).where("project_id", "=", this.projectId).orderBy("id").execute();
    return rows.map(row => ({ id: row.id, installationId: Number(row.installation_id), repositoryId: Number(row.repo_id), ...repository(row.repo_name),
      environment: row.environment, sourceIds: row.source_ids,
      scopeDescription: row.scope_description, confirmedBy: row.confirmed_by, confirmedAt: Number(row.confirmed_at), version: Number(row.config_version),
      generation: Number(row.generation), observed: parseJson(row.observed_json), snapshot: parseJson(row.snapshot_json),
      snapshotGeneration: nullableNumber(row.snapshot_generation), checkedAt: nullableNumber(row.checked_at) }));
  }

  async saveMapping(value: ActivationMapping): Promise<void> {
    if (!this.executor.isTransaction) {
      await this.executor.transaction().execute(transaction => new PublicSqlActivationSessionData(transaction, this.projectId).saveMapping(value));
      return;
    }
    await lockProject(this.executor, this.projectId);
    const fields = { installation_id: value.installationId, repo_id: value.repositoryId, repo_name: `${value.owner}/${value.name}`, environment: value.environment,
      scope_description: value.scopeDescription, confirmed_by: value.confirmedBy, confirmed_at: value.confirmedAt, config_version: value.version,
      generation: value.generation, observed_json: json(value.observed), snapshot_json: json(value.snapshot), snapshot_generation: value.snapshotGeneration, checked_at: value.checkedAt };
    const sourceIds = [...new Set(value.sourceIds)];
    const row = await this.executor
      .with("saved_mapping", query => query.insertInto("github_deployment_mappings").values({ id: value.id, project_id: this.projectId, ...fields })
        .onConflict(conflict => conflict.column("id").doUpdateSet(fields).where("github_deployment_mappings.project_id", "=", this.projectId)).returning("id"))
      .with("removed_bindings", query => query.deleteFrom("github_deployment_mapping_sources")
        .where("project_id", "=", this.projectId).where("mapping_id", "in", expression => expression.selectFrom("saved_mapping").select("id"))
        .$if(sourceIds.length > 0, query => query.where("source_id", "not in", sourceIds)).returning("mapping_id"))
      .with("added_bindings", query => query.insertInto("github_deployment_mapping_sources").columns(["project_id", "mapping_id", "source_id"])
        .expression(expression => expression.selectFrom("saved_mapping").select([
          sql<string>`${this.projectId}`.as("project_id"), "id as mapping_id", sql<string>`unnest(${sourceIds}::text[])`.as("source_id"),
        ])).onConflict(conflict => conflict.columns(["mapping_id", "source_id"]).doNothing()).returning("mapping_id"))
      .selectFrom("saved_mapping").select("id").executeTakeFirst();
    if (!row) throw new Error("Deployment mapping belongs to another project");
  }

  async deleteMapping(id: string): Promise<void> {
    await this.executor.deleteFrom("github_deployment_mappings").where("project_id", "=", this.projectId).where("id", "=", id).execute();
  }

  async state(campaignId: string): Promise<ActivationState | null> {
    const row = await this.executor.selectFrom("campaign_activation_state").selectAll().where("project_id", "=", this.projectId)
      .where("campaign_id", "=", campaignId).executeTakeFirst();
    return row ? { modeOverride: row.mode_override === null ? null : launchMode(row.mode_override), version: Number(row.version),
      launch: parseJson(row.launch_json), monitor: parseJson(row.monitor_json), readinessError: row.readiness_error } : null;
  }

  async saveState(campaignId: string, value: ActivationState): Promise<void> {
    const fields = { mode_override: value.modeOverride, version: value.version, launch_json: json(value.launch), monitor_json: json(value.monitor), readiness_error: value.readinessError };
    await this.executor.insertInto("campaign_activation_state").values({ project_id: this.projectId, campaign_id: campaignId, ...fields })
      .onConflict(conflict => conflict.columns(["project_id", "campaign_id"]).doUpdateSet(fields)).execute();
  }

  async warnings(campaignId: string): Promise<ShippingWarning[]> {
    const rows = await this.executor.selectFrom("campaign_shipping_warnings").select("warning_json").where("project_id", "=", this.projectId)
      .where("campaign_id", "=", campaignId).orderBy("created_at", "desc").orderBy("id").execute();
    return rows.map(row => JSON.parse(row.warning_json) as ShippingWarning);
  }

  async insertWarning(campaignId: string, value: ShippingWarning): Promise<void> {
    const row = await this.executor.insertInto("campaign_shipping_warnings").values({ id: value.id, project_id: this.projectId, campaign_id: campaignId,
      incident_key: value.id, warning_json: JSON.stringify(value), created_at: value.createdAt }).onConflict(conflict => conflict.doNothing()).returning("id").executeTakeFirst();
    if (row) return;
    const existing = await this.executor.selectFrom("campaign_shipping_warnings").select("id").where("project_id", "=", this.projectId)
      .where("campaign_id", "=", campaignId).where(expression => expression.or([expression("id", "=", value.id), expression("incident_key", "=", value.id)])).executeTakeFirst();
    if (!existing) throw new Error("Warning identity belongs to another campaign or project");
  }

  async preparation(campaignId: string): Promise<StockPreparation | null> {
    const row = await this.executor.selectFrom("campaign_shipping_preparations").selectAll().where("project_id", "=", this.projectId)
      .where("campaign_id", "=", campaignId).executeTakeFirst();
    return row ? { version: Number(row.version), changes: JSON.parse(row.changes_json), approvedBy: row.approved_by,
      approvedAt: nullableNumber(row.approved_at), reviewedContentHash: row.reviewed_content_hash } : null;
  }

  async savePreparation(campaignId: string, value: StockPreparation): Promise<void> {
    const fields = { version: value.version, changes_json: JSON.stringify(value.changes), approved_by: value.approvedBy, approved_at: value.approvedAt, reviewed_content_hash: value.reviewedContentHash };
    await this.executor.insertInto("campaign_shipping_preparations").values({ project_id: this.projectId, campaign_id: campaignId, ...fields })
      .onConflict(conflict => conflict.columns(["project_id", "campaign_id"]).doUpdateSet(fields)).execute();
  }

  async preparationCampaignIds(after: string, limit: number): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid preparation page limit");
    return (await this.executor.selectFrom("campaign_shipping_preparations").select("campaign_id").where("project_id", "=", this.projectId)
      .where("campaign_id", ">", after).orderBy("campaign_id").limit(limit).execute()).map(row => row.campaign_id);
  }
}

export class PublicSqlActivationData extends PublicSqlActivationSessionData implements ProductActivationData {
  constructor(private readonly stockExecutor: Kysely<ProductDB>, private readonly stockProjectId: string) {
    super(stockExecutor.$pickTables<keyof ActivationSessionDB>(), stockProjectId);
  }
  async sources(): Promise<StockSource[]> {
    const rows = await this.stockExecutor.selectFrom("shipping_sources").selectAll().where("project_id", "=", this.stockProjectId).orderBy("id").execute();
    return rows.map(row => ({ id: row.id, installationId: Number(row.installation_id), repositoryId: Number(row.repo_id), ...repository(row.repo_name),
      branch: row.branch, enabled: row.enabled, paused: row.paused, version: Number(row.version) }));
  }

  async saveSource(value: StockSource): Promise<void> {
    const fields = { installation_id: value.installationId, repo_id: value.repositoryId, repo_name: `${value.owner}/${value.name}`, branch: value.branch,
      enabled: value.enabled, paused: value.paused, version: value.version };
    const row = await this.stockExecutor.insertInto("shipping_sources").values({ id: value.id, project_id: this.stockProjectId, ...fields })
      .onConflict(conflict => conflict.column("id").doUpdateSet(fields).where("shipping_sources.project_id", "=", this.stockProjectId)).returning("id").executeTakeFirst();
    if (!row) throw new Error("Source belongs to another project");
  }

  async controls(): Promise<StockProjectControls> {
    const row = await this.stockExecutor.selectFrom("shipping_project_controls").selectAll().where("project_id", "=", this.stockProjectId).executeTakeFirst();
    return row ? { paused: row.paused, version: Number(row.version) } : { paused: false, version: 0 };
  }

  async saveControls(value: StockProjectControls): Promise<void> {
    const fields = { paused: value.paused, version: value.version };
    await this.stockExecutor.insertInto("shipping_project_controls").values({ project_id: this.stockProjectId, ...fields })
      .onConflict(conflict => conflict.column("project_id").doUpdateSet(fields)).execute();
  }

}

export function createPostgresActivationSessionData(executor: Kysely<ActivationSessionDB>, projectId: string): PublicSqlActivationSessionData {
  return new PublicSqlActivationSessionData(executor, projectId);
}

export function createPostgresActivationData(executor: Kysely<ProductDB>, projectId: string): PublicSqlActivationData {
  return new PublicSqlActivationData(executor, projectId);
}
