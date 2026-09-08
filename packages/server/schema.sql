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
  push_json text,
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

CREATE TABLE installations (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  token_scope text,
  state_json text NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_scope)
);
CREATE INDEX installations_user ON installations (project_id, ((state_json::jsonb)->>'userId'), id);
CREATE TABLE installation_requests (
  project_id text NOT NULL,
  installation_id text NOT NULL,
  request_id text NOT NULL,
  replay_json text NOT NULL,
  PRIMARY KEY (project_id, installation_id, request_id),
  FOREIGN KEY (project_id, installation_id) REFERENCES installations(project_id, id) ON DELETE CASCADE
);

CREATE TABLE push_records (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('work','queue','scan','test','credential','delivery','target','attempt','outcome','observation','conversion','event','clock','cursor')),
  id text NOT NULL,
  campaign_id text NOT NULL,
  user_id text,
  target_id text,
  installation_id text,
  is_test boolean,
  command_kind text,
  result_kind text,
  available_at bigint,
  event_order bigint,
  goal_event text,
  replacement_key text,
  credential_id text,
  recipient_id text,
  slot_id text,
  state_kind text,
  submission_kind text,
  is_uncertain boolean,
  body_json text NOT NULL,
  PRIMARY KEY (project_id, kind, id)
);
CREATE INDEX push_records_campaign ON push_records (project_id, kind, campaign_id, id COLLATE "C");
CREATE INDEX push_records_user ON push_records (project_id, kind, user_id, campaign_id, id COLLATE "C");
CREATE INDEX push_records_target ON push_records (project_id, kind, target_id, id COLLATE "C");
CREATE INDEX push_records_installation ON push_records (project_id, kind, installation_id, id COLLATE "C");
CREATE INDEX push_records_due ON push_records (project_id, available_at, id COLLATE "C") WHERE kind = 'queue' AND available_at IS NOT NULL;
CREATE INDEX push_records_engagement ON push_records (project_id, user_id, campaign_id, event_order) WHERE kind = 'observation' AND command_kind IN ('tap','action');
CREATE INDEX push_records_goal ON push_records (project_id, user_id, goal_event, id COLLATE "C") WHERE kind = 'delivery' AND is_test = false;
CREATE UNIQUE INDEX push_user_delivery ON push_records (project_id, campaign_id, user_id) WHERE kind = 'delivery' AND is_test = false;
CREATE INDEX end_users_push_cursor ON end_users (project_id, id COLLATE "C");
CREATE INDEX push_records_replacement ON push_records (project_id, installation_id, credential_id, replacement_key, event_order) WHERE kind = 'target' AND is_test = false;
CREATE INDEX push_records_recipient ON push_records (project_id, kind, recipient_id, state_kind, id COLLATE "C");
CREATE INDEX push_records_slot ON push_records (project_id, kind, slot_id, id COLLATE "C");
CREATE INDEX push_records_work_due ON push_records (project_id, available_at, id COLLATE "C") WHERE kind = 'work' AND available_at IS NOT NULL;
CREATE INDEX push_records_work_campaign_due ON push_records (project_id, campaign_id, available_at, id COLLATE "C") WHERE kind = 'work' AND available_at IS NOT NULL;
CREATE INDEX push_records_uncertain ON push_records (project_id, recipient_id, id COLLATE "C") WHERE kind = 'queue' AND is_uncertain = true;
