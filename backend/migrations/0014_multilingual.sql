-- Keep this migration repeatable for the persistent local preview runner.
-- The shared tenant_features version coordinates Flow and UI feature changes.
CREATE TABLE IF NOT EXISTS tenant_ui_features (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  multilingual_enabled INTEGER NOT NULL DEFAULT 0 CHECK(multilingual_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
