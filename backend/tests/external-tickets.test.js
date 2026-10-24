import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Breakdown tickets sent by trusted systems (MouldCare Monitor) with a company integration key.
const dir=mkdtempSync(join(tmpdir(),'mouldcare-external-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,headers={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...headers},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const login=async email=>(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const tokens={admin:await login('admin@demo.test'),acme:await login('acme@demo.test'),nova:await login('nova@demo.test'),engineer:await login('engineer@demo.test')};
const minutesAgo=m=>new Date(Date.now()-m*60000).toISOString();
const draft=(extra={})=>({source:'monitor',externalId:crypto.randomUUID(),assetTag:'IMM-04',title:'IMM-04: hydraulic oil temperature rising',symptoms:'Oil temperature up 6 °C in 3 days.',failureCategory:'hydraulic',priority:'high',machineState:'running',safetyIssue:false,occurredAt:minutesAgo(90),productionImpact:'Machine still running.',suggestedActions:['Check the oil cooler','Check the cooling water flow'],assigneeName:'Ravi Kumar',...extra});
const send=(key,body)=>call('/integrations/tickets','POST',body,null,key==null?{}:{'x-integration-key':key});
const keys={acme:(await call('/integration-keys','POST',{name:'MouldCare Monitor'},tokens.acme)).data,nova:(await call('/integration-keys','POST',{companyId:'c-nova',name:'Monitor Köln'},tokens.admin)).data};

test('company integration keys: shown once, scoped to the company, managed by its admins',async()=>{
  assert.match(keys.acme.key,/^mck_/); assert.equal(keys.acme.companyId,'c-acme'); assert.equal(keys.nova.companyId,'c-nova');
  const listed=await call('/integration-keys','GET',null,tokens.acme);
  assert.deepEqual(listed.data.map(k=>k.id),[keys.acme.id]); assert.ok(!JSON.stringify(listed.data).includes(keys.acme.key)); assert.ok(!('key_hash' in listed.data[0]));
  assert.equal((await one('SELECT count(*)::int n FROM integration_keys WHERE key_hash=?',keys.acme.key)).n,0);
  assert.equal((await call('/integration-keys','POST',{name:'x'},tokens.engineer)).status,403);
  // A customer admin's key is always for their own company, and they cannot change another company's keys.
  assert.equal((await call('/integration-keys','POST',{companyId:'c-nova',name:'x'},tokens.acme)).status,403);
  assert.equal((await call(`/integration-keys/${keys.nova.id}`,'PATCH',{active:false},tokens.acme)).status,403);
  assert.ok(await one("SELECT 1 FROM audit_events WHERE action='integration_key.create' AND entity_id=?",keys.acme.id));
});

test('the key is required and wrong keys are refused',async()=>{
  assert.equal((await send(null,draft())).status,401);
  assert.equal((await send('mck_not-a-real-key-at-all-0000000',draft())).status,401);
  // The server-wide machine-data key reaches every company, so it cannot raise tickets.
  assert.equal((await send(process.env.MOULDCARE_INTEGRATION_KEY,draft())).status,401);
  const spare=(await call('/integration-keys','POST',{name:'Spare'},tokens.acme)).data;
  assert.equal((await send(spare.key,draft())).status,201);
  assert.equal((await call(`/integration-keys/${spare.id}`,'PATCH',{active:false},tokens.acme)).data.active,false);
  assert.equal((await send(spare.key,draft())).status,401);
  const rotated=(await call(`/integration-keys/${spare.id}/key`,'POST',null,tokens.acme)).data; await call(`/integration-keys/${spare.id}`,'PATCH',{active:true},tokens.acme);
  assert.equal((await send(spare.key,draft())).status,401); assert.equal((await send(rotated.key,draft())).status,201);
});

test('a ticket is created from a draft, and sending it again returns the same ticket',async()=>{
  const body=draft(), first=await send(keys.acme.key,body);
  assert.equal(first.status,201,JSON.stringify(first.data)); assert.equal(first.data.created,true);
  const t=first.data.ticket; assert.equal(t.assetTag,'IMM-04'); assert.equal(t.raisedVia,'monitor'); assert.equal(t.externalId,body.externalId); assert.equal(t.status,'open');
  const row=await one('SELECT * FROM tickets WHERE id=?',t.id);
  assert.equal(row.company_id,'c-acme'); assert.equal(row.equipment_id,'eq-a'); assert.equal(row.created_by,'u-system'); assert.equal(row.failure_category,'hydraulic'); assert.equal(row.machine_state,'running');
  assert.match(row.symptoms,/Suggested actions:\n1\. Check the oil cooler\n2\. Check the cooling water flow/);
  assert.match((await one("SELECT detail FROM ticket_events WHERE ticket_id=? AND event_type='external'",t.id)).detail,/MouldCare Monitor.*Ravi Kumar/);
  assert.ok(await one("SELECT 1 FROM audit_events WHERE action='ticket.create_external' AND entity_id=? AND company_id='c-acme'",t.id));
  assert.ok((await one('SELECT last_used_at FROM integration_keys WHERE id=?',keys.acme.id)).last_used_at);
  // Resending (e.g. a retry after a lost reply) is idempotent, even with a changed body.
  const again=await send(keys.acme.key,{...body,title:'Changed'});
  assert.equal(again.status,200); assert.equal(again.data.created,false); assert.equal(again.data.ticket.id,t.id);
  assert.equal((await one('SELECT count(*)::int n FROM tickets WHERE external_id=?',body.externalId)).n,1);
  // The customer sees it like any other ticket.
  const seen=await call(`/tickets/${t.id}`,'GET',null,tokens.acme); assert.equal(seen.status,200); assert.equal(seen.data.raised_via,'monitor');
});

test('an unknown asset tag gets a clear error; asset tags match regardless of case',async()=>{
  const r=await send(keys.acme.key,draft({assetTag:'IMM-99'})); assert.equal(r.status,404); assert.match(r.data.error,/No machine with asset tag IMM-99/);
  assert.equal((await send(keys.acme.key,draft({assetTag:'imm-05'}))).status,201);
});

test('a key cannot reach another company\'s machines',async()=>{
  // EXT-02 belongs to Nova Polymers, IMM-04 to Acme.
  const r=await send(keys.acme.key,draft({assetTag:'EXT-02'})); assert.equal(r.status,404); assert.match(r.data.error,/No machine with asset tag EXT-02/);
  assert.equal((await send(keys.nova.key,draft())).status,404);
  const ok=await send(keys.nova.key,draft({assetTag:'EXT-02',failureCategory:'mechanical'})); assert.equal(ok.status,201); assert.equal((await one('SELECT company_id FROM tickets WHERE id=?',ok.data.ticket.id)).company_id,'c-nova');
  // References are per company: Acme's reference does not find Nova's ticket.
  const shared=draft({assetTag:'EXT-02'}); await send(keys.nova.key,shared);
  assert.equal((await send(keys.acme.key,{...shared,assetTag:'IMM-04'})).status,201);
  assert.equal((await call(`/tickets/${ok.data.ticket.id}`,'GET',null,tokens.acme)).status,403);
});

test('every field is validated like a ticket raised in the app',async()=>{
  const k=keys.acme.key, err=async (extra,re)=>{ const r=await send(k,draft(extra)); assert.equal(r.status,400,JSON.stringify(r.data)); assert.match(r.data.error,re); };
  await err({source:'erp'},/source must be one of: monitor/);
  await err({externalId:''},/externalId must be/);
  await err({failureCategory:'control'},/failureCategory must be one of/);
  await err({machineState:'running_degraded'},/machineState must be one of/);
  await err({priority:'urgent'},/priority must be one of/);
  await err({safetyIssue:undefined},/safetyIssue must be answered/);
  await err({title:'x'.repeat(161)},/title must be 1-160/);
  await err({symptoms:''},/symptoms must be/);
  await err({productionImpact:undefined},/productionImpact must be/);
  await err({occurredAt:new Date(Date.now()+3600000).toISOString()},/cannot be in the future/);
  await err({occurredAt:new Date(Date.now()-100*86400000).toISOString()},/within the last 90 days/);
  await err({occurredAt:'yesterday'},/occurredAt must be an ISO date/);
  await err({suggestedActions:'check it'},/suggestedActions must be an array/);
  await err({suggestedActions:['']},/suggestedActions must be up to 20/);
  await err({assigneeName:42},/assigneeName must be text/);
  const before=(await one("SELECT count(*)::int n FROM tickets WHERE raised_via='monitor'")).n;
  await err({failureCategory:'nope'},/failureCategory/); assert.equal((await one("SELECT count(*)::int n FROM tickets WHERE raised_via='monitor'")).n,before);
  // A safety issue is always critical; a decommissioned machine cannot get a breakdown.
  const safety=await send(k,draft({safetyIssue:true,priority:'low'})); assert.equal(safety.data.ticket.priority,'critical');
  await run("UPDATE equipment SET status='decommissioned' WHERE id='eq-bm'");
  await err({assetTag:'BM-01'},/decommissioned/);
  await run("UPDATE equipment SET status='in_service' WHERE id='eq-bm'");
  assert.ok((await all("SELECT id FROM tickets WHERE raised_via='monitor'")).length>=5);
});
