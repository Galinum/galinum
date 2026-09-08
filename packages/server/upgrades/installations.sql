BEGIN;

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

COMMIT;
