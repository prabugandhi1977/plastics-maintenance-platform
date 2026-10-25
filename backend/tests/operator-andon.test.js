import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-andon-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
delete process.env.EMAIL_PROVIDER;
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const { checkAndonEscalations }=await import('../services/factory/andon.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const ago=m=>new Date(Date.now()-m*60000).toISOString();
const state=async (eq,s,reason,start,source='device',company='c-acme')=>{ await run('UPDATE machine_states SET ended_at=? WHERE equipment_id=? AND ended_at IS NULL',start,eq); const key=crypto.randomUUID(); await run('INSERT INTO machine_states (id,company_id,equipment_id,state,reason_code,started_at,source) VALUES (?,?,?,?,?,?,?)',key,company,eq,s,reason,start,source); return key; };
const outbox=async alertId=>(await all("SELECT recipient FROM notification_outbox WHERE alert_id=? AND channel='email' ORDER BY recipient",alertId)).map(r=>r.recipient);
const station={}, since=`from=${encodeURIComponent(new Date(Date.now()-30*60000).toISOString())}`;

test('stations: created by plant management with a PIN, scoped to machines of one plant',async()=>{
  const body={plantId:'plant-a',name:'IMM-04 tablet',kind:'tablet',equipmentIds:['eq-a'],pin:'482915'};
  assert.equal((await call('/operator/stations','POST',body,tokens.maint)).status,403,'maintenance staff cannot create stations');
  assert.equal((await call('/operator/stations','POST',body,tokens.nova)).status,403,'another company cannot');
  assert.equal((await call('/operator/stations','POST',{...body,pin:'1234'},tokens.acme)).status,400,'simple PIN refused');
  assert.equal((await call('/operator/stations','POST',{...body,pin:'99'},tokens.acme)).status,400,'short PIN refused');
  assert.equal((await call('/operator/stations','POST',{...body,equipmentIds:['eq-n']},tokens.acme)).status,400,'machine of another company refused');
  assert.equal((await call('/operator/stations','POST',{...body,equipmentIds:['eq-b']},tokens.acme)).status,400,'a mould is not a production machine');
  const r=await call('/operator/stations','POST',body,tokens.acme); assert.equal(r.status,201);
  assert.match(r.data.code,/^[A-Z2-9]{8}$/); assert.deepEqual(r.data.equipmentIds,['eq-a']); assert.equal(r.data.pin_hash,undefined);
  station.tablet=r.data;
  const b=await call('/operator/stations','POST',{plantId:'plant-a',name:'Hall TV',kind:'board',pin:'730152'},tokens.acme); assert.equal(b.status,201); station.board=b.data;
  const n=await call('/operator/stations','POST',{plantId:'plant-n',name:'EXT-02 Tablet',kind:'tablet',equipmentIds:['eq-n'],pin:'615204'},tokens.nova); assert.equal(n.status,201); station.nova=n.data;
  assert.ok(!(await call('/operator/stations','GET',null,tokens.nova)).data.some(s=>s.id===station.tablet.id),'stations are company-scoped');
  assert.ok(await one("SELECT 1 FROM audit_events WHERE action='station.create' AND entity_id=?",station.tablet.id));
});

test('station login: wrong PINs lock the station; a supervisor unlocks it',async()=>{
  const code=station.tablet.code;
  for (let i=1;i<=4;i++) { const r=await call('/operator/login','POST',{code,pin:'111112'}); assert.equal(r.status,401); assert.equal(r.data.attemptsLeft,5-i); }
  const locked=await call('/operator/login','POST',{code,pin:'111112'}); assert.equal(locked.status,429);
  const right=await call('/operator/login','POST',{code,pin:'482915'}); assert.equal(right.status,429,'locked even with the right PIN');
  assert.match(right.data.error,/locked/);
  assert.ok(await one("SELECT 1 FROM audit_events WHERE action='station.locked' AND entity_id=?",station.tablet.id));
  assert.equal((await call('/operator/login','POST',{code:'NOPE1234',pin:'482915'})).status,401,'unknown code');
  assert.equal((await call(`/operator/stations/${station.tablet.id}`,'PATCH',{unlock:true},tokens.nova)).status,403);
  assert.equal((await call(`/operator/stations/${station.tablet.id}`,'PATCH',{unlock:true},tokens.acme)).status,200);
  const ok=await call('/operator/login','POST',{code:code.toLowerCase().replace(/(....)/,'$1-'),pin:'482915'}); assert.equal(ok.status,200,'code is case and dash tolerant');
  assert.match(ok.data.token,/^st1\./); station.tabletToken=ok.data.token;
  station.boardToken=(await call('/operator/login','POST',{code:station.board.code,pin:'730152'})).data.token;
  station.novaToken=(await call('/operator/login','POST',{code:station.nova.code,pin:'615204'})).data.token;
  assert.ok(station.boardToken&&station.novaToken);
});

test('scope: a station acts only on its own machines and reaches no other API',async()=>{
  const t=station.tabletToken;
  const me=await call('/operator/me','GET',null,t); assert.equal(me.status,200); assert.deepEqual(me.data.machines.map(m=>m.id),['eq-a']);
  assert.equal((await call('/operator/machines/eq-a','GET',null,t)).status,200);
  assert.equal((await call('/operator/machines/eq-a2','GET',null,t)).status,403,'same company, not bound');
  assert.equal((await call('/operator/machines/eq-n','GET',null,t)).status,403,'other company');
  assert.equal((await call('/operator/machines/eq-a2/andon','POST',{type:'material'},t)).status,403);
  assert.equal((await call('/operator/machines/eq-n/scrap','POST',{quantity:1,reason:'other'},t)).status,403);
  for (const p of ['/tickets','/equipment','/alerts','/andon/report','/operator/stations','/me']) assert.equal((await call(p,'GET',null,t)).status,401,`${p} refuses a station token`);
  assert.equal((await call('/operator/machines/eq-a/andon','POST',{type:'quality'},station.boardToken)).status,403,'a board cannot act');
  assert.equal((await call('/operator/machines/eq-a','GET',null,station.novaToken)).status,403);
  // A user token is never accepted as a station token and vice versa (scoped signatures).
  const forged=`st1.${tokens.acme.split('.')[0]}.${tokens.acme.split('.')[1]}`; assert.equal((await call('/operator/me','GET',null,forged)).status,401);
  assert.equal((await call('/operator/machines/eq-a','GET',null,tokens.nova)).status,403,'a person is scoped to their company');
  assert.equal((await call('/operator/machines/eq-a','GET',null,tokens.atlas)).status,403,'providers have no shop-floor access');
});

test('downtime reasons: operators classify stops from machine data; manual machines are stopped and resumed',async()=>{
  const t=station.tabletToken;
  const running=await state('eq-a','running',null,ago(60));
  assert.equal((await call('/operator/machines/eq-a/downtime','POST',{state:'down',reason:'mould_fault'},t)).status,409,'machine data says running');
  const stop=await state('eq-a','down',null,ago(20));
  assert.equal((await call('/operator/machines/eq-a/downtime','POST',{state:'down',reason:'cosmic_rays'},t)).status,400);
  const r=await call('/operator/machines/eq-a/downtime','POST',{state:'down',reason:'mould_fault',note:'Ejector pin stuck',operator:'Jo Operator'},t);
  assert.equal(r.status,200); assert.equal(r.data.stateId,stop);
  assert.deepEqual(await one('SELECT state,reason_code,source FROM machine_states WHERE id=?',stop),{state:'down',reason_code:'mould_fault',source:'device'});
  const ev=await one("SELECT * FROM operator_events WHERE state_id=? AND kind='downtime'",stop);
  assert.equal(ev.station_id,station.tablet.id); assert.equal(ev.operator_name,'Jo Operator'); assert.equal(ev.created_by,'u-system'); assert.equal(ev.note,'Ejector pin stuck');
  const a=await one("SELECT * FROM audit_events WHERE action='operator.downtime' AND entity_id='eq-a'"); assert.equal(a.actor_id,'u-system'); assert.equal(JSON.parse(a.detail).stationId,station.tablet.id);
  assert.equal(r.data.machine.stops.find(s=>s.id===stop).classified,true);
  // An earlier, already-ended stop is classified by its id; a running interval is not a stop.
  await run('UPDATE machine_states SET state=?,reason_code=? WHERE id=?','idle',null,running);
  assert.equal((await call('/operator/machines/eq-a/downtime','POST',{stateId:running,state:'idle',reason:'waiting_material'},t)).status,200);
  assert.equal((await one('SELECT reason_code FROM machine_states WHERE id=?',running)).reason_code,'waiting_material');
  // A machine without machine data (eq-a2) is stopped and resumed from the tablet (here by a signed-in person).
  const m=await call('/operator/machines/eq-a2/downtime','POST',{state:'idle',reason:'waiting_operator'},tokens.maint); assert.equal(m.status,200);
  assert.equal(m.data.machine.state.state,'idle'); assert.equal(m.data.machine.state.source,'operator');
  assert.equal((await call('/operator/machines/eq-a2/resume','POST',{},tokens.maint)).data.machine.state.state,'running');
  assert.equal((await call('/operator/machines/eq-a/resume','POST',{},t)).status,409,'machine data decides when eq-a runs');
});

test('scrap: logged with reason and quantity, counted in OEE quality, never more than the good output',async()=>{
  const t=station.tabletToken, period=new Date(Date.now()-5*60000); period.setUTCSeconds(0,0);
  await run("INSERT INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,?,?,?,?,?,'test')",crypto.randomUUID(),'c-acme','eq-a','pr-cap',period.toISOString(),15,500,5,'parts',18000);
  const before=(await call('/operator/machines/eq-a','GET',null,t)).data.today;
  assert.equal((await call('/operator/machines/eq-a/scrap','POST',{quantity:20,reason:'not_a_reason'},t)).status,400);
  assert.equal((await call('/operator/machines/eq-a/scrap','POST',{quantity:2.5,reason:'flash'},t)).status,400,'parts are whole numbers');
  assert.equal((await call('/operator/machines/eq-a/scrap','POST',{quantity:before.good+1,reason:'flash'},t)).status,400);
  const r=await call('/operator/machines/eq-a/scrap','POST',{quantity:20,reason:'flash',operator:'Jo Operator'},t); assert.equal(r.status,201);
  assert.equal(r.data.machine.today.scrap,before.scrap+20); assert.equal(r.data.machine.today.good,before.good-20);
  const ev=await one('SELECT * FROM operator_events WHERE id=?',r.data.id); assert.equal(ev.kind,'scrap'); assert.equal(ev.reason,'flash'); assert.equal(ev.quantity,20);
  assert.ok(await one("SELECT 1 FROM production_counts WHERE equipment_id='eq-a' AND source='operator' AND total_qty=0 AND scrap_qty=20"));
});

test('jobs and mould changes set what the machine makes',async()=>{
  const t=station.tabletToken;
  assert.equal((await call('/operator/machines/eq-a/job','POST',{action:'start',kind:'job',productId:'pr-cmp'},t)).status,400,'product of another company');
  const s=await call('/operator/machines/eq-a/job','POST',{action:'start',kind:'job',productId:'pr-hsg'},t); assert.equal(s.status,200);
  assert.equal(s.data.machine.product.partNumber,'HSG-180-A'); assert.ok(s.data.machine.job);
  const mc=await call('/operator/machines/eq-a/job','POST',{action:'start',kind:'mould_change'},t); assert.equal(mc.status,200);
  assert.equal(mc.data.machine.job,null,'a mould change ends the job'); assert.ok(mc.data.machine.mouldChange);
  assert.equal((await one('SELECT state,reason_code FROM machine_states WHERE equipment_id=? AND ended_at IS NULL','eq-a')).reason_code,'mould_change','the stop is classified as a mould change');
  assert.equal((await call('/operator/machines/eq-a/job','POST',{action:'start',kind:'mould_change'},t)).status,400);
  const f=await call('/operator/machines/eq-a/job','POST',{action:'finish',kind:'mould_change',productId:'pr-cap'},t); assert.equal(f.status,200);
  assert.equal(f.data.machine.mouldChange,null); assert.equal(f.data.machine.product.partNumber,'CAP-28-PCO');
  assert.deepEqual((await all("SELECT kind FROM operator_events WHERE equipment_id='eq-a' AND (kind LIKE 'job%' OR kind LIKE 'mould%') ORDER BY created_at")).map(r=>r.kind),['job_start','job_finish','mould_change_start','mould_change_finish','job_start']);
});

test('andon: raise → notify the right role → escalate after the timeout → acknowledge → resolve, with times',async()=>{
  const t=station.tabletToken;
  // Escalation for maintenance calls: plant management after 5 minutes, platform dispatch after 15.
  assert.equal((await call('/andon/settings','PUT',{companyId:'c-acme',types:{maintenance:{notify:['maintenance'],escalation:[{afterMinutes:5,roles:['customer_admin']},{afterMinutes:3,roles:['dispatcher']}]}}},tokens.acme)).status,400,'levels must come later');
  assert.equal((await call('/andon/settings','PUT',{companyId:'c-acme',types:{maintenance:{notify:['operators']}}},tokens.acme)).status,400,'unknown role');
  assert.equal((await call('/andon/settings','PUT',{companyId:'c-acme',types:{maintenance:{notify:['maintenance']}}},tokens.maint)).status,403);
  const saved=await call('/andon/settings','PUT',{companyId:'c-acme',types:{maintenance:{notify:['maintenance'],escalation:[{afterMinutes:5,roles:['customer_admin']},{afterMinutes:15,roles:['dispatcher']}]}}},tokens.acme);
  assert.equal(saved.status,200); assert.equal(saved.data.types.safety.severity,'critical'); assert.equal(saved.data.types.maintenance.escalation.length,2);

  assert.equal((await call('/operator/machines/eq-a/andon','POST',{type:'coffee'},t)).status,400);
  const r=await call('/operator/machines/eq-a/andon','POST',{type:'maintenance',note:'Ejector pin stuck',operator:'Jo Operator'},t);
  assert.equal(r.status,201); const c=r.data.call;
  assert.equal(c.status,'open'); assert.equal(c.level,0); assert.equal(c.severity,'warning'); assert.equal(c.operator,'Jo Operator'); assert.equal(c.machineState,'setup');
  const again=await call('/operator/machines/eq-a/andon','POST',{type:'maintenance'},t); assert.equal(again.status,200); assert.equal(again.data.call.id,c.id,'a second tap joins the open call');
  const alert=await one('SELECT * FROM alerts WHERE id=?',c.alertId); assert.equal(alert.module,'andon'); assert.equal(alert.dedupe_key,`andon:${c.id}`);
  assert.deepEqual(await outbox(c.alertId),['maint@demo.test'],'level 0: maintenance only');

  const raised=Date.parse(c.raisedAt);
  assert.equal(await checkAndonEscalations(raised+4*60000),0,'not yet');
  assert.equal(await checkAndonEscalations(raised+6*60000),1);
  let row=await one('SELECT * FROM andon_calls WHERE id=?',c.id); assert.equal(row.level,1); assert.equal(row.severity,'critical');
  assert.deepEqual(await outbox(c.alertId),['acme@demo.test','maint@demo.test'],'level 1: customer admin');
  assert.equal((await one('SELECT severity FROM alerts WHERE id=?',c.alertId)).severity,'critical');
  assert.equal(await checkAndonEscalations(raised+7*60000),0,'each level once');
  assert.equal(await checkAndonEscalations(raised+16*60000),1);
  assert.deepEqual(await outbox(c.alertId),['acme@demo.test','dispatch@demo.test','maint@demo.test'],'level 2: platform dispatch');
  assert.equal((await all("SELECT 1 FROM audit_events WHERE action='andon.escalate' AND entity_id=?",c.id)).length,2);

  // Response 10 minutes after the call (moved back in time), acknowledged from the desktop; resolved at the tablet.
  await run('UPDATE andon_calls SET raised_at=? WHERE id=?',ago(10),c.id);
  assert.equal((await call(`/andon/calls/${c.id}/acknowledge`,'POST',{},tokens.nova)).status,403);
  const ack=await call(`/andon/calls/${c.id}/acknowledge`,'POST',{},tokens.maint); assert.equal(ack.status,200);
  assert.equal(ack.data.status,'acknowledged'); assert.equal(ack.data.acknowledgedBy,'Lee Maintenance'); assert.ok(Math.abs(ack.data.responseMinutes-10)<0.5,`${ack.data.responseMinutes}`);
  assert.equal((await one('SELECT status FROM alerts WHERE id=?',c.alertId)).status,'acknowledged');
  assert.equal((await call(`/andon/calls/${c.id}/acknowledge`,'POST',{},tokens.maint)).status,400);
  assert.equal(await checkAndonEscalations(Date.now()+60*60000),0,'acknowledged calls do not escalate');
  const res=await call(`/andon/calls/${c.id}/resolve`,'POST',{resolution:'Pin freed and greased',operator:'Jo Operator'},t); assert.equal(res.status,200);
  assert.equal(res.data.status,'resolved'); assert.ok(res.data.resolveMinutes>=9.9); assert.equal(res.data.resolution,'Pin freed and greased');
  assert.equal((await one('SELECT status FROM alerts WHERE id=?',c.alertId)).status,'resolved');
  for (const action of ['andon.raise','andon.acknowledge','andon.resolve']) assert.ok(await one('SELECT 1 FROM audit_events WHERE action=? AND entity_id=?',action,c.id),action);

  // Safety is always critical and goes to everyone in plant management at once.
  const s=(await call('/operator/machines/eq-a/andon','POST',{type:'safety',note:'Guard door damaged'},t)).data.call;
  assert.equal(s.severity,'critical'); assert.deepEqual(await outbox(s.alertId),['acme@demo.test','maint@demo.test']);
  // Acknowledging the alert on the Alerts page acknowledges the call too.
  assert.equal((await call(`/alerts/${s.alertId}/acknowledge`,'POST',{},tokens.acme)).status,200);
  assert.equal((await one('SELECT status,acknowledged_name FROM andon_calls WHERE id=?',s.id)).status,'acknowledged');
  assert.equal((await call(`/andon/calls/${s.id}/resolve`,'POST',{},tokens.acme)).status,200);
});

test('andon → breakdown ticket in one tap, pre-filled with machine, state and time',async()=>{
  const t=station.tabletToken;
  await state('eq-a','down','mould_fault',ago(8));
  const c=(await call('/operator/machines/eq-a/andon','POST',{type:'maintenance',note:'Mould does not open',operator:'Jo Operator'},t)).data.call;
  const q=(await call('/operator/machines/eq-a/andon','POST',{type:'quality'},t)).data.call;
  assert.equal((await call(`/andon/calls/${q.id}/ticket`,'POST',{},t)).status,400,'only maintenance calls');
  assert.equal((await call(`/andon/calls/${c.id}/ticket`,'POST',{},station.novaToken)).status,403);
  const r=await call(`/andon/calls/${c.id}/ticket`,'POST',{},t); assert.equal(r.status,201);
  const tk=await one('SELECT * FROM tickets WHERE id=?',r.data.ticketId);
  assert.equal(tk.equipment_id,'eq-a'); assert.equal(tk.company_id,'c-acme'); assert.equal(tk.machine_state,'stopped'); assert.equal(tk.failure_category,'tooling');
  assert.equal(tk.occurred_at,c.raisedAt); assert.equal(tk.raised_via,'andon'); assert.equal(tk.created_by,'u-system'); assert.equal(tk.priority,'high'); assert.match(tk.symptoms,/Mould does not open/);
  assert.equal(r.data.call.ticketId,tk.id); assert.equal(r.data.call.status,'acknowledged','turning it into a ticket is the response');
  const again=await call(`/andon/calls/${c.id}/ticket`,'POST',{},tokens.acme); assert.equal(again.status,200); assert.equal(again.data.ticketId,tk.id);
  assert.ok((await call(`/tickets/${tk.id}`,'GET',null,tokens.acme)).data.events.some(e=>e.event_type==='andon'));
  // The ticket is visible to the company and dispatch like any breakdown.
  assert.ok((await call('/tickets','GET',null,tokens.dispatch)).data.some(x=>x.id===tk.id));
  await call(`/andon/calls/${q.id}/resolve`,'POST',{},tokens.acme);
});

test('tenancy, the board and reports',async()=>{
  // Nova sees none of Acme's calls; its own station sees only its own.
  const n=(await call('/operator/machines/eq-n/andon','POST',{type:'material'},station.novaToken)).data.call;
  const acmeCalls=(await call(`/andon/calls?status=all&${since}`,'GET',null,tokens.acme)).data, novaCalls=(await call(`/andon/calls?status=all&${since}`,'GET',null,tokens.nova)).data;
  assert.equal(acmeCalls.length,4); assert.ok(acmeCalls.every(c=>c.companyId==='c-acme')); assert.deepEqual(novaCalls.map(c=>c.id),[n.id]);
  assert.ok((await call('/andon/calls','GET',null,station.tabletToken)).data.every(c=>c.equipmentId==='eq-a'));
  assert.equal((await call(`/andon/calls/${n.id}/resolve`,'POST',{},station.tabletToken)).status,403);
  assert.equal((await call(`/andon/calls/${n.id}/acknowledge`,'POST',{},tokens.acme)).status,403);
  assert.equal((await call('/andon/settings?companyId=c-nova','GET',null,tokens.acme)).status,403);
  assert.equal((await call('/andon/report','GET',null,tokens.atlas)).status,403);
  // Board: the plant's machines with open calls; a board station sees its own plant only.
  const board=await call('/andon/board','GET',null,station.boardToken); assert.equal(board.status,200);
  assert.equal(board.data.plant.id,'plant-a'); assert.deepEqual(board.data.tiles.map(x=>x.assetTag).sort(),['BM-01','IMM-04','IMM-05']);
  assert.ok(board.data.tiles.find(x=>x.id==='eq-a').calls.length>=1);
  assert.equal((await call('/andon/board?plantId=plant-a','GET',null,tokens.nova)).status,403);
  assert.equal((await call('/andon/board?plantId=plant-n','GET',null,tokens.nova)).data.tiles.length,2);
  // Reports: counts and mean response/resolve by type, machine and shift; downtime Pareto and scrap from operator entries.
  const rep=(await call(`/andon/report?${since}`,'GET',null,tokens.acme)).data;
  const maint=rep.byType.find(x=>x.type==='maintenance'); assert.equal(maint.count,2); assert.equal(maint.escalated,1); assert.ok(maint.meanResponseMinutes>4,`${maint.meanResponseMinutes}`);
  assert.equal(rep.byMachine.find(x=>x.equipmentId==='eq-a').count,4); assert.ok(rep.byShift.length>=1);
  assert.ok(!rep.calls.some(c=>c.companyId!=='c-acme'));
  assert.ok(rep.downtime.some(d=>d.state==='setup'&&d.reason==='mould_change'),'the stop reclassified by the mould change'); assert.ok(rep.downtime.some(d=>d.reason==='waiting_material'));
  assert.equal(rep.downtime.at(-1).cumulativePct,100);
  assert.deepEqual(rep.scrap.map(s=>[s.reason,s.quantity]),[['flash',20]]);
  const novaRep=(await call(`/andon/report?${since}`,'GET',null,tokens.nova)).data; assert.equal(novaRep.total.count,1); assert.equal(novaRep.scrap.length,0);
  assert.equal((await call(`/andon/report?${since}`,'GET',null,tokens.dispatch)).data.total.count,5,'dispatch sees all companies');
});

test('signing a station out, or a new PIN, ends its tablet sessions',async()=>{
  assert.equal((await call('/operator/me','GET',null,station.tabletToken)).status,200);
  assert.equal((await call(`/operator/stations/${station.tablet.id}`,'PATCH',{signOut:true},tokens.acme)).status,200);
  assert.equal((await call('/operator/me','GET',null,station.tabletToken)).status,401);
  const fresh=(await call('/operator/login','POST',{code:station.tablet.code,pin:'482915'})).data.token;
  assert.equal((await call(`/operator/stations/${station.tablet.id}`,'PATCH',{pin:'905173'},tokens.acme)).status,200);
  assert.equal((await call('/operator/me','GET',null,fresh)).status,401);
  assert.equal((await call('/operator/login','POST',{code:station.tablet.code,pin:'482915'})).status,401,'old PIN no longer works');
  assert.equal((await call('/operator/login','POST',{code:station.tablet.code,pin:'905173'})).status,200);
  assert.equal((await call(`/operator/stations/${station.board.id}`,'PATCH',{active:false},tokens.acme)).status,200);
  assert.equal((await call('/andon/board','GET',null,station.boardToken)).status,401,'a deactivated board is signed out');
  assert.equal((await call('/operator/login','POST',{code:station.board.code,pin:'730152'})).status,401);
  assert.ok(!(await one("SELECT detail FROM audit_events WHERE action='station.update' AND detail LIKE '%905173%'")),'PINs are never written to the audit log');
});
