import { seedVision } from './vision-demo.js';
import { seedTraceSuite } from './trace-demo.js';
import { db, id, now, one, run, transaction } from '../common/db.js';
import { hashPassword } from '../common/security.js';
import { parametersFor } from '../common/catalog.js';

const isMain=process.argv[1]?.endsWith('seed.js');
const stamp=now(), daysAgo=d=>new Date(Date.now()-d*86400000).toISOString();
function company(key,name,currency,timezone,locale,country,contact,email,phone) { run('INSERT INTO companies (id,name,timezone,currency,units,locale,created_at,country,contact_name,contact_email,contact_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,name,timezone,currency,'metric',locale,stamp,country,contact,email,phone); }
function provider(key,name,areas,skills,country,contact,email,phone,certs) { run('INSERT INTO providers (id,name,approved,service_areas,skills,created_at,country,contact_name,contact_email,contact_phone,insurance_expiry,certifications) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,name,1,JSON.stringify(areas),JSON.stringify(skills),stamp,country,contact,email,phone,'2027-06-30T00:00:00.000Z',certs); }
function user(key,name,email,role,companyId=null,providerId=null,areas=[],skills=[],phone='',title='') { run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at,phone,job_title) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',key,companyId,providerId,name,email,hashPassword('DemoPass123!'),role,1,JSON.stringify(areas),JSON.stringify(skills),stamp,phone,title); }
function equipment(key,companyId,plantId,type,make,model,serial,location,tag,criticality,year,specs) { run('INSERT INTO equipment (id,company_id,plant_id,machine_type,make,model,serial_number,location,qr_code,created_at,asset_tag,criticality,status,year_built,specs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,companyId,plantId,type,make,model,serial,location,`MC:${key}`,stamp,tag,criticality,'in_service',year,JSON.stringify(specs)); }
function ticket(t) { run('INSERT INTO tickets (id,company_id,plant_id,equipment_id,title,priority,symptoms,error_codes,production_impact,status,assigned_user_id,assigned_provider_id,created_by,created_at,first_response_at,completed_at,downtime_minutes,failure_category,machine_state,safety_issue,occurred_at,failure_mode,root_cause,action_taken) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',t.id,t.company,t.plant,t.equipment,t.title,t.priority,t.symptoms,t.codes,t.impact,t.status,t.user??null,t.provider??null,t.by,t.created,t.response??null,t.completed??null,t.downtime,t.category,t.state,0,t.occurred??t.created,t.mode??null,t.cause??null,t.action??null); }
const event=(ticketId,actor,type,detail,at=stamp)=>run('INSERT INTO ticket_events (id,ticket_id,actor_id,event_type,detail,created_at) VALUES (?,?,?,?,?,?)',id(),ticketId,actor,type,detail,at);

// Stage 3–4 demo data (traceability, safety, asset tracking). Also added to an existing demo database that predates it.
function seedOperations() {
  const zone=(key,company,plant,name,kind,reader)=>run('INSERT INTO zones (id,company_id,plant_id,name,kind,reader_id,created_at) VALUES (?,?,?,?,?,?,?)',key,company,plant,name,kind,reader,stamp);
  zone('z-a-hall','c-acme','plant-a','Moulding hall','production','GW-ACME-01'); zone('z-a-tool','c-acme','plant-a','Tool room','tool_room','GW-ACME-02'); zone('z-a-wh','c-acme','plant-a','Warehouse','storage','GW-ACME-03');
  zone('z-a-mnt','c-acme','plant-a','Maintenance shop','maintenance','GW-ACME-04'); zone('z-a-dock','c-acme','plant-a','Shipping dock','dock','RFID-ACME-DOCK'); zone('z-a-yard','c-acme','plant-a','Yard / gate','outside','RFID-ACME-GATE');
  zone('z-n-hall','c-nova','plant-n','Extrusionshalle','production','GW-NOVA-01'); zone('z-n-lager','c-nova','plant-n','Lager','storage','GW-NOVA-02'); zone('z-n-werk','c-nova','plant-n','Werkstatt','tool_room','GW-NOVA-03'); zone('z-n-tor','c-nova','plant-n','Tor / Hof','outside','RFID-NOVA-GATE');
  const asset=(key,company,plant,tag,type,kind,name,equipment,home,missingAfter=24)=>run('INSERT INTO tracked_assets (id,company_id,plant_id,tag_id,tag_type,kind,name,equipment_id,home_zone_id,missing_after_hours,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,company,plant,tag,type,kind,name,equipment,home,missingAfter,stamp);
  asset('ta-mould','c-acme','plant-a','BLE-0001','ble','mould','Mould M-2409 (24-cav closure)','eq-b','z-a-hall');
  asset('ta-mould2','c-acme','plant-a','BLE-0002','ble','mould','Mould M-1802 (housing)',null,'z-a-tool');
  asset('ta-trolley1','c-acme','plant-a','RFID-T-101','rfid','trolley','Mould trolley 1',null,'z-a-hall',12);
  asset('ta-trolley2','c-acme','plant-a','RFID-T-102','rfid','trolley','Material trolley 2',null,'z-a-wh',12);
  asset('ta-torque','c-acme','plant-a','BLE-0101','ble','tool','Torque wrench 40–200 Nm',null,'z-a-tool',8);
  asset('ta-gauge','c-acme','plant-a','BLE-0102','ble','gauge','Thread gauge PCO1881',null,'z-a-tool',8);
  asset('ta-fork','c-acme','plant-a','BLE-0201','ble','forklift','Forklift FL-02',null,'z-a-wh',4);
  asset('ta-die','c-nova','plant-n','BLE-N-01','ble','tool','Pipe die head 110 mm','eq-n2','z-n-hall');
  asset('ta-ntrolley','c-nova','plant-n','RFID-N-11','rfid','trolley','Screw-change trolley',null,'z-n-werk',12);
  asset('ta-ngauge','c-nova','plant-n','BLE-N-21','ble','gauge','Wall-thickness gauge',null,'z-n-werk',8);
  // Material lots (with supplier certificates) and three batches per production machine: released, completed, running.
  const lot=(key,company,number,material,supplier,days,kg,cert)=>run('INSERT INTO material_lots (id,company_id,lot_number,material,supplier,received_at,quantity_kg,status,certificate,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',key,company,number,material,supplier,daysAgo(days),kg,'released',cert,stamp);
  lot('lot-pp1','c-acme','PP-24-0815','PP homopolymer MFI 12','PolyChem Inc.',12,12500,'CoA 0815-A'); lot('lot-pp2','c-acme','PP-24-0902','PP homopolymer MFI 12','PolyChem Inc.',4,12500,'CoA 0902-A');
  lot('lot-mb','c-acme','MB-BLUE-311','Blue masterbatch 2 %','ColorTec',20,500,'CoA MB-311'); lot('lot-pcabs','c-acme','PCABS-7731','PC/ABS flame-retardant','Polymer Partners',9,2000,'CoA 7731');
  lot('lot-hd1','c-acme','HDPE-5502','HDPE blow grade','Gulf Resins',10,10000,'CoA 5502'); lot('lot-hd2','c-acme','HDPE-5517','HDPE blow grade','Gulf Resins',3,10000,'CoA 5517');
  lot('lot-npp','c-nova','PP-H-44120','PP-Homopolymer','Rheinpolymer GmbH',8,20000,'APZ 3.1 44120'); lot('lot-gf','c-nova','GF-ECR-9081','Glasfaser ECR 4,5 mm','FiberGlas AG',15,8000,'APZ 3.1 9081');
  lot('lot-pe1','c-nova','PE100-22871','PE100 schwarz','Rheinpolymer GmbH',11,22000,'APZ 3.1 22871'); lot('lot-pe2','c-nova','PE100-23015','PE100 schwarz','Rheinpolymer GmbH',2,22000,'APZ 3.1 23015');
  const batch=(key,company,number,product,machine,mould,operator,planned,status,start,end,params,lots)=>{ run('INSERT INTO batches (id,company_id,batch_number,product_id,equipment_id,mould_id,operator_name,planned_qty,status,started_at,ended_at,process_params,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',key,company,number,product,machine,mould,operator,planned,status,daysAgo(start),end==null?null:daysAgo(end),JSON.stringify(params),stamp); for (const [l,kg] of lots) run('INSERT INTO batch_materials (batch_id,lot_id,quantity_kg) VALUES (?,?,?)',key,l,kg); };
  const cap={meltTempC:230,mouldTempC:35,injectionPressureBar:950,holdPressureBar:520,cycleTimeS:4.9}, hsg={meltTempC:265,mouldTempC:80,injectionPressureBar:1150,holdPressureBar:650,cycleTimeS:32.5}, btl={parisonTempC:195,blowPressureBar:7,cycleTimeS:14.4}, cmp={meltTempC:235,screwRpm:450,meltPressureBar:45,lineSpeedMMin:28}, pipe={meltTempC:210,screwRpm:32,meltPressureBar:185,lineSpeedMMin:2.1};
  batch('b-cap1','c-acme','B-CAP-2026-101','pr-cap','eq-a','eq-b','J. Ortiz',1000000,'released',6.5,4.6,cap,[['lot-pp1',820],['lot-mb',16]]);
  batch('b-cap2','c-acme','B-CAP-2026-102','pr-cap','eq-a','eq-b','K. Wong',1000000,'completed',4.5,1.6,cap,[['lot-pp1',600],['lot-pp2',240],['lot-mb',17]]);
  batch('b-cap3','c-acme','B-CAP-2026-103','pr-cap','eq-a','eq-b','J. Ortiz',1000000,'running',1.5,null,cap,[['lot-pp2',null],['lot-mb',null]]);
  batch('b-hsg1','c-acme','B-HSG-2026-041','pr-hsg','eq-a2',null,'K. Wong',8000,'released',6.8,4.2,hsg,[['lot-pcabs',600]]);
  batch('b-hsg2','c-acme','B-HSG-2026-042','pr-hsg','eq-a2',null,'P. Shah',8000,'completed',4.1,1.4,hsg,[['lot-pcabs',590]]);
  batch('b-hsg3','c-acme','B-HSG-2026-043','pr-hsg','eq-a2',null,'P. Shah',8000,'running',1.3,null,hsg,[['lot-pcabs',null]]);
  batch('b-btl1','c-acme','B-BTL-2026-210','pr-btl','eq-bm',null,'M. Brown',50000,'released',6.2,4.0,btl,[['lot-hd1',2100]]);
  batch('b-btl2','c-acme','B-BTL-2026-211','pr-btl','eq-bm',null,'M. Brown',50000,'completed',3.9,1.2,btl,[['lot-hd1',1500],['lot-hd2',650]]);
  batch('b-btl3','c-acme','B-BTL-2026-212','pr-btl','eq-bm',null,'L. Garcia',50000,'running',1.1,null,btl,[['lot-hd2',null]]);
  batch('b-cmp1','c-nova','C-2026-0611','pr-cmp','eq-n',null,'T. Becker',40000,'released',6.9,4.5,cmp,[['lot-npp',27000],['lot-gf',11600]]);
  batch('b-cmp2','c-nova','C-2026-0612','pr-cmp','eq-n',null,'A. Yilmaz',40000,'completed',4.4,1.5,cmp,[['lot-npp',26500],['lot-gf',11400]]);
  batch('b-cmp3','c-nova','C-2026-0613','pr-cmp','eq-n',null,'T. Becker',40000,'running',1.4,null,cmp,[['lot-npp',null],['lot-gf',null]]);
  batch('b-pipe1','c-nova','R-2026-1101','pr-pipe','eq-n2',null,'S. Wagner',45000,'released',6.6,4.3,pipe,[['lot-pe1',24500]]);
  batch('b-pipe2','c-nova','R-2026-1102','pr-pipe','eq-n2',null,'S. Wagner',45000,'completed',4.2,1.3,pipe,[['lot-pe1',9000],['lot-pe2',15000]]);
  batch('b-pipe3','c-nova','R-2026-1103','pr-pipe','eq-n2',null,'L. Krause',45000,'running',1.2,null,pipe,[['lot-pe2',null]]);
  // Safety history: reported near misses and conditions, camera detections, and one lost-time injury at Nova ~40 days ago.
  const safety=(company,plant,zone,eq,type,severity,source,text,days,by,status,lost=0,cause=null,action=null)=>run('INSERT INTO safety_events (id,company_id,plant_id,zone_id,equipment_id,event_type,severity,source,description,occurred_at,reported_by,status,lost_time,root_cause,corrective_action,closed_by,closed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id(),company,plant,zone,eq,type,severity,source,text,daysAgo(days),by,status,lost,cause,action,status==='closed'?'u-acme':null,status==='closed'?daysAgo(days-2):null,stamp);
  safety('c-acme','plant-a','z-a-hall','eq-a','near_miss','warning','person','Mould trolley rolled when the brake was not set; nobody hurt',12,'u-acme-maint','closed',0,'Trolley brake worn, slope at bay 4','Brake replaced; wheel chocks at every press');
  safety('c-acme','plant-a','z-a-wh',null,'unsafe_condition','warning','person','Oil spill next to the dryer stairs',5,'u-acme-maint','investigating');
  safety('c-acme','plant-a','z-a-hall','eq-a2','first_aid','warning','person','Small cut on hand while removing a part from the gripper',9,'u-acme-maint','closed',0,'Sharp edge on gripper finger','Edge deburred; cut-resistant gloves issued');
  safety('c-acme','plant-a','z-a-dock',null,'near_miss','warning','person','Forklift reversed close to a pedestrian at the dock door',2,'u-acme','open');
  safety('c-nova','plant-n','z-n-hall','eq-n2','injury','critical','person','Verbrennung am Unterarm beim Reinigen des Werkzeugs ohne Hitzeschutz',41,'u-nova','closed',1,'Hitzeschutzhandschuhe nicht am Arbeitsplatz','Handschuhe an jeder Linie; Unterweisung aller Schichten');
  safety('c-nova','plant-n','z-n-lager',null,'unsafe_condition','warning','person','Regal im Lager beschädigt (Anfahrschaden)',6,'u-nova','open');
  run("UPDATE safety_events SET closed_by='u-nova' WHERE company_id='c-nova' AND closed_by IS NOT NULL");
}
// Demo RFID tags beside the QR labels (UHF EPC on the big machines, an NFC UID on the mould), so tickets can be raised
// and closed by tag as well as by QR. Repeatable: only demo machines without a tag get one.
function demoRfid() {
  for (const [eq,tag] of [['eq-a','E28011606000020840A1B204'],['eq-b','04A23B5C6D7E80'],['eq-a2','E28011606000020840A1B205'],['eq-n','E28011606000020840B2C311']])
    if (!one('SELECT 1 FROM equipment WHERE rfid_tag=?',tag)) run('UPDATE equipment SET rfid_tag=? WHERE id=? AND rfid_tag IS NULL',tag,eq);
}
if (one('SELECT 1 FROM companies LIMIT 1')) {
  demoRfid();
  if (seedVision()) console.log('Vision demo data added');
  if (seedTraceSuite()) console.log('Traceability suite demo data added');
  if (one("SELECT 1 FROM companies WHERE id='c-acme'")&&one("SELECT 1 FROM products WHERE id='pr-cap'")&&!one('SELECT 1 FROM zones LIMIT 1')) { transaction(()=>{ seedOperations(); }); console.log('Added traceability, safety and asset-tracking demo data'); }
  else console.log('Seed already present');
  if (isMain) { await db.close(); process.exit(0); }
} else {
transaction(()=>{
  for (const [code,name] of [['US-MW','United States – Midwest'],['DE-NW','Germany – North-West'],['IN-S','India – South']]) run('INSERT OR IGNORE INTO service_areas (code,name,created_at) VALUES (?,?,?)',code,name,stamp);
  company('c-acme','Acme Plastics','USD','America/Chicago','en','US','Sam Acme','acme@demo.test','+1 312 555 0100'); company('c-nova','Nova Polymers','EUR','Europe/Berlin','de','DE','Nora Nova','nova@demo.test','+49 221 555 0100');
  provider('p-atlas','Atlas Field Service',['US-MW'],['injection','mould','auxiliary'],'US','Avery Atlas','atlas-admin@demo.test','+1 312 555 0200','ISO 9001; OEM-certified Arburg service');
  provider('p-euro','EuroTech Service',['DE-NW'],['blow','extrusion','auxiliary'],'DE','Emil Euro','euro@demo.test','+49 221 555 0200','ISO 9001');
  user('u-admin','Platform Admin','admin@demo.test','platform_admin'); user('u-dispatch','Maya Dispatch','dispatch@demo.test','dispatcher',null,null,[],[],'+1 312 555 0300','Service dispatcher');
  user('u-engineer','Alex Engineer','engineer@demo.test','engineer',null,null,['US-MW'],['injection','mould'],'+1 312 555 0301','Field service engineer');
  user('u-acme','Sam Acme','acme@demo.test','customer_admin','c-acme',null,[],[],'+1 312 555 0100','Maintenance manager'); user('u-acme-maint','Lee Maintenance','maint@demo.test','maintenance','c-acme',null,[],[],'','Maintenance technician');
  user('u-nova','Nora Nova','nova@demo.test','customer_admin','c-nova',null,[],[],'+49 221 555 0100','Leiterin Instandhaltung');
  user('u-atlas-admin','Avery Atlas','atlas-admin@demo.test','provider_admin',null,'p-atlas',['US-MW'],['injection','mould'],'+1 312 555 0200','Service manager');
  user('u-atlas','Ari Atlas','atlas@demo.test','provider_engineer',null,'p-atlas',['US-MW'],['injection','mould'],'+1 312 555 0201','Service engineer');
  user('u-euro','Emil Euro','euro@demo.test','provider_engineer',null,'p-euro',['DE-NW'],['blow','extrusion'],'+49 221 555 0201','Servicetechniker');
  run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at,operating_pattern) VALUES (?,?,?,?,?,?,?,?,?)','plant-a','c-acme','Chicago Plant','1200 Industrial Way, Chicago, IL','US','US-MW','America/Chicago',stamp,'24x5');
  run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at,operating_pattern) VALUES (?,?,?,?,?,?,?,?,?)','plant-n','c-nova','Cologne Plant','Werkstrasse 8, 50667 Köln','DE','DE-NW','Europe/Berlin',stamp,'24x7');
  equipment('eq-a','c-acme','plant-a','injection','Arburg','Allrounder 570','ARB-570-001','Bay 4','IMM-04','A',2019,{clampForceKn:2000,shotVolumeCm3:442,screwDiameterMm:50,driveType:'hydraulic',controller:'Selogica'});
  equipment('eq-b','c-acme','plant-a','mould','Husky','Hot Runner 24','HSK-2409','Tool Room','MLD-24','B',2021,{mouldNumber:'M-2409',cavities:24,hotRunner:'yes',hotRunnerZones:26,shotCount:1842000,pmIntervalShots:250000,steelGrade:'1.2343'});
  equipment('eq-n','c-nova','plant-n','extrusion','Coperion','ZSK 58','COP-58-811','Line 2','EXT-02','A',2017,{lineType:'compounding',screwConfig:'twin',screwDiameterMm:58,ldRatio:44,outputKgH:400});
  equipment('eq-c','c-acme','plant-a','auxiliary','Motan','Luxor CA 120','MOT-120-77','Bay 4 mezzanine','AUX-DRY-01','B',2019,{auxType:'dryer',capacity:'120 L hopper',linkedEquipmentId:'eq-a'});
  equipment('eq-a2','c-acme','plant-a','injection','Engel','e-mac 180','ENG-180-2214','Bay 5','IMM-05','A',2022,{clampForceKn:1800,shotVolumeCm3:301,screwDiameterMm:40,driveType:'electric',controller:'CC300'});
  equipment('eq-bm','c-acme','plant-a','blow','Kautex','KBS 2-20','KTX-220-0881','Blow hall','BM-01','B',2018,{process:'extrusion_blow',cavities:4,maxVolumeL:2,clampForceKn:200});
  equipment('eq-n2','c-nova','plant-n','extrusion','battenfeld-cincinnati','solEX NG 75','BC-75-4410','Line 3','EXT-03','A',2020,{lineType:'pipe',screwConfig:'single',screwDiameterMm:75,ldRatio:40,outputKgH:450});
  // Products with the ideal rates OEE performance is measured against (parts: 3600 ÷ cycle × cavities).
  const product=(id,company,pn,name,material,weight,unit,cycle,cav,rate,mould,machine)=>run('INSERT INTO products (id,company_id,part_number,name,material,part_weight_g,unit,ideal_cycle_s,cavities,ideal_rate_per_hour,mould_id,default_machine_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',id,company,pn,name,material,weight,unit,cycle,cav,rate,mould,machine,stamp);
  product('pr-cap','c-acme','CAP-28-PCO','28 mm PCO1881 closure','PP',2.1,'parts',4.8,24,3600/4.8*24,'eq-b','eq-a');
  product('pr-hsg','c-acme','HSG-180-A','Electronics housing','PC/ABS',38,'parts',32,2,3600/32*2,null,'eq-a2');
  product('pr-btl','c-acme','BTL-1L-HD','1 L HDPE bottle','HDPE',42,'parts',14,4,3600/14*4,null,'eq-bm');
  product('pr-cmp','c-nova','CMP-PPGF30','PP-GF30 compound','PP + 30 % glass fibre',null,'kg',null,1,400,null,'eq-n');
  product('pr-pipe','c-nova','PIPE-PE100-110','PE100 pipe 110 mm SDR11','PE100',null,'kg',null,1,450,null,'eq-n2');
  run('INSERT INTO contracts (id,company_id,title,starts_at,renews_at,commitments,exclusions,status,created_at,response_hours,contract_number,coverage_hours,restore_hours,visits_per_year,notice_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)','contract-a','c-acme','Annual care 2026','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z','4 preventive visits; 8-hour response','Consumables and tooling','active',stamp,8,'AMC-2026-001','8x5',48,4,60);
  run('INSERT INTO contract_equipment (contract_id,equipment_id) VALUES (?,?)','contract-a','eq-a');
  run('INSERT INTO visits (id,contract_id,company_id,equipment_id,due_at,status,notes) VALUES (?,?,?,?,?,?,?)','visit-a','contract-a','c-acme','eq-a','2026-11-15T14:00:00.000Z','scheduled','Quarterly inspection');
  run('INSERT INTO contracts (id,company_id,title,starts_at,renews_at,commitments,exclusions,status,created_at,response_hours,contract_number,coverage_hours,restore_hours,visits_per_year,notice_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)','contract-n','c-nova','Wartungsvertrag Linie 2','2025-12-01T00:00:00.000Z','2026-12-01T00:00:00.000Z','2 inspections per year; 4-hour response','Screw and barrel wear parts','active',stamp,4,'WV-2025-017','24x7',24,2,90);
  run('INSERT INTO contract_equipment (contract_id,equipment_id) VALUES (?,?)','contract-n','eq-n');
  run('INSERT INTO visits (id,contract_id,company_id,equipment_id,due_at,status,notes) VALUES (?,?,?,?,?,?,?)','visit-n','contract-n','c-nova','eq-n','2026-10-20T07:00:00.000Z','scheduled','Half-year inspection');
  ticket({id:'ticket-a',company:'c-acme',plant:'plant-a',equipment:'eq-a',title:'Hydraulic pressure drops',priority:'high',symptoms:'Pressure falls after warm-up',codes:'E-204',impact:'Line stopped',status:'assigned',user:'u-engineer',by:'u-acme',created:stamp,downtime:120,category:'hydraulic',state:'stopped'});
  ticket({id:'ticket-n',company:'c-nova',plant:'plant-n',equipment:'eq-n',title:'Extruder temperature alarm',priority:'critical',symptoms:'Zone 3 overheats',codes:'T-302',impact:'Reduced output',status:'assigned',provider:'p-euro',by:'u-nova',created:stamp,downtime:45,category:'heating',state:'reduced_output'});
  // History: an earlier, completed occurrence of the same fault on eq-a, so repeat faults, MTTR and downtime have data.
  ticket({id:'ticket-a-old',company:'c-acme',plant:'plant-a',equipment:'eq-a',title:'Hydraulic pressure low at start-up',priority:'medium',symptoms:'Pressure slow to build',codes:'E-204',impact:'Delayed start',status:'completed',user:'u-engineer',by:'u-acme-maint',created:daysAgo(20),occurred:daysAgo(20.05),response:daysAgo(19.9),completed:daysAgo(19.7),downtime:180,category:'hydraulic',state:'stopped',mode:'low_output',cause:'wear_and_ageing',action:'replace'});
  run('INSERT INTO work_logs (id,ticket_id,user_id,description,minutes,parts_used,created_at) VALUES (?,?,?,?,?,?,?)','wl-old','ticket-a-old','u-engineer','Replaced worn pressure relief valve seal; pressure stable at setpoint',150,'Relief valve seal kit',daysAgo(19.7));
  run("INSERT INTO signoffs (ticket_id,customer_user_id,signer_name,signed_at,method) VALUES (?,?,?,?,'portal')",'ticket-a-old','u-acme-maint','Lee Maintenance',daysAgo(19.6));
  for (const [type,detail,at] of [['assigned','Assigned to Alex Engineer',daysAgo(20)],['accepted','',daysAgo(19.9)],['completed','Seal replaced',daysAgo(19.7)]]) event('ticket-a-old','u-dispatch',type,detail,at);
  event('ticket-a','u-dispatch','assigned','Assigned to Alex Engineer'); event('ticket-n','u-dispatch','assigned','Assigned to EuroTech Service');
  run('INSERT INTO parts_requests (id,company_id,ticket_id,item,quantity,status,created_at,updated_at,part_number,unit,urgency,manufacturer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)','part-a','c-acme','ticket-a','Pressure relief valve assembly',1,'quoted',stamp,stamp,'ARB-PRV-570-02','pcs','breakdown','Arburg');
  run('INSERT INTO quotations (id,request_id,company_id,amount_minor,currency,lead_days,status,created_at,valid_until) VALUES (?,?,?,?,?,?,?,?,?)','quote-a','part-a','c-acme',48500,'USD',3,'pending',stamp,new Date(Date.now()+30*86400000).toISOString().slice(0,10)+'T00:00:00.000Z');
  // Condition monitoring: recommended limits on every production machine; energy prices for cost reporting.
  for (const eq of ['eq-a','eq-a2','eq-bm','eq-n','eq-n2']) { const m=one('SELECT company_id,machine_type FROM equipment WHERE id=?',eq); for (const p of parametersFor(m.machine_type)) run('INSERT INTO sensor_limits (id,company_id,equipment_id,parameter,warn_low,warn_high,crit_low,crit_high,auto_ticket,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?)',id(),m.company_id,eq,p.key,p.limits.warnLow??null,p.limits.warnHigh??null,p.limits.critLow??null,p.limits.critHigh??null,stamp); }
  run("UPDATE companies SET energy_price_per_kwh=0.12 WHERE id='c-acme'"); run("UPDATE companies SET energy_price_per_kwh=0.21 WHERE id='c-nova'");
  run('INSERT INTO device_mappings (id,external_device_id,company_id,equipment_id,created_at) VALUES (?,?,?,?,?)','map-a','demo-device-a','c-acme','eq-a',stamp);
  run('INSERT INTO device_mappings (id,external_device_id,company_id,equipment_id,created_at) VALUES (?,?,?,?,?)','map-n','demo-device-n','c-nova','eq-n',stamp);
  seedOperations(); demoRfid(); seedVision(); seedTraceSuite(true);
});
console.log('Seeded two customers, two providers, equipment, contracts, tickets and history. Password: DemoPass123!');
}
if (isMain) await db.close();
