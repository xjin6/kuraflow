-- Stable numeric identities reference real audit entries; no account fields,
-- credentials or new business events are copied or invented.
CREATE TABLE IF NOT EXISTS platform_notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL UNIQUE REFERENCES account_audit(id)
);
INSERT OR IGNORE INTO platform_notification_events(audit_id)
SELECT id FROM account_audit ORDER BY rowid;
CREATE TRIGGER IF NOT EXISTS account_audit_platform_notification
AFTER INSERT ON account_audit BEGIN
  INSERT OR IGNORE INTO platform_notification_events(audit_id) VALUES(NEW.id);
END;

-- Read markers are personal and never change the source audit or business.
CREATE TABLE IF NOT EXISTS platform_notification_reads (
  user_id TEXT NOT NULL,
  audit_id TEXT NOT NULL REFERENCES account_audit(id),
  read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, audit_id)
);
