CREATE TABLE IF NOT EXISTS organizations (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  code TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT '标准版',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  expires_on TEXT,
  admin_limit INTEGER NOT NULL DEFAULT 3 CHECK(admin_limit BETWEEN 1 AND 100),
  store_limit INTEGER NOT NULL DEFAULT 3 CHECK(store_limit BETWEEN 1 AND 100),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS organization_store_codes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  store_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  PRIMARY KEY(tenant_id,store_id)
);
CREATE TABLE IF NOT EXISTS staff_accounts (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT REFERENCES tenants(id),
  store_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('platform','admin','store')),
  account_role TEXT NOT NULL CHECK(account_role IN ('owner','member')),
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')),
  password_hash TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER,
  CHECK((role='platform' AND tenant_id IS NULL AND store_id IS NULL) OR (role='admin' AND tenant_id IS NOT NULL AND store_id IS NULL) OR (role='store' AND tenant_id IS NOT NULL AND store_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_one_owner ON staff_accounts(COALESCE(tenant_id,''),COALESCE(store_id,''),role) WHERE account_role='owner';
CREATE INDEX IF NOT EXISTS staff_scope ON staff_accounts(tenant_id,store_id,status);
CREATE TABLE IF NOT EXISTS account_invites (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES staff_accounts(id),
  expires INTEGER NOT NULL,
  version INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS account_invites_account ON account_invites(account_id);
CREATE TABLE IF NOT EXISTS account_sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES staff_accounts(id),
  expires INTEGER NOT NULL,
  version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_id);
CREATE TABLE IF NOT EXISTS account_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  store_id TEXT,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_audit_scope ON account_audit(tenant_id,store_id,created_at DESC);
