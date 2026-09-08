import { sql, type QueryExecutorProvider } from "kysely";

const relations = {
  installations: ["project_id", "id", "token_scope", "state_json"],
  installation_requests: ["project_id", "installation_id", "request_id", "replay_json"],
  push_records: ["project_id", "kind", "id", "body_json", "available_at", "recipient_id", "slot_id", "state_kind", "submission_kind", "is_uncertain"],
  inapp_feedback: ["project_id", "id", "delivery_id", "user_id", "external_id", "type", "acknowledged_at"],
  campaigns: ["id", "project_id", "push_json", "audience_version_id", "deliver_from", "deliver_until"],
  project_launch_settings: ["project_id", "generation", "lease_token", "campaign_cursor"],
  github_deployment_mappings: ["id", "project_id", "snapshot_generation"],
  github_deployment_mapping_sources: ["project_id", "mapping_id", "source_id"],
  campaign_activation_state: ["project_id", "campaign_id", "launch_json", "readiness_error"],
  campaign_shipping_warnings: ["project_id", "campaign_id", "incident_key"],
  shipping_sources: ["id", "project_id", "branch", "version"],
  shipping_project_controls: ["project_id", "paused", "version"],
  campaign_shipping_preparations: ["project_id", "campaign_id", "changes_json", "reviewed_content_hash"],
};
const constraints = {
  installations: ["PRIMARY KEY (project_id, id)", "UNIQUE (project_id, token_scope)"],
  installation_requests: ["PRIMARY KEY (project_id, installation_id, request_id)", "FOREIGN KEY (project_id, installation_id) REFERENCES installations(project_id, id) ON DELETE CASCADE"],
  push_records: ["PRIMARY KEY (project_id, kind, id)"],
  inapp_feedback: ["PRIMARY KEY (project_id, id)", "FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE", "FOREIGN KEY (user_id) REFERENCES end_users(id) ON DELETE CASCADE"],
  campaign_activation_state: ["PRIMARY KEY (project_id, campaign_id)", "FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns(project_id, id) ON DELETE CASCADE"],
  campaign_shipping_preparations: ["PRIMARY KEY (project_id, campaign_id)", "FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns(project_id, id) ON DELETE CASCADE"],
};
const indexes = ["push_records_due", "push_records_recipient", "push_records_slot", "push_records_uncertain", "push_user_delivery", "inapp_feedback_delivery", "inapp_feedback_exposure"];
export async function assertCommunicationSchema(executor: QueryExecutorProvider): Promise<void> {
  for (const [table, columns] of Object.entries(relations)) {
    const actual = await sql<{ name: string }>`select attname as name from pg_attribute where attrelid = to_regclass(${table}) and attnum > 0 and not attisdropped`.execute(executor);
    if (!columns.every((name) => actual.rows.some((column) => column.name === name))) throw new Error(`Communication schema is incomplete: ${table}`);
  }
  for (const [table, expected] of Object.entries(constraints)) {
    const actual = await sql<{ definition: string }>`select pg_get_constraintdef(oid, true) as definition from pg_constraint where conrelid = to_regclass(${table}) and convalidated`.execute(executor);
    if (!expected.every((definition) => actual.rows.some((constraint) => constraint.definition === definition))) throw new Error(`Communication constraints are incomplete: ${table}`);
  }
  for (const index of indexes) {
    const actual = await sql<{ valid: boolean }>`select indisvalid and indisready as valid from pg_index where indexrelid = to_regclass(${index})`.execute(executor);
    if (actual.rows[0]?.valid !== true) throw new Error(`Communication index is unavailable: ${index}`);
  }
}
