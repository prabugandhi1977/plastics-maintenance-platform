import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Editing master data after it was added: contracts (title, period, covered machines, terms), visits (reschedule,
// cancel), users (details) and IoT device mappings (remap, stale time) – with the rules that protect scheduled work.
const dir=mkdtempSync(join(tmpdir(),'mouldcare-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one }=await import('../common/db.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token) { const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)}); return {status:r.status,data:await r.json()}; }
async function login(email) { const r=await call('/auth/login','POST',{email,password:'DemoPass123!'}); assert.equal(r.status,200); return r.data.token; }
const tokens={};
const contract=async(token=tokens.acme)=>(await call('/contracts','GET',null,token)).data.find(c=>c.id==='contract-a');

test('sign in',async()=>{ for (const [k,e] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',nova:'nova@demo.test'})) tokens[k]=await login(e); });

test('contract: title, start date, covered machines and terms can be edited',async()=>{
  const r=await call('/contracts/contract-a','PATCH',{title:'Annual care 2026 (extended)',startsAt:'2026-02-01',equipmentIds:['eq-a','eq-b'],commitments:'5 preventive visits',exclusions:'Wear parts'},tokens.acme);
  assert.equal(r.status,200);
  const c=await contract();
  assert.equal(c.title,'Annual care 2026 (extended)'); assert.equal(c.starts_at.slice(0,10),'2026-02-01');
  assert.deepEqual(c.equipmentIds.sort(),['eq-a','eq-b']); assert.equal(c.commitments,'5 preventive visits'); assert.equal(c.exclusions,'Wear parts');
  assert.ok(await one("SELECT 1 FROM audit_events WHERE action='contract.update' AND entity_id='contract-a'"));
});

test('contract: edits that would strand scheduled visits or cross companies are refused',async()=>{
  // visit-a is scheduled on eq-a on 2026-11-15
  assert.match((await call('/contracts/contract-a','PATCH',{equipmentIds:['eq-b']},tokens.acme)).data.error,/scheduled visits/);
  assert.match((await call('/contracts/contract-a','PATCH',{startsAt:'2026-12-01'},tokens.acme)).data.error,/before the new start date/);
  assert.match((await call('/contracts/contract-a','PATCH',{renewsAt:'2026-11-01'},tokens.acme)).data.error,/after the new renewal date/);
  assert.match((await call('/contracts/contract-a','PATCH',{startsAt:'2027-02-01'},tokens.acme)).data.error,/Renewal must be after start/);
  assert.equal((await call('/contracts/contract-a','PATCH',{equipmentIds:['eq-a','eq-n']},tokens.acme)).status,400);
  assert.equal((await call('/contracts/contract-a','PATCH',{equipmentIds:[]},tokens.acme)).status,400);
  assert.equal((await call('/contracts/contract-a','PATCH',{title:''},tokens.acme)).status,400);
  assert.equal((await call('/contracts/contract-a','PATCH',{title:'Taken over'},tokens.nova)).status,403);
  const c=await contract(); assert.deepEqual(c.equipmentIds.sort(),['eq-a','eq-b']); assert.equal(c.title,'Annual care 2026 (extended)');
});

test('visit: reschedule within the contract period, edit scope, cancel',async()=>{
  const moved=await call('/visits/visit-a','PATCH',{dueAt:'2026-12-01T09:30',notes:'Quarterly inspection + hot runner check'},tokens.acme);
  assert.equal(moved.status,200); assert.equal(moved.data.status,'scheduled'); assert.equal(moved.data.notes,'Quarterly inspection + hot runner check');
  assert.ok(moved.data.due_at.startsWith('2026-12-01T'),moved.data.due_at); assert.notEqual(moved.data.due_at,'2026-11-15T14:00:00.000Z');
  assert.match((await call('/visits/visit-a','PATCH',{dueAt:'2027-03-01T09:00'},tokens.acme)).data.error,/within the contract period/);
  assert.equal((await call('/visits/visit-a','PATCH',{dueAt:'2026-12-02T09:00'},tokens.nova)).status,403);
  assert.equal((await call('/visits/visit-a','PATCH',{status:'cancelled'},tokens.acme)).data.status,'cancelled');
  assert.match((await call('/visits/visit-a','PATCH',{dueAt:'2026-12-03T09:00'},tokens.acme)).data.error,/Only a scheduled visit/);
  // With its only scheduled visit cancelled, eq-a can now leave the contract.
  assert.equal((await call('/contracts/contract-a','PATCH',{equipmentIds:['eq-b']},tokens.acme)).status,200);
});

test('user: details can be edited by those who manage the account',async()=>{
  const r=await call('/users/u-acme-maint','PATCH',{name:'Lee Maintenance-Kim',jobTitle:'Senior technician',phone:'+1 312 555 0111'},tokens.acme);
  assert.equal(r.status,200);
  const u=await one('SELECT name,job_title,phone,role,email FROM users WHERE id=?', 'u-acme-maint');
  assert.deepEqual({...u},{name:'Lee Maintenance-Kim',job_title:'Senior technician',phone:'+1 312 555 0111',role:'maintenance',email:'maint@demo.test'});
  assert.equal((await call('/users/u-acme-maint','PATCH',{name:'Hijacked'},tokens.nova)).status,403);
  assert.equal((await call('/users/u-acme-maint','PATCH',{serviceAreas:['US-MW']},tokens.acme)).status,400);
  const eng=await call('/users/u-engineer','PATCH',{name:'Alex Engineer',serviceAreas:['US-MW'],skills:['injection','mould','blow']},tokens.admin);
  assert.equal(eng.status,200); assert.deepEqual(JSON.parse((await one('SELECT skills FROM users WHERE id=?', 'u-engineer')).skills),['injection','mould','blow']);
});

test('device mapping: move to another machine of the same company and change stale time',async()=>{
  const r=await call('/devices/map-a','PATCH',{equipmentId:'eq-b',staleAfterMinutes:45},tokens.acme);
  assert.equal(r.status,200);
  assert.deepEqual({...await one('SELECT equipment_id,stale_after_minutes FROM device_mappings WHERE id=?', 'map-a')},{equipment_id:'eq-b',stale_after_minutes:45});
  assert.match((await call('/devices/map-a','PATCH',{equipmentId:'eq-n'},tokens.acme)).data.error,/same company/);
  assert.equal((await call('/devices/map-a','PATCH',{staleAfterMinutes:10},tokens.nova)).status,403);
});

test('equipment: a wrong machine type can be corrected, with parameters for the new type',async()=>{
  const { SPECS }=await import('./fixtures.js');
  assert.match((await call('/equipment/eq-bm','PATCH',{machineType:'injection'},tokens.acme)).data.error,/technical parameters for the new machine type/);
  assert.equal((await call('/equipment/eq-bm','PATCH',{machineType:'injection',specs:SPECS.blow},tokens.acme)).status,400);
  const r=await call('/equipment/eq-bm','PATCH',{machineType:'injection',specs:SPECS.injection},tokens.acme);
  assert.equal(r.status,200);
  assert.deepEqual({...await one('SELECT machine_type,specs FROM equipment WHERE id=?', 'eq-bm')},{machine_type:'injection',specs:JSON.stringify({...SPECS.injection})});
  // eq-c (a chiller) serves eq-a, so eq-a cannot become a mould or auxiliary unit
  assert.match((await call('/equipment/eq-a','PATCH',{machineType:'mould',specs:SPECS.mould},tokens.acme)).data.error,/serves this machine/);
  assert.equal((await one('SELECT machine_type FROM equipment WHERE id=?', 'eq-a')).machine_type,'injection');
  assert.equal((await call('/equipment/eq-bm','PATCH',{machineType:'blow',specs:SPECS.blow},tokens.nova)).status,403);
});

test('asset tracking: a replaced tag or reader gets its new ID, duplicates are refused',async()=>{
  const z1=await call('/zones','POST',{plantId:'plant-a',name:'Tool room',kind:'storage',readerId:'GW-EDIT-1'},tokens.acme);
  const z2=await call('/zones','POST',{plantId:'plant-a',name:'Dock 2',kind:'storage',readerId:'GW-EDIT-2'},tokens.acme);
  assert.equal(z1.status,201,JSON.stringify(z1.data)); assert.equal(z2.status,201);
  assert.equal((await call(`/zones/${z1.data.id}`,'PATCH',{readerId:'GW-EDIT-1B'},tokens.acme)).data.reader_id,'GW-EDIT-1B');
  assert.match((await call(`/zones/${z1.data.id}`,'PATCH',{readerId:'GW-EDIT-2'},tokens.acme)).data.error,/already covers another zone/);
  const body={plantId:'plant-a',name:'Mould trolley 7',kind:'trolley',tagType:'ble',missingAfterHours:24};
  const a1=await call('/assets','POST',{...body,tagId:'BLE-EDIT-1'},tokens.acme), a2=await call('/assets','POST',{...body,name:'Mould trolley 8',tagId:'BLE-EDIT-2'},tokens.acme);
  assert.equal(a1.status,201,JSON.stringify(a1.data)); assert.equal(a2.status,201);
  const moved=await call(`/assets/${a1.data.id}`,'PATCH',{tagId:'BLE-EDIT-1B'},tokens.acme);
  assert.equal(moved.status,200); assert.equal((await one('SELECT tag_id FROM tracked_assets WHERE id=?', a1.data.id)).tag_id,'BLE-EDIT-1B');
  assert.match((await call(`/assets/${a1.data.id}`,'PATCH',{tagId:'BLE-EDIT-2'},tokens.acme)).data.error,/already on another asset/);
  assert.equal((await call(`/assets/${a1.data.id}`,'PATCH',{tagId:'BLE-X'},tokens.nova)).status,403);
});
