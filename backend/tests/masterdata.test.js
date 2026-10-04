import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-masterdata-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one }=await import('../common/db.js');
const { ticketBody, closeOut, atMachine, partBody, quoteBody, contractBody, companyBody, plantBody, equipmentBody }=await import('./fixtures.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',engineer:'engineer@demo.test',acme:'acme@demo.test',nova:'nova@demo.test',atlas:'atlas@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const error=r=>r.data.error||'';

test('catalogue exposes the parameter sets and ISO 14224 code lists',async()=>{
  const c=(await call('/catalog','GET',null,tokens.acme)).data;
  assert.deepEqual(c.specFields.injection.filter(f=>f.required).map(f=>f.key),['clampForceKn','shotVolumeCm3','screwDiameterMm','driveType']);
  assert.ok(c.failureModes.includes('external_leakage')&&c.rootCauses.includes('wear_and_ageing')&&c.actions.includes('replace'));
  assert.equal((await call('/catalog')).status,401);
});

test('equipment needs asset tag, criticality, year and the full parameter set for its type',async()=>{
  const missingSpecs=await call('/equipment','POST',equipmentBody('plant-a','injection',{specs:{clampForceKn:1500}}),tokens.acme);
  assert.equal(missingSpecs.status,400); assert.match(error(missingSpecs),/Missing mandatory injection parameters: Shot volume, Screw diameter, Drive type/);
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','injection',{specs:{clampForceKn:10,shotVolumeCm3:300,screwDiameterMm:45,driveType:'electric'}}),tokens.acme)),/Clamp force must be a number from 50 to 100000 kN/);
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','extrusion',{specs:{lineType:'pipe',screwConfig:'triple',screwDiameterMm:75,ldRatio:33,outputKgH:350}}),tokens.acme)),/Screw configuration must be one of: single, twin/);
  assert.equal((await call('/equipment','POST',equipmentBody('plant-a','injection',{criticality:'D'}),tokens.acme)).status,400);
  assert.equal((await call('/equipment','POST',equipmentBody('plant-a','injection',{yearBuilt:1900}),tokens.acme)).status,400);
  const ok=await call('/equipment','POST',equipmentBody('plant-a','injection',{assetTag:'imm-09'}),tokens.acme);
  assert.equal(ok.status,201); assert.equal(ok.data.asset_tag,'IMM-09'); assert.deepEqual(ok.data.missing,[]); assert.equal(ok.data.specs.driveType,'electric');
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','injection',{assetTag:'IMM-09'}),tokens.acme)),/already used/);
  assert.match(error(await call('/equipment','POST',equipmentBody('plant-a','auxiliary',{specs:{auxType:'dryer',linkedEquipmentId:'eq-n'}}),tokens.acme)),/same company/);
  assert.equal((await call('/equipment','POST',equipmentBody('plant-a','auxiliary',{specs:{auxType:'dryer',linkedEquipmentId:'eq-a'}}),tokens.acme)).status,201);
  assert.match(error(await call(`/equipment/${ok.data.id}`,'PATCH',{specs:{clampForceKn:1600}},tokens.acme)),/Missing mandatory/);
  assert.equal((await call(`/equipment/${ok.data.id}`,'PATCH',{status:'decommissioned'},tokens.acme)).data.status,'decommissioned');
  assert.match(error(await call('/tickets','POST',ticketBody(ok.data.id),tokens.acme)),/decommissioned/);
  db.prepare("INSERT INTO equipment (id,company_id,plant_id,machine_type,make,model,serial_number,location,qr_code,created_at) VALUES ('eq-legacy','c-acme','plant-a','mould','Old','M1','OLD-1','Store','MC:legacy',?)").run(new Date().toISOString());
  const legacy=(await call('/equipment','GET',null,tokens.acme)).data.find(e=>e.id==='eq-legacy');
  assert.deepEqual(legacy.missing,['Asset tag','Year built','Mould number','Cavities','Hot runner','Current shot count','Preventive maintenance interval']);
  assert.ok((await call('/dashboard','GET',null,tokens.acme)).data.incompleteAssets.some(a=>a.id==='eq-legacy'));
});

test('breakdown report and ISO 14224 close-out are mandatory; safety issues become critical',async()=>{
  assert.match(error(await call('/tickets','POST',ticketBody('eq-a',{failureCategory:undefined}),tokens.acme)),/failureCategory must be one of/);
  assert.match(error(await call('/tickets','POST',ticketBody('eq-a',{safetyIssue:undefined}),tokens.acme)),/safetyIssue must be answered/);
  assert.match(error(await call('/tickets','POST',ticketBody('eq-a',{occurredAt:new Date(Date.now()+3600000).toISOString()}),tokens.acme)),/future/);
  const local=await call('/tickets','POST',ticketBody('eq-a',{occurredAt:'2026-09-30T08:00'}),tokens.acme);
  assert.equal(local.data.occurred_at,'2026-09-30T13:00:00.000Z');
  const safety=(await call('/tickets','POST',ticketBody('eq-a',{priority:'low',safetyIssue:true,machineState:'stopped',occurredAt:new Date(Date.now()-90*60000).toISOString()}),tokens.acme)).data;
  assert.equal(safety.priority,'critical'); assert.ok(safety.events.some(e=>e.event_type==='safety'));
  await call(`/tickets/${safety.id}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  for (const status of ['accepted','in_progress']) await call(`/tickets/${safety.id}/status`,'POST',{status},tokens.engineer);
  await call(`/tickets/${safety.id}/work-logs`,'POST',{description:'Guard interlock replaced',minutes:60},tokens.engineer);
  const noCloseOut=await call(`/tickets/${safety.id}/status`,'POST',{status:'completed'},tokens.engineer);
  assert.equal(noCloseOut.status,400); assert.match(error(noCloseOut),/record the failure mode, root cause, action taken/);
  assert.equal((await call(`/tickets/${safety.id}/status`,'POST',{status:'completed',...closeOut,rootCause:'bad_luck'},tokens.engineer)).status,400);
  const done=(await call(`/tickets/${safety.id}/status`,'POST',{status:'completed',...closeOut,...atMachine()},tokens.engineer)).data;
  assert.deepEqual([done.failure_mode,done.root_cause,done.action_taken],['low_output','wear_and_ageing','replace']);
  assert.ok(done.downtime_minutes>=89&&done.downtime_minutes<=95,`auto downtime ${done.downtime_minutes}`);
});

test('contracts need number, coverage, response target, visits and notice period',async()=>{
  assert.match(error(await call('/contracts','POST',contractBody('c-acme',['eq-a'],{contractNumber:''}),tokens.acme)),/contractNumber/);
  assert.match(error(await call('/contracts','POST',contractBody('c-acme',['eq-a'],{responseHours:undefined}),tokens.acme)),/responseHours/);
  assert.match(error(await call('/contracts','POST',contractBody('c-acme',['eq-a'],{coverageHours:'9x9'}),tokens.acme)),/coverageHours must be one of/);
  assert.match(error(await call('/contracts','POST',contractBody('c-acme',['eq-a'],{responseHours:8,restoreHours:4}),tokens.acme)),/Restore target cannot be shorter/);
  assert.match(error(await call('/contracts','POST',contractBody('c-acme',['eq-a'],{contractNumber:'AMC-2026-001'}),tokens.acme)),/already used/);
  assert.equal((await call('/contracts','POST',contractBody('c-nova',['eq-n'],{contractNumber:'AMC-2026-001'}),tokens.nova)).status,201);
  const nova=(await call('/contracts','GET',null,tokens.nova)).data.find(c=>c.id==='contract-n');
  assert.equal(nova.renewalNoticeDue,true); assert.equal(nova.coverage_hours,'24x7');
});

test('spare parts need part number, unit and urgency; quotes need a validity date; ordering needs a PO',async()=>{
  assert.match(error(await call('/tickets/ticket-a/parts','POST',partBody({partNumber:''}),tokens.acme)),/partNumber/);
  assert.match(error(await call('/tickets/ticket-a/parts','POST',partBody({urgency:'whenever'}),tokens.acme)),/urgency must be one of/);
  const part=(await call('/tickets/ticket-a/parts','POST',partBody(),tokens.acme)).data;
  assert.match(error(await call(`/parts/${part.id}/quote`,'POST',quoteBody({validUntil:undefined}),tokens.dispatch)),/validUntil/);
  assert.match(error(await call(`/parts/${part.id}/quote`,'POST',quoteBody({validUntil:'2020-01-01'}),tokens.dispatch)),/between today and one year ahead/);
  const quote=(await call(`/parts/${part.id}/quote`,'POST',quoteBody(),tokens.dispatch)).data;
  db.prepare('UPDATE quotations SET valid_until=? WHERE id=?').run('2026-01-01T00:00:00.000Z',quote.id);
  assert.match(error(await call(`/quotes/${quote.id}/decision`,'POST',{decision:'approved'},tokens.acme)),/expired/);
  const fresh=(await call(`/parts/${part.id}/quote`,'POST',quoteBody(),tokens.dispatch)).data;
  assert.equal((await call(`/quotes/${fresh.id}/decision`,'POST',{decision:'approved'},tokens.acme)).status,200);
  assert.match(error(await call(`/parts/${part.id}/fulfilment`,'POST',{status:'ordered'},tokens.dispatch)),/purchase order number/);
  assert.equal((await call(`/parts/${part.id}/fulfilment`,'POST',{status:'ordered',reference:'PO-1001'},tokens.dispatch)).status,200);
});

test('organisation master data: companies, plants, service areas, users and provider qualification',async()=>{
  assert.match(error(await call('/companies','POST',companyBody({contactPhone:'call me'}),tokens.admin)),/contactPhone must be a phone number/);
  assert.match(error(await call('/companies','POST',companyBody({country:'India'}),tokens.admin)),/two-letter code/);
  const company=(await call('/companies','POST',companyBody(),tokens.admin)).data; assert.deepEqual(company.missing??[],[]);
  assert.equal((await call('/service-areas','POST',{code:'IN-W',name:'India – West'},tokens.acme)).status,403);
  assert.match(error(await call('/service-areas','POST',{code:'bad code!',name:'x'},tokens.admin)),/Code must be/);
  assert.equal((await call('/service-areas','POST',{code:'in-w',name:'India – West'},tokens.admin)).data.code,'IN-W');
  assert.match(error(await call('/service-areas','POST',{code:'IN-W',name:'dup'},tokens.admin)),/already exists/);
  assert.match(error(await call('/plants','POST',plantBody(company.id,{serviceArea:'XX-NOWHERE'}),tokens.admin)),/Unknown service area/);
  assert.match(error(await call('/plants','POST',plantBody(company.id,{operatingPattern:undefined}),tokens.admin)),/operatingPattern/);
  assert.equal((await call('/plants','POST',plantBody(company.id,{serviceArea:'in-w'}),tokens.admin)).data.service_area,'IN-W');
  const engineer={name:'Ravi Kumar',email:'ravi@service.test',role:'engineer',password:'Temporary-Pass-123',serviceAreas:['IN-W'],skills:['injection']};
  assert.match(error(await call('/users','POST',engineer,tokens.admin)),/phone/);
  assert.match(error(await call('/users','POST',{...engineer,phone:'+91 98450 00000',serviceAreas:[]},tokens.admin)),/at least one service area/);
  assert.equal((await call('/users','POST',{...engineer,phone:'+91 98450 00000'},tokens.admin)).status,201);

  const provider={name:'Deccan Polymers Service',serviceAreas:['IN-W'],skills:['injection'],contactName:'Anil',contactEmail:'anil@deccan.test',contactPhone:'+91 80 5555 0101',country:'IN'};
  assert.match(error(await call('/providers','POST',{...provider,serviceAreas:['NOPE']},tokens.admin)),/Unknown service area/);
  const p=(await call('/providers','POST',provider,tokens.admin)).data;
  assert.match(error(await call(`/providers/${p.id}/approval`,'PATCH',{approved:true},tokens.admin)),/Insurance expiry/);
  await call(`/providers/${p.id}`,'PATCH',{insuranceExpiry:'2020-01-01'},tokens.admin);
  assert.match(error(await call(`/providers/${p.id}/approval`,'PATCH',{approved:true},tokens.admin)),/Insurance has expired/);
  await call(`/providers/${p.id}`,'PATCH',{insuranceExpiry:'2030-01-01',certifications:'ISO 9001'},tokens.admin);
  assert.equal((await call(`/providers/${p.id}/approval`,'PATCH',{approved:true},tokens.admin)).data.approved,1);
  assert.equal((await call(`/providers/${p.id}`,'PATCH',{name:'x'},tokens.dispatch)).status,403);
});

test('settings: default response targets and editable standard checklists',async()=>{
  assert.equal((await call('/settings/response-targets','PATCH',{critical:2},tokens.acme)).status,403);
  assert.match(error(await call('/settings/response-targets','PATCH',{critical:10,high:8},tokens.admin)),/must not get shorter/);
  assert.deepEqual((await call('/settings/response-targets','PATCH',{critical:2,high:6,medium:24,low:72},tokens.admin)).data,{critical:2,high:6,medium:24,low:72});
  const uncovered=(await call('/tickets','POST',ticketBody('eq-b',{priority:'high'}),tokens.acme)).data;
  assert.equal(uncovered.coverage,null); assert.deepEqual([uncovered.responseSource,uncovered.responseHours],['default',6]);
  const covered=(await call('/tickets/ticket-a','GET',null,tokens.acme)).data;
  assert.deepEqual([covered.responseSource,covered.responseHours,covered.coverage.contractNumber],['contract',8,'AMC-2026-001']); assert.ok(covered.restoreDueAt);
  assert.equal((await call('/settings/checklists/mould','PATCH',{items:['Clean vents']},tokens.dispatch)).status,403);
  assert.match(error(await call('/settings/checklists/mould','PATCH',{items:['A','a']},tokens.admin)),/unique/);
  assert.deepEqual((await call('/settings/checklists/mould','PATCH',{items:['Clean vents','Check ejectors','Record shot count']},tokens.admin)).data,['Clean vents','Check ejectors','Record shot count']);
  await call(`/tickets/${uncovered.id}/assign`,'POST',{assigneeType:'engineer',assigneeId:'u-engineer'},tokens.dispatch);
  assert.deepEqual((await call(`/tickets/${uncovered.id}/status`,'POST',{status:'accepted'},tokens.engineer)).data.checklist.map(c=>c.item),['Clean vents','Check ejectors','Record shot count']);
});

test('dashboard reports MTTR, MTBF, availability and a 12-week trend',async()=>{
  const d=(await call('/dashboard','GET',null,tokens.acme)).data;
  assert.equal(d.weekly.length,12); assert.ok(d.weekly.every(w=>/^\d{4}-\d\d-\d\d$/.test(w.weekStart)));
  assert.ok(d.kpi.mttrHours>0); assert.ok(d.kpi.mtbfHours>0); assert.ok(d.kpi.availabilityPct>90&&d.kpi.availabilityPct<=100);
  assert.equal(d.kpi.periodDays,90);
  assert.equal((await call('/dashboard','GET',null,tokens.atlas)).data.kpi.mtbfHours,null);
});

test('failure coding lists: a platform admin adds and deletes codes; recorded tickets keep theirs',async()=>{
  const cat=async()=>(await call('/catalog','GET',null,tokens.acme)).data;
  assert.equal((await call('/settings/codes/failureCategories','POST',{label:'Lubrication'},tokens.acme)).status,403);
  assert.equal((await call('/settings/codes/machineTypes','POST',{label:'Robot'},tokens.admin)).status,400);
  const added=await call('/settings/codes/failureCategories','POST',{label:'Lubrication & grease'},tokens.admin);
  assert.equal(added.status,201); assert.equal(added.data.code,'lubrication_and_grease');
  assert.equal((await cat()).failureCategories.at(-1),'lubrication_and_grease');
  assert.match(error(await call('/settings/codes/failureCategories','POST',{label:'lubrication and GREASE'},tokens.admin)),/already in the list/);
  // The new code is accepted on a ticket straight away.
  const t=await call('/tickets','POST',ticketBody('eq-a',{failureCategory:'lubrication_and_grease'}),tokens.acme);
  assert.equal(t.status,201);
  assert.equal((await call('/settings/codes/failureCategories/lubrication_and_grease','DELETE',null,tokens.acme)).status,403);
  const del=await call('/settings/codes/failureCategories/lubrication_and_grease','DELETE',null,tokens.admin);
  assert.equal(del.data.ticketsKeepingCode,1); assert.ok(!(await cat()).failureCategories.includes('lubrication_and_grease'));
  assert.equal((await call(`/tickets/${t.data.id}`,'GET',null,tokens.acme)).data.failure_category,'lubrication_and_grease');
  assert.match(error(await call('/tickets','POST',ticketBody('eq-a',{failureCategory:'lubrication_and_grease'}),tokens.acme)),/failureCategory must be one of/);
  assert.equal((await call('/settings/codes/failureCategories/lubrication_and_grease','DELETE',null,tokens.admin)).status,404);
  // Close-out lists are editable too, but never emptied.
  for (const code of (await cat()).actions.slice(1)) assert.equal((await call(`/settings/codes/actions/${code}`,'DELETE',null,tokens.admin)).status,200);
  assert.match(error(await call(`/settings/codes/actions/${(await cat()).actions[0]}`,'DELETE',null,tokens.admin)),/at least one/);
});
