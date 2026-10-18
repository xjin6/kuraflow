PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  core_json TEXT NOT NULL CHECK (json_valid(core_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS products (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS private_materials (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
);

CREATE TABLE IF NOT EXISTS orders (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('pending', 'packing', 'ready', 'delivering', 'delivered')),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS orders_tenant_stage_date ON orders(tenant_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_tenant_store_date ON orders(tenant_id, store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  store_id TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS documents_tenant_store ON documents(tenant_id, store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS command_idempotency (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL,
  store_id TEXT,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, request_key)
);
CREATE INDEX IF NOT EXISTS command_idempotency_created ON command_idempotency(created_at);

CREATE TABLE IF NOT EXISTS business_audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL,
  command TEXT NOT NULL,
  entity_id TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS business_audit_tenant_date ON business_audit_log(tenant_id, created_at DESC);

-- A failed assertion aborts the entire D1 batch, including its revision update.
-- This protects all product/order writes from concurrent stale snapshots.
CREATE TABLE IF NOT EXISTS business_write_assertion (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT business_revision_conflict CHECK (ok = 1)
);
