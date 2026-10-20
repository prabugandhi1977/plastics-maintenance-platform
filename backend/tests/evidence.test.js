import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-evidence-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one }=await import('../common/db.js');
const { ticketBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});const type=r.headers.get('content-type')||'';return {status:r.status,headers:r.headers,data:type.includes('json')&&!r.headers.get('content-disposition')?await r.json():await r.text()};}
const login=async email=>(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const tokens={acme:await login('acme@demo.test'),maint:await login('maint@demo.test'),nova:await login('nova@demo.test'),engineer:await login('engineer@demo.test'),dispatch:await login('dispatch@demo.test')};
const ago=d=>new Date(Date.now()-d*86400000).toISOString();

test('the pack covers the company and period, and lists the gaps an auditor would raise',async()=>{
  const pack=(await call('/reports/iatf','GET',null,tokens.acme)).data;
  assert.equal(pack.company.name.length>0,true); assert.equal(pack.company.id,'c-acme'); assert.equal(pack.period.days,90); assert.match(pack.fingerprint,/^[0-9a-f]{64}$/);
  assert.ok(pack.kpis.machines.every(m=>m.type!=='mould'),'moulds are reported under tooling, not KPIs');
  assert.ok(pack.tooling.some(m=>m.equipmentId==='eq-b'&&m.recordedShots===1842000&&m.plan===null));
  const findings=pack.gaps.map(g=>g.finding);
  assert.ok(findings.includes('Moulds without an active preventive maintenance plan'));
  assert.ok(findings.includes('Criticality A machines without an active preventive maintenance plan'));
  assert.ok(pack.breakdowns.every(b=>b.machine!=='—'));
  // Nova's records never appear in Acme's pack.
  assert.ok(!JSON.stringify(pack).includes('Coperion'));
});

test('plans and jobs close the gaps and feed PM compliance',async()=>{
  await call('/pm/plans','POST',{equipmentId:'eq-b',trigger:'shots',intervalValue:250000},tokens.acme);
  for (const id of ['eq-a','eq-a2']) {
    const p=(await call('/pm/plans','POST',{equipmentId:id,trigger:'calendar',intervalValue:30,lastDoneAt:ago(31)},tokens.acme)).data;
    await call(`/pm/jobs/${p.openJobId}/complete`,'POST',{results:p.checklist.map((_,i)=>i?{done:true}:{done:false,note:'Gauge away for calibration'})},tokens.maint);
  }
  const pack=(await call('/reports/iatf','GET',null,tokens.acme)).data, findings=pack.gaps.map(g=>g.finding);
  assert.ok(!findings.includes('Moulds without an active preventive maintenance plan'));
  assert.ok(!findings.includes('Criticality A machines without an active preventive maintenance plan'));
  assert.equal(pack.pm.compliance.due,2); assert.equal(pack.pm.compliance.compliancePct,100);
  assert.equal(pack.pm.jobs.length,2); assert.ok(pack.pm.jobs.every(j=>j.onTime&&j.completedBy==='Lee Maintenance'));
  const skipped=pack.gaps.find(g=>g.finding==='Checklist items not done on completed jobs'); assert.equal(skipped.count,2); assert.match(skipped.items[0],/calibration/);
  assert.equal(pack.tooling.find(m=>m.equipmentId==='eq-b').plan.usage,92000);
});

test('breakdowns are reported with cause and action, and the printable copy is escaped and audited',async()=>{
  const t=await call('/tickets','POST',ticketBody('eq-a',{title:'<script>alert(1)</script> Heater band'}),tokens.acme); assert.equal(t.status,201,JSON.stringify(t.data));
  const pack=(await call('/reports/iatf','GET',null,tokens.acme)).data;
  assert.ok(pack.breakdowns.some(b=>b.title.includes('Heater band')&&b.failureCategory==='mechanical'));
  const d=await call('/reports/iatf/download?from='+ago(30).slice(0,10),'GET',null,tokens.acme);
  assert.equal(d.status,200); assert.match(d.headers.get('content-type'),/text\/html/); assert.match(d.headers.get('content-disposition'),/attachment; filename="iatf-maintenance-evidence-.+\.html"/);
  assert.match(d.headers.get('content-security-policy'),/default-src 'none'/);
  assert.ok(d.data.includes('&lt;script&gt;alert(1)&lt;/script&gt; Heater band')); assert.ok(!d.data.includes('<script>'));
  assert.match(d.data,/8\.5\.1\.6 Tooling management/); assert.match(d.data,/SHA-256 fingerprint of the data: [0-9a-f]{64}/);
  assert.ok(await one("SELECT 1 FROM audit_events WHERE action='report.iatf' AND company_id='c-acme'"));
  const j=await call('/reports/iatf/download?format=json','GET',null,tokens.acme); assert.equal(JSON.parse(j.data).company.id,'c-acme');
});

test('access and period rules',async()=>{
  assert.equal((await call('/reports/iatf?companyId=c-acme','GET',null,tokens.nova)).status,403);
  assert.equal((await call('/reports/iatf?companyId=c-acme','GET',null,tokens.engineer)).status,403);
  assert.equal((await call('/reports/iatf','GET',null,tokens.dispatch)).status,400,'dispatchers choose the company');
  assert.equal((await call('/reports/iatf?companyId=c-nova','GET',null,tokens.dispatch)).data.company.id,'c-nova');
  assert.equal((await call('/reports/iatf?companyId=nope','GET',null,tokens.dispatch)).status,404);
  assert.equal((await call('/reports/iatf?from=2026-06-01&to=2026-05-01','GET',null,tokens.acme)).status,400);
  assert.equal((await call('/reports/iatf?from=2024-01-01&to=2026-01-01','GET',null,tokens.acme)).status,400);
  assert.equal((await call('/reports/iatf/download?format=pdf','GET',null,tokens.acme)).status,400);
});
