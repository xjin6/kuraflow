CREATE TABLE IF NOT EXISTS flow_connections (
  tenant_id TEXT PRIMARY KEY,
  data_cipher TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS flow_conversations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(tenant_id,user_id,id)
);
CREATE INDEX IF NOT EXISTS flow_conversations_owner_updated ON flow_conversations(tenant_id,user_id,deleted_at,updated_at DESC);
CREATE TABLE IF NOT EXISTS flow_artifacts (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  svg TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,id)
);
CREATE TABLE IF NOT EXISTS flow_auth (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data_cipher TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,user_id,id)
);
CREATE INDEX IF NOT EXISTS flow_auth_expiry ON flow_auth(expires_at);
CREATE TABLE IF NOT EXISTS flow_leases (
  scope TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
