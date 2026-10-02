import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-trace-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.EMAIL_PROVIDER;
await import('../seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../db.js');
const { simulateMachine, simulateAssets }=await import('../factory/simulator.js');
const { checkMissing }=await import('../factory/assets.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test',engineer:'engineer@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const key={'x-integration-key':'test-integration-key'}, ago=m=>new Date(Date.now()-m*60000).toISOString();
const intake=events=>call('/integrations/factory/events','POST',{events},null,key);
const capParams={meltTempC:230,mouldTempC:35,injectionPressureBar:950,holdPressureBar:520,cycleTimeS:4.9};

test('traceability: lots and batches are tenant-scoped; batch start validates mould, lots and process settings',async()=>{
  const lots=(await call('/trace/lots','GET',null,tokens.acme)).data;
  assert.ok(lots.length>=6&&lots.every(l=>l.company_id==='c-acme'));
  assert.ok((await call('/trace/lots','GET',null,tokens.nova)).data.every(l=>l.company_id==='c-nova'));
  assert.equal((await call('/trace/lots','GET',null,tokens.atlas)).status,403);
  assert.equal((await call('/trace/batches/b-cap1','GET',null,tokens.nova)).status,403);
  const body={productId:'pr-cap',equipmentId:'eq-a',mouldId:'eq-b',batchNumber:'b-cap-new-1',operatorName:'Test Operator',plannedQty:1000,lots:[{lotId:'lot-pp2',quantityKg:5}],processParams:capParams};
  assert.match((await call('/trace/batches','POST',body,tokens.acme)).data.error,/already has a running batch/);
  run("UPDATE batches SET status='completed',ended_at=? WHERE id='b-cap3'",new Date().toISOString());
  assert.match((await call('/trace/batches','POST',{...body,mouldId:undefined},tokens.acme)).data.error,/must record the mould/);
  assert.match((await call('/trace/batches','POST',{...body,processParams:{...capParams,cycleTimeS:undefined}},tokens.acme)).data.error,/Cycle time/i);
  assert.match((await call('/trace/batches','POST',{...body,lots:[{lotId:'lot-npp'}]},tokens.acme)).data.error,/unknown lot/);
  assert.match((await call('/trace/batches','POST',{...body,lots:[]},tokens.acme)).data.error,/at least one material lot/);
  const started=await call('/trace/batches','POST',body,tokens.maint);
  assert.equal(started.status,201); assert.equal(started.data.batch_number,'B-CAP-NEW-1'); assert.equal(started.data.process_params.cycleTimeS,4.9);
  assert.match((await call('/trace/batches','POST',body,tokens.acme)).data.error,/already exists/);
  const done=await call(`/trace/batches/${started.data.id}/complete`,'POST',{goodQty:900,scrapQty:12},tokens.maint);
  assert.deepEqual([done.data.status,done.data.good,done.data.scrap],['completed',900,12]);
  assert.equal((await call(`/trace/batches/${started.data.id}/status`,'POST',{status:'released'},tokens.maint)).status,403);
  assert.match((await call(`/trace/batches/${started.data.id}/status`,'POST',{status:'on_hold'},tokens.acme)).data.error,/reason/);
  assert.equal((await call(`/trace/batches/${started.data.id}/status`,'POST',{status:'released'},tokens.acme)).data.status,'released');
});

test('traceability: quarantining a lot holds exactly the batches that used it, then genealogy shows the context',async()=>{
  const before=(await call('/trace/lots/lot-hd1','GET',null,tokens.acme)).data;
  assert.deepEqual(before.batches.map(b=>b.batch_number).sort(),['B-BTL-2026-210','B-BTL-2026-211']);
  assert.equal((await call('/trace/lots/lot-hd1/quarantine','POST',{reason:'Black specks'},tokens.maint)).status,403);
  const q=(await call('/trace/lots/lot-hd1/quarantine','POST',{reason:'Black specks found by customer'},tokens.acme)).data;
  assert.equal(q.lot.status,'quarantined'); assert.deepEqual(q.affected.map(b=>b.previousStatus).sort(),['completed','released']);
  assert.equal(one("SELECT status FROM batches WHERE id='b-btl3'").status,'running','batch using only the other lot is untouched');
  assert.ok(one("SELECT 1 FROM alerts WHERE dedupe_key='lot-quarantine:lot-hd1' AND module='quality'"));
  assert.match((await call('/trace/batches/b-btl1/status','POST',{status:'released'},tokens.acme)).data.error,/still quarantined/);
  run("UPDATE batches SET status='completed',ended_at=? WHERE id='b-btl3'",new Date().toISOString());
  assert.match((await call('/trace/batches','POST',{productId:'pr-btl',equipmentId:'eq-bm',batchNumber:'X1',operatorName:'A',plannedQty:10,lots:[{lotId:'lot-hd1'}],processParams:{parisonTempC:195,blowPressureBar:7,cycleTimeS:14}},tokens.acme)).data.error,/quarantined and cannot be used/);
  await call('/trace/lots/lot-hd1/release','POST',{},tokens.acme);
  assert.equal((await call('/trace/batches/b-btl1/status','POST',{status:'released'},tokens.acme)).data.status,'released');
  simulateMachine(one("SELECT * FROM equipment WHERE id='eq-n'"));
  const g=(await call('/trace/batches/b-cmp2','GET',null,tokens.nova)).data;
  assert.deepEqual(g.lots.map(l=>l.lot_number),['GF-ECR-9081','PP-H-44120']);
  assert.ok(g.good>0&&g.vision.inspected>0&&typeof g.oee==='number'&&Array.isArray(g.downtime)&&Array.isArray(g.tickets));
  const found=(await call('/trace/search?q=44120','GET',null,tokens.nova)).data; assert.equal(found.lots[0].lot_number,'PP-H-44120');
  assert.equal((await call('/trace/search?q=44120','GET',null,tokens.acme)).data.lots.length,0);
});

test('vision quality: intake validates defects, rejects raise and clear alerts, report gives FPY and Pareto',async()=>{
  const slot=m=>new Date(Math.floor((Date.now()-m*60000)/900000)*900000).toISOString();
  const bad=await intake([{type:'vision',deviceId:'demo-device-a',periodStart:slot(60),periodMinutes:15,inspected:100,rejected:120},{type:'vision',deviceId:'demo-device-a',periodStart:slot(60),periodMinutes:15,inspected:100,rejected:2,defects:{ovality:2}}]);
  assert.match(bad.data.results[0].error,/cannot exceed/); assert.match(bad.data.results[1].error,/defect must be one of/);
  const r=await intake([{type:'vision',deviceId:'demo-device-a',station:'Cam X',periodStart:slot(45),periodMinutes:15,inspected:1000,rejected:50,defects:{short_shot:30,flash:20}}]);
  assert.equal(r.data.accepted,1);
  let alert=one("SELECT * FROM alerts WHERE dedupe_key='quality:eq-a:Cam X' AND status<>'resolved'"); assert.equal(alert.severity,'warning'); assert.match(alert.detail,/short shot/);
  await intake([{type:'vision',deviceId:'demo-device-a',station:'Cam X',periodStart:slot(30),periodMinutes:15,inspected:1000,rejected:90,defects:{short_shot:90}}]);
  assert.equal(one("SELECT severity FROM alerts WHERE id=?",alert.id).severity,'critical');
  assert.equal((await intake([{type:'vision',deviceId:'demo-device-a',station:'Cam X',periodStart:slot(30),periodMinutes:15,inspected:1000,rejected:90}])).data.duplicates,1);
  await intake([{type:'vision',deviceId:'demo-device-a',station:'Cam X',periodStart:slot(15),periodMinutes:15,inspected:1000,rejected:5,defects:{flash:5}}]);
  assert.equal(one("SELECT status FROM alerts WHERE id=?",alert.id).status,'resolved');
  const q=(await call('/factory/quality?equipmentId=eq-a','GET',null,tokens.acme)).data;
  assert.ok(q.total.inspected>=3000); assert.equal(q.pareto[0].defect,'short_shot'); assert.ok(q.total.fpy<100&&q.total.ppm>0); assert.ok(q.daily.length>=7);
  assert.equal((await call('/factory/quality','GET',null,tokens.atlas)).status,403);
});

test('safety: people report, devices detect (deduplicated), managers investigate and close; KPIs',async()=>{
  const report=await call('/safety/events','POST',{plantId:'plant-a',zoneId:'z-a-hall',eventType:'near_miss',description:'Pallet fell from rack edge'},tokens.maint);
  assert.equal(report.status,201); assert.equal(report.data.severity,'warning');
  assert.ok(one('SELECT 1 FROM alerts WHERE dedupe_key=?',`safety:${report.data.id}`));
  assert.match((await call('/safety/events','POST',{plantId:'plant-a',zoneId:'z-n-hall',eventType:'near_miss',description:'x'},tokens.acme)).data.error,/same plant/);
  assert.match((await call('/safety/events','POST',{plantId:'plant-a',eventType:'near_miss',description:'x',lostTime:true},tokens.acme)).data.error,/Only an injury/);
  assert.equal((await call('/safety/events','POST',{plantId:'plant-n',eventType:'near_miss',description:'x'},tokens.acme)).status,403);
  assert.equal((await call('/safety/events','POST',{plantId:'plant-a',eventType:'near_miss',description:'Hose across walkway'},tokens.engineer)).status,201,'engineer with open work at the plant can report');
  const at=ago(5), ev={type:'safety',readerId:'GW-ACME-01',eventType:'ppe_missing',source:'camera',at};
  const det=await intake([ev,ev,{type:'safety',deviceId:'demo-device-a',eventType:'guard_bypassed',source:'sensor',at},{type:'safety',readerId:'GW-ACME-01',eventType:'dancing',at}]);
  assert.deepEqual([det.data.accepted,det.data.duplicates,det.data.rejected],[2,1,1]);
  assert.equal(one("SELECT severity FROM safety_events WHERE event_type='guard_bypassed' AND equipment_id='eq-a' AND occurred_at=?",at).severity,'critical');
  assert.equal((await call(`/safety/events/${report.data.id}/close`,'POST',{rootCause:'x',correctiveAction:'y'},tokens.maint)).status,403);
  assert.match((await call(`/safety/events/${report.data.id}/close`,'POST',{rootCause:'Rack edge damaged'},tokens.acme)).data.error,/correctiveAction/);
  assert.equal((await call(`/safety/events/${report.data.id}/investigate`,'POST',{},tokens.acme)).data.status,'investigating');
  const closed=(await call(`/safety/events/${report.data.id}/close`,'POST',{rootCause:'Rack edge damaged',correctiveAction:'Rack repaired; pallet stops fitted'},tokens.acme)).data;
  assert.equal(closed.status,'closed'); assert.equal(one('SELECT status FROM alerts WHERE dedupe_key=?',`safety:${report.data.id}`).status,'resolved');
  const nova=(await call('/safety','GET',null,tokens.nova)).data;
  assert.ok(nova.daysSinceLostTime>=40&&nova.daysSinceLostTime<=42); assert.ok(nova.events.every(e=>e.company_id==='c-nova'));
  const acme=(await call('/safety','GET',null,tokens.acme)).data;
  assert.equal(acme.daysSinceLostTime,null); assert.ok(acme.nearMisses>=2&&acme.byType.length>=3);
});

test('asset tracking: sightings move assets, guarded assets outside alert, missing and battery alerts, history',async()=>{
  assert.equal((await call('/assets','GET',null,tokens.acme)).data.length,7);
  const t=ago(20), seen=await intake([{type:'sighting',tagId:'BLE-0001',readerId:'RFID-ACME-GATE',at:t,rssi:-70,batteryPct:10},{type:'sighting',tagId:'BLE-0001',readerId:'GW-NOVA-01',at:t},{type:'sighting',tagId:'NOPE',readerId:'GW-ACME-01',at:t}]);
  assert.equal(seen.data.accepted,1); assert.match(seen.data.results[1].error,/different companies/); assert.match(seen.data.results[2].error,/Unknown tagId/);
  const mould=(await call('/assets','GET',null,tokens.acme)).data.find(a=>a.id==='ta-mould');
  assert.deepEqual([mould.zone.name,mould.awayFromHome,mould.missing,mould.battery_pct],['Yard / gate',true,false,10]);
  assert.ok(one("SELECT 1 FROM alerts WHERE dedupe_key='asset-zone:ta-mould' AND status<>'resolved'"));
  assert.ok(one("SELECT 1 FROM alerts WHERE dedupe_key='asset-battery:ta-mould' AND status<>'resolved'"));
  await intake([{type:'sighting',tagId:'BLE-0001',readerId:'GW-ACME-01',at:ago(10),batteryPct:95},{type:'sighting',tagId:'BLE-0001',readerId:'RFID-ACME-GATE',at:ago(30)}]);
  assert.ok(!one("SELECT 1 FROM alerts WHERE dedupe_key IN ('asset-zone:ta-mould','asset-battery:ta-mould') AND status<>'resolved'"),'back in the hall with a new battery; the late older sighting does not move it back');
  assert.equal(one("SELECT last_zone_id FROM tracked_assets WHERE id='ta-mould'").last_zone_id,'z-a-hall');
  const h=(await call('/assets/ta-mould/history','GET',null,tokens.acme)).data; assert.deepEqual(h.stays.map(s=>s.zone),['Moulding hall','Yard / gate']);
  run("UPDATE tracked_assets SET last_seen_at=?,last_zone_id='z-a-tool' WHERE id='ta-torque'",ago(10*60));
  assert.ok(checkMissing()>=1); assert.ok(one("SELECT 1 FROM alerts WHERE dedupe_key='asset-missing:ta-torque' AND status<>'resolved'"));
  assert.equal(checkMissing(),0,'raised once');
  await intake([{type:'sighting',tagId:'BLE-0101',readerId:'GW-ACME-02',at:ago(1)}]);
  assert.equal(one("SELECT status FROM alerts WHERE dedupe_key='asset-missing:ta-torque' ORDER BY created_at DESC").status,'resolved');
  assert.equal((await call('/assets','POST',{plantId:'plant-a',name:'Gauge',kind:'gauge',tagType:'ble',tagId:'BLE-0101'},tokens.acme)).data.error,'Tag BLE-0101 is already on another asset');
  assert.equal((await call('/assets','POST',{plantId:'plant-a',name:'Gauge',kind:'gauge',tagType:'ble',tagId:'BLE-9'},tokens.maint)).status,403);
  const made=await call('/assets','POST',{plantId:'plant-a',name:'Caliper 150',kind:'gauge',tagType:'ble',tagId:'BLE-9',homeZoneId:'z-a-tool',missingAfterHours:8},tokens.acme);
  assert.equal(made.status,201); assert.equal(made.data.missing,true,'never seen yet');
  assert.match((await call('/assets','POST',{plantId:'plant-a',name:'X',kind:'gauge',tagType:'ble',tagId:'BLE-10',homeZoneId:'z-n-hall'},tokens.acme)).data.error,/same plant/);
  assert.match((await call('/zones','POST',{plantId:'plant-a',name:'Dup',kind:'storage',readerId:'GW-ACME-01'},tokens.acme)).data.error,/already covers/);
  assert.equal((await call('/zones','POST',{plantId:'plant-a',name:'Regrind room',kind:'restricted',readerId:'GW-ACME-09'},tokens.acme)).status,201);
  assert.ok((await call('/zones','GET',null,tokens.nova)).data.every(z=>z.company_id==='c-nova'));
});

test('simulator: camera results, safety detections and asset sightings are generated deterministically',()=>{
  run("DELETE FROM factory_cursors WHERE equipment_id='eq-a'");
  simulateMachine(one("SELECT * FROM equipment WHERE id='eq-a'"));
  const v=one("SELECT count(*) n,sum(inspected) i,sum(rejected) r FROM vision_results WHERE equipment_id='eq-a' AND station='Camera 1'");
  assert.ok(v.n>50&&v.r>0&&v.r<v.i*0.2);
  const counts=one("SELECT sum(scrap_qty) s FROM production_counts WHERE equipment_id='eq-a'").s; assert.equal(v.r,counts,'camera rejects equal counted scrap for discrete parts');
  const keys=new Set(all("SELECT defects FROM vision_results WHERE equipment_id='eq-a' AND station='Camera 1' AND rejected>0").flatMap(r=>Object.keys(JSON.parse(r.defects))));
  assert.ok(keys.size>=1&&keys.size<=3);
  for (const eq of ['eq-a2','eq-bm','eq-n2']) simulateMachine(one('SELECT * FROM equipment WHERE id=?',eq));
  const cam=one("SELECT count(*) n,sum(status='closed') c FROM safety_events WHERE source='camera'"); assert.ok(cam.n>=3&&cam.c>=1,JSON.stringify(cam));
  const n=simulateAssets(); assert.ok(n>500); assert.equal(simulateAssets(),0,'cursor prevents re-generation');
  assert.ok(all('SELECT * FROM tracked_assets').every(a=>a.last_seen_at));
});

test('safety reports queued offline by the field app are stored once when replayed',async()=>{
  const body={plantId:'plant-a',equipmentId:'eq-a',eventType:'unsafe_condition',description:'Oil on the floor under IMM-04',occurredAt:ago(90)}, hdr={'x-client-action-id':'0f6c1e2a-1b2c-4d3e-8f9a-0b1c2d3e4f5a'};
  const first=await call('/safety/events','POST',body,tokens.engineer,hdr), again=await call('/safety/events','POST',body,tokens.engineer,hdr);
  assert.equal(first.status,201); assert.equal(again.data.id,first.data.id);
  assert.equal(one("SELECT count(*) n FROM safety_events WHERE description='Oil on the floor under IMM-04'").n,1);
  assert.equal((await call('/safety/events','POST',{...body,plantId:'plant-n'},tokens.engineer)).status,403,'no work at that plant');
});
