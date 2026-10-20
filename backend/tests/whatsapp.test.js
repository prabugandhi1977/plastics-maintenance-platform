import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-whatsapp-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
const WA=['WHATSAPP_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_TEMPLATE','WHATSAPP_TEMPLATE_LANG','WHATSAPP_API_VERSION'];
for (const k of [...WA,'EMAIL_PROVIDER','EMAIL_API_KEY','EMAIL_FROM']) delete process.env[k];
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const { raiseAlert, sendQueued }=await import('../services/factory/alerts.js');
const { e164, sendQueuedWhatsapp, whatsappRequest }=await import('../common/whatsapp.js');
const { ticketBody, closeOut, atMachine }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const realFetch=globalThis.fetch;
after(async()=>{globalThis.fetch=realFetch;await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token){const r=await realFetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',engineer:'engineer@demo.test',atlas:'atlas@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const whatsappRows=async where=>await all(`SELECT * FROM notification_outbox WHERE channel='whatsapp' AND ${where} ORDER BY recipient`);
const configure=()=>Object.assign(process.env,{WHATSAPP_TOKEN:'secret-test-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_TEMPLATE:'mouldcare_alert',WHATSAPP_TEMPLATE_LANG:'en_US',WHATSAPP_API_VERSION:'v99.0'});
const unconfigure=()=>{ for (const k of WA) delete process.env[k]; };

test('E.164 numbers: + country code and 8-15 digits; spaces and dashes are ignored',()=>{
  assert.equal(e164('+919876543210'),'+919876543210');
  assert.equal(e164('+91 98765-43210'),'+919876543210');
  for (const bad of ['','9876543210','+0123456789','+1234567','+1234567890123456','+1 (312) 555 0300','+49 221 555 0100 ext 2']) assert.equal(e164(bad),null,bad);
});

test('opt-in: off by default; turning it on needs a valid phone, on the own account and in user admin',async()=>{
  const me=(await call('/me','GET',null,tokens.maint)).data;
  assert.deepEqual([me.alertWhatsapp,me.alertEmails,me.phone],[false,true,'']);
  const noPhone=await call('/me','PATCH',{alertWhatsapp:true},tokens.maint);
  assert.equal(noPhone.status,400); assert.match(noPhone.data.error,/international format.*\+919876543210/);
  assert.match((await call('/me','PATCH',{alertWhatsapp:true,phone:'098765 43210'},tokens.maint)).data.error,/international format/);
  const on=await call('/me','PATCH',{alertWhatsapp:true,phone:'+91 98765 43210'},tokens.maint);
  assert.equal(on.status,200); assert.deepEqual([on.data.alertWhatsapp,on.data.phone,on.data.preferences.locale],[true,'+91 98765 43210','en']);
  assert.equal((await call('/me','PATCH',{phone:'12345678'},tokens.maint)).status,400,'cannot break the number while opted in');
  assert.equal((await call('/me','PATCH',{alertWhatsapp:'yes'},tokens.maint)).status,400);
  assert.equal((await call('/me','PATCH',{locale:'de'},tokens.maint)).data.alertWhatsapp,true,'changing the language keeps the opt-in');
  assert.equal((await call('/me','PATCH',{locale:'en'},tokens.maint)).data.preferences.locale,'en');
  assert.equal((await call('/me','PATCH',{phone:''},tokens.engineer)).status,400,'field engineers keep a phone number');

  // Admin edit form: the same rules.
  assert.equal((await call('/users/u-dispatch','PATCH',{alertWhatsapp:true,phone:'+1 (312) 555 0300'},tokens.admin)).status,400);
  const admin=await call('/users/u-dispatch','PATCH',{alertWhatsapp:true,alertEmails:false},tokens.admin);
  assert.equal(admin.status,200,'seeded +1 312 555 0300 is valid'); assert.deepEqual([admin.data.alert_whatsapp,admin.data.alert_emails],[1,0]);
  assert.equal((await call('/users/u-dispatch','PATCH',{alertEmails:true},tokens.admin)).data.alert_emails,1);
  assert.equal((await call('/users/u-acme-maint','PATCH',{alertWhatsapp:false},tokens.acme)).data.alert_whatsapp,0,'customer admin manages their staff');
  assert.equal((await call('/users/u-acme-maint','PATCH',{alertWhatsapp:true},tokens.acme)).data.alert_whatsapp,1);
  assert.equal((await call('/users/u-dispatch','PATCH',{alertWhatsapp:true},tokens.acme)).status,403);
  const created=await call('/users','POST',{role:'maintenance',companyId:'c-acme',name:'Ravi Kumar',email:'ravi@acme.test',password:'TemporaryPass123',alertWhatsapp:true},tokens.acme);
  assert.equal(created.status,400); assert.match(created.data.error,/international format/);
  assert.equal((await call('/users','POST',{role:'maintenance',companyId:'c-acme',name:'Ravi Kumar',email:'ravi@acme.test',password:'TemporaryPass123',phone:'+919812345678',alertWhatsapp:true},tokens.acme)).status,201);
  const listed=(await call('/users','GET',null,tokens.acme)).data.find(x=>x.email==='ravi@acme.test');
  assert.deepEqual([listed.alert_whatsapp,listed.alert_emails],[1,1]);
});

test('alerts: WhatsApp rows only for opted-in recipients with a valid number, same threshold as email',async()=>{
  // Opted in with a number WhatsApp cannot reach (saved before validation existed): skipped, not sent wrongly.
  await run("UPDATE users SET alert_whatsapp=1,phone='555 0100' WHERE id='u-acme'");
  await run("UPDATE users SET alert_whatsapp=1 WHERE id IN ('u-engineer','u-nova')"); // not alert recipients for Acme
  const warn=await raiseAlert({companyId:'c-acme',plantId:'plant-a',module:'condition',severity:'warning',equipmentId:'eq-a',title:'Oil warm',dedupeKey:'wa-warn-1'});
  assert.equal((await whatsappRows(`alert_id='${warn}'`)).length,0,'below the threshold: no WhatsApp, like email');
  const key=await raiseAlert({companyId:'c-acme',plantId:'plant-a',module:'condition',severity:'critical',equipmentId:'eq-a',title:'Hydraulic oil overheating',detail:'72 °C\nsecond line',dedupeKey:'wa-crit-1'});
  const rows=await whatsappRows(`alert_id='${key}'`);
  assert.deepEqual(rows.map(r=>r.recipient),['+13125550300','+919812345678','+919876543210'],'dispatcher, Ravi and Lee; not Sam (bad number), engineer or Nova');
  assert.ok(rows.every(r=>r.status==='not_configured'&&r.ticket_id===null));
  assert.equal(rows[0].subject,'Critical machine alert'); assert.match(rows[0].body,/^IMM-04 .* - Hydraulic oil overheating - severity critical$/);
  const mails=await all("SELECT recipient FROM notification_outbox WHERE channel='email' AND alert_id=? ORDER BY recipient",key);
  assert.deepEqual(mails.map(m=>m.recipient),['acme@demo.test','dispatch@demo.test','maint@demo.test','ravi@acme.test'],'email follows its own opt-in');
  // Escalating a warning to critical sends now.
  const { escalateAlert }=await import('../services/factory/alerts.js');
  await escalateAlert(warn,{severity:'critical',title:'Oil hot',detail:''});
  assert.equal((await whatsappRows(`alert_id='${warn}'`)).length,3);
  await run("UPDATE users SET alert_whatsapp=0 WHERE id IN ('u-acme','u-engineer','u-nova')");
});

test('tickets: assignment messages the engineer or provider staff; completion messages the reporter',async()=>{
  await run("UPDATE users SET alert_whatsapp=1,phone='+1 312 555 0100' WHERE id='u-acme'");
  const t=(await call('/tickets','POST',ticketBody('eq-a',{title:'Screw slips',priority:'high'}),tokens.acme)).data;
  assert.equal((await call(`/tickets/${t.id}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch)).status,200);
  assert.equal((await whatsappRows(`ticket_id='${t.id}'`)).length,0,'engineer has not opted in');
  await run("UPDATE users SET alert_whatsapp=1 WHERE id='u-engineer'");
  await call(`/tickets/${t.id}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  let rows=await whatsappRows(`ticket_id='${t.id}'`);
  assert.deepEqual(rows.map(r=>[r.recipient,r.subject,r.status,r.alert_id]),[['+13125550301','Ticket assigned to you','not_configured',null]]);
  assert.match(rows[0].body,/^IMM-04 .* - Screw slips - priority high - /);
  for (const status of ['accepted','in_progress']) assert.equal((await call(`/tickets/${t.id}/status`,'POST',{status},tokens.engineer)).status,200);
  await call(`/tickets/${t.id}/work-logs`,'POST',{description:'Replaced check ring',minutes:60},tokens.engineer);
  assert.equal((await call(`/tickets/${t.id}/status`,'POST',{status:'completed',...closeOut,...atMachine()},tokens.engineer)).status,200);
  rows=await whatsappRows(`ticket_id='${t.id}' AND subject LIKE 'Your breakdown%'`);
  assert.deepEqual(rows.map(r=>r.recipient),['+13125550100'],'the reporter, Sam Acme');

  // Provider assignment: the provider's engineers and service manager who opted in.
  await run("UPDATE users SET alert_whatsapp=1,phone='+13125550201' WHERE id='u-atlas'");
  const t2=(await call('/tickets','POST',ticketBody('eq-a',{title:'Heater band failed'}),tokens.acme)).data;
  assert.equal((await call(`/tickets/${t2.id}/assign`,'POST',{assigneeType:'provider',assigneeId:'p-atlas'},tokens.dispatch)).status,200);
  assert.deepEqual((await whatsappRows(`ticket_id='${t2.id}'`)).map(r=>r.recipient),['+13125550201']);
  // Completed by the person who reported it: no message to themselves.
  const t3=(await call('/tickets','POST',ticketBody('eq-a',{title:'Nozzle leak'}),tokens.maint)).data;
  await run("UPDATE tickets SET created_by='u-dispatch' WHERE id=?",t3.id);
  await call(`/tickets/${t3.id}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  for (const status of ['accepted','in_progress']) await call(`/tickets/${t3.id}/status`,'POST',{status},tokens.dispatch);
  await call(`/tickets/${t3.id}/work-logs`,'POST',{description:'Tightened nozzle',minutes:20},tokens.dispatch);
  assert.equal((await call(`/tickets/${t3.id}/status`,'POST',{status:'completed',...closeOut,...atMachine()},tokens.dispatch)).status,200);
  assert.equal((await whatsappRows(`ticket_id='${t3.id}' AND subject LIKE 'Your breakdown%'`)).length,0);
});

test('delivery: Cloud API template request, sent and failed, nothing without configuration',async()=>{
  await run("DELETE FROM notification_outbox WHERE channel='whatsapp'");
  const insert=async (recipient,status='queued')=>{ const key=crypto.randomUUID(); await run("INSERT INTO notification_outbox (id,channel,recipient,subject,body,status,created_at) VALUES (?,'whatsapp',?,?,?,?,?)",key,recipient,'Critical machine alert','IMM-04 - Oil hot - severity critical',status,new Date().toISOString()); return key; };
  const calls=[]; globalThis.fetch=async (url,init)=>{ calls.push({url,init}); return url.includes('/messages')&&JSON.parse(init.body).to==='919876543210'?new Response('{"messages":[{"id":"wamid.1"}]}',{status:200}):new Response('{"error":{"message":"Recipient not on WhatsApp"}}',{status:400}); };
  try {
    unconfigure();
    const waiting=await insert('+919876543210');
    assert.equal(await sendQueuedWhatsapp(),0); assert.equal(calls.length,0,'not configured: nothing is sent');
    configure();
    // The email sender leaves WhatsApp rows alone.
    Object.assign(process.env,{EMAIL_PROVIDER:'resend',EMAIL_API_KEY:'k',EMAIL_FROM:'alerts@demo.test'});
    await sendQueued(); assert.equal(calls.length,0);
    for (const k of ['EMAIL_PROVIDER','EMAIL_API_KEY','EMAIL_FROM']) delete process.env[k];
    const bad=await insert('+13125550999');
    assert.equal(await sendQueuedWhatsapp(),1);
    assert.equal(calls.length,2);
    const c=calls.find(x=>JSON.parse(x.init.body).to==='919876543210');
    assert.equal(c.url,'https://graph.facebook.com/v99.0/1234567890/messages');
    assert.equal(c.init.method,'POST');
    assert.deepEqual(c.init.headers,{authorization:'Bearer secret-test-token','content-type':'application/json'});
    assert.deepEqual(JSON.parse(c.init.body),{messaging_product:'whatsapp',recipient_type:'individual',to:'919876543210',type:'template',
      template:{name:'mouldcare_alert',language:{code:'en_US'},components:[{type:'body',parameters:[{type:'text',text:'Critical machine alert'},{type:'text',text:'IMM-04 - Oil hot - severity critical'}]}]}});
    const sent=await one('SELECT * FROM notification_outbox WHERE id=?',waiting), failed=await one('SELECT * FROM notification_outbox WHERE id=?',bad);
    assert.equal(sent.status,'sent'); assert.ok(sent.sent_at);
    assert.equal(failed.status,'failed'); assert.match(failed.error,/^400 .*Recipient not on WhatsApp/); assert.doesNotMatch(failed.error,/secret-test-token/);
    assert.equal(await sendQueuedWhatsapp(),0,'sent and failed rows are not retried');
    // A network error marks the row failed too.
    const down=await insert('+919876543210'); globalThis.fetch=async ()=>{ throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); };
    await sendQueuedWhatsapp(); assert.deepEqual([(await one('SELECT status FROM notification_outbox WHERE id=?',down)).status],['failed']);
    // Template variables cannot hold new lines or long runs of spaces.
    const body=JSON.parse(whatsappRequest({recipient:'+919876543210',subject:'A\nB',body:'x     y\t'+'z'.repeat(900)}).init.body);
    assert.deepEqual(body.template.components[0].parameters.map(p=>[p.text.includes('\n'),p.text.length<=500]),[[false,true],[false,true]]);
    assert.equal(body.template.components[0].parameters[1].text.slice(0,4),'x y ');
  } finally { globalThis.fetch=realFetch; unconfigure(); }
});

test('channel status for admins: shows whether email and WhatsApp are set up, never the token',async()=>{
  assert.equal((await call('/alerts/channels','GET',null,tokens.acme)).status,403);
  let s=(await call('/alerts/channels','GET',null,tokens.admin)).data;
  assert.deepEqual([s.email.configured,s.whatsapp.configured,s.minSeverity],[false,false,'critical']);
  configure();
  try {
    s=(await call('/alerts/channels','GET',null,tokens.admin)).data;
    assert.deepEqual(s.whatsapp,{configured:true,template:'mouldcare_alert',lang:'en_US',apiVersion:'v99.0'});
    assert.doesNotMatch(JSON.stringify(s),/secret-test-token/);
  } finally { unconfigure(); }
  const outbox=(await call('/alerts/emails','GET',null,tokens.admin)).data;
  assert.ok(outbox.some(m=>m.channel==='whatsapp')&&outbox.some(m=>m.channel==='email'));
});
