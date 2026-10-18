CREATE TABLE IF NOT EXISTS account_keys (
  account_id TEXT PRIMARY KEY REFERENCES staff_accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('platform','master')),
  key_hash TEXT NOT NULL UNIQUE,
  key_cipher TEXT,
  created_at INTEGER NOT NULL,
  CHECK((kind='platform' AND key_cipher IS NULL) OR (kind='master' AND key_cipher IS NOT NULL))
);
-- Member names are normalized on write. Existing numeric names remain valid.
CREATE UNIQUE INDEX IF NOT EXISTS staff_username_normalized ON staff_accounts(lower(login_id));
