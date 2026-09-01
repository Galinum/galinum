CREATE TABLE projects (
  id         text   PRIMARY KEY,
  name       text   NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE email_suppressions (
  project_id    text   NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  email         text   NOT NULL,
  reason        text   NOT NULL,
  suppressed_at bigint NOT NULL,
  PRIMARY KEY (project_id, email),
  CHECK (reason IN ('unsubscribed', 'bounced', 'complained'))
);

CREATE INDEX email_suppressions_project_reason_idx
  ON email_suppressions (project_id, reason);

CREATE TABLE end_users (
  id               text   PRIMARY KEY,
  project_id       text   NOT NULL REFERENCES projects (id),
  external_user_id text   NOT NULL,
  traits_json      text,
  first_seen_at    bigint NOT NULL,
  last_seen_at     bigint NOT NULL
);

CREATE UNIQUE INDEX end_users_project_external_idx
  ON end_users (project_id, external_user_id);

CREATE TABLE events (
  id          text   PRIMARY KEY,
  project_id  text   NOT NULL REFERENCES projects (id),
  end_user_id text   NOT NULL REFERENCES end_users (id) ON DELETE CASCADE,
  name        text   NOT NULL,
  props_json  text,
  ts          bigint NOT NULL
);

CREATE INDEX events_project_name_ts_idx ON events (project_id, name, ts);

CREATE INDEX events_user_ts_idx ON events (end_user_id, ts);

CREATE INDEX events_user_name_ts_id_idx ON events (end_user_id, name, ts, id);

CREATE TABLE goals (
  id              text   PRIMARY KEY,
  project_id      text   NOT NULL REFERENCES projects (id),
  name            text   NOT NULL,
  description     text,
  target_event    text,
  guardrails_json text,
  approval_mode   text   NOT NULL DEFAULT 'require_human',
  status          text   NOT NULL DEFAULT 'active',
  created_at      bigint NOT NULL
);

CREATE INDEX goals_project_idx ON goals (project_id);

CREATE TABLE agent_runs (
  id          text   PRIMARY KEY,
  project_id  text   NOT NULL REFERENCES projects (id),
  goal_id     text   REFERENCES goals (id),
  kind        text   NOT NULL,
  input_json  text,
  output_json text,
  rationale   text,
  created_at  bigint NOT NULL,

  idempotency_key text,



  campaign_id text,

  UNIQUE (project_id, id)
);

CREATE UNIQUE INDEX agent_runs_project_campaign_id_idx
  ON agent_runs (project_id, campaign_id, id);

CREATE INDEX agent_runs_project_created_idx ON agent_runs (project_id, created_at);

CREATE INDEX agent_runs_goal_idx ON agent_runs (goal_id);

CREATE UNIQUE INDEX agent_runs_project_idempotency_idx
  ON agent_runs (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX agent_runs_campaign_idx
  ON agent_runs (campaign_id) WHERE campaign_id IS NOT NULL;

CREATE TABLE segments (
  id              text    PRIMARY KEY,
  project_id      text    NOT NULL REFERENCES projects (id),
  key             text    NOT NULL, -- stable project-unique machine key
  name            text    NOT NULL,
  description     text,             -- the audience's intent, not its rules
  status          text    NOT NULL DEFAULT 'active', -- active | archived
  current_version integer NOT NULL DEFAULT 1,
  idempotency_key text,             -- retry-safe creation
  created_by      text    NOT NULL DEFAULT 'api',
  created_at      bigint  NOT NULL,
  updated_at      bigint  NOT NULL,

  UNIQUE (project_id, id)
);

CREATE UNIQUE INDEX segments_project_key_idx ON segments (project_id, key);

CREATE UNIQUE INDEX segments_project_idempotency_idx
  ON segments (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX segments_project_status_idx ON segments (project_id, status);

CREATE TABLE audience_versions (
  id              text    PRIMARY KEY,
  project_id      text    NOT NULL REFERENCES projects (id),
  segment_id      text,             -- NULL = inline/anonymous audience
  segment_version integer,          -- version number within its segment
  schema_version  integer NOT NULL, -- audience-expression schema version
  expression_json text    NOT NULL, -- canonical expression (JSON)
  expression_hash text    NOT NULL, -- sha256 of the canonical expression
  reason          text,             -- why this version was created/revised
  agent_run_id    text,
  created_by      text    NOT NULL DEFAULT 'api',
  created_at      bigint  NOT NULL,

  UNIQUE (project_id, id),


  FOREIGN KEY (project_id, agent_run_id) REFERENCES agent_runs (project_id, id),


  FOREIGN KEY (project_id, segment_id) REFERENCES segments (project_id, id),
  CHECK ((segment_id IS NULL) = (segment_version IS NULL))
);

CREATE INDEX audience_versions_project_idx ON audience_versions (project_id);

CREATE INDEX audience_versions_agent_run_idx
  ON audience_versions (agent_run_id) WHERE agent_run_id IS NOT NULL;

CREATE UNIQUE INDEX audience_versions_segment_version_idx
  ON audience_versions (segment_id, segment_version) WHERE segment_id IS NOT NULL;

CREATE TABLE campaigns (
  id                  text   PRIMARY KEY,
  project_id          text   NOT NULL REFERENCES projects (id),
  goal_id             text   REFERENCES goals (id),
  name                text   NOT NULL,
  channel             text   NOT NULL DEFAULT 'web_inapp',
  status              text   NOT NULL DEFAULT 'draft',
  targeting_json      text,
  audience_version_id text,

  pages_json          text,
  hypothesis          text,
  created_by          text   NOT NULL DEFAULT 'agent',
  created_at          bigint NOT NULL,
  started_at          bigint,
  ended_at            bigint,
  deliver_from        bigint,
  deliver_until       bigint,
  FOREIGN KEY (project_id, audience_version_id)
    REFERENCES audience_versions (project_id, id),

  CHECK (targeting_json IS NULL OR audience_version_id IS NULL),

  UNIQUE (project_id, id)
);

CREATE INDEX campaigns_project_status_idx ON campaigns (project_id, status);

CREATE INDEX campaigns_goal_idx ON campaigns (goal_id);

CREATE INDEX campaigns_audience_version_idx ON campaigns (audience_version_id);

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_project_campaign_fkey
  FOREIGN KEY (project_id, campaign_id) REFERENCES campaigns (project_id, id);

CREATE TABLE campaign_execution_state (
  campaign_id       text   PRIMARY KEY REFERENCES campaigns (id) ON DELETE CASCADE,
  recipient_cursor  text,
  last_processed_at bigint NOT NULL
);

CREATE INDEX campaign_execution_state_processed_idx
  ON campaign_execution_state (last_processed_at);

CREATE TABLE variants (
  id           text    PRIMARY KEY,
  campaign_id  text    NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  name         text    NOT NULL,
  content_json text    NOT NULL,
  weight       integer NOT NULL DEFAULT 1,
  is_control   boolean NOT NULL DEFAULT false
);

CREATE INDEX variants_campaign_idx ON variants (campaign_id);

CREATE TABLE deliveries (
  id                  text   PRIMARY KEY,
  campaign_id         text   NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  variant_id          text   NOT NULL REFERENCES variants (id) ON DELETE CASCADE,
  end_user_id         text   NOT NULL REFERENCES end_users (id) ON DELETE CASCADE,
  provider_message_id text,

  state               text   NOT NULL DEFAULT 'queued',
  queued_at           bigint NOT NULL,
  send_attempted_at   bigint,
  sent_at             bigint,
  delivered_at        bigint,
  shown_at            bigint,
  opened_at           bigint,
  clicked_at          bigint,
  dismissed_at        bigint,
  bounced_at          bigint,
  complained_at       bigint,
  unsubscribed_at     bigint,
  converted_at        bigint
);

CREATE UNIQUE INDEX deliveries_campaign_user_idx ON deliveries (campaign_id, end_user_id);

CREATE UNIQUE INDEX deliveries_provider_message_idx
  ON deliveries (provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE INDEX deliveries_user_state_idx ON deliveries (end_user_id, state);

CREATE INDEX deliveries_variant_idx ON deliveries (variant_id);

CREATE INDEX deliveries_campaign_shown_idx
  ON deliveries (campaign_id, shown_at) WHERE shown_at IS NOT NULL;

CREATE INDEX deliveries_campaign_sent_idx
  ON deliveries (campaign_id, sent_at) WHERE sent_at IS NOT NULL;

CREATE INDEX deliveries_user_sent_idx
  ON deliveries (end_user_id, sent_at) WHERE sent_at IS NOT NULL;
