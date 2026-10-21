-- Administrator deletion is reversible. Login identity and historical avatar
-- records stay on staff_accounts; restoring does not automatically re-enable it.
CREATE TABLE IF NOT EXISTS staff_account_archives (
  account_id TEXT PRIMARY KEY REFERENCES staff_accounts(id),
  deleted_at INTEGER NOT NULL CHECK(deleted_at > 0),
  deleted_by TEXT NOT NULL
);
