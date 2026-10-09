import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-iot-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, run }=await import('../common/db.js');
const { normalizeRecord }=await import('../services/iot/contract.js');
const { runSync }=await import('../services/iot/sync.js');
const { createMockAdapter }=await import('../services/iot/adapters/mock.js');
const { ticketBody, closeOut, partBody, quoteBody, contractBody, companyBody, plantBody, equipmentBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}) {const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',engineer:'engineer@demo.test',acme:'acme@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test',euro:'euro@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const push=(records)=>call('/integrations/iot/records','POST',{records},null,{'x-integration-key':'test-integration-key'});
const ago=min=>new Date(Date.now()-min*60000).toISOString();

test('canonical contract validates timestamps, ranges, units and alarms',()=>{
  assert.match(normalizeRecord({deviceId:'d',observedAt:'2026-10-01T09:30:00',runningHours:1}).errors[0],/UTC offset/);
  assert.match(normalizeRecord({deviceId:'d',observedAt:new Date(Date.now()+60*60000).toISOString(),runningHours:1}).errors[0],/future/);
  assert.equal(normalizeRecord({deviceId:'d',observedAt:ago(1),temperatureF:212}).record.temperatureC,100);
  assert.match(normalizeRecord({deviceId:'d',observedAt:ago(1)}).errors[0],/no measurements/);
  assert.ok(normalizeRecord({deviceId:'d',observedAt:ago(1),cycleCount:1.5,temperatureC:900,alarms:[{code:'A',state:'on'}]}).errors.length===3);
  assert.deepEqual(normalizeRecord({deviceId:'d',observedAt:'2026-09-01T09:30:00+02:00',alarmCode:'X'}).record.alarms,[{code:'X',state:'active',severity:'warning',message:''}]);
});

test('mock adapter sync ingests, quarantines bad records, and is idempotent',async()=>{
  const first=await runSync(createMockAdapter({}));
  assert.equal(first.status,'succeeded'); assert.ok(first.accepted>50,`accepted ${first.accepted}`); assert.equal(first.rejected,2); assert.ok(first.cursor_after);
  const again=await runSync(createMockAdapter({}));
  assert.equal(again.status,'succeeded'); assert.equal(again.rejected,0); assert.equal(again.cursor_before,first.cursor_after);
  run('DELETE FROM integration_cursors');
  const replay=await runSync(createMockAdapter({}));
  assert.equal(replay.accepted,0); assert.ok(replay.duplicates>=first.accepted);
  const status=await call('/integrations/status','GET',null,tokens.admin);
  assert.equal(status.status,200); assert.equal(status.data.runs.length,3);
  assert.ok(status.data.rejections.some(r=>r.external_device_id==='demo-device-x'&&/Unknown deviceId/.test(r.reasons[0])));
  assert.ok(status.data.rejections.some(r=>/temperatureC/.test(r.reasons[0])));
  assert.equal((await call('/integrations/status','GET',null,tokens.acme)).status,403);
  assert.equal((await call('/integrations/sync','POST',{},tokens.dispatch)).status,403);
});

test('freshness per asset and per metric, with active alarms',async()=>{
  const a=(await call('/equipment/eq-a/readings','GET',null,tokens.acme)).data;
  assert.equal(a.status,'current'); assert.equal(a.metrics.cycleCount.status,'current'); assert.ok(a.history.length>0&&a.history.length<=100);
  const n=(await call('/equipment/eq-n/readings?limit=5','GET',null,tokens.nova)).data;
  assert.equal(n.status,'stale'); assert.ok(n.ageMinutes>=110); assert.equal(n.metrics.cycleCount.status,'missing'); assert.equal(n.history.length,5);
  assert.deepEqual(n.activeAlarms.map(x=>[x.code,x.severity]),[['T-302','critical']]);
  assert.equal((await call('/equipment/eq-b/readings','GET',null,tokens.acme)).data.status,'unmapped');
  const dash=(await call('/dashboard','GET',null,tokens.nova)).data.telemetry;
  assert.deepEqual([dash.stale,dash.activeAlarms],[1,1]);
  assert.equal((await call('/equipment/eq-a/readings?before=2026-10-01','GET',null,tokens.acme)).status,400);
});

test('push batch reports per-record outcomes, quality flags and alarm lifecycle',async()=>{
  const t0=ago(20),t1=ago(15),t2=ago(10);
  const batch=await push([{deviceId:'demo-device-a',observedAt:t0,cycleCount:10_000_000,alarms:[{code:'P-9',state:'active',severity:'critical'}]},{deviceId:'demo-device-a',observedAt:t0,cycleCount:10_000_000},{deviceId:'demo-device-a',observedAt:'2026-10-01T09:30:00',cycleCount:1}]);
  assert.equal(batch.status,200); assert.deepEqual([batch.data.accepted,batch.data.duplicates,batch.data.rejected],[1,1,1]);
  assert.ok(batch.data.results[0].flags.includes('out_of_order'));
  const next=await push([{deviceId:'demo-device-a',observedAt:t1,cycleCount:5,alarms:[{code:'P-9',state:'active',severity:'critical'}]},{deviceId:'demo-device-a',observedAt:t2,runningHours:1,alarms:[{code:'P-9',state:'cleared'}]}]);
  assert.ok(next.data.results[0].flags.includes('cycle_count_regression'));
  const alarms=(await call('/equipment/eq-a/alarms','GET',null,tokens.acme)).data.filter(x=>x.code==='P-9');
  assert.equal(alarms.length,1); assert.equal(alarms[0].raised_at,t0); assert.equal(alarms[0].cleared_at,t2);
  const late=await push([{deviceId:'demo-device-a',observedAt:ago(24*60),runningHours:1}]);
  assert.deepEqual(late.data.results[0].flags.sort(),['late_arrival','out_of_order']);
  assert.equal((await call('/integrations/iot/records','POST',{records:[]},null,{'x-integration-key':'test-integration-key'})).status,400);
  assert.equal((await call('/integrations/iot/records','POST',{records:[{}]},null,{'x-integration-key':'wrong-integration-key'})).status,401);
});

test('telemetry and device mappings respect tenant and assignment boundaries',async()=>{
  assert.equal((await call('/equipment/eq-n/readings','GET',null,tokens.acme)).status,403);
  assert.equal((await call('/equipment/eq-n/alarms','GET',null,tokens.acme)).status,403);
  assert.equal((await call('/equipment/eq-n/readings','GET',null,tokens.euro)).status,200);
  assert.equal((await call('/equipment/eq-n/readings','GET',null,tokens.atlas)).status,403);
  assert.equal((await call('/equipment/eq-a/readings','GET',null,tokens.engineer)).status,200);
  assert.equal((await call('/equipment/eq-n/readings','GET',null,tokens.engineer)).status,403);
  assert.deepEqual((await call('/devices','GET',null,tokens.nova)).data.map(d=>d.external_device_id),['demo-device-n']);
  assert.deepEqual((await call('/devices','GET',null,tokens.euro)).data,[]);
  assert.equal((await call('/devices','POST',{externalDeviceId:'intruder',equipmentId:'eq-n'},tokens.acme)).status,403);
  assert.equal((await call('/devices/map-n','PATCH',{active:false},tokens.acme)).status,403);
  assert.equal((await call('/devices/map-a','PATCH',{equipmentId:'eq-n'},tokens.acme)).status,400);
  const mapped=await call('/devices','POST',{externalDeviceId:'hot-runner-ctrl-1',equipmentId:'eq-b',staleAfterMinutes:10},tokens.acme);
  assert.equal(mapped.status,201); assert.equal(mapped.data.company_id,'c-acme');
  assert.equal((await call('/devices','POST',{externalDeviceId:'hot-runner-ctrl-1',equipmentId:'eq-b'},tokens.acme)).status,409);
  assert.equal((await call('/equipment/eq-b/readings','GET',null,tokens.acme)).data.status,'missing');
  assert.equal((await call(`/devices/${mapped.data.id}`,'PATCH',{active:false},tokens.acme)).status,200);
  assert.equal((await call('/equipment/eq-b/readings','GET',null,tokens.acme)).data.status,'inactive');
  assert.match((await push([{deviceId:'hot-runner-ctrl-1',observedAt:ago(1),temperatureC:210}])).data.results[0].errors[0],/inactive/);
  assert.ok(one("SELECT 1 FROM audit_events WHERE action='device.update' AND company_id='c-acme'"));
});

test('plant-local visit times, quote lifecycle and upload signatures',async()=>{
  const contract=await call('/contracts','POST',contractBody('c-acme',['eq-a'],{title:'TZ check',visits:[{equipmentId:'eq-a',dueAt:'2026-11-15T08:00'}]}),tokens.acme);
  assert.equal(contract.status,201);
  assert.equal(one('SELECT due_at FROM visits WHERE contract_id=?',contract.data.id).due_at,'2026-11-15T14:00:00.000Z');
  assert.equal((await call('/contracts','POST',contractBody('c-acme',['eq-a'],{startsAt:'2026-01-01T00:00:00'}),tokens.acme)).status,400);
  const part=await call('/tickets/ticket-a/parts','POST',partBody({item:'Check valve'}),tokens.acme);
  const q1=await call(`/parts/${part.data.id}/quote`,'POST',quoteBody({amountMinor:1000,leadDays:2}),tokens.dispatch);
  const q2=await call(`/parts/${part.data.id}/quote`,'POST',quoteBody({amountMinor:900,leadDays:2}),tokens.dispatch);
  assert.equal(one('SELECT status FROM quotations WHERE id=?',q1.data.id).status,'superseded');
  assert.equal((await call(`/quotes/${q1.data.id}/decision`,'POST',{decision:'approved'},tokens.acme)).status,400);
  assert.equal((await call(`/quotes/${q2.data.id}/decision`,'POST',{decision:'approved'},tokens.acme)).status,200);
  assert.equal((await call(`/parts/${part.data.id}/fulfil`,'POST',{},tokens.dispatch)).status,200);
  assert.equal((await call(`/parts/${part.data.id}/quote`,'POST',quoteBody({amountMinor:1,leadDays:1}),tokens.dispatch)).status,400);
  assert.equal(one('SELECT status FROM parts_requests WHERE id=?',part.data.id).status,'fulfilled');
  const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEfmt ')]).toString('base64');
  assert.equal((await call('/attachments','POST',{entityType:'ticket',entityId:'ticket-a',kind:'photo',filename:'x.webp',mime:'image/webp',base64:wav},tokens.acme)).status,400);
});
