import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-tariff-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.EMAIL_PROVIDER;
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const { tariffBody, slotWindows, maxDemand, pfAdjustmentPct, checkEnergyAlerts }=await import('../services/factory/tariff.js');
const { companyBody, plantBody, equipmentBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;

// An Indian plant (Asia/Kolkata, UTC+5:30) with two machines, set up by the platform admin.
const company=(await call('/companies','POST',companyBody(),tokens.admin)).data;
const pune=(await call('/plants','POST',plantBody(company.id),tokens.admin)).data;
const [m1,m2]=[(await call('/equipment','POST',equipmentBody(pune.id,'injection'),tokens.admin)).data,(await call('/equipment','POST',equipmentBody(pune.id,'injection'),tokens.admin)).data];
const ins=async (e,start,minutes,kwh,{kva=null,kvar=null,pf=null}={})=>await run('INSERT INTO energy_readings (equipment_id,period_start,period_minutes,kwh,peak_kw,kva,kvar,pf,company_id,source) VALUES (?,?,?,?,NULL,?,?,?,?,?)',e.id,start,minutes,kwh,kva,kvar,pf,e.company_id,'test');
const SLOTS=[{band:'off_peak',start:'22:00',end:'06:00',rate:5},{band:'normal',start:'06:00',end:'18:00',rate:7},{band:'peak',start:'18:00',end:'22:00',rate:9}];
const TARIFF={slots:SLOTS,contractDemandKva:200,demandChargePerKva:300,billingDemandPct:80,demandIntervalMinutes:15,pfTarget:0.95,pfPenaltyPct:1,pfIncentivePct:0.5};

test('slots: all 24 hours exactly once; gaps and overlaps are refused',async()=>{
  assert.equal(tariffBody(TARIFF).slots.length,3);
  assert.throws(()=>tariffBody({...TARIFF,slots:[SLOTS[0],SLOTS[1],{...SLOTS[2],end:'21:00'}]}),/No slot covers 21:00–22:00/);
  assert.throws(()=>tariffBody({...TARIFF,slots:[SLOTS[0],{...SLOTS[1],end:'19:00'},SLOTS[2]]}),/overlaps another slot at 18:00/);
  assert.throws(()=>tariffBody({...TARIFF,slots:[{band:'normal',start:'00:00',end:'12:00',rate:7}]}),/No slot covers 12:00–24:00/);
  assert.equal(tariffBody({...TARIFF,slots:[{band:'normal',start:'06:00',end:'05:30',rate:7},{band:'off_peak',start:'05:30',end:'06:00',rate:5}]}).slots.length,2,'a slot may run past midnight');
  assert.throws(()=>tariffBody({...TARIFF,demandIntervalMinutes:20}),/15 or 30/);
  assert.throws(()=>tariffBody({...TARIFF,slots:[{...SLOTS[0],band:'shoulder'},SLOTS[1],SLOTS[2]]}),/band must be one of/);
  const r=await call(`/plants/${pune.id}/energy-tariff`,'PUT',{...TARIFF,slots:[SLOTS[0],SLOTS[1]]},tokens.admin);
  assert.equal(r.status,400); assert.match(r.data.error,/No slot covers 18:00–22:00/);
  const saved=await call(`/plants/${pune.id}/energy-tariff`,'PUT',TARIFF,tokens.admin);
  assert.equal(saved.status,200); assert.deepEqual([saved.data.currency,saved.data.billingDemandPct,saved.data.slots[0].band],['INR',80,'off_peak']);
});

test('cost by slot in the plant time zone, across midnight',async()=>{
  // 22:00 IST is 16:30 UTC. A slot crossing local midnight is one window.
  const w=slotWindows(tariffBody(TARIFF),'Asia/Kolkata',Date.parse('2026-09-01T12:00:00Z'),Date.parse('2026-09-02T02:00:00Z'));
  assert.deepEqual(w.map(x=>[x.slot,new Date(x.start).toISOString()]),[[1,'2026-09-01T00:30:00.000Z'],[2,'2026-09-01T12:30:00.000Z'],[0,'2026-09-01T16:30:00.000Z'],[1,'2026-09-02T00:30:00.000Z']]);
  assert.equal(new Date(w[2].end).toISOString(),'2026-09-02T00:30:00.000Z');
  await ins(m1,'2026-09-01T16:00:00.000Z',60,10); // 21:30–22:30 IST: half peak (9), half off-peak (5) = 70
  await ins(m1,'2026-09-01T18:00:00.000Z',60,10); // 23:30–00:30 IST, across local midnight: off-peak = 50
  await ins(m2,'2026-09-01T06:00:00.000Z',60,4);  // 11:30 IST: normal = 28
  const r=(await call(`/factory/energy?plantId=${pune.id}&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z`,'GET',null,tokens.admin)).data;
  assert.equal(r.pricing,'tod'); assert.deepEqual(r.slots.map(s=>[s.band,s.kwh,s.cost]),[['off_peak',15,75],['normal',4,28],['peak',5,45]]);
  assert.equal(r.total.cost,148); assert.equal(r.total.currency,'INR'); assert.equal(r.machines.find(m=>m.equipmentId===m1.id).cost,120);
});

test('maximum demand: highest average kVA over the demand interval',()=>{
  const at=(e,start,minutes,kwh,x={})=>({equipment_id:e,period_start:start,period_minutes:minutes,kwh,kva:null,kvar:null,pf:null,...x});
  const rows=[at('a','2026-09-02T04:00:00.000Z',15,20,{kva:100}),  // measured kVA: 25 kVAh
    at('b','2026-09-02T04:00:00.000Z',15,10,{pf:0.8}),             // from kW and PF: 12.5 kVAh
    at('a','2026-09-02T04:15:00.000Z',30,30,{kvar:80})];           // 60 kW with 80 kvar = 100 kVA, spread over two intervals
  const from=Date.parse('2026-09-02T00:00:00Z'), to=Date.parse('2026-09-03T00:00:00Z');
  assert.deepEqual(maxDemand(rows,15,from,to),{kva:150,at:'2026-09-02T04:00:00.000Z'});
  assert.deepEqual(maxDemand(rows,30,from,to),{kva:125,at:'2026-09-02T04:00:00.000Z'},'30-minute interval averages the peak away');
  assert.equal(maxDemand([at('a','2026-09-02T04:00:00.000Z',60,40)],15,from,to).kva,40,'no kVA, kvar or PF: unity power factor');
});

test('projected bill: demand floor, demand charge and PF adjustment',async()=>{
  await ins(m1,'2026-09-02T04:00:00.000Z',15,20,{kva:100}); await ins(m2,'2026-09-02T04:00:00.000Z',15,10,{pf:0.8}); await ins(m1,'2026-09-02T04:15:00.000Z',30,30,{kvar:80});
  const bill=async ()=>(await call(`/plants/${pune.id}/energy-bill?at=2026-09-02T06:00:00Z`,'GET',null,tokens.admin)).data;
  let b=await bill();
  assert.deepEqual([b.month,b.demand.monthKva,b.demand.todayKva,b.demand.floorKva,b.demand.billedKva,b.demand.billedOnFloor],['2026-09',150,150,160,160,true],'billed on 80 % of 200 kVA');
  assert.equal(b.bill.demand,48000);
  // Energy so far: 148 (Sept 1) + 20+10+30 kWh in the normal slot (09:30–10:15 IST) × 7 = 568, projected over 30 days.
  assert.equal(b.toDate.energy,568);
  const near=(a,b,msg)=>assert.ok(Math.abs(a-b)<0.02,`${msg}: ${a} vs ${b}`);
  assert.equal(b.toDate.since,'2026-09-01T06:00:00.000Z','projected from the first reading of the month');
  near(b.bill.energy,568*30,'one day of data projected over the 30 days of September');
  // PF from measured readings only: 60 kWh ÷ 87.5 kVAh = 0.686 → 26 steps below 0.95 × 1 %.
  assert.deepEqual([b.pf.month,b.pf.coveragePct,b.pf.adjustmentPct],[0.686,50,26]);
  near(b.bill.pfAdjustment,b.bill.energy*0.26,'26 % of the energy charges'); near(b.bill.total,b.bill.energy+b.bill.demand+b.bill.pfAdjustment,'total');
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'PUT',{...TARIFF,billingDemandPct:50},tokens.admin)).status,200);
  b=await bill(); assert.deepEqual([b.demand.billedKva,b.demand.billedOnFloor,b.bill.demand],[150,false,45000],'maximum demand above the floor is billed');
  const t=tariffBody(TARIFF);
  assert.deepEqual([0.92,0.925,0.95,0.97,1,null].map(pf=>pfAdjustmentPct(t,pf)),[3,2,0,-1,-2.5,0],'penalty per full 0.01 below target, incentive above');
});

test('demand alert at 90 % (warning), 100 % (critical), resolved when demand drops; PF alert',async()=>{
  const key=`energy-demand:${pune.id}`, open=async k=>await one("SELECT * FROM alerts WHERE dedupe_key=? AND status<>'resolved'",k);
  await ins(m1,'2026-09-03T05:00:00.000Z',10,27.75,{kva:185}); // 185 kVA so far in the 05:00 interval
  await checkEnergyAlerts(Date.parse('2026-09-03T05:10:00Z'));
  let a=await open(key); assert.deepEqual([a.severity,a.module,a.plant_id],['warning','energy',pune.id]); assert.match(a.title,/185 kVA \(93 % of 200 kVA\)/);
  await checkEnergyAlerts(Date.parse('2026-09-03T05:11:00Z')); assert.equal((await all('SELECT 1 FROM alerts WHERE dedupe_key=?',key)).length,1,'one alert while it lasts');
  await ins(m2,'2026-09-03T05:10:00.000Z',5,17,{kva:230});    // the full interval now averages 200 kVA
  await checkEnergyAlerts(Date.parse('2026-09-03T05:16:00Z'));
  a=await open(key); assert.equal(a.severity,'critical'); assert.match(a.title,/over contract/);
  await ins(m1,'2026-09-03T05:30:00.000Z',15,22,{kva:100});
  await checkEnergyAlerts(Date.parse('2026-09-03T05:46:00Z'));
  assert.equal(await open(key),undefined); assert.equal((await one('SELECT status FROM alerts WHERE id=?',a.id)).status,'resolved');
  assert.ok(await open(`energy-pf:${pune.id}`),'month PF below target raises an alert');
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'PUT',{...TARIFF,pfTarget:0.6},tokens.admin)).status,200);
  await checkEnergyAlerts(Date.parse('2026-09-03T05:47:00Z')); assert.equal(await open(`energy-pf:${pune.id}`),undefined,'resolved once the PF meets the target');
});

test('without a tariff the flat price is used',async()=>{
  await run("INSERT INTO energy_readings VALUES ('eq-a2','2026-09-05T13:00:00.000Z',60,10,NULL,'c-acme','test')");
  const r=(await call('/factory/energy?equipmentId=eq-a2&from=2026-09-05T00:00:00Z&to=2026-09-06T00:00:00Z','GET',null,tokens.acme)).data;
  assert.deepEqual([r.pricing,r.slots,Math.round(r.total.cost*100)/100,r.total.currency],['flat',null,1.2,'USD']);
  assert.deepEqual((await call('/plants/plant-a/energy-bill','GET',null,tokens.acme)).data,{plantId:'plant-a',tariff:null});
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'DELETE',null,tokens.admin)).status,200);
  await run('UPDATE companies SET energy_price_per_kwh=6 WHERE id=?',company.id);
  const back=(await call(`/factory/energy?plantId=${pune.id}&from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z`,'GET',null,tokens.admin)).data;
  assert.deepEqual([back.pricing,back.slots,back.total.cost],['flat',null,144],'removing the tariff returns the plant to the flat price');
});

test('intake: kVA, kvar and PF accepted and checked',async()=>{
  const key={'x-integration-key':'test-integration-key'};
  const r=(await call('/integrations/factory/events','POST',{events:[{type:'energy',deviceId:'demo-device-a',periodStart:'2026-09-06T10:00:00Z',periodMinutes:15,kwh:11,kva:48,kvar:20,pf:0.92},{type:'energy',deviceId:'demo-device-a',periodStart:'2026-09-06T10:15:00Z',periodMinutes:15,kwh:11,pf:1.2},{type:'energy',deviceId:'demo-device-a',periodStart:'2026-09-06T10:30:00Z',periodMinutes:15,kwh:11,kva:-1}]},null,key)).data;
  assert.deepEqual(r.results.map(x=>x.status),['accepted','rejected','rejected']); assert.match(r.results[1].error,/pf must be/);
  assert.deepEqual({...await one("SELECT kva,kvar,pf FROM energy_readings WHERE equipment_id='eq-a' AND period_start='2026-09-06T10:00:00.000Z'")},{kva:48,kvar:20,pf:0.92});
});

test('access: own company only; customer admins and plant managers edit',async()=>{
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'PUT',TARIFF,tokens.admin)).status,200);
  for (const who of ['acme','nova','atlas']) {
    assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'GET',null,tokens[who])).status,403,`${who} cannot read another company's tariff`);
    assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'PUT',TARIFF,tokens[who])).status,403);
    assert.equal((await call(`/plants/${pune.id}/energy-bill`,'GET',null,tokens[who])).status,403);
  }
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'DELETE',null,tokens.nova)).status,403);
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'GET',null,tokens.dispatch)).status,200,'the platform team can read it');
  assert.equal((await call(`/plants/${pune.id}/energy-tariff`,'PUT',TARIFF,tokens.dispatch)).status,403);
  assert.equal((await call('/plants/plant-a/energy-tariff','PUT',TARIFF,tokens.maint)).status,403,'maintenance staff cannot set the tariff');
  assert.equal((await call('/plants/plant-a/energy-tariff','GET',null,tokens.maint)).status,200);
  await run("INSERT INTO users (id,company_id,name,email,password_hash,role,active,service_areas,skills,created_at) SELECT 'u-pm',company_id,'Pat Manager','pm@demo.test',password_hash,'plant_manager',1,'[]','[]',created_at FROM users WHERE id='u-acme'");
  const pm=(await call('/auth/login','POST',{email:'pm@demo.test',password:'DemoPass123!'})).data.token;
  assert.equal((await call('/plants/plant-a/energy-tariff','PUT',TARIFF,pm)).status,200);
  assert.equal((await call('/plants/plant-a/energy-tariff','PUT',TARIFF,tokens.acme)).status,200);
  assert.equal((await call('/plants/nope/energy-tariff','GET',null,tokens.acme)).status,404);
  assert.ok((await all("SELECT 1 FROM audit_events WHERE action='plant.energy_tariff'")).length>=2);
});
