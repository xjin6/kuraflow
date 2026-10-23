-- Prepared business operations; only the human confirmation route can commit.
CREATE TABLE IF NOT EXISTS flow_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  args_json TEXT NOT NULL,
  command_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  account_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','saved','cancelled')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(tenant_id,user_id,request_key)
);
CREATE INDEX IF NOT EXISTS flow_proposals_request ON flow_proposals(tenant_id,user_id,request_id);
