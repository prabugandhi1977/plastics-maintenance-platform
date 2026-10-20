import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-pm-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, run }=await import('../common/db.js');
const { syncAll, statusOf }=await import('../services/core/routes/pm.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const login=async email=>(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const tokens={acme:await login('acme@demo.test'),maint:await login('maint@demo.test'),nova:await login('nova@demo.test'),engineer:await login('engineer@demo.test'),dispatch:await login('dispatch@demo.test')};
const hoursAgo=h=>new Date(Date.now()-h*3600000).toISOString();
const done=n=>Array.from({length:n},()=>({done:true}));

test('status bands: due soon at 90 %, due at 100 %, overdue at 110 %',()=>{
  assert.deepEqual([0.5,0.9,1,1.09,1.1].map(statusOf),['ok','due_soon','due','due','overdue']);
});

test('runtime plan counts running hours, opens a job when due and raises an alert when overdue',async()=>{
  // 30 h running and 10 h down since the last service, on a machine with no other state history.
  await run("INSERT INTO equipment (id,company_id,plant_id,machine_type,make,model,serial_number,location,qr_code,created_at,asset_tag) VALUES ('eq-pm','c-acme','plant-a','injection','Arburg','A','PM-1','Bay 9','MC:eq-pm',?, 'IMM-PM')",hoursAgo(100));
  for (const [state,from,to] of [['running',40,20],['down',20,10],['running',10,null]]) await run('INSERT INTO machine_states (id,company_id,equipment_id,state,started_at,ended_at,source) VALUES (?,?,?,?,?,?,?)',crypto.randomUUID(),'c-acme','eq-pm',state,hoursAgo(from),to==null?null:hoursAgo(to),'test');
  const created=await call('/pm/plans','POST',{equipmentId:'eq-pm',trigger:'runtime',intervalValue:40,lastDoneAt:hoursAgo(50),title:'Hydraulic service'},tokens.acme);
  assert.equal(created.status,201,JSON.stringify(created.data));
  const p=created.data; assert.equal(p.unit,'hours'); assert.ok(Math.abs(p.usage-30)<0.2,`usage ${p.usage}`); assert.equal(p.status,'ok'); assert.equal(p.openJobId,null);
  assert.ok(p.checklist.length>0,'defaults to the machine type checklist');
  // Lower the interval: 30 of 28 h is 107 % (due, a job opens, no alert yet); 30 of 25 h is overdue.
  const due=await call(`/pm/plans/${p.id}`,'PATCH',{intervalValue:28},tokens.acme); assert.equal(due.data.status,'due'); assert.ok(due.data.openJobId);
  assert.equal(await one("SELECT 1 FROM alerts WHERE dedupe_key=?",`pm-overdue:${p.id}`),undefined);
  await call(`/pm/plans/${p.id}`,'PATCH',{intervalValue:25},tokens.acme); await syncAll(); await syncAll();
  assert.equal((await one("SELECT count(*)::int n FROM pm_jobs WHERE plan_id=? AND status='open'",p.id)).n,1,'one open job, however often it syncs');
  const alert=await one("SELECT * FROM alerts WHERE dedupe_key=?",`pm-overdue:${p.id}`); assert.equal(alert.module,'maintenance'); assert.equal(alert.status,'open');
  // Completing late: every checklist item needs a result, and a skipped item needs a note.
  const jobId=due.data.openJobId, n=p.checklist.length;
  assert.equal((await call(`/pm/jobs/${jobId}/complete`,'POST',{results:done(n-1)},tokens.maint)).status,400);
  assert.match((await call(`/pm/jobs/${jobId}/complete`,'POST',{results:[...done(n-1),{done:false}]},tokens.maint)).data.error,/note/);
  assert.equal((await call(`/pm/jobs/${jobId}/complete`,'POST',{results:done(n)},tokens.nova)).status,403);
  const closed=await call(`/pm/jobs/${jobId}/complete`,'POST',{results:[...done(n-1),{done:false,note:'Seal on order'}],notes:'Oil changed'},tokens.maint);
  assert.equal(closed.status,200,JSON.stringify(closed.data)); assert.equal(closed.data.onTime,false);
  assert.equal((await one("SELECT status FROM alerts WHERE id=?",alert.id)).status,'resolved');
  assert.equal((await call(`/pm/jobs/${jobId}/complete`,'POST',{results:done(n)},tokens.maint)).status,400,'cannot complete twice');
  const after=(await call(`/pm/plans/${p.id}`,'GET',null,tokens.acme)).data; assert.equal(after.status,'ok'); assert.ok(after.usage<0.1); assert.equal(after.jobs.length,1);
  const c=(await call('/pm/compliance','GET',null,tokens.acme)).data; assert.equal(c.due,1); assert.equal(c.late,1); assert.equal(c.compliancePct,0);
});

test('mould plan counts shots from batches and products, starting from the recorded shot count',async()=>{
  // Seeded mould MLD-24: 24 cavities, 1,842,000 shots recorded, 250,000-shot service interval → 92,000 since the last service.
  const p=(await call('/pm/plans','POST',{equipmentId:'eq-b',trigger:'shots',intervalValue:250000,lastDoneAt:hoursAgo(6),checklist:['Clean vents','Check hot runner zones']},tokens.acme)).data;
  assert.equal(p.usage,92000); assert.equal(p.unit,'shots');
  assert.equal((await call('/pm/plans','POST',{equipmentId:'eq-b',trigger:'runtime',intervalValue:100},tokens.acme)).status,400,'moulds count shots, not running hours');
  assert.equal((await call('/pm/plans','POST',{equipmentId:'eq-a',trigger:'shots',intervalValue:100000},tokens.acme)).status,400,'machines do not count shots');
  // 2,400 parts in a batch with this mould = 100 shots, and 240 parts of a product made with it = 10 shots. Parts
  // outside the batch or before the last service don't count.
  await run("INSERT INTO batches (id,company_id,batch_number,product_id,equipment_id,mould_id,operator_name,planned_qty,status,started_at,ended_at,created_at) VALUES ('b-pm','c-acme','PM-1','pr-hsg','eq-pm','eq-b','Op',1000,'completed',?,?,?)",hoursAgo(5),hoursAgo(1),hoursAgo(5));
  const count=async (machine,product,h,qty)=>await run("INSERT INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,60,?,0,'parts',1000,'test')",crypto.randomUUID(),'c-acme',machine,product,hoursAgo(h),qty);
  for (const [h,qty] of [[4,1200],[2,1200],[0.5,9999],[7,9999]]) await count('eq-pm',null,h,qty);
  await count('eq-a2','pr-cap',3,240); await count('eq-a2','pr-cap',8,9999);
  assert.equal((await call(`/pm/plans/${p.id}`,'GET',null,tokens.acme)).data.usage,92110);
});

test('calendar plans, access and compliance',async()=>{
  const p=(await call('/pm/plans','POST',{equipmentId:'eq-c',trigger:'calendar',intervalValue:30,lastDoneAt:new Date(Date.now()-28*86400000).toISOString()},tokens.acme)).data;
  assert.equal(p.status,'due_soon'); assert.equal(p.title,'Every 30 days');
  assert.equal((await call('/pm/plans','POST',{equipmentId:'eq-c',trigger:'calendar',intervalValue:30},tokens.maint)).status,403,'maintenance staff complete jobs but do not plan');
  assert.equal((await call('/pm/plans','POST',{equipmentId:'eq-c',trigger:'calendar',intervalValue:30},tokens.nova)).status,403);
  assert.equal((await call(`/pm/plans/${p.id}`,'GET',null,tokens.nova)).status,403);
  assert.equal((await call('/pm/plans','GET',null,tokens.nova)).data.length,0);
  assert.deepEqual((await call('/pm/plans','GET',null,tokens.engineer)).data,[]);
  assert.ok((await call('/pm/plans','GET',null,tokens.dispatch)).data.length>=3);
  // Done on time: a due job completed within 110 % of its interval.
  await call(`/pm/plans/${p.id}`,'PATCH',{intervalValue:27},tokens.acme);
  const job=(await call('/pm/jobs?status=open','GET',null,tokens.maint)).data.find(j=>j.plan_id===p.id); assert.ok(job);
  const ok=await call(`/pm/jobs/${job.id}/complete`,'POST',{results:done(job.checklist.length)},tokens.maint); assert.equal(ok.data.onTime,true);
  const c=(await call('/pm/compliance?days=30','GET',null,tokens.acme)).data; assert.equal(c.due,2); assert.equal(c.onTime,1); assert.equal(c.compliancePct,50);
  // Pausing a plan withdraws its open job.
  await call(`/pm/plans/${p.id}`,'PATCH',{intervalValue:1},tokens.acme);
  const paused=(await call(`/pm/plans/${p.id}`,'PATCH',{active:false},tokens.acme)).data; assert.equal(paused.status,'inactive'); assert.equal(paused.openJobId,null);
});
