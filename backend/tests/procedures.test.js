import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ticketBody } from './fixtures.js';

// Work procedures on work orders: authoring and versions, running a procedure on a ticket, the execution data, the close-out gate.
const dir=mkdtempSync(join(tmpdir(),'mouldcare-procedure-test-'));
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
const tokens={admin:await login('admin@demo.test'),dispatch:await login('dispatch@demo.test'),acme:await login('acme@demo.test'),engineer:await login('engineer@demo.test'),atlas:await login('atlas@demo.test'),euro:await login('euro@demo.test')};
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const MACHINE='eq-a2'; // an Acme injection machine; the in-house engineer covers injection in US-MW
const STEPS=[
  {title:'Lock out and tag the machine',safety:'Isolate electrical and hydraulic supply',instruction:'Apply your own lock.',expectedMinutes:5},
  {title:'Torque the tie-bar nuts',spec:'M36 nuts, 1450 Nm',instruction:'Cross pattern.',measurement:{name:'Torque',unit:'Nm',min:1400,max:1500},expectedMinutes:20,parts:[{partNumber:'NUT-M36',quantity:4}]},
  {title:'Photograph the platen after cleaning',requiresPhoto:true,expectedMinutes:5},
  {title:'Wipe down the guard',mandatory:false}
];
const draft=(extra={})=>({code:'IMM-TIEBAR',title:'Tie-bar inspection',machineTypes:['injection'],steps:STEPS,...extra});
const newTicket=async()=>(await call('/tickets','POST',ticketBody(MACHINE),tokens.acme)).data.id;
const toEngineer=async t=>{ assert.equal((await call(`/tickets/${t}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch)).status,200); };
const accept=t=>call(`/tickets/${t}/status`,'POST',{status:'accepted',note:'On site'},tokens.engineer);
const detail=async t=>(await call(`/tickets/${t}`,'GET',null,tokens.engineer)).data;
const step=(id,body,token=tokens.engineer)=>call(`/procedure-steps/${id}`,'PATCH',body,token);
let published;

test('procedures are written and published by dispatch only, validated, and versioned',async()=>{
  assert.equal((await call('/procedures','POST',draft(),tokens.engineer)).status,403); assert.equal((await call('/procedures','POST',draft(),tokens.acme)).status,403);
  for (const bad of [{code:'a b'},{title:''},{machineTypes:['lathe']},{steps:[{}]},{steps:[{title:'x',measurement:{name:'T',min:5,max:1}}]},{steps:[{title:'x',parts:[{quantity:1}]}]},{steps:[{title:'x',requiresPhoto:'yes'}]},{steps:'none'}]) assert.equal((await call('/procedures','POST',draft(bad),tokens.dispatch)).status,400,JSON.stringify(bad));
  const made=await call('/procedures','POST',draft(),tokens.dispatch); assert.equal(made.status,201); assert.equal(made.data.status,'draft'); assert.equal(made.data.version,1); assert.equal(made.data.steps.length,4); assert.deepEqual(made.data.steps.map(s=>s.position),[1,2,3,4]);
  assert.equal((await call('/procedures','POST',draft(),tokens.dispatch)).status,400,'one draft per code');
  const edit=await call(`/procedures/${made.data.id}`,'PATCH',{title:'Tie-bar inspection and torque',autoAttach:true,steps:STEPS.slice(0,3)},tokens.dispatch); assert.equal(edit.data.steps.length,3); assert.equal(edit.data.autoAttach,true);
  assert.equal((await call(`/procedures/${made.data.id}/publish`,'POST',null,tokens.engineer)).status,403);
  const empty=await call('/procedures','POST',draft({code:'EMPTY',machineTypes:[],steps:[]}),tokens.dispatch); assert.equal((await call(`/procedures/${empty.data.id}/publish`,'POST',null,tokens.dispatch)).status,400,'needs steps and machine types');
  published=await call(`/procedures/${made.data.id}/publish`,'POST',null,tokens.dispatch); assert.equal(published.status,200); assert.equal(published.data.status,'active'); assert.ok(published.data.publishedAt);
  assert.equal((await call(`/procedures/${made.data.id}`,'PATCH',{title:'x'},tokens.dispatch)).status,400,'a published version is not edited');
  // the next version replaces it when published
  const v2=await call('/procedures','POST',draft({title:'Tie-bar inspection v2',steps:STEPS}),tokens.dispatch); assert.equal(v2.data.version,2);
  assert.equal((await call('/procedures?status=active','GET',null,tokens.engineer)).data.filter(p=>p.code==='IMM-TIEBAR').length,1);
  await call(`/procedures/${v2.data.id}/publish`,'POST',null,tokens.dispatch);
  const list=(await call('/procedures','GET',null,tokens.engineer)).data.filter(p=>p.code==='IMM-TIEBAR'); assert.deepEqual(list.map(p=>[p.version,p.status]),[[2,'active'],[1,'retired']]); assert.equal(list[0].stepCount,4);
  published=v2; assert.equal((await call('/procedures','GET',null,tokens.acme)).status,403);
});

test('a procedure is attached to a ticket by whoever services it, for the right machine type, and keeps the steps as they were',async()=>{
  const t=await newTicket(); await toEngineer(t);
  assert.equal((await call(`/tickets/${t}/procedures`,'POST',{procedureId:published.data.id},tokens.acme)).status,403,'customers do not attach');
  assert.equal((await call(`/tickets/${t}/procedures`,'POST',{procedureId:published.data.id},tokens.euro)).status,403,'another provider has no access');
  await call('/procedures','POST',draft({code:'BLOW-CHECK',machineTypes:['blow'],steps:[{title:'x'}]}),tokens.dispatch); const blow=(await call('/procedures?machineType=blow','GET',null,tokens.dispatch)).data[0];
  await call(`/procedures/${blow.id}/publish`,'POST',null,tokens.dispatch);
  assert.equal((await call(`/tickets/${t}/procedures`,'POST',{procedureId:blow.id},tokens.engineer)).status,400,'not for injection machines');
  const old=(await call('/procedures','GET',null,tokens.dispatch)).data.find(p=>p.code==='IMM-TIEBAR'&&p.version===1); assert.equal((await call(`/tickets/${t}/procedures`,'POST',{procedureId:old.id},tokens.engineer)).status,400,'a retired version cannot be attached');
  const a=await call(`/tickets/${t}/procedures`,'POST',{procedureId:published.data.id},tokens.engineer); assert.equal(a.status,201); assert.equal(a.data.steps.length,4); assert.equal(a.data.status,'in_progress');
  const again=await call(`/tickets/${t}/procedures`,'POST',{procedureId:published.data.id},tokens.engineer); assert.equal(again.status,200); assert.equal(again.data.id,a.data.id,'attaching twice changes nothing');
  assert.equal((await detail(t)).procedures.length,1); assert.match((await detail(t)).events.map(e=>e.detail).join('|'),/Procedure attached: Tie-bar inspection v2 \(v2\)/);
  // editing the published definition later (a new version) does not change this run
  await run("UPDATE procedure_steps SET title='CHANGED' WHERE procedure_id=?",published.data.id);
  assert.equal((await detail(t)).procedures[0].steps[0].title,'Lock out and tag the machine');
});

test('steps are recorded with their measurement, photo and deviation; the run completes when the mandatory steps are done',async()=>{
  const t=await newTicket(); await toEngineer(t); const run0=(await call(`/tickets/${t}/procedures`,'POST',{procedureId:published.data.id},tokens.engineer)).data, [s1,s2,s3,s4]=run0.steps;
  assert.equal((await step(s1.id,{status:'done'})).status,400,'accept the job first'); assert.equal((await accept(t)).status,200);
  assert.equal((await step(s1.id,{status:'done'},tokens.acme)).status,403);
  assert.equal((await step(s1.id,{status:'maybe'})).status,400);
  assert.equal((await step(s1.id,{status:'skipped',note:'later'})).status,400,'a mandatory step cannot be skipped');
  assert.equal((await step(s1.id,{status:'done'})).status,200);
  // measurement: required, and a value outside the limits needs a deviation note
  assert.equal((await step(s2.id,{status:'done'})).status,400);
  const out=await step(s2.id,{status:'done',measurementValue:1300}); assert.equal(out.status,400); assert.match(out.data.error,/outside 1400 to 1500/);
  const dev=await step(s2.id,{status:'done',measurementValue:1300,deviation:'Wrench limit; re-torqued next shift'}); assert.equal(dev.status,200);
  const st2=dev.data.steps[1]; assert.equal(st2.measurementValue,1300); assert.equal(st2.inRange,false); assert.equal(st2.deviation,'Wrench limit; re-torqued next shift'); assert.equal(st2.completedBy,'u-engineer');
  // photo: must be a photo uploaded to this ticket
  assert.equal((await step(s3.id,{status:'done'})).status,400);
  assert.equal((await step(s3.id,{status:'done',photoId:'nope'})).status,400);
  const other=await newTicket(), foreign=(await call('/attachments','POST',{entityType:'ticket',entityId:other,kind:'photo',filename:'x.png',mime:'image/png',base64:PNG},tokens.acme)).data.id;
  assert.equal((await step(s3.id,{status:'done',photoId:foreign})).status,400,'a photo from another ticket does not count');
  const photo=(await call('/attachments','POST',{entityType:'ticket',entityId:t,kind:'photo',filename:'platen.png',mime:'image/png',base64:PNG},tokens.engineer)).data.id;
  assert.equal((await step(s4.id,{status:'skipped'})).status,400,'a skipped step says why');
  assert.equal((await step(s4.id,{status:'skipped',note:'Guard already clean'})).status,200);
  let r=await step(s3.id,{status:'done',photoId:photo}); assert.equal(r.status,200); assert.equal(r.data.steps[2].photoId,photo);
  assert.equal(r.data.status,'completed'); assert.ok(r.data.completedAt);
  assert.ok(r.data.steps.every(s=>s.status!=='pending')); assert.ok(r.data.steps.filter(s=>s.status==='done').every(s=>Number.isInteger(s.seconds)&&s.seconds>=0));
  assert.match((await detail(t)).events.map(e=>e.detail).join('|'),/Procedure completed: Tie-bar inspection v2 \(v2\)/);
  assert.equal((await one("SELECT count(*)::int n FROM audit_events WHERE action='procedure.step' AND entity_id=? AND detail LIKE '%outOfRange%'",t)).n,1);
  // undoing a step reopens the run
  r=await step(s1.id,{status:'pending'}); assert.equal(r.data.status,'in_progress'); assert.equal(r.data.steps[0].status,'pending'); assert.equal(r.data.steps[0].completedAt,null);
});

test('a ticket cannot be completed while a mandatory step is open; auto-attach happens when the job is accepted',async()=>{
  const auto=(await call('/procedures','GET',null,tokens.dispatch)).data.find(p=>p.code==='IMM-TIEBAR'&&p.status==='active');
  await call('/procedures','POST',draft({steps:STEPS,autoAttach:true}),tokens.dispatch); const v3=(await call('/procedures','GET',null,tokens.dispatch)).data.find(p=>p.code==='IMM-TIEBAR'&&p.status==='draft'); await call(`/procedures/${v3.id}/publish`,'POST',null,tokens.dispatch);
  const t=await newTicket(); await toEngineer(t); assert.equal((await detail(t)).procedures.length,0);
  assert.equal((await accept(t)).status,200); const d=await detail(t); assert.equal(d.procedures.length,1,'attached when accepted'); assert.equal(d.procedures[0].version,3);
  assert.equal((await call(`/tickets/${t}/status`,'POST',{status:'in_progress'},tokens.engineer)).status,200);
  assert.equal((await call(`/tickets/${t}/work-logs`,'POST',{description:'Torqued tie-bars',minutes:60},tokens.engineer)).status,201);
  const close={status:'completed',failureMode:'low_output',rootCause:'wear_and_ageing',actionTaken:'replace',scanCode:`MC:${MACHINE}`};
  const refused=await call(`/tickets/${t}/status`,'POST',close,tokens.engineer); assert.equal(refused.status,400); assert.match(refused.data.error,/Complete the procedure steps first: Tie-bar inspection: Lock out/);
  const [s1,s2,s3]=d.procedures[0].steps; const photo=(await call('/attachments','POST',{entityType:'ticket',entityId:t,kind:'photo',filename:'p.png',mime:'image/png',base64:PNG},tokens.engineer)).data.id;
  await step(s1.id,{status:'done'}); await step(s2.id,{status:'done',measurementValue:1450}); await step(s3.id,{status:'done',photoId:photo});
  const ok=await call(`/tickets/${t}/status`,'POST',close,tokens.engineer); assert.equal(ok.status,200,JSON.stringify(ok.data)); assert.equal(ok.data.procedures[0].status,'completed');
  assert.equal((await step(s1.id,{status:'pending'})).status,400,'a completed ticket is read-only');
});

test('analytics: how often each step is done, skipped, out of range or noted, and how long it takes',async()=>{
  assert.equal((await call('/procedures/by-code/IMM-TIEBAR/analytics','GET',null,tokens.engineer)).status,403);
  assert.equal((await call('/procedures/by-code/NOPE/analytics','GET',null,tokens.dispatch)).status,404);
  assert.equal((await call('/procedures/by-code/IMM-TIEBAR/analytics?version=x','GET',null,tokens.dispatch)).status,400);
  const a=(await call('/procedures/by-code/IMM-TIEBAR/analytics','GET',null,tokens.dispatch)).data;
  assert.equal(a.runs,3,'three tickets ran version 2 or 3'); assert.equal(a.completedRuns,1);
  const v2=a.steps.filter(s=>s.version===2); assert.equal(v2.length,4);
  const torque=v2.find(s=>s.title==='Torque the tie-bar nuts'); assert.equal(torque.runs,2); assert.equal(torque.outOfRange,1); assert.equal(torque.deviations,1); assert.equal(torque.outOfRangeRate,0.5); assert.equal(torque.deviationRate,0.5);
  const guard=v2.find(s=>s.title==='Wipe down the guard'); assert.equal(guard.skipped,1); assert.equal(guard.skipRate,0.5);
  assert.ok(torque.averageMinutes==null||typeof torque.averageMinutes==='number'); assert.equal(typeof a.averageRunMinutes==='number'||a.averageRunMinutes===null,true);
  const only3=(await call('/procedures/by-code/IMM-TIEBAR/analytics?version=3','GET',null,tokens.dispatch)).data; assert.equal(only3.runs,1);
});
