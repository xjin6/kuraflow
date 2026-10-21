-- Person and organization pictures have their own revision; changing them must
-- not invalidate account sessions or alter business snapshots.
CREATE TABLE IF NOT EXISTS account_avatars (
  account_id TEXT PRIMARY KEY REFERENCES staff_accounts(id) ON DELETE CASCADE,
  mime TEXT CHECK(mime IS NULL OR mime IN ('image/png','image/jpeg','image/webp')),
  image BLOB,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK((image IS NULL AND mime IS NULL) OR (image IS NOT NULL AND mime IS NOT NULL AND length(image) BETWEEN 16 AND 204800))
);
CREATE TABLE IF NOT EXISTS organization_avatars (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  mime TEXT CHECK(mime IS NULL OR mime IN ('image/png','image/jpeg','image/webp')),
  image BLOB,
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK((image IS NULL AND mime IS NULL) OR (image IS NOT NULL AND mime IS NOT NULL AND length(image) BETWEEN 16 AND 204800))
);
