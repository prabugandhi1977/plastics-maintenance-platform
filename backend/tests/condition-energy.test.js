import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-condition-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.EMAIL_PROVIDER;
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const { judge }=await import('../services/factory/condition.js');
const { simulateMachine }=await import('../services/factory/simulator.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const key={'x-integration-key':'test-integration-key'}, ago=m=>new Date(Date.now()-m*60000).toISOString();
const reading=(value,minutesAgo,parameter='hydraulic_oil_temp')=>call('/integrations/factory/events','POST',{events:[{type:'condition',deviceId:'demo-device-a',at:ago(minutesAgo),parameter,value}]},null,key);

test('limits: judged high and low; warning and critical bounds',()=>{
  const high={warn_high:55,crit_high:65}, low={warn_low:6,crit_low:5};
  assert.deepEqual([judge(50,high),judge(55,high),judge(64.9,high),judge(65,high)],['ok','warning','warning','critical']);
  assert.deepEqual([judge(7,low),judge(6,low),judge(5,low)],['ok','warning','critical']);
  assert.equal(judge(999,null),'ok');
});

test('limits API: parameters per machine type, validation, permissions',async()=>{
  const limits=(await call('/equipment/eq-a/limits','GET',null,tokens.acme)).data;
  assert.deepEqual(limits.map(l=>l.parameter),['hydraulic_oil_temp','pump_vibration','cooling_water_temp']);
  assert.deepEqual([limits[1].warnHigh,limits[1].critHigh,limits[1].configured],[4.5,7.1,true]);
  assert.match((await call('/equipment/eq-a/limits','PATCH',{limits:[{parameter:'hydraulic_oil_temp',warnHigh:60,critHigh:55}]},tokens.acme)).data.error,/critical high limit must be at or above/);
  assert.match((await call('/equipment/eq-a/limits','PATCH',{limits:[{parameter:'gearbox_oil_temp',warnHigh:70}]},tokens.acme)).data.error,/parameter must be one of/);
  assert.equal((await call('/equipment/eq-a/limits','PATCH',{limits:[]},tokens.maint)).status,403);
  assert.equal((await call('/equipment/eq-n/limits','GET',null,tokens.acme)).status,404);
  assert.equal((await call('/equipment/eq-n/limits','GET',null,tokens.atlas)).status,403);
  const saved=await call('/equipment/eq-bm/limits','PATCH',{limits:[{parameter:'air_pressure',warnLow:6.5,critLow:5.5,autoTicket:false},{parameter:'pump_vibration',warnHigh:null,critHigh:null}]},tokens.acme);
  assert.equal(saved.status,200);
  assert.deepEqual(all("SELECT parameter,warn_low,crit_low,auto_ticket FROM sensor_limits WHERE equipment_id='eq-bm'").map(r=>({...r})),[{parameter:'air_pressure',warn_low:6.5,crit_low:5.5,auto_ticket:0}],'a parameter without bounds is not monitored');
});

test('condition chain: warning alert, critical escalation with one automatic ticket, auto-resolve',async()=>{
  await reading(50,40);
  assert.equal(all("SELECT * FROM alerts WHERE dedupe_key='condition:eq-a:hydraulic_oil_temp'").length,0,'normal reading raises nothing');
  await reading(58,30); await reading(59,25);
  const open=()=>one("SELECT * FROM alerts WHERE dedupe_key='condition:eq-a:hydraulic_oil_temp' AND status<>'resolved'");
  assert.deepEqual([open().severity,all("SELECT 1 FROM alerts WHERE dedupe_key='condition:eq-a:hydraulic_oil_temp'").length],['warning',1]);
  assert.equal(open().ticket_id,null,'warnings do not raise tickets');
  await reading(67,20);
  const a=open();
  assert.equal(a.severity,'critical'); assert.match(a.title,/critical: 67 °C/);
  assert.ok(all('SELECT * FROM notification_outbox WHERE alert_id=?',a.id).length>0,'critical alert queued for email');
  const t=one('SELECT * FROM tickets WHERE id=?',a.ticket_id);
  assert.deepEqual([t.created_by,t.priority,t.failure_category,t.machine_state,t.status],['u-system','high','hydraulic','running','open']);
  await reading(68,15);
  assert.equal(all("SELECT 1 FROM tickets WHERE created_by='u-system'").length,1,'a continuing problem keeps one ticket');
  const health=(await call('/factory/condition','GET',null,tokens.acme)).data.find(m=>m.id==='eq-a');
  assert.equal(health.status,'critical'); assert.equal(health.parameters.find(p=>p.parameter==='hydraulic_oil_temp').value,68);
  assert.equal((await call('/factory/floor','GET',null,tokens.acme)).data.find(m=>m.id==='eq-a').health,'critical');
  await reading(48,5);
  assert.equal(one('SELECT status FROM alerts WHERE id=?',a.id).status,'resolved','alert clears when the reading is normal again');
  assert.equal(one('SELECT status FROM tickets WHERE id=?',t.id).status,'open','the repair ticket stays until the work is done');
  const ticketView=(await call(`/tickets/${t.id}`,'GET',null,tokens.acme)).data;
  assert.ok(ticketView.events.some(e=>e.event_type==='alert'&&/condition monitoring/.test(e.detail)));
});

test('critical without auto-ticket, stale data, trend and isolation',async()=>{
  await call('/integrations/factory/events','POST',{events:[{type:'condition',deviceId:'demo-device-a',at:ago(3),parameter:'pump_vibration',value:8}]},null,key);
  await call('/equipment/eq-a/limits','PATCH',{limits:[{parameter:'cooling_water_temp',warnHigh:22,critHigh:28,autoTicket:false}]},tokens.acme);
  await call('/integrations/factory/events','POST',{events:[{type:'condition',deviceId:'demo-device-a',at:ago(2),parameter:'cooling_water_temp',value:30}]},null,key);
  const a=one("SELECT * FROM alerts WHERE dedupe_key='condition:eq-a:cooling_water_temp' AND status<>'resolved'");
  assert.equal(a.severity,'critical'); assert.equal(a.ticket_id,null,'auto-ticket switched off for this limit');
  const h=(await call('/factory/condition','GET',null,tokens.acme)).data.find(m=>m.id==='eq-a');
  assert.equal(h.parameters.find(p=>p.parameter==='pump_vibration').status,'no_limit','limits replaced: vibration no longer monitored');
  const tr=(await call('/factory/condition/eq-a/trend?parameter=hydraulic_oil_temp&hours=24','GET',null,tokens.acme)).data;
  assert.equal(tr.points.length,6); assert.equal(tr.unit,'°C');
  assert.equal((await call('/factory/condition/eq-a/trend?parameter=hydraulic_oil_temp&hours=5','GET',null,tokens.acme)).status,400);
  assert.equal((await call('/factory/condition/eq-a/trend?parameter=hydraulic_oil_temp&hours=24','GET',null,tokens.nova)).status,404);
  assert.ok((await call('/factory/condition','GET',null,tokens.nova)).data.every(m=>m.companyId==='c-nova'));
  assert.equal((await call('/factory/condition','GET',null,tokens.atlas)).status,403);
  run("INSERT INTO condition_readings VALUES ('eq-a2','hydraulic_oil_temp',?,40,'c-acme','test')", ago(180));
  assert.equal((await call('/factory/condition','GET',null,tokens.acme)).data.find(m=>m.id==='eq-a2').parameters.find(p=>p.parameter==='hydraulic_oil_temp').status,'stale');
});

test('energy: kWh, kWh per kg, waste, CO2 and cost',async()=>{
  const ins=(t,kwh,peak)=>run("INSERT INTO energy_readings VALUES ('eq-a2',?,60,?,?,'c-acme','test')", t,kwh,peak);
  ins('2026-09-01T13:00:00.000Z',10,14); ins('2026-09-01T14:00:00.000Z',10,15); ins('2026-09-01T15:00:00.000Z',10,14); ins('2026-09-01T16:00:00.000Z',2,3);
  run("INSERT INTO machine_states (id,company_id,equipment_id,state,reason_code,started_at,ended_at,source) VALUES ('s1','c-acme','eq-a2','running',NULL,'2026-09-01T13:00:00.000Z','2026-09-01T16:00:00.000Z','test'),('s2','c-acme','eq-a2','idle','waiting_material','2026-09-01T16:00:00.000Z','2026-09-01T17:00:00.000Z','test')");
  for (const t of ['2026-09-01T13:00:00.000Z','2026-09-01T14:00:00.000Z']) run("INSERT INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,?,?,?,?,?,'test')", crypto.randomUUID(),'c-acme','eq-a2','pr-hsg',t,60,1000,10,'parts',225);
  const r=(await call('/factory/energy?equipmentId=eq-a2&from=2026-09-01T13:00:00Z&to=2026-09-01T17:00:00Z','GET',null,tokens.acme)).data.total;
  assert.equal(r.kwh,32); assert.equal(r.wasteKwh,2); assert.equal(r.kg,76); assert.equal(Math.round(r.secKwhPerKg*1000)/1000,0.421);
  assert.equal(Math.round(r.co2Kg*100)/100,11.84,'US grid factor 0.37 kg/kWh'); assert.equal(Math.round(r.cost*100)/100,3.84); assert.equal(r.currency,'USD'); assert.equal(r.peakKw,15);
  assert.equal((await call('/companies/c-acme','PATCH',{gridCo2KgPerKwh:0.2},tokens.acme)).status,200);
  assert.equal(Math.round((await call('/factory/energy?equipmentId=eq-a2&from=2026-09-01T13:00:00Z&to=2026-09-01T17:00:00Z','GET',null,tokens.acme)).data.total.co2Kg*10)/10,6.4,'supplier factor overrides the national average');
  assert.equal((await call('/companies/c-acme','PATCH',{energyPricePerKwh:-1},tokens.acme)).status,400);
  const intake=(await call('/integrations/factory/events','POST',{events:[{type:'energy',deviceId:'demo-device-a',periodStart:'2026-09-02T10:00:00Z',periodMinutes:15,kwh:11,peakKw:50},{type:'energy',deviceId:'demo-device-a',periodStart:'2026-09-02T10:00:00Z',periodMinutes:15,kwh:11},{type:'energy',deviceId:'demo-device-a',periodStart:'2026-09-02T10:15:00Z',periodMinutes:15,kwh:-3}]},null,key)).data;
  assert.deepEqual(intake.results.map(x=>x.status),['accepted','duplicate','rejected']);
  assert.equal((await call('/factory/energy','GET',null,tokens.atlas)).status,403);
});

test('simulator produces energy and condition signals for every production machine',()=>{
  simulateMachine(one("SELECT * FROM equipment WHERE id='eq-n2'"),Date.parse('2026-09-10T12:00:00Z'));
  assert.equal(one("SELECT count(*) n FROM energy_readings WHERE equipment_id='eq-n2'").n,7*96);
  assert.deepEqual(all("SELECT DISTINCT parameter FROM condition_readings WHERE equipment_id='eq-n2' ORDER BY 1").map(r=>r.parameter),['cooling_water_temp','gearbox_oil_temp','melt_pressure','pump_vibration']);
  const kwh=one("SELECT sum(kwh) k FROM energy_readings WHERE equipment_id='eq-n2'").k;
  assert.ok(kwh>5000&&kwh<25000,`a 450 kg/h line uses roughly 100-130 kW when running: ${Math.round(kwh)} kWh in a week`);
  assert.equal(all("SELECT 1 FROM alerts WHERE equipment_id='eq-n2'").length,0,'backfilled history raises no alerts');
});
