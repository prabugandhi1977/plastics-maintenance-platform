import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-platform-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
await import('../seed.js');
const { createServer }=await import('../server.js');
const { db, one, all }=await import('../db.js');
const { ticketBody, closeOut, partBody, quoteBody, contractBody, companyBody, plantBody, equipmentBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}) {const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),headers:r.headers};}
const login=async(email,password='DemoPass123!')=>call('/auth/login','POST',{email,password});
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',engineer:'engineer@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',atlasAdmin:'atlas-admin@demo.test',atlas:'atlas@demo.test',euro:'euro@demo.test'})) tokens[key]=(await login(email)).data.token;
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex').toString('base64');
const raise=async(token=tokens.acme,equipmentId='eq-a')=>(await call('/tickets','POST',ticketBody(equipmentId),token)).data.id;

test('security: throttled login, security headers, deactivation, password change, preferences',async()=>{
  for (let i=0;i<5;i++) assert.equal((await login('maint@demo.test','wrong-password-123')).status,401);
  const locked=await login('maint@demo.test');
  assert.equal(locked.status,429); assert.ok(Number(locked.headers.get('retry-after'))>0);
  assert.equal((await login('nobody@demo.test')).status,401);
  const page=await fetch(base+'/'); assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/); assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.equal((await call('/tickets','DELETE',null,tokens.acme)).status,405);
  assert.equal((await call('/users/u-nova','PATCH',{active:false},tokens.acme)).status,403);
  assert.equal((await call('/users/u-acme','PATCH',{active:false},tokens.acme)).status,403);
  assert.equal((await call('/users/u-atlas','PATCH',{skills:['injection','mould','auxiliary']},tokens.atlasAdmin)).status,200);
  assert.equal((await call('/users/u-euro','PATCH',{active:false},tokens.atlasAdmin)).status,403);
  assert.equal((await call('/users/u-acme-maint','PATCH',{active:false},tokens.acme)).status,200);
  assert.equal((await call('/tickets','GET',null,tokens.maint)).status,401);
  assert.equal((await call('/users/u-acme-maint','PATCH',{active:true},tokens.acme)).status,200);
  assert.equal((await call('/me/password','POST',{currentPassword:'nope-nope-nope',newPassword:'AnotherPass456!'},tokens.nova)).status,403);
  assert.equal((await call('/me/password','POST',{currentPassword:'DemoPass123!',newPassword:'short'},tokens.nova)).status,400);
  const changed=await call('/me/password','POST',{currentPassword:'DemoPass123!',newPassword:'AnotherPass456!'},tokens.nova);
  assert.equal(changed.status,200); assert.ok(changed.data.token);
  assert.equal((await call('/me','GET',null,tokens.nova)).status,401);
  tokens.nova=changed.data.token;
  assert.equal((await login('nova@demo.test','AnotherPass456!')).status,200);
  const me=await call('/me','GET',null,tokens.nova); assert.deepEqual(me.data.preferences,{locale:'de',timezone:'Europe/Berlin',currency:'EUR',units:'metric'});
  assert.equal((await call('/me','PATCH',{locale:'en'},tokens.nova)).data.preferences.locale,'en');
  assert.equal((await call('/me','PATCH',{locale:'xx'},tokens.nova)).status,400);
});

test('equipment edits stay inside the owning company',async()=>{
  assert.equal((await call('/equipment/eq-a','PATCH',{location:'Bay 5'},tokens.acme)).data.location,'Bay 5');
  assert.equal((await call('/equipment/eq-a','PATCH',{plantId:'plant-n'},tokens.acme)).status,400);
  assert.equal((await call('/equipment/eq-n','PATCH',{location:'Hijack'},tokens.acme)).status,403);
  assert.equal((await call('/equipment/eq-a','PATCH',{location:'Bay 6'},tokens.maint)).status,403);
  assert.equal(one('SELECT qr_code FROM equipment WHERE id=?','eq-a').qr_code,'MC:eq-a');
});

test('assignment candidates, provider decline, and templated checklist',async()=>{
  const tid=await raise();
  assert.equal((await call(`/tickets/${tid}/candidates`,'GET',null,tokens.acme)).status,403);
  const candidates=(await call(`/tickets/${tid}/candidates`,'GET',null,tokens.dispatch)).data;
  assert.deepEqual(candidates.filter(c=>c.eligible).map(c=>c.id).sort(),['p-atlas','u-engineer']);
  assert.deepEqual(candidates.find(c=>c.id==='p-euro').reasons,['does not cover US-MW','no injection skill']);
  assert.match((await call(`/tickets/${tid}/assign`,'POST',{assigneeType:'provider',assigneeId:'p-euro'},tokens.dispatch)).data.error,/not eligible: does not cover US-MW/);
  assert.equal((await call(`/tickets/${tid}/assign`,'POST',{assigneeType:'provider',assigneeId:'p-atlas'},tokens.dispatch)).status,200);
  assert.equal((await call(`/tickets/${tid}/status`,'POST',{status:'declined'},tokens.atlas)).status,400);
  const actionId=crypto.randomUUID(), decline=await call(`/tickets/${tid}/status`,'POST',{status:'declined',note:'No technician free this week'},tokens.atlas,{'x-client-action-id':actionId});
  assert.deepEqual(decline.data,{id:tid,status:'open',declined:true});
  assert.equal((await call(`/tickets/${tid}/status`,'POST',{status:'declined',note:'No technician free this week'},tokens.atlas,{'x-client-action-id':actionId})).status,200);
  assert.equal((await call(`/tickets/${tid}`,'GET',null,tokens.atlas)).status,403);
  const reopened=(await call(`/tickets/${tid}`,'GET',null,tokens.dispatch)).data;
  assert.equal(reopened.status,'open'); assert.equal(reopened.assigned_provider_id,null); assert.ok(reopened.events.some(e=>e.event_type==='declined'&&/No technician/.test(e.detail)));
  await call(`/tickets/${tid}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  assert.equal((await call(`/tickets/${tid}/status`,'POST',{status:'declined',note:'x'},tokens.dispatch)).status,400);
  const accepted=(await call(`/tickets/${tid}/status`,'POST',{status:'accepted'},tokens.engineer)).data;
  assert.equal(accepted.checklist.length,7); assert.equal(accepted.checklist[0].item,'Lock-out / tag-out applied');
  const item=accepted.checklist[1], tick=crypto.randomUUID();
  assert.equal((await call(`/checklist/${item.id}`,'POST',{done:true,note:'Oil OK'},tokens.engineer,{'x-client-action-id':tick})).data.done,1);
  assert.equal((await call(`/checklist/${item.id}`,'POST',{done:true,note:'Oil OK'},tokens.engineer,{'x-client-action-id':tick})).status,200);
  assert.equal((await call(`/checklist/${item.id}`,'POST',{done:false},tokens.atlas)).status,403);
  assert.equal((await call(`/tickets/${tid}/status`,'POST',{status:'escalated'},tokens.engineer)).status,400);
  assert.equal((await call(`/tickets/${tid}/status`,'POST',{status:'escalated',note:'Needs OEM hydraulic specialist'},tokens.engineer)).data.status,'escalated');
  assert.equal((await call(`/tickets/${tid}/status`,'POST',{status:'accepted'},tokens.engineer)).status,400);
});

test('on-site signature sign-off by the assigned provider',async()=>{
  const tid=await raise();
  await call(`/tickets/${tid}/assign`,'POST',{assigneeType:'provider',assigneeId:'p-atlas'},tokens.dispatch);
  for (const status of ['accepted','in_progress']) await call(`/tickets/${tid}/status`,'POST',{status},tokens.atlas);
  assert.equal((await call(`/tickets/${tid}/signoff`,'POST',{signerName:'Lee',signatureBase64:PNG},tokens.atlas)).status,400);
  await call(`/tickets/${tid}/work-logs`,'POST',{description:'Replaced check ring',minutes:90},tokens.atlas);
  await call(`/tickets/${tid}/status`,'POST',{status:'completed',...closeOut},tokens.atlas);
  assert.equal((await call(`/tickets/${tid}/signoff`,'POST',{signerName:'Lee',signatureBase64:Buffer.from('not an image').toString('base64')},tokens.atlas)).status,400);
  assert.equal((await call(`/tickets/${tid}/signoff`,'POST',{signerName:'Lee',signatureBase64:PNG},tokens.euro)).status,403);
  const signed=await call(`/tickets/${tid}/signoff`,'POST',{signerName:'Lee Maintenance',signatureBase64:PNG},tokens.atlas,{'x-client-action-id':crypto.randomUUID()});
  assert.equal(signed.status,201); assert.equal(signed.data.method,'on_site'); assert.equal(signed.data.collected_by,'u-atlas');
  const sig=await fetch(`${base}/api/attachments/${signed.data.signature_attachment_id}`,{headers:{authorization:`Bearer ${tokens.acme}`}}); assert.equal(sig.status,200); assert.equal(sig.headers.get('content-type'),'image/png');
  assert.equal((await fetch(`${base}/api/attachments/${signed.data.signature_attachment_id}`,{headers:{authorization:`Bearer ${tokens.nova}`}})).status,403);
  assert.equal((await call(`/tickets/${tid}/signoff`,'POST',{signerName:'Sam Acme'},tokens.acme)).status,409);
});

test('contract coverage, response targets, visits and renewal',async()=>{
  const t=(await call('/tickets/ticket-a','GET',null,tokens.acme)).data;
  assert.equal(t.coverage.contractId,'contract-a'); assert.equal(t.coverage.responseHours,8);
  assert.equal(Date.parse(t.responseDueAt)-Date.parse(t.created_at),8*3600000); assert.equal(t.responseBreached,false);
  db.prepare("UPDATE tickets SET created_at=? WHERE id='ticket-a'").run(new Date(Date.now()-9*3600000).toISOString());
  assert.equal((await call('/tickets/ticket-a','GET',null,tokens.acme)).data.responseBreached,true);
  assert.equal((await call('/tickets/'+(await raise(tokens.acme,'eq-b')),'GET',null,tokens.acme)).data.coverage,null);
  assert.equal((await call('/contracts/contract-a/visits','POST',{equipmentId:'eq-a',dueAt:'2026-12-01T09:00',notes:'Pre-renewal check'},tokens.nova)).status,403);
  assert.equal((await call('/contracts/contract-a/visits','POST',{equipmentId:'eq-b',dueAt:'2026-12-01T09:00'},tokens.acme)).status,400);
  assert.equal((await call('/contracts/contract-a/visits','POST',{equipmentId:'eq-a',dueAt:'2027-02-01T09:00'},tokens.acme)).status,400);
  const visit=await call('/contracts/contract-a/visits','POST',{equipmentId:'eq-a',dueAt:'2026-12-01T09:00',notes:'Pre-renewal check'},tokens.acme);
  assert.equal(visit.status,201); assert.equal(visit.data.due_at,'2026-12-01T15:00:00.000Z');
  assert.equal((await call('/contracts/contract-a','PATCH',{renewsAt:'2026-11-01'},tokens.acme)).status,400);
  assert.equal((await call('/contracts/contract-a','PATCH',{renewsAt:'2028-01-01',responseHours:6},tokens.acme)).data.response_hours,6);
  assert.equal((await call('/contracts/contract-n','PATCH',{status:'cancelled'},tokens.acme)).status,403);
});

test('parts fulfilment stages and dashboard metrics stay tenant-scoped',async()=>{
  const parts=(await call('/parts','GET',null,tokens.acme)).data, part=parts.find(p=>p.id==='part-a');
  assert.equal(part.quote.amount_minor,48500); assert.equal(part.ticketTitle,'Hydraulic pressure drops');
  assert.equal((await call('/parts/part-a/fulfilment','POST',{status:'ordered'},tokens.dispatch)).status,400);
  await call('/quotes/quote-a/decision','POST',{decision:'approved'},tokens.acme);
  assert.equal((await call('/parts/part-a/fulfilment','POST',{status:'ordered',reference:'PO-7781'},tokens.acme)).status,403);
  assert.equal((await call('/parts/part-a/fulfilment','POST',{status:'ordered',reference:'PO-7781'},tokens.dispatch)).data.fulfilment_reference,'PO-7781');
  assert.equal((await call('/parts/part-a/fulfilment','POST',{status:'shipped',reference:'UPS 1Z999'},tokens.dispatch)).data.status,'shipped');
  assert.equal((await call('/parts/part-a/fulfilment','POST',{status:'ordered'},tokens.dispatch)).status,400);
  assert.equal((await call('/parts/part-a/fulfil','POST',{},tokens.dispatch)).data.status,'fulfilled');
  assert.equal((await call('/parts','GET',null,tokens.nova)).data.some(p=>p.id==='part-a'),false);
  const acme=(await call('/dashboard','GET',null,tokens.acme)).data, nova=(await call('/dashboard','GET',null,tokens.nova)).data;
  assert.equal(acme.repeatFaults[0].equipmentId,'eq-a'); assert.ok(acme.repeatFaults[0].value>=2);
  assert.ok(acme.downtimeByAsset.some(x=>x.equipmentId==='eq-a'&&x.value>=300));
  assert.equal(acme.responseBreaches,1); assert.ok(acme.upcomingMaintenance.every(v=>v.company_id==='c-acme'));
  assert.ok(nova.repeatFaults.every(x=>x.equipmentId==='eq-n')); assert.ok(nova.upcomingMaintenance.every(v=>v.company_id==='c-nova'));
  assert.deepEqual(nova.upcomingRenewals.map(c=>c.id),['contract-n']);
  const atlas=(await call('/dashboard','GET',null,tokens.atlas)).data; assert.deepEqual([atlas.upcomingMaintenance,atlas.upcomingRenewals],[[],[]]);
  assert.ok(all("SELECT 1 FROM audit_events WHERE action IN ('parts.ordered','parts.shipped','parts.fulfilled')").length===3);
});

test('company and plant settings, admin password reset and session sign-out',async()=>{
  const edited=await call('/companies/c-acme','PATCH',{timezone:'America/New_York',units:'imperial'},tokens.acme);
  assert.equal(edited.status,200); assert.deepEqual([edited.data.timezone,edited.data.units,edited.data.currency],['America/New_York','imperial','USD']);
  assert.equal((await call('/me','GET',null,tokens.acme)).data.preferences.timezone,'America/New_York');
  assert.equal((await call('/companies/c-acme','PATCH',{timezone:'Mars/Olympus'},tokens.acme)).status,400);
  assert.equal((await call('/companies/c-acme','PATCH',{currency:'usd'},tokens.acme)).status,400);
  assert.equal((await call('/companies/c-acme','PATCH',{locale:'xx'},tokens.acme)).status,400);
  assert.equal((await call('/companies/c-acme','PATCH',{name:'Hijacked'},tokens.nova)).status,403);
  assert.equal((await call('/companies/c-acme','PATCH',{name:'Hijacked'},tokens.maint)).status,403);
  assert.equal((await call('/companies/c-nova','PATCH',{currency:'CHF'},tokens.admin)).data.currency,'CHF');
  assert.equal((await call('/plants/plant-a','PATCH',{serviceArea:'US-MW',name:'Chicago Plant 1'},tokens.acme)).data.name,'Chicago Plant 1');
  assert.equal((await call('/plants/plant-a','PATCH',{country:'USA'},tokens.acme)).status,400);
  assert.equal((await call('/plants/plant-n','PATCH',{name:'Hijacked'},tokens.acme)).status,403);
  assert.ok(one("SELECT 1 FROM audit_events WHERE action='plant.update' AND company_id='c-acme'"));

  const created=await call('/users','POST',{companyId:'c-acme',name:'New Planner',email:'planner@acme.test',role:'plant_manager',password:'Temporary-Pass-001'},tokens.acme);
  assert.equal(created.status,201);
  const first=await login('planner@acme.test','Temporary-Pass-001'); assert.equal(first.data.user.mustChangePassword,true);
  const own=await call('/me/password','POST',{currentPassword:'Temporary-Pass-001',newPassword:'Planner-Own-Pass-002'},first.data.token);
  assert.equal(own.data.user.mustChangePassword,false);

  const maintSession=tokens.maint;
  assert.equal((await call('/users/u-acme-maint/password','POST',{newPassword:'short'},tokens.acme)).status,400);
  assert.equal((await call('/users/u-nova/password','POST',{newPassword:'Reset-By-Wrong-Admin'},tokens.acme)).status,403);
  assert.equal((await call('/users/u-acme/password','POST',{newPassword:'Reset-My-Own-Pass'},tokens.acme)).status,400);
  assert.equal((await call('/users/u-acme/password','POST',{newPassword:'Reset-Temp-Pass-003'},tokens.maint)).status,403);
  assert.equal((await call('/users/u-acme-maint/password','POST',{newPassword:'Reset-Temp-Pass-003'},tokens.acme)).status,200);
  assert.equal((await call('/tickets','GET',null,maintSession)).status,401);
  assert.equal((await login('maint@demo.test')).status,401);
  const reset=await login('maint@demo.test','Reset-Temp-Pass-003'); assert.equal(reset.status,200); assert.equal(reset.data.user.mustChangePassword,true);
  assert.equal((await call('/users/u-atlas/password','POST',{newPassword:'Atlas-Temp-Pass-004'},tokens.atlasAdmin)).status,200);
  assert.equal((await call('/users/u-euro/password','POST',{newPassword:'Euro-Temp-Pass-005'},tokens.atlasAdmin)).status,403);
  assert.ok(one("SELECT 1 FROM audit_events WHERE action='user.password_reset' AND entity_id='u-acme-maint'"));
});

test('sign-in: per-account pause with warnings, padded passwords, demo flag, admin bootstrap and recovery',async()=>{
  const { spawnSync }=await import('node:child_process');
  const { hashPassword }=await import('../security.js');
  assert.deepEqual((await call('/config')).data,{demoAccounts:true});
  assert.equal((await call('/users','POST',{companyId:'c-acme',name:'Typo Prone',email:'typo@acme.test',role:'maintenance',password:'Correct-Pass-777'},tokens.acme)).status,201);
  const wrong=()=>login('typo@acme.test','not-the-password');
  assert.equal((await wrong()).data.error,'Email or password is incorrect.');
  await wrong();
  assert.match((await wrong()).data.error,/2 attempts left/);
  assert.match((await wrong()).data.error,/1 attempt left/);
  assert.match((await wrong()).data.error,/now paused for 15 minutes/);
  const paused=await login('typo@acme.test','Correct-Pass-777');
  assert.equal(paused.status,429); assert.match(paused.data.error,/Try again in 15 minutes/);
  assert.equal((await call('/users/'+one("SELECT id FROM users WHERE email='typo@acme.test'").id+'/password','POST',{newPassword:'Fresh-Temp-Pass-888'},tokens.acme)).status,200);
  assert.equal((await login('typo@acme.test','Fresh-Temp-Pass-888')).status,200);
  assert.equal((await login('  TYPO@Acme.test ','Fresh-Temp-Pass-888')).status,200);
  assert.equal((await login('typo@acme.test','  Fresh-Temp-Pass-888  ')).status,200);
  db.prepare("UPDATE users SET password_hash=? WHERE email='typo@acme.test'").run(hashPassword(' pasted with spaces '));
  assert.equal((await login('typo@acme.test',' pasted with spaces ')).status,200);
  assert.equal((await call('/auth/login','POST',{email:'typo@acme.test',password:''})).status,400);

  const bootstrap=env=>spawnSync(process.execPath,['api/bootstrap-admin.js'],{env:{...process.env,...env},encoding:'utf8'});
  const created=bootstrap({MOULDCARE_ADMIN_EMAIL:'Owner@Example.com',MOULDCARE_ADMIN_PASSWORD:'  Owner-Start-Pass-01 \n'});
  assert.equal(created.status,0,created.stderr); assert.match(created.stdout,/Created platform admin owner@example.com/);
  const owner=await login('owner@example.com','Owner-Start-Pass-01'); assert.equal(owner.status,200); assert.equal(owner.data.user.mustChangePassword,true);
  assert.match(bootstrap({MOULDCARE_ADMIN_EMAIL:'owner@example.com',MOULDCARE_ADMIN_PASSWORD:'Something-Else-02'}).stdout,/already exists/);
  assert.equal((await login('owner@example.com','Something-Else-02')).status,401);
  const recovered=bootstrap({MOULDCARE_ADMIN_EMAIL:'owner@example.com',MOULDCARE_ADMIN_PASSWORD:'Recovered-Pass-03',MOULDCARE_ADMIN_RESET_PASSWORD:'true'});
  assert.equal(recovered.status,0,recovered.stderr); assert.match(recovered.stdout,/Reset password for platform admin/);
  assert.equal((await call('/me','GET',null,owner.data.token)).status,401);
  assert.equal((await login('owner@example.com','Recovered-Pass-03')).status,200);
  const refused=bootstrap({MOULDCARE_ADMIN_EMAIL:'nova@demo.test',MOULDCARE_ADMIN_PASSWORD:'Hijack-Attempt-04',MOULDCARE_ADMIN_RESET_PASSWORD:'true'});
  assert.notEqual(refused.status,0); assert.match(refused.stderr,/not a platform admin/);
});
