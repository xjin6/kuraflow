-- Event history is append-only. Existing business records are not backfilled.
CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 120),
  body TEXT NOT NULL CHECK (length(body) <= 1000),
  target_type TEXT NOT NULL CHECK (target_type IN ('order', 'product')),
  target_id TEXT NOT NULL,
  order_id TEXT,
  product_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  UNIQUE (tenant_id, event_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS notification_events_tenant_sequence ON notification_events(tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS notification_events_tenant_demo_sequence ON notification_events(tenant_id, is_demo, id DESC);

CREATE TABLE IF NOT EXISTS notification_reads (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES notification_events(tenant_id, id)
);
