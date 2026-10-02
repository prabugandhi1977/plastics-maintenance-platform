-- Traceability suite: forward (serialised labels, dispatch, customers, field returns, warranty), backward (FIFO,
-- suppliers, operator) and real-time process traceability (process windows, live readings, deviations, quality gates
-- with digital check sheets).

-- Products: customer, warranty period, label settings, process window per setting ({"meltTempC":{"min":220,"max":240}})
-- and the quality gates with their check sheets ({"first_article":[{"label":"…","type":"measure","min":…,"max":…,"unit":"mm"}]}).
ALTER TABLE products ADD COLUMN customer TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN warranty_months INTEGER NOT NULL DEFAULT 24;
ALTER TABLE products ADD COLUMN pack_qty INTEGER;
ALTER TABLE products ADD COLUMN process_window TEXT NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN check_sheets TEXT NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN hold_on_deviation INTEGER NOT NULL DEFAULT 0;

-- Batches: the signed-in person who started it (operator authentication), FIFO overrides, released by/at.
ALTER TABLE batches ADD COLUMN started_by TEXT REFERENCES users(id);
ALTER TABLE batches ADD COLUMN fifo_override TEXT;
ALTER TABLE batches ADD COLUMN released_by TEXT REFERENCES users(id);
ALTER TABLE batches ADD COLUMN released_at TEXT;

-- Serialised units: a part (DMC/QR on the part), a box (KLT/carton label) or a pallet; boxes hold parts, pallets boxes.
CREATE TABLE IF NOT EXISTS trace_units (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), batch_id TEXT NOT NULL REFERENCES batches(id),
  serial TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('part','box','pallet')), parent_id TEXT REFERENCES trace_units(id), quantity REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'packed' CHECK(status IN ('packed','shipped','returned','scrapped')), shipment_id TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(company_id,serial));
CREATE INDEX IF NOT EXISTS idx_trace_units_batch ON trace_units(batch_id);

-- Quality gates: each check-sheet result (first article, in-process, final QC, packaging) with its values and signer.
CREATE TABLE IF NOT EXISTS batch_checks (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), batch_id TEXT NOT NULL REFERENCES batches(id),
  gate TEXT NOT NULL CHECK(gate IN ('first_article','in_process','final_qc','packaging')), result TEXT NOT NULL CHECK(result IN ('pass','fail')),
  answers TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', checked_by TEXT NOT NULL REFERENCES users(id), checked_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_batch_checks_batch ON batch_checks(batch_id,gate);

-- Process readings while a batch runs (from the machine/IoT or entered), and deviations outside the product's window.
CREATE TABLE IF NOT EXISTS process_readings (batch_id TEXT NOT NULL REFERENCES batches(id), observed_at TEXT NOT NULL, parameter TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL DEFAULT 'machine',
  PRIMARY KEY(batch_id,parameter,observed_at));
CREATE TABLE IF NOT EXISTS process_deviations (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), batch_id TEXT NOT NULL REFERENCES batches(id),
  parameter TEXT NOT NULL, value REAL NOT NULL, min REAL, max REAL, started_at TEXT NOT NULL, ended_at TEXT, readings INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected')), disposition TEXT, decided_by TEXT REFERENCES users(id), decided_at TEXT);
CREATE INDEX IF NOT EXISTS idx_deviations_batch ON process_deviations(batch_id);

-- Forward: shipments to customers, through a channel, with the units (boxes/pallets) on them.
CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), shipment_number TEXT NOT NULL, customer TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('oem','tier1','distributor','aftermarket','internal')), destination TEXT NOT NULL DEFAULT '', customer_po TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'loading' CHECK(status IN ('loading','shipped','cancelled')), shipped_at TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(company_id,shipment_number));

-- Field returns, complaints and warranty claims, linked to the unit or batch they concern.
CREATE TABLE IF NOT EXISTS field_returns (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), reference TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('complaint','warranty_claim','field_failure')), customer TEXT NOT NULL, serial TEXT NOT NULL DEFAULT '', unit_id TEXT REFERENCES trace_units(id),
  batch_id TEXT REFERENCES batches(id), quantity REAL NOT NULL DEFAULT 1, defect TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', reported_at TEXT NOT NULL,
  authenticity TEXT NOT NULL CHECK(authenticity IN ('genuine','suspicious','not_found')), checks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','rejected','closed')), root_cause TEXT, corrective_action TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(company_id,reference));
CREATE INDEX IF NOT EXISTS idx_field_returns_batch ON field_returns(batch_id);
