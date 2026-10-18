-- Store codes are indexed by SHA-256 and recoverable only with the Worker secret.
CREATE TABLE IF NOT EXISTS store_access_codes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  code_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, store_id)
);
