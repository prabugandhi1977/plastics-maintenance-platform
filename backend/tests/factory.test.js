import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-factory-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.EMAIL_PROVIDER;
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const { simulateMachine }=await import('../services/factory/simulator.js');
const { shiftWindows }=await import('../services/factory/time.js');
const { ticketBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const insertState=async (eq,state,reason,start,end)=>await run("INSERT INTO machine_states (id,company_id,equipment_id,state,reason_code,started_at,ended_at,source) VALUES (?,?,?,?,?,?,?,'test')", crypto.randomUUID(),'c-acme',eq,state,reason,start,end);
const insertCount=async (eq,start,total,scrap,rate)=>await run("INSERT INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,?,?,?,?,?,'test')", crypto.randomUUID(),'c-acme',eq,'pr-hsg',start,60,total,scrap,'parts',rate);
const close=(a,b,msg)=>assert.ok(Math.abs(a-b)<0.15,`${msg}: ${a} vs ${b}`);

test('shifts: custom shifts replace the operating-pattern defaults; validation',async()=>{
  const plantA=await one("SELECT * FROM plants WHERE id='plant-a'");
  assert.equal((await shiftWindows(plantA,Date.parse('2026-09-05T12:00:00Z'),Date.parse('2026-09-06T12:00:00Z'))).length,0,'24x5 plant has no shifts at the weekend');
  assert.equal((await call('/plants/plant-a/shifts','PATCH',{shifts:[{name:'Day',start:'25:00',end:'16:00',days:[1]}]},tokens.acme)).status,400);
  assert.equal((await call('/plants/plant-a/shifts','PATCH',{shifts:[{name:'Day',start:'08:00',end:'16:00',days:[1,2,3,4,5,6,7]}]},tokens.nova)).status,403);
  assert.equal((await call('/plants/plant-a/shifts','PATCH',{shifts:[{name:'Day',start:'08:00',end:'16:00',days:[1,2,3,4,5,6,7]}]},tokens.maint)).status,403);
  const saved=await call('/plants/plant-a/shifts','PATCH',{shifts:[{name:'Day',start:'08:00',end:'16:00',days:[1,2,3,4,5,6,7]}]},tokens.acme);
  assert.equal(saved.status,200); assert.deepEqual(saved.data.map(s=>[s.name,s.start,s.end,s.custom]),[['Day','08:00','16:00',true]]);
});

test('OEE = availability × performance × quality, within planned shift time',async()=>{
  // Tuesday 1 Sep 2026, Chicago (CDT, UTC-5): shift 08:00-16:00 local = 13:00-21:00 UTC.
  await insertState('eq-a2','running',null,'2026-09-01T12:00:00.000Z','2026-09-01T17:00:00.000Z'); // 1 h of it is before the shift
  await insertState('eq-a2','down','breakdown','2026-09-01T17:00:00.000Z','2026-09-01T18:00:00.000Z');
  await insertState('eq-a2','planned_stop','break','2026-09-01T18:00:00.000Z','2026-09-01T18:30:00.000Z');
  await insertState('eq-a2','running',null,'2026-09-01T18:30:00.000Z','2026-09-01T22:00:00.000Z'); // 1 h after the shift
  await insertCount('eq-a2','2026-09-01T14:00:00.000Z',650,13,225); await insertCount('eq-a2','2026-09-01T19:00:00.000Z',650,13,225);
  await insertCount('eq-a2','2026-09-01T21:00:00.000Z',999,0,225); // outside the shift: ignored
  const r=(await call('/factory/oee?equipmentId=eq-a2&from=2026-09-01T05:00:00Z&to=2026-09-02T05:00:00Z','GET',null,tokens.acme)).data;
  const m=r.machines[0];
  assert.equal(m.plannedHours,7.5); assert.equal(m.runningHours,6.5);
  await close(m.availability,86.7,'availability'); await close(m.performance,88.9,'performance'); await close(m.quality,98,'quality'); await close(m.oee,75.5,'OEE');
  assert.equal(m.good,1274); assert.equal(m.scrap,26);
  assert.deepEqual(r.losses.map(l=>[l.state,l.reason,l.minutes]),[['down','breakdown',60],['planned_stop','break',30]]);
  assert.equal(r.daily.length,1); await close(r.daily[0].oee,75.5,'daily OEE');
  assert.equal((await call('/factory/oee?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z','GET',null,tokens.acme)).status,400);
});

test('factory data is tenant-scoped and closed to service providers',async()=>{
  const acme=(await call('/factory/floor','GET',null,tokens.acme)).data, nova=(await call('/factory/floor','GET',null,tokens.nova)).data;
  assert.deepEqual(acme.map(m=>m.assetTag).sort(),['BM-01','IMM-04','IMM-05']); assert.deepEqual(nova.map(m=>m.assetTag).sort(),['EXT-02','EXT-03']);
  assert.equal((await call('/factory/oee?equipmentId=eq-n','GET',null,tokens.acme)).data.machines.length,0);
  assert.equal((await call('/factory/floor','GET',null,tokens.atlas)).status,403);
  assert.equal((await call('/products','GET',null,tokens.atlas)).status,403);
  assert.ok((await call('/products','GET',null,tokens.nova)).data.every(p=>p.company_id==='c-nova'));
  assert.equal((await call('/factory/floor','GET',null,tokens.dispatch)).data.length,5);
});

test('products: ideal rate from cycle time and cavities; validation and ownership',async()=>{
  const body={companyId:'c-acme',partNumber:'lid-90',name:'Lid',material:'PP',unit:'parts',idealCycleS:6,cavities:8,mouldId:'eq-b',defaultMachineId:'eq-a2'};
  const p=await call('/products','POST',body,tokens.acme);
  assert.equal(p.status,201); assert.equal(p.data.part_number,'LID-90'); assert.equal(p.data.ideal_rate_per_hour,4800);
  assert.match((await call('/products','POST',body,tokens.acme)).data.error,/already exists/);
  assert.match((await call('/products','POST',{...body,partNumber:'X1',mouldId:'eq-a'},tokens.acme)).data.error,/must be a mould/);
  assert.match((await call('/products','POST',{...body,partNumber:'X2',defaultMachineId:'eq-n'},tokens.acme)).data.error,/same company/);
  assert.equal((await call('/products','POST',{...body,partNumber:'X3'},tokens.nova)).status,403);
  assert.equal((await call(`/products/${p.data.id}`,'PATCH',{idealCycleS:5},tokens.acme)).data.ideal_rate_per_hour,5760);
  const kg=await call('/products','POST',{companyId:'c-nova',partNumber:'PIPE-63',name:'Pipe 63',material:'PE100',unit:'kg',idealRatePerHour:300},tokens.nova);
  assert.equal(kg.data.ideal_rate_per_hour,300);
});

test('machine-data intake: states and counts through device mappings, stop alerts, idempotent counts',async()=>{
  const key={'x-integration-key':'test-integration-key'}, at=m=>new Date(Date.now()-m*60000).toISOString();
  assert.equal((await call('/integrations/factory/events','POST',{events:[]},null,key)).status,400);
  assert.equal((await call('/integrations/factory/events','POST',{events:[{type:'state',deviceId:'demo-device-a',at:at(5),state:'running'}]},null,{'x-integration-key':'wrong-key-value-000'})).status,401);
  const r=(await call('/integrations/factory/events','POST',{events:[
    {type:'state',deviceId:'demo-device-a',at:at(50),state:'running'},
    {type:'count',deviceId:'demo-device-a',periodStart:at(45),periodMinutes:15,totalQty:4300,scrapQty:40},
    {type:'count',deviceId:'demo-device-a',periodStart:at(45),periodMinutes:15,totalQty:4300,scrapQty:40},
    {type:'state',deviceId:'demo-device-a',at:at(30),state:'down',reason:'breakdown'},
    {type:'state',deviceId:'demo-device-a',at:at(29),state:'down',reason:'tea_break'},
    {type:'state',deviceId:'no-such-device',at:at(20),state:'running'},
    {type:'count',deviceId:'demo-device-a',periodStart:at(10),periodMinutes:15,totalQty:10,scrapQty:20}
  ]},null,key)).data;
  assert.deepEqual(r.results.map(x=>x.status),['accepted','accepted','duplicate','accepted','rejected','rejected','rejected']);
  assert.match(r.results[4].error,/reason must be one of/);
  const floor=(await call('/factory/floor','GET',null,tokens.acme)).data.find(m=>m.id==='eq-a');
  assert.deepEqual([floor.state,floor.reason,floor.openAlerts],['down','breakdown',1]);
  const alert=(await call('/alerts','GET',null,tokens.acme)).data.find(a=>a.equipment_id==='eq-a');
  assert.match(alert.title,/Machine stopped: breakdown/);
  assert.equal((await all("SELECT * FROM notification_outbox WHERE alert_id=?",alert.id)).length,0,'warnings are not emailed by default');
  assert.equal((await call('/alerts','GET',null,tokens.nova)).data.some(a=>a.id===alert.id),false);
  await call('/integrations/factory/events','POST',{events:[{type:'state',deviceId:'demo-device-a',at:at(5),state:'running'}]},null,key);
  assert.equal((await one('SELECT status FROM alerts WHERE id=?',alert.id)).status,'resolved','alert resolves itself when the machine runs again');
});

test('alerts: acknowledge, resolve, raise a ticket, email outbox for critical alerts',async()=>{
  const { raiseAlert }=await import('../services/factory/alerts.js');
  const keyId=await raiseAlert({companyId:'c-acme',plantId:'plant-a',module:'condition',severity:'critical',equipmentId:'eq-a',title:'Hydraulic oil overheating',detail:'72 °C (critical above 65 °C)',dedupeKey:'test-critical-1'});
  assert.equal(await raiseAlert({companyId:'c-acme',module:'condition',severity:'critical',title:'dup',dedupeKey:'test-critical-1'}),null,'one open alert per key');
  const mails=await all('SELECT recipient,status FROM notification_outbox WHERE alert_id=?',keyId);
  assert.deepEqual(mails.map(m=>m.recipient).sort(),['acme@demo.test','dispatch@demo.test','maint@demo.test']);
  assert.ok(mails.every(m=>m.status==='not_configured'));
  assert.deepEqual((await call('/alerts/summary','GET',null,tokens.acme)).data.critical,1);
  assert.equal((await call(`/alerts/${keyId}/acknowledge`,'POST',{},tokens.nova)).status,403);
  assert.equal((await call(`/alerts/${keyId}/acknowledge`,'POST',{},tokens.maint)).data.status,'acknowledged');
  assert.equal((await call(`/alerts/${keyId}/acknowledge`,'POST',{},tokens.maint)).status,400);
  const t=await call('/tickets','POST',ticketBody('eq-a',{title:'Hydraulic oil overheating',alertId:keyId}),tokens.acme);
  assert.equal(t.status,201); assert.equal((await one('SELECT ticket_id FROM alerts WHERE id=?',keyId)).ticket_id,t.data.id); assert.ok(t.data.events.some(e=>e.event_type==='alert'));
  assert.match((await call('/tickets','POST',ticketBody('eq-n',{alertId:keyId}),tokens.nova)).data.error,/Unknown alert/);
  assert.equal((await call(`/alerts/${keyId}/resolve`,'POST',{},tokens.acme)).data.status,'resolved');
  assert.equal((await call('/alerts/emails','GET',null,tokens.acme)).status,403);
  assert.ok((await call('/alerts/emails','GET',null,tokens.admin)).data.length>=3);
});

test('simulator: deterministic history through the ingest path; off unless enabled',async()=>{
  const until=Date.parse('2026-09-10T12:00:00Z');
  const slots=await simulateMachine(await one("SELECT * FROM equipment WHERE id='eq-bm'"),until);
  assert.equal(slots,7*96,'a week of 15-minute slots');
  assert.equal(await simulateMachine(await one("SELECT * FROM equipment WHERE id='eq-bm'"),until),0,'resumes from its cursor');
  const states=(await all("SELECT state,count(*) n FROM machine_states WHERE equipment_id='eq-bm' GROUP BY state")).map(s=>s.state);
  assert.ok(states.includes('running')&&states.includes('planned_stop'));
  const counts=await one("SELECT count(*) n,sum(total_qty) q FROM production_counts WHERE equipment_id='eq-bm'");
  assert.ok(counts.n>100&&counts.q>0);
  const oee=(await call('/factory/oee?equipmentId=eq-bm&from=2026-09-03T12:00:00Z&to=2026-09-10T12:00:00Z','GET',null,tokens.acme)).data.machines[0];
  assert.ok(oee.oee>30&&oee.oee<95,`plausible OEE ${oee.oee}`); assert.ok(oee.performance<=100);
  assert.equal((await call('/factory/simulator/run','POST',{},tokens.admin)).status,400,'simulator is off by default');
  assert.equal((await call('/factory/simulator/run','POST',{},tokens.acme)).status,403);
});
