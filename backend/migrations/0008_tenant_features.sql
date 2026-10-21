CREATE TABLE IF NOT EXISTS tenant_features (
  tenant_id TEXT PRIMARY KEY,
  flow_enabled INTEGER NOT NULL DEFAULT 0 CHECK(flow_enabled IN (0,1)),
  flow_model TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO tenant_features(tenant_id,flow_enabled,flow_model,version,updated_at)
  SELECT t.id,CASE WHEN c.tenant_id IS NULL THEN 0 ELSE 1 END,NULL,1,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM tenants t LEFT JOIN flow_connections c ON c.tenant_id=t.id;

CREATE TABLE IF NOT EXISTS flow_model_catalogues (
  tenant_id TEXT PRIMARY KEY,
  connection_version INTEGER NOT NULL CHECK(connection_version > 0),
  data_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
