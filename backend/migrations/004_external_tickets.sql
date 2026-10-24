-- Tickets raised by trusted outside systems (MouldCare Monitor first). Each system holds a company integration key:
-- it reaches only that company's machines. Only the key's hash is stored; the key is shown once, when it is created.
CREATE TABLE integration_keys (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_integration_keys_company ON integration_keys(company_id);

-- The sender's own reference (e.g. source 'monitor', external id = the Monitor draft id). Sending the same draft
-- again finds this ticket instead of raising a second one.
ALTER TABLE tickets ADD COLUMN external_source TEXT;
ALTER TABLE tickets ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX idx_tickets_external ON tickets(company_id, external_source, external_id) WHERE external_id IS NOT NULL;
