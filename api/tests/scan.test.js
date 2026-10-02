import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
await import('../seed.js');
const { createServer }=await import('../server.js');
const { db }=await import('../db.js');
const { ticketBody, closeOut, atMachine, equipmentBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}) {const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});const data=await r.json();return {status:r.status,data};}
async function login(email){const r=await call('/auth/login','POST',{email,password:'DemoPass123!'});assert.equal(r.status,200);return r.data.token;}
const error=r=>r.data.error;
const tokens={};
// Seeded tags: eq-a carries a UHF EPC, eq-b (a mould) an NFC UID.
const EQ_A_RFID='E28011606000020840A1B204';
const noScan=equipmentId=>{const {scanCode,...body}=ticketBody(equipmentId);return body;};

test('setup',async()=>{
  for(const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',engineer:'engineer@demo.test',acme:'acme@demo.test',nova:'nova@demo.test'}))tokens[key]=await login(email);
  // During rollout raising does not need a scan; these tests cover the policy with both steps required.
  assert.deepEqual((await call('/catalog','GET',null,tokens.acme)).data.scanPolicy,{raise:'optional',close:'required'});
  assert.deepEqual((await call('/settings/scan-policy','PATCH',{raise:'required'},tokens.admin)).data,{raise:'required',close:'required'});
});

test('a scan of the QR label or the RFID tag resolves the machine, within tenant limits',async()=>{
  const qr=(await call('/equipment/lookup?code=MC%3Aeq-a','GET',null,tokens.acme)).data;
  assert.equal(qr.id,'eq-a'); assert.equal(qr.scannedVia,'qr'); assert.equal(qr.rfidTag,EQ_A_RFID);
  // Readers format the same UID differently; all forms resolve.
  const tag=(await call(`/equipment/lookup?code=${encodeURIComponent('e2:80:11:60 6000020840a1b204')}`,'GET',null,tokens.acme)).data;
  assert.equal(tag.id,'eq-a'); assert.equal(tag.scannedVia,'rfid');
  assert.equal((await call('/equipment/lookup?code=04-A2-3B-5C-6D-7E-80','GET',null,tokens.acme)).data.id,'eq-b');
  assert.equal((await call('/equipment/lookup?qr=MC%3Aeq-a','GET',null,tokens.acme)).data.id,'eq-a');
  assert.equal((await call(`/equipment/lookup?code=${EQ_A_RFID}`,'GET',null,tokens.nova)).status,403);
  assert.equal((await call('/equipment/lookup?code=NOPE1234','GET',null,tokens.acme)).status,404);
});

test('raising a ticket needs a scan at the machine, or a dispatcher override with a reason',async()=>{
  assert.match(error(await call('/tickets','POST',noScan('eq-a'),tokens.acme)),/Scan the equipment QR label or RFID tag to raise/);
  assert.match(error(await call('/tickets','POST',{...noScan('eq-a'),scanCode:'MC:eq-b'},tokens.acme)),/different machine.*IMM-04/);
  assert.match(error(await call('/tickets','POST',{...noScan('eq-a'),scanCode:'MC:unknown'},tokens.acme)),/not a known equipment/);
  assert.match(error(await call('/tickets','POST',{...noScan('eq-a'),scanCode:'MC:eq-n'},tokens.acme)),/different machine/);
  assert.match(error(await call('/tickets','POST',noScan('eq-a'),tokens.dispatch)),/give a reason/);
  // Scanning alone identifies the machine: no equipment ID needed.
  const {equipmentId,...byTag}=noScan('eq-a');
  const tagged=await call('/tickets','POST',{...byTag,scanCode:EQ_A_RFID},tokens.acme);
  assert.equal(tagged.status,201); assert.equal(tagged.data.equipment_id,'eq-a'); assert.equal(tagged.data.raised_via,'rfid'); assert.ok(tagged.data.raised_scan_at);
  assert.match(tagged.data.events.find(e=>e.event_type==='scan').detail,/RFID tag scanned/);
  // A customer cannot raise on another company's machine by scanning its tag.
  assert.equal((await call('/tickets','POST',{...byTag,scanCode:'MC:eq-n'},tokens.acme)).status,403);
  const phoned=await call('/tickets','POST',{...noScan('eq-a'),scanOverrideReason:'Customer phoned in; label unreadable'},tokens.dispatch);
  assert.equal(phoned.status,201); assert.equal(phoned.data.raised_via,'override'); assert.match(phoned.data.scan_override_reason,/phoned in/);
  // The field app replays a queued raise with the same action ID: one ticket only.
  const actionId=crypto.randomUUID(), queued=ticketBody('eq-a2'), before=db.prepare('SELECT count(*) n FROM tickets').get().n;
  const first=await call('/tickets','POST',queued,tokens.acme,{'x-client-action-id':actionId}), replay=await call('/tickets','POST',queued,tokens.acme,{'x-client-action-id':actionId});
  assert.deepEqual([first.status,replay.status,replay.data.id],[201,200,first.data.id]);
  assert.equal(db.prepare('SELECT count(*) n FROM tickets').get().n,before+1);
});

test('closing a ticket needs a scan of the same machine, or a dispatcher override',async()=>{
  const tid=(await call('/tickets','POST',ticketBody('eq-a'),tokens.acme)).data.id;
  await call(`/tickets/${tid}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  for (const status of ['accepted','in_progress']) assert.equal((await call(`/tickets/${tid}/status`,'POST',{status},tokens.engineer)).status,200);
  await call(`/tickets/${tid}/work-logs`,'POST',{description:'Replaced seal',minutes:60},tokens.engineer);
  assert.match(error(await call(`/tickets/${tid}/status`,'POST',{status:'completed',...closeOut},tokens.engineer)),/Scan the equipment QR label or RFID tag to close/);
  assert.match(error(await call(`/tickets/${tid}/status`,'POST',{status:'completed',...closeOut,...atMachine('eq-b')},tokens.engineer)),/different machine/);
  // An engineer cannot override; only dispatch can.
  assert.match(error(await call(`/tickets/${tid}/status`,'POST',{status:'completed',...closeOut,scanOverrideReason:'In a hurry'},tokens.engineer)),/Scan the equipment/);
  assert.equal(db.prepare('SELECT status FROM tickets WHERE id=?').get(tid).status,'in_progress');
  const done=await call(`/tickets/${tid}/status`,'POST',{status:'completed',...closeOut,scanCode:'e2 80 11 60 60 00 02 08 40 a1 b2 04'},tokens.engineer);
  assert.equal(done.status,200); assert.equal(done.data.status,'completed'); assert.equal(done.data.closed_via,'rfid'); assert.ok(done.data.closed_scan_at);
  assert.match(done.data.events.find(e=>e.event_type==='scan'&&/Closed/.test(e.detail)).detail,/Closed at the machine: RFID/);

  const other=(await call('/tickets','POST',ticketBody('eq-a'),tokens.acme)).data.id;
  await call(`/tickets/${other}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  for (const status of ['accepted','in_progress']) await call(`/tickets/${other}/status`,'POST',{status},tokens.engineer);
  await call(`/tickets/${other}/work-logs`,'POST',{description:'Remote fix by phone',minutes:20},tokens.engineer);
  assert.match(error(await call(`/tickets/${other}/status`,'POST',{status:'completed',...closeOut},tokens.dispatch)),/give a reason/);
  const overridden=(await call(`/tickets/${other}/status`,'POST',{status:'completed',...closeOut,scanOverrideReason:'Fixed remotely, nobody on site'},tokens.dispatch)).data;
  assert.equal(overridden.closed_via,'override'); assert.equal(overridden.closed_scan_at,null); assert.match(overridden.scan_override_reason,/^Close: Fixed remotely/);
});

test('the scan policy is a platform setting',async()=>{
  assert.equal((await call('/settings/scan-policy','PATCH',{raise:'optional'},tokens.acme)).status,403);
  assert.match(error(await call('/settings/scan-policy','PATCH',{raise:'sometimes'},tokens.admin)),/raise must be one of/);
  assert.deepEqual((await call('/settings/scan-policy','PATCH',{raise:'optional'},tokens.admin)).data,{raise:'optional',close:'required'});
  const manual=await call('/tickets','POST',noScan('eq-a'),tokens.acme);
  assert.equal(manual.status,201); assert.equal(manual.data.raised_via,'manual');
  await call('/settings/scan-policy','PATCH',{raise:'required'},tokens.admin);
  assert.equal((await call('/tickets','POST',noScan('eq-a'),tokens.acme)).status,400);
});

test('equipment carries an optional, platform-unique RFID tag that can be replaced',async()=>{
  const created=await call('/equipment','POST',equipmentBody('plant-a','blow',{rfidTag:'04:aa:bb:cc:dd'}),tokens.acme);
  assert.equal(created.status,201); assert.equal(created.data.rfid_tag,'04AABBCCDD');
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','blow',{rfidTag:EQ_A_RFID}),tokens.acme)),/already fixed to another machine/);
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','blow',{rfidTag:'0x1'}),tokens.acme)),/RFID tag must be/);
  assert.equal((await call(`/equipment/${created.data.id}`,'PATCH',{rfidTag:'04AABBCCEE'},tokens.acme)).data.rfid_tag,'04AABBCCEE');
  assert.equal((await call('/equipment/lookup?code=04AABBCCEE','GET',null,tokens.acme)).data.id,created.data.id);
  assert.equal((await call(`/equipment/${created.data.id}`,'PATCH',{rfidTag:null},tokens.acme)).data.rfid_tag,null);
  assert.equal((await call('/equipment/lookup?code=04AABBCCEE','GET',null,tokens.acme)).status,404);
  // A raise by scan of a new machine's own QR label.
  const raised=await call('/tickets','POST',{...noScan(created.data.id),scanCode:created.data.qr_code},tokens.acme);
  assert.equal(raised.status,201); assert.equal(raised.data.raised_via,'qr');
});

test('a machine can use a QR label it already has, and the label can be replaced',async()=>{
  const own=await call('/equipment','POST',equipmentBody('plant-a','blow',{qrCode:'https://labels.acme.example/asset/BM-77'}),tokens.acme);
  assert.equal(own.status,201); assert.equal(own.data.qr_code,'https://labels.acme.example/asset/BM-77');
  assert.equal((await call(`/equipment/lookup?code=${encodeURIComponent('https://labels.acme.example/asset/BM-77')}`,'GET',null,tokens.acme)).data.id,own.data.id);
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','blow',{qrCode:'MC:eq-a'}),tokens.acme)),/already on another machine/);
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','blow',{qrCode:'has space'}),tokens.acme)),/QR code must be/);
  // Empty creates the platform's own code; an edit with an empty code keeps the label.
  assert.match((await call('/equipment','POST',equipmentBody('plant-a','blow',{qrCode:''}),tokens.acme)).data.qr_code,/^MC:[0-9a-f]{12}$/);
  assert.equal((await call(`/equipment/${own.data.id}`,'PATCH',{qrCode:''},tokens.acme)).data.qr_code,'https://labels.acme.example/asset/BM-77');
  assert.equal((await call(`/equipment/${own.data.id}`,'PATCH',{qrCode:'ACME-BM-77-NEW'},tokens.acme)).data.qr_code,'ACME-BM-77-NEW');
  assert.match(error(await call(`/equipment/${own.data.id}`,'PATCH',{qrCode:'MC:eq-b'},tokens.acme)),/already on another machine/);
});

test('the alerts list works for platform staff as well as customers',async()=>{
  for (const who of ['admin','dispatch','acme']) assert.equal((await call('/alerts','GET',null,tokens[who])).status,200,who);
});
