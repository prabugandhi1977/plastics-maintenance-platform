import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ticketBody } from './fixtures.js';

// Training requirements and completions from a learning management system: what they do to assigning work.
const dir=mkdtempSync(join(tmpdir(),'mouldcare-competency-test-'));
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
const tokens={admin:await login('admin@demo.test'),dispatch:await login('dispatch@demo.test'),acme:await login('acme@demo.test'),engineer:await login('engineer@demo.test'),atlasAdmin:await login('atlas-admin@demo.test'),euro:await login('euro@demo.test')};
const KEY={'x-integration-key':'test-integration-key'};
const lms=(completions,headers=KEY)=>call('/integrations/lms/completions','POST',{completions},null,headers);
const DAY=86400000, iso=ms=>new Date(Date.now()+ms).toISOString();
const ENGINEER='engineer@demo.test', MACHINE='eq-a2'; // an Acme injection machine; the in-house engineer covers injection in US-MW
const newTicket=async()=>(await call('/tickets','POST',ticketBody(MACHINE),tokens.acme)).data.id;
const candidate=async t=>(await call(`/tickets/${t}/candidates`,'GET',null,tokens.dispatch)).data.find(c=>c.id==='u-engineer');
const assign=t=>call(`/tickets/${t}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
const define=(extra={})=>call('/competencies','POST',{code:'HYD-SAFE',name:'Hydraulic safety',machineTypes:['injection'],validityMonths:12,enforcement:'block',...extra},tokens.dispatch);

test('requirements are defined by dispatch only and validated',async()=>{
  assert.equal((await call('/competencies','POST',{code:'X1',name:'x',machineTypes:[],enforcement:'flag'},tokens.acme)).status,403);
  assert.equal((await call('/competencies','POST',{code:'X1',name:'x',machineTypes:[],enforcement:'flag'},tokens.engineer)).status,403);
  for (const bad of [{code:'a b'},{machineTypes:['lathe']},{enforcement:'maybe'},{validityMonths:0},{name:''}]) assert.equal((await define(bad)).status,400,JSON.stringify(bad));
  const r=await define(); assert.equal(r.status,201); assert.equal(r.data.code,'HYD-SAFE'); assert.deepEqual(r.data.machineTypes,['injection']); assert.equal(r.data.enforcement,'block');
  assert.equal((await define({code:'hyd-safe'})).status,400,'codes are unique, whatever the case');
  assert.equal((await call('/competencies','GET',null,tokens.acme)).status,403,'customers do not see technician training');
  assert.equal((await call('/competencies','GET',null,tokens.engineer)).data.length,1);
  const p=await call(`/competencies/${r.data.id}`,'PATCH',{validityMonths:24},tokens.dispatch); assert.equal(p.data.validityMonths,24); assert.equal(p.data.name,'Hydraulic safety');
  await call(`/competencies/${r.data.id}`,'PATCH',{validityMonths:12},tokens.dispatch);
  assert.equal((await one("SELECT count(*)::int n FROM audit_events WHERE action IN ('competency.create','competency.update')")).n,3);
});

test('the LMS endpoint needs the integration key, answers each completion on its own and is safe to repeat',async()=>{
  const row={email:ENGINEER,courseCode:'hyd-safe',completedAt:iso(-400*DAY),externalId:'lms-1'};
  assert.equal((await lms([row],{})).status,401); assert.equal((await lms([row],{'x-integration-key':'wrong'})).status,401);
  assert.equal((await call('/integrations/lms/completions','POST',{completions:[]},null,KEY)).status,400); assert.equal((await lms(Array(201).fill(row))).status,400);
  const r=await lms([row,{...row,email:'nobody@demo.test'},{...row,courseCode:'NOPE'},{...row,passed:false,completedAt:iso(-3*DAY)},{...row,completedAt:'yesterday'},{...row,completedAt:iso(3*DAY)},'junk']);
  assert.equal(r.status,200); assert.deepEqual(r.data.results.map(x=>x.status),['recorded','unknown_user','unknown_course','not_passed','rejected','rejected','rejected']); assert.equal(r.data.recorded,1);
  assert.equal(r.data.results[0].expiresAt.slice(0,7),iso(-400*DAY+0).slice(0,7).replace(/^(\d{4})/,y=>String(Number(y)+1)),'12 months after completion');
  assert.equal((await lms([row])).data.results[0].status,'duplicate'); assert.equal((await one("SELECT count(*)::int n FROM user_competencies WHERE source='lms'")).n,1);
  assert.equal((await one("SELECT actor_id a FROM audit_events WHERE action='competency.lms_completion'")).a,'u-system');
});

test('missing or expired blocking training stops assignment, with the reason; a current completion lifts it',async()=>{
  await run('DELETE FROM user_competencies');
  const t=await newTicket(); let c=await candidate(t);
  assert.equal(c.eligible,false); assert.ok(c.reasons.includes('Hydraulic safety not on record'),JSON.stringify(c.reasons));
  const refused=await assign(t); assert.equal(refused.status,400); assert.match(refused.data.error,/not eligible: .*Hydraulic safety not on record/);
  // expired: completed 400 days ago with a 12-month validity
  await lms([{email:ENGINEER,courseCode:'HYD-SAFE',completedAt:iso(-400*DAY)}]);
  c=await candidate(t); assert.equal(c.eligible,false); assert.match(c.reasons.join(),/Hydraulic safety expired on \d{4}-\d\d-\d\d/);
  // renewal: a newer completion replaces it
  assert.equal((await lms([{email:ENGINEER,courseCode:'HYD-SAFE',completedAt:iso(-5*DAY)}])).data.recorded,1);
  c=await candidate(t); assert.equal(c.eligible,true); assert.deepEqual([c.reasons,c.warnings],[[],[]]);
  const ok=await assign(t); assert.equal(ok.status,200); assert.equal(ok.data.warnings,undefined);
});

test('an expiring completion and a flag-only requirement warn but do not stop the assignment, and the warning is on record',async()=>{
  await run('DELETE FROM user_competencies');
  await lms([{email:ENGINEER,courseCode:'HYD-SAFE',completedAt:iso(-340*DAY)}]); // expires in about 25 days
  await define({code:'MOULD-CLAMP',name:'Mould clamping',machineTypes:['injection','mould'],validityMonths:null,enforcement:'flag'});
  const t=await newTicket(), c=await candidate(t);
  assert.equal(c.eligible,true); assert.equal(c.warnings.length,2); assert.ok(c.warnings.some(w=>/Hydraulic safety expires on/.test(w))); assert.ok(c.warnings.includes('Mould clamping not on record'));
  const r=await assign(t); assert.equal(r.status,200); assert.equal(r.data.warnings.length,2);
  assert.match((await one("SELECT detail FROM ticket_events WHERE ticket_id=? AND event_type='assigned'",t)).detail,/Training warning: .*Mould clamping not on record/);
  assert.match((await one("SELECT detail FROM audit_events WHERE action='ticket.assign' AND entity_id=?",t)).detail,/trainingWarnings/);
  // a requirement for another machine type, or one that is switched off, does not count
  await define({code:'EXT-ONLY',name:'Extrusion die change',machineTypes:['extrusion'],enforcement:'block'});
  const comp=await one("SELECT id FROM competencies WHERE code='MOULD-CLAMP'"); await call(`/competencies/${comp.id}`,'PATCH',{active:false},tokens.dispatch);
  const t2=await newTicket(), c2=await candidate(t2); assert.equal(c2.eligible,true); assert.equal(c2.warnings.length,1);
});

test('a completion recorded by hand counts, and who sees the standing is limited',async()=>{
  await run('DELETE FROM user_competencies');
  const id=(await one("SELECT id FROM users WHERE email=?",ENGINEER)).id;
  assert.equal((await call('/competencies/records','POST',{userId:id,code:'HYD-SAFE',completedAt:iso(-10*DAY)},tokens.acme)).status,403);
  assert.equal((await call('/competencies/records','POST',{userId:'u-acme',code:'HYD-SAFE',completedAt:iso(-10*DAY)},tokens.dispatch)).status,400,'office staff are not technicians');
  assert.equal((await call('/competencies/records','POST',{userId:id,code:'NOPE',completedAt:iso(-10*DAY)},tokens.dispatch)).status,400);
  assert.equal((await call('/competencies/records','POST',{userId:id,code:'HYD-SAFE',completedAt:iso(-10*DAY),expiresAt:iso(-20*DAY)},tokens.dispatch)).status,400);
  const rec={userId:id,code:'HYD-SAFE',completedAt:iso(-10*DAY),note:'Course on site'};
  assert.equal((await call('/competencies/records','POST',rec,tokens.dispatch)).status,201); assert.equal((await call('/competencies/records','POST',rec,tokens.dispatch)).status,400,'the same completion twice');
  const mine=await call('/competencies/matrix','GET',null,tokens.engineer); assert.equal(mine.status,200);
  assert.deepEqual(mine.data.people.map(p=>p.email),[ENGINEER]); assert.equal(mine.data.people[0].standing['HYD-SAFE'].status,'valid'); assert.equal(mine.data.people[0].standing['HYD-SAFE'].source,'manual');
  const all_=await call('/competencies/matrix?machineType=injection','GET',null,tokens.dispatch); assert.ok(all_.data.people.length>=2,'dispatch sees every technician');
  assert.deepEqual(all_.data.competencies.map(c=>c.code),['HYD-SAFE']);
  assert.equal((await call('/competencies/matrix?machineType=lathe','GET',null,tokens.dispatch)).status,400);
  assert.equal((await call('/competencies/matrix','GET',null,tokens.acme)).status,403);
  // a provider administrator sees only their own engineers, and a provider engineer only themselves
  const atlas=await call('/competencies/matrix','GET',null,tokens.atlasAdmin), euro=await call('/competencies/matrix','GET',null,tokens.euro);
  assert.equal(atlas.status,200); assert.deepEqual(atlas.data.people.map(p=>p.email),['atlas@demo.test']); assert.ok(atlas.data.people.every(p=>p.providerId==='p-atlas'));
  assert.deepEqual(euro.data.people.map(p=>p.email),['euro@demo.test']);
});
