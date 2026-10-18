-- Authentication data is private and is never returned by the state API.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'store')),
  store_id TEXT,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((role = 'admin' AND store_id IS NULL) OR (role = 'store' AND store_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS users_tenant ON users(tenant_id);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);

CREATE TABLE IF NOT EXISTS invites (
  hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'store')),
  display_name TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used_at INTEGER,
  CHECK ((role = 'admin' AND store_id IS NULL) OR (role = 'store' AND store_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS invites_expiry ON invites(expires);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  -- Registration reserves a new ID before that user exists.
  user_id TEXT,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('login', 'register')),
  invite_hash TEXT REFERENCES invites(hash) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires);

CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_expiry ON auth_rate_limits(expires);

-- A failed conditional write must abort the entire D1 batch, including earlier
-- writes. The singleton CHECK guard converts changes() = 0 into a SQL error.
CREATE TABLE IF NOT EXISTS auth_atomic_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ok INTEGER NOT NULL CHECK (ok = 1)
);
