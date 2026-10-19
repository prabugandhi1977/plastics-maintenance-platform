-- Workflow completion: contract response targets, on-site signatures, parts fulfilment stages,
-- standard checklists per machine type, and per-user language preference.
ALTER TABLE contracts ADD COLUMN response_hours INTEGER;
ALTER TABLE parts_requests ADD COLUMN fulfilment_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE parts_requests ADD COLUMN updated_at TEXT;
ALTER TABLE users ADD COLUMN locale TEXT;

-- Sign-off can now be collected on site by the engineer (no customer account), so customer_user_id becomes optional.
CREATE TABLE signoffs_new (ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), customer_user_id TEXT REFERENCES users(id), signer_name TEXT NOT NULL, signed_at TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'portal' CHECK(method IN ('portal','on_site')), signature_attachment_id TEXT REFERENCES attachments(id), collected_by TEXT REFERENCES users(id));
INSERT INTO signoffs_new (ticket_id,customer_user_id,signer_name,signed_at) SELECT ticket_id,customer_user_id,signer_name,signed_at FROM signoffs;
DROP TABLE signoffs;
ALTER TABLE signoffs_new RENAME TO signoffs;

CREATE TABLE IF NOT EXISTS checklist_templates (id TEXT PRIMARY KEY, machine_type TEXT NOT NULL CHECK(machine_type IN ('injection','blow','extrusion','mould','auxiliary')), position INTEGER NOT NULL, item TEXT NOT NULL, UNIQUE(machine_type,item));
INSERT INTO checklist_templates VALUES
 ('ct-inj-1','injection',1,'Lock-out / tag-out applied'),
 ('ct-inj-2','injection',2,'Hydraulic oil level, temperature and leaks checked'),
 ('ct-inj-3','injection',3,'Clamp unit, tie bars and platen lubrication inspected'),
 ('ct-inj-4','injection',4,'Barrel heater bands and thermocouples checked'),
 ('ct-inj-5','injection',5,'Injection pressure and cushion verified against setpoint'),
 ('ct-inj-6','injection',6,'Safety gates and emergency stops tested'),
 ('ct-inj-7','injection',7,'Machine returned to production and first parts verified'),
 ('ct-blw-1','blow',1,'Lock-out / tag-out applied'),
 ('ct-blw-2','blow',2,'Parison head and die tooling inspected'),
 ('ct-blw-3','blow',3,'Blow pin, air pressure and valves checked'),
 ('ct-blw-4','blow',4,'Mould cooling circuits checked for leaks'),
 ('ct-blw-5','blow',5,'Guards and light curtains tested'),
 ('ct-blw-6','blow',6,'Machine returned to production and first parts verified'),
 ('ct-ext-1','extrusion',1,'Lock-out / tag-out applied'),
 ('ct-ext-2','extrusion',2,'Barrel zone temperatures checked against setpoint'),
 ('ct-ext-3','extrusion',3,'Screw drive, gearbox oil and motor current checked'),
 ('ct-ext-4','extrusion',4,'Die, breaker plate and screen changer inspected'),
 ('ct-ext-5','extrusion',5,'Downstream haul-off and cooling verified'),
 ('ct-ext-6','extrusion',6,'Emergency stops tested'),
 ('ct-ext-7','extrusion',7,'Line returned to production and output verified'),
 ('ct-mld-1','mould',1,'Parting line and vents cleaned and inspected'),
 ('ct-mld-2','mould',2,'Ejector pins and return springs checked'),
 ('ct-mld-3','mould',3,'Cooling channel flow checked and no leaks'),
 ('ct-mld-4','mould',4,'Hot runner heaters and thermocouples checked'),
 ('ct-mld-5','mould',5,'Shot count recorded'),
 ('ct-mld-6','mould',6,'Mould returned to press or stored protected'),
 ('ct-aux-1','auxiliary',1,'Lock-out / tag-out applied'),
 ('ct-aux-2','auxiliary',2,'Filters inspected and cleaned'),
 ('ct-aux-3','auxiliary',3,'Temperature, dew point or flow verified against setpoint'),
 ('ct-aux-4','auxiliary',4,'Alarms and safety interlocks tested'),
 ('ct-aux-5','auxiliary',5,'Equipment returned to service');
CREATE INDEX IF NOT EXISTS idx_checklist_ticket ON checklist_entries(ticket_id);
CREATE INDEX IF NOT EXISTS idx_parts_ticket ON parts_requests(ticket_id);
CREATE INDEX IF NOT EXISTS idx_tickets_equipment ON tickets(equipment_id,created_at);
