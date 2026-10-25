-- Keep old flags and history intact; missing rows inherit the previous defaults.
CREATE TABLE IF NOT EXISTS tenant_portal_features (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  admin_multilingual_enabled INTEGER NOT NULL CHECK(admin_multilingual_enabled IN (0,1)),
  admin_notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK(admin_notifications_enabled IN (0,1)),
  store_flow_enabled INTEGER NOT NULL DEFAULT 0 CHECK(store_flow_enabled IN (0,1)),
  store_multilingual_enabled INTEGER NOT NULL CHECK(store_multilingual_enabled IN (0,1)),
  store_notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK(store_notifications_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_features (
  id INTEGER PRIMARY KEY CHECK(id=1),
  flow_enabled INTEGER NOT NULL DEFAULT 0 CHECK(flow_enabled IN (0,1)),
  flow_model TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO platform_features(id,flow_enabled,version,updated_at) VALUES(1,0,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
