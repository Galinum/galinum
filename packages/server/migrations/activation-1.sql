BEGIN;

CREATE TABLE project_launch_settings (
  project_id text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  default_mode text NOT NULL DEFAULT 'automatic' CHECK (default_mode IN ('automatic', 'manual')),
  policy_version bigint NOT NULL DEFAULT 0,
  generation bigint NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL DEFAULT 0,
  lease_token text,
  lease_generation bigint,
  lease_expires_at bigint,
  campaign_cursor text NOT NULL DEFAULT '',
  last_error text,
  CHECK ((lease_token IS NULL AND lease_generation IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_generation IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE TABLE github_deployment_mappings (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repo_id bigint NOT NULL CHECK (repo_id > 0),
  repo_name text NOT NULL,
  environment text NOT NULL CHECK (length(environment) BETWEEN 1 AND 255),
  scope_description text NOT NULL CHECK (length(scope_description) BETWEEN 1 AND 2000),
  confirmed_by text NOT NULL,
  confirmed_at bigint NOT NULL,
  config_version bigint NOT NULL DEFAULT 1,
  generation bigint NOT NULL DEFAULT 0,
  observed_json text,
  snapshot_json text,
  snapshot_generation bigint,
  checked_at bigint,
  UNIQUE (project_id, id),
  UNIQUE (project_id, repo_id, environment)
);
CREATE INDEX github_deployment_mappings_ingress_idx ON github_deployment_mappings (installation_id, repo_id, environment);

CREATE TABLE github_deployment_mapping_sources (
  project_id text NOT NULL,
  mapping_id text NOT NULL,
  source_id text NOT NULL,
  PRIMARY KEY (mapping_id, source_id),
  FOREIGN KEY (project_id, mapping_id) REFERENCES github_deployment_mappings (project_id, id) ON DELETE CASCADE
);
CREATE INDEX github_deployment_mapping_sources_source_idx ON github_deployment_mapping_sources (source_id);

CREATE TABLE campaign_activation_state (
  project_id text NOT NULL,
  campaign_id text NOT NULL,
  mode_override text CHECK (mode_override IN ('automatic', 'manual')),
  version bigint NOT NULL DEFAULT 0,
  launch_json text,
  monitor_json text,
  readiness_error text,
  PRIMARY KEY (project_id, campaign_id),
  FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns (project_id, id) ON DELETE CASCADE
);

CREATE TABLE campaign_shipping_warnings (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  campaign_id text NOT NULL,
  incident_key text NOT NULL,
  warning_json text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (project_id, campaign_id, incident_key),
  FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns (project_id, id) ON DELETE CASCADE
);
CREATE INDEX campaign_shipping_warnings_campaign_idx ON campaign_shipping_warnings (project_id, campaign_id, created_at);


CREATE TABLE shipping_sources (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repo_id bigint NOT NULL CHECK (repo_id > 0),
  repo_name text NOT NULL,
  branch text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (project_id, id),
  UNIQUE (project_id, installation_id, repo_id, branch)
);

CREATE TABLE shipping_project_controls (
  project_id text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0
);

CREATE TABLE campaign_shipping_preparations (
  project_id text NOT NULL,
  campaign_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  changes_json text NOT NULL DEFAULT '[]',
  approved_by text,
  approved_at bigint,
  reviewed_content_hash text,
  PRIMARY KEY (project_id, campaign_id),
  FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns (project_id, id) ON DELETE CASCADE,
  CHECK ((approved_by IS NULL AND approved_at IS NULL AND reviewed_content_hash IS NULL)
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND reviewed_content_hash IS NOT NULL))
);

CREATE TABLE product_schema_versions (
  version text PRIMARY KEY,
  applied_at bigint NOT NULL
);
INSERT INTO product_schema_versions (version, applied_at) VALUES ('activation-1', (extract(epoch from clock_timestamp()) * 1000)::bigint);

COMMIT;
