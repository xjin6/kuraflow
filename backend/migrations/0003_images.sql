CREATE TABLE IF NOT EXISTS media_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0 AND bytes <= 104857600)
);
CREATE TABLE IF NOT EXISTS media_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 204800),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_tenant_created ON media_files(tenant_id,created_at);
CREATE TABLE IF NOT EXISTS media_assertions (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
