import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-tracesuite-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
delete process.env.EMAIL_PROVIDER;
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all }=await import('../common/db.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,extra={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...extra},body:body==null?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
const tokens={};
for (const [key,email] of Object.entries({acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',engineer:'engineer@demo.test'})) tokens[key]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
const intake=events=>call('/integrations/factory/events','POST',{events},null,{'x-integration-key':'test-integration-key'});

test('trace search: any code gives the chain backward and forward, tenant-scoped',async()=>{
  const box=await call('/trace/find?code=b-hsg-2026-041-0004','GET',null,tokens.acme);
  assert.equal(box.data.found.type,'box');
  const c=box.data.chain;
  assert.deepEqual(c.lots.map(l=>l.lot_number),['PCABS-7731']);
  assert.equal(c.batches[0].batchNumber,'B-HSG-2026-041');
  assert.ok(c.batches[0].gates.every(g=>g.result==='pass'));
  assert.deepEqual(c.shipments.map(s=>s.customer),['Meridian Automotive','Meridian Automotive']);
  assert.ok(c.returns.some(r=>r.reference==='FR-2026-0001'));
  assert.equal(c.focusUnit.shipment.shipment_number,'DN-2026-00042');
  for (const [code,type] of [['PCABS-7731','lot'],['DN-2026-00041','shipment'],['FR-2026-0005','return'],['PAL-CAP-2026-101-01','pallet']]) assert.equal((await call(`/trace/find?code=${code}`,'GET',null,tokens.acme)).data.found.type,type,code);
  const none=await call('/trace/find?code=HSG-2026-041-00','GET',null,tokens.acme);
  assert.equal(none.data.found,null); assert.ok(none.data.suggestions.length);
  assert.equal((await call('/trace/find?code=B-HSG-2026-041-0004','GET',null,tokens.nova)).data.found,null);
  assert.equal((await call('/trace/find?code=x1','GET',null,tokens.engineer)).status,403);
  const k=(await call('/trace/kpis','GET',null,tokens.acme)).data;
  assert.ok(k.compliancePct>0&&k.compliancePct<100); assert.equal(k.openDeviations,1); assert.ok(k.missing.some(m=>m.what==='Process deviation decisions'));
});

test('real time: process window at start, live readings open deviations, decisions gate the release',async()=>{
  // The window applies at batch start.
  const r0=await call('/trace/batches','POST',{productId:'pr-cap',equipmentId:'eq-a',mouldId:'eq-b',batchNumber:'W-1',operatorName:'A',plannedQty:100,lots:[{lotId:'lot-pp1'},{lotId:'lot-mb'}],processParams:{meltTempC:250,mouldTempC:35,injectionPressureBar:950,holdPressureBar:520,cycleTimeS:4.9}},tokens.acme);
  assert.match(r0.data.error,/already has a running batch|Outside the validated process window/);
  // Machine readings through the intake go to the batch running on the machine (B-CAP-2026-103 on IMM-04).
  const t=Date.now();
  const at=m=>new Date(t-m*60000).toISOString();
  let res=await intake([{type:'process',deviceId:'demo-device-a',at:at(3),values:{meltTempC:231,cycleTimeS:4.9}},{type:'process',deviceId:'demo-device-a',at:at(2),values:{meltTempC:246.5}},{type:'process',deviceId:'demo-device-a',at:at(1),values:{meltTempC:249}}]);
  assert.equal(res.data.accepted,3,JSON.stringify(res.data.results));
  let dev=await one("SELECT * FROM process_deviations WHERE batch_id='b-cap3' AND parameter='meltTempC'");
  assert.deepEqual([dev.value,dev.readings,dev.max,dev.ended_at],[249,2,240,null]);
  assert.ok(await one("SELECT 1 FROM alerts WHERE dedupe_key=? AND status='open'",`deviation:${dev.id}`));
  await intake([{type:'process',deviceId:'demo-device-a',at:at(0),values:{meltTempC:232}}]);
  assert.ok((await one('SELECT ended_at FROM process_deviations WHERE id=?',dev.id)).ended_at);
  assert.equal((await intake([{type:'process',deviceId:'demo-device-n',at:at(0),values:{meltTempC:1}}])).data.accepted,1);
  // Decisions: only managers; a rejected deviation blocks release.
  assert.equal((await call(`/trace/deviations/${dev.id}/decision`,'POST',{decision:'accepted',disposition:'x'},tokens.maint)).status,403);
  const q=(await call('/trace/batches/b-cap3/quality','GET',null,tokens.acme)).data;
  assert.ok(q.releaseBlockers.includes('Process deviations are waiting for a decision'));
  assert.ok(q.spc.find(s=>s.parameter==='meltTempC').outside>=2);
  assert.equal((await call(`/trace/deviations/${dev.id}/decision`,'POST',{decision:'rejected',disposition:'2 h of production sorted'},tokens.acme)).data.status,'rejected');
  assert.ok(!await one("SELECT 1 FROM alerts WHERE dedupe_key=? AND status='open'",`deviation:${dev.id}`));
  assert.ok((await call('/trace/batches/b-cap3/quality','GET',null,tokens.acme)).data.releaseBlockers.some(b=>/rejected/.test(b)));
  // Housing: hold on deviation – completing with an open deviation puts the batch on hold.
  await call('/trace/products/pr-hsg','PUT',{customer:'Meridian Automotive',warrantyMonths:36,packQty:40,holdOnDeviation:true,processWindow:{meltTempC:{min:255,max:275}},checkSheets:{}},tokens.acme);
  await call('/trace/batches/b-hsg3/readings','POST',{readings:[{parameter:'meltTempC',value:290}]},tokens.maint);
  const done=await call('/trace/batches/b-hsg3/complete','POST',{goodQty:100,scrapQty:0},tokens.maint);
  assert.deepEqual([done.data.status,done.data.hold_reason],['on_hold','Process deviations need a decision']);
  // Product rules validation.
  assert.match((await call('/trace/products/pr-hsg','PUT',{processWindow:{meltTempC:{min:280,max:270}}},tokens.acme)).data.error,/min must be below max/);
  assert.match((await call('/trace/products/pr-hsg','PUT',{checkSheets:{final_qc:[{label:'X',type:'measure'}]}},tokens.acme)).data.error,/numeric min/);
  assert.equal((await call('/trace/products/pr-hsg','PUT',{},tokens.maint)).status,403);
});

test('labels and dispatch: only released batches, the right customer, FIFO warnings, then traceable shipments',async()=>{
  // Labels never exceed the batch quantity; pallets group boxes.
  const b=await one("SELECT * FROM batches WHERE id='b-btl1'");
  assert.match((await call('/trace/batches/b-btl1/units','POST',{kind:'box',count:500,perUnit:250},tokens.maint)).data.error,/more than the batch's good quantity/);
  const boxes=(await call('/trace/batches/b-btl1/units','POST',{kind:'box',count:2,perUnit:250},tokens.maint)).data;
  assert.deepEqual(boxes.map(x=>x.serial),[`${b.batch_number}-0041`,`${b.batch_number}-0042`]);
  const pal=(await call('/trace/pallets','POST',{serials:boxes.map(x=>x.serial)},tokens.maint)).data;
  assert.deepEqual([pal.boxes,pal.quantity],[2,500]);
  assert.match((await call('/trace/pallets','POST',{serials:[boxes[0].serial]},tokens.maint)).data.error,/already on a pallet/);
  // Shipment checks.
  const s=(await call('/trace/shipments','POST',{customer:'CleanHome Products',channel:'distributor',destination:'DC'},tokens.maint)).data;
  assert.match(s.shipment_number,/^DN-\d{4}-\d{5}$/);
  const scan=serial=>call(`/trace/shipments/${s.id}/scan`,'POST',{serial},tokens.maint);
  assert.match((await scan('B-BTL-2026-211-0001')).data.error,/Unknown label|not found/);
  assert.match((await scan('B-CAP-2026-101-0036')).data.error,/made for FreshDrinks Bottling, not CleanHome Products/);
  assert.match((await scan(boxes[0].serial)).data.error,/on a pallet – scan the pallet label/);
  const ok=await scan(pal.serial);
  assert.equal(ok.status,200,JSON.stringify(ok.data)); assert.equal(ok.data.shipment.quantity,500);
  const fifoBox=(await scan('B-BTL-2026-210-0030'));
  assert.equal(fifoBox.status,200); assert.deepEqual(fifoBox.data.warnings,[]);
  // A completed (not released) batch cannot ship.
  const cap2=await call('/trace/shipments','POST',{customer:'FreshDrinks Bottling',channel:'oem'},tokens.maint);
  assert.match((await call(`/trace/shipments/${cap2.data.id}/scan`,'POST',{serial:'B-CAP-2026-102-0001'},tokens.maint)).data.error,/is completed – only released batches may ship/);
  // Ship; labels are then shipped and a second ship is refused.
  const shipped=(await call(`/trace/shipments/${s.id}/ship`,'POST',{},tokens.maint)).data;
  assert.equal(shipped.status,'shipped'); assert.equal((await one('SELECT status FROM trace_units WHERE serial=?',boxes[1].serial)).status,'shipped');
  assert.match((await call(`/trace/shipments/${s.id}/ship`,'POST',{},tokens.maint)).data.error,/already closed/);
  assert.equal((await call(`/trace/shipments/${s.id}/scan`,'POST',{serial:'B-BTL-2026-210-0031'},tokens.nova)).status,403);
});

test('recall scope, warranty authentication, returns, correlation and supplier scorecard',async()=>{
  const r=(await call('/trace/recall?lotId=lot-pcabs','GET',null,tokens.acme)).data;
  assert.deepEqual(r.customers.map(c=>c.customer),['Meridian Automotive']);
  assert.ok(r.shipped.quantity>0&&r.inStock.quantity>0);
  assert.equal((await call('/trace/recall?lotId=lot-pcabs','GET',null,tokens.nova)).status,403);
  // Authentication: genuine, wrong customer, duplicate claim, unknown label.
  const auth=(serial,customer)=>call(`/trace/authenticate?serial=${serial}&customer=${encodeURIComponent(customer)}`,'GET',null,tokens.acme).then(x=>x.data);
  assert.equal((await auth('B-HSG-2026-041-0010','Meridian Automotive')).authenticity,'genuine');
  const wrong=await auth('B-HSG-2026-041-0010','AutoFix Aftermarket');
  assert.equal(wrong.authenticity,'suspicious'); assert.equal(wrong.checks.find(c=>c.check==='Shipped to this customer').ok,false);
  assert.equal((await auth('B-HSG-2026-041-0004','Meridian Automotive')).checks.find(c=>c.check==='Not claimed before').ok,false);
  assert.equal((await auth('B-HSG-2026-041-0050','Meridian Automotive')).checks.find(c=>c.check==='Shipped by us').ok,false);
  assert.equal((await auth('NOPE-1','Meridian Automotive')).authenticity,'not_found');
  // Recording a claim links it to the batch and marks the box returned.
  const fr=await call('/trace/returns','POST',{kind:'warranty_claim',customer:'Meridian Automotive',serial:'B-HSG-2026-041-0010',defect:'Cracked clip',quantity:2},tokens.maint);
  assert.equal(fr.status,201); assert.equal(fr.data.authenticity,'genuine'); assert.equal(fr.data.batch_id,'b-hsg1'); assert.match(fr.data.reference,/^FR-\d{4}-0006$/);
  assert.equal((await one("SELECT status FROM trace_units WHERE serial='B-HSG-2026-041-0010'")).status,'returned');
  assert.match((await call('/trace/returns','POST',{kind:'complaint',customer:'X',defect:'Y'},tokens.maint)).data.error,/serial on the label, or the batch number/);
  assert.equal((await call('/trace/returns','POST',{kind:'complaint',customer:'X',defect:'Y',batchNumber:'b-cap-2026-101'},tokens.maint)).data.batch_id,'b-cap1');
  assert.equal((await call(`/trace/returns/${fr.data.id}`,'PATCH',{status:'accepted',rootCause:'Dryer dew point'},tokens.maint)).status,403);
  assert.equal((await call(`/trace/returns/${fr.data.id}`,'PATCH',{status:'accepted',rootCause:'Dryer dew point'},tokens.acme)).data.status,'accepted');
  // Correlation puts the housing (with its lot, machine and supplier) on top.
  const c=(await call('/trace/correlation','GET',null,tokens.acme)).data;
  assert.equal(c.factors[0].vsAverage>1,true); assert.ok(c.factors.slice(0,6).some(f=>f.dimension==='lot'&&f.label.startsWith('PCABS-7731')));
  const sup=(await call('/trace/suppliers','GET',null,tokens.acme)).data;
  assert.equal(sup[0].supplier,'Polymer Partners'); assert.ok(sup[0].fieldReturns>=3);
  assert.ok((await call('/trace/suppliers','GET',null,tokens.nova)).data.every(s=>!['Polymer Partners','ColorTec'].includes(s.supplier)));
});
