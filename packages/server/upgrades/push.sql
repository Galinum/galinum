BEGIN;

ALTER TABLE campaigns ADD COLUMN push_json text;

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

COMMIT;
