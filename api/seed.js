import { db, id, now, one, run } from './db.js';
import { hashPassword } from './security.js';

const stamp=now(), daysAgo=d=>new Date(Date.now()-d*86400000).toISOString();
function company(key,name,currency,timezone,locale) { run('INSERT INTO companies (id,name,timezone,currency,units,locale,created_at) VALUES (?,?,?,?,?,?,?)',key,name,timezone,currency,'metric',locale,stamp); }
function provider(key,name,areas,skills) { run('INSERT INTO providers (id,name,approved,service_areas,skills,created_at) VALUES (?,?,?,?,?,?)',key,name,1,JSON.stringify(areas),JSON.stringify(skills),stamp); }
function user(key,name,email,role,companyId=null,providerId=null,areas=[],skills=[]) { run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,companyId,providerId,name,email,hashPassword('DemoPass123!'),role,1,JSON.stringify(areas),JSON.stringify(skills),stamp); }
function equipment(key,companyId,plantId,type,make,model,serial,location) { run('INSERT INTO equipment (id,company_id,plant_id,machine_type,make,model,serial_number,location,qr_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',key,companyId,plantId,type,make,model,serial,location,`MC:${key}`,stamp); }
function ticket(key,companyId,plantId,equipmentId,title,priority,symptoms,codes,impact,status,userId,providerId,createdBy,createdAt,firstResponse,completed,downtime) { run('INSERT INTO tickets (id,company_id,plant_id,equipment_id,title,priority,symptoms,error_codes,production_impact,status,assigned_user_id,assigned_provider_id,created_by,created_at,first_response_at,completed_at,downtime_minutes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,companyId,plantId,equipmentId,title,priority,symptoms,codes,impact,status,userId,providerId,createdBy,createdAt,firstResponse,completed,downtime); }
const event=(ticketId,actor,type,detail,at=stamp)=>run('INSERT INTO ticket_events (id,ticket_id,actor_id,event_type,detail,created_at) VALUES (?,?,?,?,?,?)',id(),ticketId,actor,type,detail,at);

if (one('SELECT 1 FROM companies LIMIT 1')) { console.log('Seed already present'); process.exit(0); }
db.exec('BEGIN IMMEDIATE');
try {
  company('c-acme','Acme Plastics','USD','America/Chicago','en'); company('c-nova','Nova Polymers','EUR','Europe/Berlin','de');
  provider('p-atlas','Atlas Field Service',['US-MW'],['injection','mould','auxiliary']); provider('p-euro','EuroTech Service',['DE-NW'],['blow','extrusion','auxiliary']);
  user('u-admin','Platform Admin','admin@demo.test','platform_admin'); user('u-dispatch','Maya Dispatch','dispatch@demo.test','dispatcher');
  user('u-engineer','Alex Engineer','engineer@demo.test','engineer',null,null,['US-MW'],['injection','mould']);
  user('u-acme','Sam Acme','acme@demo.test','customer_admin','c-acme'); user('u-acme-maint','Lee Maintenance','maint@demo.test','maintenance','c-acme');
  user('u-nova','Nora Nova','nova@demo.test','customer_admin','c-nova');
  user('u-atlas-admin','Avery Atlas','atlas-admin@demo.test','provider_admin',null,'p-atlas',['US-MW'],['injection','mould']);
  user('u-atlas','Ari Atlas','atlas@demo.test','provider_engineer',null,'p-atlas',['US-MW'],['injection','mould']);
  user('u-euro','Emil Euro','euro@demo.test','provider_engineer',null,'p-euro',['DE-NW'],['blow','extrusion']);
  run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at) VALUES (?,?,?,?,?,?,?,?)','plant-a','c-acme','Chicago Plant','1200 Industrial Way','US','US-MW','America/Chicago',stamp);
  run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at) VALUES (?,?,?,?,?,?,?,?)','plant-n','c-nova','Cologne Plant','Werkstrasse 8','DE','DE-NW','Europe/Berlin',stamp);
  equipment('eq-a','c-acme','plant-a','injection','Arburg','Allrounder 570','ARB-570-001','Bay 4');
  equipment('eq-b','c-acme','plant-a','mould','Husky','Hot Runner 24','HSK-2409','Tool Room');
  equipment('eq-n','c-nova','plant-n','extrusion','Coperion','ZSK 58','COP-58-811','Line 2');
  run('INSERT INTO contracts (id,company_id,title,starts_at,renews_at,commitments,exclusions,status,created_at,response_hours) VALUES (?,?,?,?,?,?,?,?,?,?)','contract-a','c-acme','Annual care 2026','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','4 preventive visits; 8-hour response','Consumables and tooling','active',stamp,8);
  run('INSERT INTO contract_equipment (contract_id,equipment_id) VALUES (?,?)','contract-a','eq-a');
  run('INSERT INTO visits (id,contract_id,company_id,equipment_id,due_at,status,notes) VALUES (?,?,?,?,?,?,?)','visit-a','contract-a','c-acme','eq-a','2026-11-15T14:00:00.000Z','scheduled','Quarterly inspection');
  run('INSERT INTO contracts (id,company_id,title,starts_at,renews_at,commitments,exclusions,status,created_at,response_hours) VALUES (?,?,?,?,?,?,?,?,?,?)','contract-n','c-nova','Wartungsvertrag Linie 2','2025-12-01T00:00:00.000Z','2026-12-01T00:00:00.000Z','2 inspections per year; 4-hour response','Screw and barrel wear parts','active',stamp,4);
  run('INSERT INTO contract_equipment (contract_id,equipment_id) VALUES (?,?)','contract-n','eq-n');
  run('INSERT INTO visits (id,contract_id,company_id,equipment_id,due_at,status,notes) VALUES (?,?,?,?,?,?,?)','visit-n','contract-n','c-nova','eq-n','2026-10-20T07:00:00.000Z','scheduled','Half-year inspection');
  ticket('ticket-a','c-acme','plant-a','eq-a','Hydraulic pressure drops','high','Pressure falls after warm-up','E-204','Line stopped','assigned','u-engineer',null,'u-acme',stamp,null,null,120);
  ticket('ticket-n','c-nova','plant-n','eq-n','Extruder temperature alarm','critical','Zone 3 overheats','T-302','Reduced output','assigned',null,'p-euro','u-nova',stamp,null,null,45);
  // History: an earlier, completed occurrence of the same fault on eq-a, so repeat faults and downtime have data.
  ticket('ticket-a-old','c-acme','plant-a','eq-a','Hydraulic pressure low at start-up','medium','Pressure slow to build','E-204','Delayed start','completed','u-engineer',null,'u-acme-maint',daysAgo(20),daysAgo(19.9),daysAgo(19.7),180);
  run('INSERT INTO work_logs (id,ticket_id,user_id,description,minutes,parts_used,created_at) VALUES (?,?,?,?,?,?,?)','wl-old','ticket-a-old','u-engineer','Replaced worn pressure relief valve seal; pressure stable at setpoint',150,'Relief valve seal kit',daysAgo(19.7));
  run("INSERT INTO signoffs (ticket_id,customer_user_id,signer_name,signed_at,method) VALUES (?,?,?,?,'portal')",'ticket-a-old','u-acme-maint','Lee Maintenance',daysAgo(19.6));
  for (const [type,detail,at] of [['assigned','Assigned to Alex Engineer',daysAgo(20)],['accepted','',daysAgo(19.9)],['completed','Seal replaced',daysAgo(19.7)]]) event('ticket-a-old','u-dispatch',type,detail,at);
  event('ticket-a','u-dispatch','assigned','Assigned to Alex Engineer'); event('ticket-n','u-dispatch','assigned','Assigned to EuroTech Service');
  run('INSERT INTO parts_requests (id,company_id,ticket_id,item,quantity,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)','part-a','c-acme','ticket-a','Pressure relief valve assembly',1,'quoted',stamp,stamp);
  run('INSERT INTO quotations (id,request_id,company_id,amount_minor,currency,lead_days,status,created_at) VALUES (?,?,?,?,?,?,?,?)','quote-a','part-a','c-acme',48500,'USD',3,'pending',stamp);
  run('INSERT INTO device_mappings (id,external_device_id,company_id,equipment_id,created_at) VALUES (?,?,?,?,?)','map-a','demo-device-a','c-acme','eq-a',stamp);
  run('INSERT INTO device_mappings (id,external_device_id,company_id,equipment_id,created_at) VALUES (?,?,?,?,?)','map-n','demo-device-n','c-nova','eq-n',stamp);
  db.exec('COMMIT'); console.log('Seeded two customers, two providers, equipment, contracts, tickets and history. Password: DemoPass123!');
} catch(e) { db.exec('ROLLBACK'); throw e; }
