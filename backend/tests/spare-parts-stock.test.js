import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partBody, plantBody, ticketBody } from './fixtures.js';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-stock-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run }=await import('../common/db.js');
const { hashPassword }=await import('../common/security.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,headers={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...headers},body:body==null?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}return {status:r.status,data,headers:r.headers};}
const login=async email=>(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token;
// A plant manager for Acme (the demo has none).
await run("INSERT INTO users (id,company_id,name,email,password_hash,role,active,created_at) VALUES ('u-acme-pm','c-acme','Pat Plant','pm@demo.test',?,'plant_manager',1,?)",hashPassword('DemoPass123!'),new Date().toISOString());
const tokens={acme:await login('acme@demo.test'),maint:await login('maint@demo.test'),pm:await login('pm@demo.test'),nova:await login('nova@demo.test'),engineer:await login('engineer@demo.test'),
  dispatch:await login('dispatch@demo.test'),admin:await login('admin@demo.test'),atlas:await login('atlas@demo.test'),euro:await login('euro@demo.test')};
let serial=0;
const newPart=async (extra={},token=tokens.acme)=>{ const r=await call('/spare-parts','POST',{partNumber:`TP-${++serial}-${Date.now().toString(36)}`,name:'Test part',unit:'pcs',unitCostMinor:1000,supplier:'Test Supply',...extra},token); assert.equal(r.status,201,JSON.stringify(r.data)); return r.data; };
const stocked=(qty,extra={})=>newPart({...extra,initialStock:{plantId:'plant-a',bin:'A-1',quantity:qty}});
const part=async id=>(await call(`/spare-parts/${id}`,'GET',null,tokens.acme)).data;
const ledger=async id=>(await one('SELECT COALESCE(SUM(quantity),0) n FROM spare_movements WHERE part_id=?',id)).n;
const openAlerts=async id=>(await one("SELECT count(*)::int n FROM alerts WHERE dedupe_key=? AND status<>'resolved'",`stock-low:${id}`)).n;

test('demo stock is seeded with bins, a low item and its alert',async()=>{
  const list=(await call('/spare-parts','GET',null,tokens.acme)).data;
  assert.ok(list.length>=8); assert.ok(list.every(p=>p.company_id==='c-acme'));
  assert.ok(list.find(p=>p.part_number==='HYD-OIL-46').low);
  assert.equal(list.find(p=>p.part_number==='TC-J-150').low,false,'on order covers the thermocouples');
  assert.equal(await openAlerts('sp-hyd-oil-46'),1);
  assert.deepEqual((await call('/spare-parts/reconcile','GET',null,tokens.acme)).data.mismatches,[]);
});

test('tenancy: no access to another company\'s stock',async()=>{
  const p=await stocked(5);
  assert.ok((await call('/spare-parts','GET',null,tokens.nova)).data.every(x=>x.company_id==='c-nova'));
  assert.equal((await call(`/spare-parts/${p.id}`,'GET',null,tokens.nova)).status,403);
  assert.equal((await call(`/spare-parts/${p.id}`,'PATCH',{name:'Mine now'},tokens.nova)).status,403);
  assert.equal((await call(`/spare-parts/${p.id}/receive`,'POST',{plantId:'plant-a',quantity:1},tokens.nova)).status,403);
  assert.equal((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-n',quantity:1},tokens.nova)).status,403);
  // Nova cannot point its own part at Acme's plant or Acme's ticket.
  const n=await newPart({},tokens.nova);
  assert.equal((await call(`/spare-parts/${n.id}/receive`,'POST',{plantId:'plant-a',quantity:1},tokens.nova)).status,400);
  assert.equal((await call(`/spare-parts/${n.id}/issue`,'POST',{ticketId:'ticket-a',quantity:1},tokens.nova)).status,403);
  assert.equal((await call('/spare-parts','POST',{companyId:'c-acme',partNumber:'X-1',name:'x'},tokens.nova)).status,403);
  assert.equal((await call('/spare-parts/reorder?companyId=c-acme','GET',null,tokens.nova)).status,403);
  assert.equal((await call('/tickets/ticket-a/spare-parts','GET',null,tokens.nova)).status,403);
  // Dispatch sees every company; providers and unassigned staff see no stock list.
  const all=(await call('/spare-parts','GET',null,tokens.dispatch)).data; assert.ok(all.some(x=>x.company_id==='c-acme')&&all.some(x=>x.company_id==='c-nova'));
  assert.deepEqual((await call('/spare-parts','GET',null,tokens.atlas)).data,[]);
  assert.deepEqual((await call('/spare-parts','GET',null,tokens.engineer)).data,[]);
  assert.equal((await call(`/spare-parts/${p.id}`,'GET',null,tokens.atlas)).status,403);
  assert.equal((await call(`/spare-parts/${p.id}`,'GET',null,tokens.engineer)).status,403);
});

test('roles: maintenance issues and returns, managers receive, adjust and transfer, providers only see their tickets',async()=>{
  const p=await stocked(6);
  // Maintenance: view, issue, return; not receive, adjust, transfer or edit.
  assert.equal((await call(`/spare-parts/${p.id}`,'GET',null,tokens.maint)).status,200);
  assert.equal((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:2},tokens.maint)).status,201);
  assert.equal((await call(`/spare-parts/${p.id}/return`,'POST',{ticketId:'ticket-a',quantity:1},tokens.maint)).status,201);
  for (const [path,body] of [['receive',{plantId:'plant-a',quantity:1}],['adjust',{plantId:'plant-a',bin:'A-1',delta:1,reason:'count'}],['transfer',{fromPlantId:'plant-a',fromBin:'A-1',toPlantId:'plant-a',toBin:'B-1',quantity:1}],['orders',{plantId:'plant-a',quantity:1}]])
    assert.equal((await call(`/spare-parts/${p.id}/${path}`,'POST',body,tokens.maint)).status,403,path);
  assert.equal((await call(`/spare-parts/${p.id}`,'PATCH',{name:'x'},tokens.maint)).status,403);
  assert.equal((await call('/spare-parts','POST',{partNumber:'M-1',name:'x'},tokens.maint)).status,403);
  // Plant manager: receive, adjust, transfer, edit; but not below zero.
  assert.equal((await call(`/spare-parts/${p.id}/receive`,'POST',{plantId:'plant-a',bin:'A-1',quantity:4,reference:'DN-1'},tokens.pm)).status,201);
  assert.equal((await call(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId:'plant-a',fromBin:'A-1',toPlantId:'plant-a',toBin:'B-1',quantity:1},tokens.pm)).status,201);
  assert.equal((await call(`/spare-parts/${p.id}`,'PATCH',{reorderPoint:2},tokens.pm)).status,200);
  assert.equal((await call(`/spare-parts/${p.id}/adjust`,'POST',{plantId:'plant-a',bin:'A-1',delta:1},tokens.pm)).status,400,'an adjustment needs a reason');
  assert.match((await call(`/spare-parts/${p.id}/adjust`,'POST',{plantId:'plant-a',bin:'B-1',delta:-5,reason:'Lost'},tokens.pm)).data.error,/administrator/);
  // Dispatch may view and issue, not receive.
  assert.equal((await call(`/spare-parts/${p.id}/receive`,'POST',{plantId:'plant-a',quantity:1},tokens.dispatch)).status,403);
  assert.equal((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:1},tokens.dispatch)).status,201);
  // Engineer assigned to ticket-a: look the part up by its label and issue it to that ticket only.
  const found=(await call(`/tickets/ticket-a/spare-parts?code=${encodeURIComponent(p.qr_code)}`,'GET',null,tokens.engineer)).data;
  assert.equal(found.length,1); assert.equal(found[0].id,p.id); assert.ok(found[0].onHand>0); assert.equal(found[0].issuedToTicket,2);
  assert.equal((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:1},tokens.engineer)).status,201);
  assert.equal((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-n',quantity:1},tokens.engineer)).status,403);
  assert.equal((await call(`/spare-parts/${p.id}/receive`,'POST',{plantId:'plant-a',quantity:1},tokens.engineer)).status,403);
  // Providers: never the stock, but the parts used on a ticket assigned to them, with cost.
  const zsk=await one("SELECT id FROM spare_parts WHERE part_number='ZSK-58-ELEM'");
  assert.equal((await call(`/spare-parts/${zsk.id}/issue`,'POST',{ticketId:'ticket-n',quantity:1},tokens.euro)).status,403);
  assert.equal((await call('/tickets/ticket-n/spare-parts','GET',null,tokens.euro)).status,403);
  assert.equal((await call(`/spare-parts/${zsk.id}/issue`,'POST',{ticketId:'ticket-n',quantity:1},tokens.nova)).status,201);
  const seen=(await call('/tickets/ticket-n','GET',null,tokens.euro)).data.stockUsed;
  assert.equal(seen.lines[0].partNumber,'ZSK-58-ELEM'); assert.equal(seen.totalMinor,89000); assert.equal(seen.currency,'EUR');
  assert.equal((await call('/tickets/ticket-n','GET',null,tokens.atlas)).status,403,'another provider sees nothing');
  // Every movement is audited.
  const moves=(await one('SELECT count(*)::int n FROM spare_movements WHERE part_id=?',p.id)).n, audits=(await one("SELECT count(*)::int n FROM audit_events WHERE entity_id=? AND action LIKE 'stock.%' AND action NOT LIKE 'stock.part.%'",p.id)).n;
  assert.equal(audits,moves);
});

test('ledger: quantities follow the movements, never go negative, and movements cannot be changed',async()=>{
  const p=await stocked(10,{unit:'l'});
  assert.equal((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:2.5},tokens.maint)).status,201);
  assert.equal((await call(`/spare-parts/${p.id}/return`,'POST',{ticketId:'ticket-a',quantity:0.5},tokens.maint)).status,201);
  assert.match((await call(`/spare-parts/${p.id}/return`,'POST',{ticketId:'ticket-a',quantity:3},tokens.maint)).data.error,/issued/,'cannot return more than was issued');
  assert.equal((await call(`/spare-parts/${p.id}/adjust`,'POST',{plantId:'plant-a',bin:'a-1',countedQuantity:7.75,reason:'Stock count'},tokens.acme)).status,201,'bins are case-insensitive');
  assert.equal((await call(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId:'plant-a',fromBin:'A-1',toPlantId:'plant-a',toBin:'B-2',quantity:2},tokens.acme)).status,201);
  let v=await part(p.id);
  assert.equal(v.onHand,7.75); assert.deepEqual(v.stock.map(s=>[s.bin,s.onHand]),[['A-1',5.75],['B-2',2]]);
  assert.equal(await ledger(p.id),7.75);
  assert.deepEqual(v.movements.map(m=>m.type).reverse(),['receive','issue','return','adjust','transfer_out','transfer_in']);
  assert.equal(v.movements.find(m=>m.type==='adjust').quantity,-0.25);
  // Too much: refused and nothing changes. An issue without a bin draws from the fullest bins first.
  const before=(await one('SELECT count(*)::int n FROM spare_movements WHERE part_id=?',p.id)).n;
  assert.match((await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:8},tokens.maint)).data.error,/Not enough stock/);
  assert.match((await call(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId:'plant-a',fromBin:'B-2',toPlantId:'plant-a',toBin:'A-1',quantity:3},tokens.acme)).data.error,/Not enough stock/);
  assert.equal((await one('SELECT count(*)::int n FROM spare_movements WHERE part_id=?',p.id)).n,before);
  const split=await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:7},tokens.maint); assert.equal(split.status,201);
  assert.deepEqual(split.data.movements.map(m=>[m.bin,m.quantity]),[['A-1',-5.75],['B-2',-1.25]]);
  // Below zero only by an administrator, with a reason.
  assert.equal((await call(`/spare-parts/${p.id}/adjust`,'POST',{plantId:'plant-a',bin:'A-1',delta:-1,reason:'Found leaking drum, book the loss'},tokens.acme)).status,201);
  v=await part(p.id); assert.equal(v.onHand,-0.25); assert.equal(await ledger(p.id),-0.25);
  // Units and validation.
  const pcs=await stocked(3);
  assert.match((await call(`/spare-parts/${pcs.id}/issue`,'POST',{ticketId:'ticket-a',quantity:1.5},tokens.maint)).data.error,/whole number/);
  assert.equal((await call(`/spare-parts/${pcs.id}/issue`,'POST',{ticketId:'ticket-a',quantity:0},tokens.maint)).status,400);
  assert.equal((await call(`/spare-parts/${pcs.id}/issue`,'POST',{quantity:1},tokens.maint)).status,400,'an issue needs a ticket or PM job');
  assert.equal((await call(`/spare-parts/${pcs.id}`,'PATCH',{unit:'kg'},tokens.acme)).status,400,'unit is fixed once stock has moved');
  assert.equal((await call('/spare-parts','POST',{partNumber:pcs.part_number.toLowerCase(),name:'dup'},tokens.acme)).status,400,'part numbers are unique per company');
  // Immutable ledger, reconciled balances.
  const m=await one('SELECT id FROM spare_movements WHERE part_id=? LIMIT 1',p.id);
  await assert.rejects(run('UPDATE spare_movements SET quantity=1 WHERE id=?',m.id),/cannot be changed/);
  await assert.rejects(run('DELETE FROM spare_movements WHERE id=?',m.id),/cannot be changed/);
  assert.deepEqual((await call('/spare-parts/reconcile','GET',null,tokens.acme)).data.mismatches,[]);
  // An offline replay of the same issue is applied once.
  const action=crypto.randomUUID(), body={ticketId:'ticket-a',quantity:1};
  const first=await call(`/spare-parts/${pcs.id}/issue`,'POST',body,tokens.maint,{'x-client-action-id':action}), again=await call(`/spare-parts/${pcs.id}/issue`,'POST',body,tokens.maint,{'x-client-action-id':action});
  assert.equal(first.status,201); assert.equal(again.status,200); assert.equal((await part(pcs.id)).onHand,2);
});

test('a ticket\'s parts request is fulfilled from stock: issued to the ticket and its machine, with cost on the ticket',async()=>{
  const p=await stocked(4,{unitCostMinor:2500});
  const req=(await call('/tickets/ticket-a/parts','POST',partBody({partNumber:p.part_number,quantity:3}),tokens.maint)).data;
  const listed=(await call('/parts','GET',null,tokens.maint)).data.find(x=>x.id===req.id);
  assert.equal(listed.stock.partId,p.id); assert.equal(listed.stock.onHand,4);
  assert.equal((await call('/parts','GET',null,tokens.atlas)).data.every(x=>x.stock==null),true,'providers are not shown stock');
  const done=await call(`/parts/${req.id}/issue-from-stock`,'POST',{},tokens.maint);
  assert.equal(done.status,200,JSON.stringify(done.data)); assert.equal(done.data.status,'fulfilled'); assert.equal(done.data.spare_part_id,p.id); assert.match(done.data.fulfilment_reference,/From stock: Chicago Plant/);
  const m=await one('SELECT * FROM spare_movements WHERE parts_request_id=?',req.id);
  assert.equal(m.ticket_id,'ticket-a'); assert.equal(m.equipment_id,'eq-a'); assert.equal(m.type,'issue'); assert.equal(Number(m.quantity),-3);
  const tk=(await call('/tickets/ticket-a','GET',null,tokens.acme)).data, line=tk.stockUsed.lines.find(l=>l.partId===p.id);
  assert.equal(line.quantity,3); assert.equal(line.costMinor,7500); assert.ok(tk.events.some(e=>e.event_type==='part_issued'));
  assert.equal((await call(`/parts/${req.id}/issue-from-stock`,'POST',{},tokens.maint)).status,400,'already fulfilled');
  // Not enough in stock: refused, request unchanged.
  const big=(await call('/tickets/ticket-a/parts','POST',partBody({partNumber:p.part_number,quantity:2}),tokens.maint)).data;
  assert.match((await call(`/parts/${big.id}/issue-from-stock`,'POST',{},tokens.maint)).data.error,/Not enough stock/);
  assert.equal((await one('SELECT status FROM parts_requests WHERE id=?',big.id)).status,'requested');
  // Where used shows the ticket.
  assert.ok((await part(p.id)).whereUsed.tickets.some(t=>t.ticket_id==='ticket-a'&&t.qty===3));
});

test('transfer between plants of the same company',async()=>{
  const second=(await call('/plants','POST',plantBody('c-acme',{name:'Dallas Plant',country:'US',serviceArea:'US-MW',timezone:'America/Chicago'}),tokens.acme));
  assert.equal(second.status,201,JSON.stringify(second.data));
  const p=await stocked(5);
  const t=await call(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId:'plant-a',fromBin:'A-1',toPlantId:second.data.id,toBin:'D-9',quantity:3,reference:'Truck 12'},tokens.acme);
  assert.equal(t.status,201,JSON.stringify(t.data)); assert.equal(t.data.movements[0].transfer_id,t.data.movements[1].transfer_id);
  const v=await part(p.id);
  assert.equal(v.onHand,5,'a transfer does not change the company total');
  assert.deepEqual(v.byPlant.map(x=>[x.plantName,x.onHand]).sort(),[['Chicago Plant',2],['Dallas Plant',3]]);
  assert.equal((await call(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId:'plant-a',fromBin:'A-1',toPlantId:'plant-n',quantity:1},tokens.acme)).status,400,'not to another company\'s plant');
  assert.equal((await call(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId:'plant-a',fromBin:'A-1',toPlantId:'plant-a',toBin:'A-1',quantity:1},tokens.acme)).status,400);
  assert.ok((await call(`/spare-parts?plantId=${second.data.id}`,'GET',null,tokens.acme)).data.some(x=>x.id===p.id));
});

test('reorder list, draft purchase list by supplier, CSV, and orders counting as on order',async()=>{
  const p=await stocked(2,{reorderPoint:5,reorderQty:10,supplier:'Zeta Seals',unitCostMinor:450});
  let r=(await call('/spare-parts/reorder','GET',null,tokens.acme)).data, line=r.lines.find(l=>l.partId===p.id);
  assert.equal(line.suggestedQty,10); assert.equal(line.lineCostMinor,4500);
  const g=r.suppliers.find(s=>s.supplier==='Zeta Seals'); assert.ok(g.lines.some(l=>l.partId===p.id)); assert.equal(g.totalMinor,4500);
  const csv=await call('/spare-parts/reorder/csv','GET',null,tokens.acme);
  assert.match(csv.headers.get('content-type'),/text\/csv/); assert.match(csv.data,/Zeta Seals,.*,pcs,2,0,5,10,4\.50,45\.00,USD/);
  assert.ok(!(await call('/spare-parts/reorder/csv','GET',null,tokens.nova)).data.includes('Zeta Seals'));
  const o=await call(`/spare-parts/${p.id}/orders`,'POST',{plantId:'plant-a',quantity:10,reference:'PO-77'},tokens.acme); assert.equal(o.status,201);
  assert.ok(!(await call('/spare-parts/reorder','GET',null,tokens.acme)).data.lines.some(l=>l.partId===p.id),'on order covers it');
  assert.equal((await part(p.id)).onOrder,10);
  // Receiving part of the order keeps the rest on order; cancelling the rest brings it back on the list.
  assert.equal((await call(`/spare-parts/${p.id}/receive`,'POST',{orderId:o.data.id,bin:'A-1',quantity:2,unitCostMinor:500},tokens.acme)).status,201);
  let v=await part(p.id); assert.equal(v.onHand,4); assert.equal(v.onOrder,8); assert.equal(v.unit_cost_minor,500,'latest purchase price');
  assert.equal((await call(`/spare-orders/${o.data.id}/cancel`,'POST',{},tokens.acme)).status,200);
  r=(await call('/spare-parts/reorder','GET',null,tokens.acme)).data; assert.equal(r.lines.find(l=>l.partId===p.id).suggestedQty,10);
  assert.equal((await call(`/spare-orders/${o.data.id}/cancel`,'POST',{},tokens.acme)).status,400);
  assert.equal((await call(`/spare-orders/${o.data.id}/cancel`,'POST',{},tokens.nova)).status,403);
});

test('low-stock alert is raised once and cleared',async()=>{
  const p=await stocked(5,{reorderPoint:3,reorderQty:6});
  assert.equal(await openAlerts(p.id),0);
  await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:3},tokens.maint);
  assert.equal(await openAlerts(p.id),1);
  const a=await one("SELECT * FROM alerts WHERE dedupe_key=? AND status='open'",`stock-low:${p.id}`);
  assert.equal(a.module,'stock'); assert.equal(a.company_id,'c-acme'); assert.match(a.detail,/2 pcs on hand/);
  await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:1},tokens.maint);
  assert.equal((await one('SELECT count(*)::int n FROM alerts WHERE dedupe_key=?',`stock-low:${p.id}`)).n,1,'still one alert');
  await call(`/spare-parts/${p.id}/receive`,'POST',{plantId:'plant-a',bin:'A-1',quantity:6},tokens.acme);
  assert.equal(await openAlerts(p.id),0); assert.equal((await one('SELECT status FROM alerts WHERE id=?',a.id)).status,'resolved');
  await call(`/spare-parts/${p.id}/issue`,'POST',{ticketId:'ticket-a',quantity:5},tokens.maint);
  assert.equal(await openAlerts(p.id),1,'a new drop raises a new alert');
  await call(`/spare-parts/${p.id}`,'PATCH',{active:false},tokens.acme);
  assert.equal(await openAlerts(p.id),0,'an inactive part is not reordered');
  // The alert shows to the company's people, not to another company.
  assert.equal((await call('/alerts','GET',null,tokens.nova)).data.some(x=>x.dedupe_key===`stock-low:${p.id}`||x.id===a.id),false);
});

test('PM plans list the parts they need and show whether stock is sufficient',async()=>{
  const p=await stocked(1);
  assert.equal((await call('/pm/plans','POST',{equipmentId:'eq-a2',trigger:'calendar',intervalValue:30,lastDoneAt:new Date(Date.now()-28*86400000).toISOString(),parts:[{partId:p.id,quantity:2}]},tokens.acme)).status,201);
  const plan=(await call('/pm/plans','GET',null,tokens.acme)).data.find(x=>x.parts.some(y=>y.partId===p.id));
  assert.equal(plan.status,'due_soon'); assert.equal(plan.stockSufficient,false); assert.deepEqual(plan.parts.map(x=>[x.quantity,x.onHand,x.sufficient]),[[2,1,false]]);
  let d=(await call('/spare-parts/pm-demand','GET',null,tokens.acme)).data.find(x=>x.planId===plan.id); assert.equal(d.sufficient,false);
  await call(`/spare-parts/${p.id}/receive`,'POST',{plantId:'plant-a',bin:'A-1',quantity:2},tokens.acme);
  assert.equal((await call(`/pm/plans/${plan.id}`,'GET',null,tokens.acme)).data.stockSufficient,true);
  // A second, more urgent plan needing the same part takes the stock first.
  const urgent=(await call('/pm/plans','POST',{equipmentId:'eq-a',trigger:'calendar',intervalValue:30,lastDoneAt:new Date(Date.now()-31*86400000).toISOString(),parts:[{partId:p.id,quantity:2}]},tokens.acme)).data;
  const demand=(await call('/spare-parts/pm-demand','GET',null,tokens.acme)).data;
  assert.equal(demand.find(x=>x.planId===urgent.id).sufficient,true); assert.equal(demand.find(x=>x.planId===plan.id).sufficient,false);
  assert.deepEqual((await call('/spare-parts/pm-demand','GET',null,tokens.nova)).data.filter(x=>x.companyId==='c-acme'),[]);
  // Issue the list to the open job (once), then the part's where-used shows the plan.
  const job=urgent.openJobId; assert.ok(job);
  assert.equal((await call(`/pm/jobs/${job}/issue-parts`,'POST',{},tokens.nova)).status,403);
  const issued=await call(`/pm/jobs/${job}/issue-parts`,'POST',{},tokens.maint); assert.equal(issued.status,201,JSON.stringify(issued.data));
  assert.equal(issued.data.movements[0].pm_job_id,job); assert.equal(issued.data.movements[0].equipment_id,'eq-a');
  assert.equal((await call(`/pm/jobs/${job}/issue-parts`,'POST',{},tokens.maint)).status,400);
  assert.equal((await part(p.id)).whereUsed.pmPlans.length,2);
  // Parts must come from the plan's company.
  const nova=await newPart({},tokens.nova);
  assert.equal((await call(`/pm/plans/${plan.id}`,'PATCH',{parts:[{partId:nova.id,quantity:1}]},tokens.acme)).status,400);
});

test('bulk import of the catalogue with opening stock, all or nothing',async()=>{
  const tpl=await call('/import/spare-parts/template','GET',null,tokens.acme); assert.equal(tpl.status,200); assert.match(tpl.data,/partNumber,name,maker,unit/);
  const head='partNumber,name,maker,unit,category,fitsTypes,fitsMachines,unitCost,reorderPoint,reorderQty,leadTimeDays,supplier,plant,bin,openingQty';
  const ok=await call('/import/spare-parts','POST',{csv:`${head}\nIMP-1,Nozzle heater,Hotset,pcs,Heating,injection|mould,IMM-04,12.40,2,5,7,Hotset Inc,Chicago Plant,h-9,4\nIMP-2,Grease,Klüber,kg,Lubricants,,,8,1,2,3,Klüber,,,`},tokens.acme);
  assert.equal(ok.status,200,JSON.stringify(ok.data)); assert.equal(ok.data.imported,2);
  const p=(await call('/spare-parts?q=IMP-1','GET',null,tokens.acme)).data[0];
  assert.equal(p.unit_cost_minor,1240); assert.deepEqual(p.fitsTypes,['injection','mould']); assert.deepEqual(p.fitsEquipmentIds,['eq-a']); assert.deepEqual(p.stock.map(s=>[s.bin,s.onHand]),[['H-9',4]]);
  const bad=await call('/import/spare-parts','POST',{csv:`${head}\nIMP-3,Fine,,pcs,,,,1,,,,,,,\nIMP-4,Broken,,pcs,,,,1,,,,,,,1.5`},tokens.acme);
  assert.equal(bad.status,400); assert.match(bad.data.error,/Row 3/);
  assert.equal((await call('/spare-parts?q=IMP-3','GET',null,tokens.acme)).data.length,0);
  assert.equal((await call('/import/spare-parts','POST',{csv:`${head}\nIMP-5,x,,pcs,,,,,,,,,,,`},tokens.maint)).status,400,'maintenance cannot add to the catalogue');
});

test('IATF evidence pack lists parts used from stock and spares for key machines',async()=>{
  const pack=(await call('/reports/iatf','GET',null,tokens.acme)).data;
  assert.ok(pack.spareStock.issued.some(x=>x.partNumber==='ARB-SEAL-50'&&x.machine.includes('IMM-04')));
  assert.ok(pack.spareStock.keySpares.some(x=>x.partNumber==='ARB-PRV-570-02'));
  assert.ok(pack.gaps.some(g=>g.finding==='Spare parts for criticality A machines below their reorder point'&&g.items.some(i=>i.startsWith('HYD-OIL-46'))));
  assert.ok(!JSON.stringify(pack.spareStock).includes('ZSK-58'),'no other company\'s parts');
  const html=(await call('/reports/iatf/download','GET',null,tokens.acme)).data; assert.match(html,/Replacement parts used from stock/);
});
