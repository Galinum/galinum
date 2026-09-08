BEGIN;

CREATE TABLE inapp_feedback (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id text NOT NULL,
  delivery_id text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES end_users(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('shown','clicked','dismissed','converted')),
  acknowledged_at bigint NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX inapp_feedback_exposure ON inapp_feedback (project_id, acknowledged_at, user_id) WHERE type = 'shown';
CREATE INDEX inapp_feedback_delivery ON inapp_feedback (project_id, delivery_id, id);

COMMIT;
