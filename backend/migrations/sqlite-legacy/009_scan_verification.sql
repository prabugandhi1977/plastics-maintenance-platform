-- Tickets are tied to the physical machine: an RFID/NFC tag can sit next to the printed QR label, and every ticket
-- records how it was raised and how it was closed (QR or RFID scan at the machine, from an alert, or a dispatcher
-- override with a reason). Tickets created before this migration keep NULL and are shown as "before scan linking".
ALTER TABLE equipment ADD COLUMN rfid_tag TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_rfid ON equipment(rfid_tag) WHERE rfid_tag IS NOT NULL;

ALTER TABLE tickets ADD COLUMN raised_via TEXT;
ALTER TABLE tickets ADD COLUMN raised_scan_at TEXT;
ALTER TABLE tickets ADD COLUMN closed_via TEXT;
ALTER TABLE tickets ADD COLUMN closed_scan_at TEXT;
ALTER TABLE tickets ADD COLUMN scan_override_reason TEXT;
UPDATE tickets SET raised_via='auto' WHERE created_by='u-system';

INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES ('scan_policy','{"raise":"required","close":"required"}',datetime('now'));
