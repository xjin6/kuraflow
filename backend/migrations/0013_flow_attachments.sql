CREATE TABLE IF NOT EXISTS flow_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  pages INTEGER NOT NULL,
  digest TEXT NOT NULL,
  content_json TEXT NOT NULL,
  stored_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flow_attachment_owner ON flow_attachments(tenant_id,user_id,created_at);
