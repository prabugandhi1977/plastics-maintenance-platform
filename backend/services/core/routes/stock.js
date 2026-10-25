// Spare parts stock: catalogue, stock per plant and bin, movements (receive, issue to a ticket or PM job, return,
// adjust with a reason, transfer between plants or bins), purchase orders, the reorder list and PM demand.
// Who may do what (every query is limited to the caller's company; the platform's dispatchers and admins see all):
//   view stock          customer admin, plant manager, maintenance; dispatcher and platform admin
//   issue and return    the same, plus the in-house engineer assigned to the ticket
//   receive, adjust, transfer, orders, catalogue   customer admin and plant manager of the company; platform admin
//   adjust below zero   customer admin or platform admin, always with a reason
// Service providers never see the stock; they see the parts used on tickets assigned to them, on the ticket.
import { id, now, one, all, run, mapSeq, forEachSeq } from '../../../common/db.js';
import { canCompany, canManageCompany, isCustomer, isPlatform, isProvider } from '../../../common/security.js';
import { audit, byId, getTicket, isDispatch, ticketEvent } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { bad, choice, deny, integer, missing, optionalDate, required, stringArray } from '../../../common/validate.js';
import { MACHINE_TYPES, PART_UNITS } from '../../../common/catalog.js';
import { binBalance, binOf, checkReorder, netIssued, partViews, plantBalance, q3, quantityOf, reconcile, record, takeFromPlant } from '../stock.js';
import { planState } from './pm.js';

const STOCK_MANAGERS=['customer_admin','plant_manager'];
export const canManageStock=(u,companyId)=>isPlatform(u)||(STOCK_MANAGERS.includes(u.role)&&u.company_id===companyId);
const canGoNegative=(u,companyId)=>canManageCompany(u,companyId);
const viewCompanies=async u=>isDispatch(u)?(await all('SELECT id FROM companies ORDER BY name')).map(c=>c.id):isCustomer(u)?[u.company_id]:[];
const text=(v,name,max)=>{ const s=String(v??'').trim(); if (s.length>max) bad(`${name} must be at most ${max} characters`); return s; };
const fmt=n=>String(q3(n));
const num=v=>typeof v==='string'&&v.trim()?Number(v):v;
const given=v=>v!=null&&v!=='';

async function getPart(u,key,manage=false) { const p=await byId('spare_parts',key); if (!p) missing(); if (!(manage?canManageStock(u,p.company_id):canCompany(u,p.company_id))) deny(); return p; }
async function plantFor(part,plantId,name='plantId') { const p=plantId?await byId('plants',plantId):null; if (!p||p.company_id!==part.company_id) bad(`${name} must be a plant of the part's company`); return p; }
const view=async part=>(await partViews([part.company_id],{partIds:[part.id]}))[0];

// Taking a part: anyone who can see the company's stock, or the in-house engineer assigned to the ticket.
async function partForIssue(u,key,body) {
  const p=await byId('spare_parts',key); if (!p) missing();
  if (!canCompany(u,p.company_id)) { const t=body.ticketId?await byId('tickets',body.ticketId):null; if (!(u.role==='engineer'&&t&&t.assigned_user_id===u.id&&t.company_id===p.company_id)) deny(); }
  return p;
}
// What a part is taken for: a ticket (linked to its machine) or a preventive maintenance job.
async function targetOf(u,part,body) {
  if (body.ticketId) {
    const t=await getTicket(u,body.ticketId);
    if (isProvider(u)||!(canCompany(u,t.company_id)||(u.role==='engineer'&&t.assigned_user_id===u.id))) deny();
    if (t.company_id!==part.company_id) bad('The part and the ticket belong to different companies');
    return {ticketId:t.id,equipmentId:t.equipment_id,plantId:t.plant_id,ticket:t};
  }
  if (body.pmJobId) {
    const j=await byId('pm_jobs',body.pmJobId); if (!j) missing(); if (!canCompany(u,j.company_id)) deny();
    if (j.company_id!==part.company_id) bad('The part and the job belong to different companies');
    return {pmJobId:j.id,equipmentId:j.equipment_id,plantId:(await byId('pm_plans',j.plan_id)).plant_id};
  }
  bad('Give the ticketId (or pmJobId) the part is taken for');
}

// Catalogue fields from a request body; on an update only the fields sent are changed.
async function fieldsOf(body,companyId,existing) {
  const has=k=>body[k]!==undefined, out={};
  if (!existing||has('partNumber')) out.part_number=required(body.partNumber,'partNumber',80);
  if (!existing||has('name')) out.name=required(body.name,'name',200);
  if (!existing||has('unit')) out.unit=choice(body.unit??'pcs','unit',PART_UNITS);
  const unit=out.unit??existing.unit;
  if (has('maker')) out.maker=text(body.maker,'maker',80);
  if (has('category')) out.category=text(body.category,'category',60);
  if (has('fitsTypes')) out.fits_types=JSON.stringify(Array.isArray(body.fitsTypes)&&body.fitsTypes.length?stringArray(body.fitsTypes,'fitsTypes',MACHINE_TYPES):[]);
  if (has('unitCostMinor')) out.unit_cost_minor=integer(num(body.unitCostMinor),'unitCostMinor',0,10000000000);
  if (has('reorderPoint')) out.reorder_point=quantityOf(body.reorderPoint,'reorderPoint',unit,{zero:true});
  if (has('reorderQty')) out.reorder_qty=quantityOf(body.reorderQty,'reorderQty',unit,{zero:true});
  if (has('leadTimeDays')) out.lead_time_days=integer(num(body.leadTimeDays),'leadTimeDays',0,365);
  if (has('supplier')) out.supplier=text(body.supplier,'supplier',120);
  if (has('barcode')) out.barcode=text(body.barcode,'barcode',80)||null;
  if (has('notes')) out.notes=text(body.notes,'notes',1000);
  if (existing&&has('active')) out.active=body.active?1:0;
  if (out.part_number&&await one('SELECT 1 FROM spare_parts WHERE company_id=? AND lower(part_number)=lower(?) AND id<>?',companyId,out.part_number,existing?.id??'')) bad(`Part number ${out.part_number} is already in the catalogue`);
  if (existing&&out.unit&&out.unit!==existing.unit&&await one('SELECT 1 FROM spare_movements WHERE part_id=?',existing.id)) bad('The unit cannot change once stock has moved; add a new part number instead');
  return out;
}
async function setFits(part,ids) {
  if (!Array.isArray(ids)||ids.length>200) bad('fitsEquipmentIds must be a list of up to 200 machines');
  const unique=[...new Set(ids)];
  for (const e of unique) { const m=await byId('equipment',e); if (!m||m.company_id!==part.company_id) bad('Each machine the part fits must be equipment of the same company'); }
  await run('DELETE FROM spare_part_fits WHERE part_id=?',part.id);
  await forEachSeq(unique,e=>run('INSERT INTO spare_part_fits (part_id,equipment_id) VALUES (?,?)',part.id,e));
}

// Low stock (on hand + on order below the reorder point) with a suggested order, grouped by company and supplier.
async function reorderList(u,companyId) {
  if (companyId) { const c=await byId('companies',companyId); if (!c) missing(); if (!canCompany(u,c.id)) deny(); }
  const parts=(await partViews(companyId?[companyId]:await viewCompanies(u))).filter(p=>p.low);
  const lines=parts.map(p=>({partId:p.id,companyId:p.company_id,companyName:p.companyName,partNumber:p.part_number,name:p.name,maker:p.maker,unit:p.unit,category:p.category,supplier:p.supplier||'',
    onHand:p.onHand,onOrder:p.onOrder,reorderPoint:p.reorder_point,reorderQty:p.reorder_qty,suggestedQty:p.suggestedQty,unitCostMinor:p.unit_cost_minor,lineCostMinor:Math.round(p.suggestedQty*p.unit_cost_minor),
    currency:p.currency,leadTimeDays:p.lead_time_days,plants:p.byPlant}));
  const groups=new Map();
  for (const l of lines) { const k=`${l.companyId}|${l.supplier.toLowerCase()}`; if (!groups.has(k)) groups.set(k,{companyId:l.companyId,companyName:l.companyName,supplier:l.supplier,currency:l.currency,lines:[],totalMinor:0}); const g=groups.get(k); g.lines.push(l); g.totalMinor+=l.lineCostMinor; }
  return {generatedAt:now(),lines,suppliers:[...groups.values()].sort((a,b)=>a.companyName.localeCompare(b.companyName)||(a.supplier||'~').localeCompare(b.supplier||'~'))};
}
const csvCell=v=>{ const s=String(v??''); return /[",\r\n;]/.test(s)?`"${s.replaceAll('"','""')}"`:s; };
const major=(minor,code)=>{ const d=new Intl.NumberFormat('en',{style:'currency',currency:code}).resolvedOptions().maximumFractionDigits; return (minor/10**d).toFixed(d); };

// Upcoming preventive maintenance (due soon, due, overdue or with an open job) and whether stock covers its parts.
// Plans are taken most urgent first and each draws on what the earlier ones left, plant by plant.
async function pmDemand(u) {
  const ids=await viewCompanies(u); if (!ids.length) return [];
  const plans=await all(`SELECT * FROM pm_plans WHERE active=1 AND company_id IN (${ids.map(()=>'?').join(',')}) AND id IN (SELECT plan_id FROM pm_plan_parts)`,...ids);
  const rows=(await mapSeq(plans,async p=>({plan:p,state:await planState(p),job:await one("SELECT id FROM pm_jobs WHERE plan_id=? AND status='open'",p.id)})))
    .filter(x=>x.state.status!=='ok'||x.job).sort((a,b)=>b.state.progress-a.state.progress);
  const left=new Map();
  return await mapSeq(rows,async ({plan,state,job})=>{
    const parts=await mapSeq(await all('SELECT pp.part_id,pp.quantity,p.part_number,p.name,p.unit FROM pm_plan_parts pp JOIN spare_parts p ON p.id=pp.part_id WHERE pp.plan_id=? ORDER BY p.part_number',plan.id),async r=>{
      const k=`${r.part_id}|${plan.plant_id}`; if (!left.has(k)) left.set(k,await plantBalance(r.part_id,plan.plant_id));
      const have=left.get(k), need=q3(r.quantity); left.set(k,q3(have-need));
      return {partId:r.part_id,partNumber:r.part_number,name:r.name,unit:r.unit,quantity:need,onHand:await plantBalance(r.part_id,plan.plant_id),availableForThis:Math.max(0,have),sufficient:have>=need};
    });
    return {planId:plan.id,companyId:plan.company_id,title:plan.title,equipmentId:plan.equipment_id,plantId:plan.plant_id,status:state.status,progress:state.progress,remaining:state.remaining,unit:state.unit,openJobId:job?.id??null,parts,sufficient:parts.every(p=>p.sufficient)};
  });
}

export function register(r) {
  // ---------- Catalogue and stock ----------
  r.get('/spare-parts',async ({u,query})=>{
    let rows=await partViews(await viewCompanies(u));
    const plantId=query.get('plantId'), category=query.get('category'), q=String(query.get('q')||'').trim().toLowerCase();
    if (plantId) rows=rows.filter(p=>p.stock.some(s=>s.plantId===plantId));
    if (category) rows=rows.filter(p=>p.category===category);
    if (query.get('low')==='1'||query.get('low')==='true') rows=rows.filter(p=>p.low);
    if (q) rows=rows.filter(p=>`${p.part_number} ${p.name} ${p.maker} ${p.category} ${p.supplier} ${p.barcode||''} ${p.qr_code}`.toLowerCase().includes(q));
    return rows;
  });
  r.post('/spare-parts',async ({u,body})=>{
    const companyId=body.companyId||u.company_id; if (!companyId) bad('companyId is required');
    const company=await byId('companies',companyId); if (!company) missing(); if (!canManageStock(u,company.id)) deny();
    const f=await fieldsOf(body,company.id,null), key=id(), at=now();
    const qr=given(body.qrCode)?text(body.qrCode,'qrCode',120):`SP:${key}`;
    if (await one('SELECT 1 FROM spare_parts WHERE qr_code=?',qr)) bad('This QR label code is already used by another part');
    const row={id:key,company_id:company.id,...f,qr_code:qr,created_by:u.id,created_at:at,updated_at:at}, cols=Object.keys(row);
    await run(`INSERT INTO spare_parts (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,...cols.map(c=>row[c]));
    const part=await byId('spare_parts',key);
    if (body.fitsEquipmentIds!==undefined) await setFits(part,body.fitsEquipmentIds);
    await audit(u,'stock.part.create','spare_part',key,company.id,{partNumber:f.part_number});
    // Opening balance, e.g. from a bulk import of the existing store.
    if (body.initialStock) { const s=body.initialStock, plant=await plantFor(part,s.plantId,'initialStock.plantId'), qty=quantityOf(s.quantity,'initialStock.quantity',part.unit,{zero:true});
      if (qty>0) await record(u,{part,plantId:plant.id,bin:binOf(s.bin),type:'receive',quantity:qty,reference:text(s.reference,'reference',200)||'Opening balance'}); }
    await checkReorder(key);
    return created(await view(part));
  });
  r.get('/spare-parts/reorder',async ({u,query})=>await reorderList(u,query.get('companyId')));
  r.get('/spare-parts/reorder/csv',async ({u,query,res})=>{
    const list=await reorderList(u,query.get('companyId'));
    const head=['company','supplier','partNumber','name','maker','unit','onHand','onOrder','reorderPoint','suggestedQty','unitCost','lineCost','currency','leadTimeDays','stockedAt'];
    const rows=list.suppliers.flatMap(g=>g.lines.map(l=>[l.companyName,l.supplier,l.partNumber,l.name,l.maker,l.unit,l.onHand,l.onOrder,l.reorderPoint,l.suggestedQty,major(l.unitCostMinor,l.currency),major(l.lineCostMinor,l.currency),l.currency,l.leadTimeDays,l.plants.map(p=>`${p.plantName} ${p.onHand}`).join(' | ')]));
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="spare-parts-reorder-${list.generatedAt.slice(0,10)}.csv"`,'cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end('﻿'+[head,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n');
  });
  r.get('/spare-parts/pm-demand',async ({u})=>await pmDemand(u));
  r.get('/spare-parts/reconcile',async ({u})=>await reconcile(await viewCompanies(u)));
  r.get('/spare-parts/:id',async ({u,params})=>{
    const p=await getPart(u,params.id), v=await view(p);
    const movements=(await all(`SELECT m.*,us.name user_name,pl.name plant_name,t.title ticket_title,e.asset_tag FROM spare_movements m LEFT JOIN users us ON us.id=m.user_id JOIN plants pl ON pl.id=m.plant_id
      LEFT JOIN tickets t ON t.id=m.ticket_id LEFT JOIN equipment e ON e.id=m.equipment_id WHERE m.part_id=? ORDER BY m.seq DESC LIMIT 300`,p.id)).map(m=>({...m,quantity:q3(m.quantity),balance_after:q3(m.balance_after)}));
    const machines=(await all(`SELECT id,asset_tag,make,model,machine_type,plant_id,(id IN (SELECT equipment_id FROM spare_part_fits WHERE part_id=?)) listed FROM equipment
      WHERE company_id=? AND status<>'decommissioned' AND (id IN (SELECT equipment_id FROM spare_part_fits WHERE part_id=?) OR machine_type IN (SELECT jsonb_array_elements_text(?::jsonb))) ORDER BY asset_tag,make`,p.id,p.company_id,p.id,p.fits_types)).map(m=>({...m,listed:!!m.listed}));
    const pmPlans=(await all('SELECT pl.id,pl.title,pl.equipment_id,pl.active,pp.quantity FROM pm_plan_parts pp JOIN pm_plans pl ON pl.id=pp.plan_id WHERE pp.part_id=? ORDER BY pl.title',p.id)).map(x=>({...x,quantity:q3(x.quantity)}));
    const tickets=(await all(`SELECT m.ticket_id,t.title,t.status,t.equipment_id,SUM(-m.quantity) qty,SUM(-m.quantity*m.unit_cost_minor) cost,MAX(m.created_at) last_at FROM spare_movements m JOIN tickets t ON t.id=m.ticket_id
      WHERE m.part_id=? AND m.type IN ('issue','return') GROUP BY m.ticket_id,t.title,t.status,t.equipment_id ORDER BY last_at DESC LIMIT 100`,p.id)).map(x=>({...x,qty:q3(x.qty),cost:Math.round(x.cost)}));
    const orders=(await all("SELECT o.*,pl.name plant_name FROM spare_orders o JOIN plants pl ON pl.id=o.plant_id WHERE o.part_id=? ORDER BY o.created_at DESC LIMIT 50",p.id)).map(o=>({...o,quantity:q3(o.quantity),received_qty:q3(o.received_qty)}));
    return {...v,movements,whereUsed:{machines,pmPlans,tickets},orders,canManage:canManageStock(u,p.company_id)};
  });
  r.patch('/spare-parts/:id',async ({u,body,params})=>{
    const p=await getPart(u,params.id,true), f=await fieldsOf(body,p.company_id,p);
    if (body.qrCode!==undefined) { const qr=text(body.qrCode,'qrCode',120)||`SP:${p.id}`; if (qr!==p.qr_code&&await one('SELECT 1 FROM spare_parts WHERE qr_code=? AND id<>?',qr,p.id)) bad('This QR label code is already used by another part'); f.qr_code=qr; }
    const keys=Object.keys(f);
    if (keys.length) await run(`UPDATE spare_parts SET ${keys.map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=?`,...keys.map(k=>f[k]),now(),p.id);
    if (body.fitsEquipmentIds!==undefined) await setFits(p,body.fitsEquipmentIds);
    await audit(u,'stock.part.update','spare_part',p.id,p.company_id,{fields:[...keys,...(body.fitsEquipmentIds!==undefined?['fits_equipment']:[])]});
    await checkReorder(p.id);
    return await view(await byId('spare_parts',p.id));
  });

  // ---------- Movements ----------
  r.post('/spare-parts/:id/receive',async ({u,body,params})=>{
    const part=await getPart(u,params.id,true); if (!part.active) bad('This part is inactive; reactivate it in the catalogue first');
    const qty=quantityOf(body.quantity,'quantity',part.unit);
    let order=null;
    if (body.orderId) { order=await byId('spare_orders',body.orderId); if (!order||order.part_id!==part.id) bad('The order is not for this part'); if (order.status!=='open') bad(`This order is already ${order.status}`); }
    const plant=await plantFor(part,body.plantId||order?.plant_id);
    const cost=given(body.unitCostMinor)?integer(num(body.unitCostMinor),'unitCostMinor',0,10000000000):null;
    const m=await record(u,{part,plantId:plant.id,bin:binOf(body.bin),type:'receive',quantity:qty,orderId:order?.id??null,reference:text(body.reference,'reference',200)||order?.reference||'',unitCostMinor:cost});
    // The latest purchase price becomes the part's unit cost.
    if (cost!=null&&cost!==part.unit_cost_minor) await run('UPDATE spare_parts SET unit_cost_minor=?,updated_at=? WHERE id=?',cost,now(),part.id);
    if (order) { const got=q3(Number(order.received_qty)+qty); await run('UPDATE spare_orders SET received_qty=?,status=?,updated_at=? WHERE id=?',got,got>=Number(order.quantity)?'received':'open',now(),order.id); }
    await checkReorder(part.id);
    return created({movements:[m],part:await view(part)});
  });
  r.post('/spare-parts/:id/issue',async ({u,body,params})=>{
    const part=await partForIssue(u,params.id,body), to=await targetOf(u,part,body);
    const plant=body.plantId?await plantFor(part,body.plantId):await byId('plants',to.plantId), qty=quantityOf(body.quantity,'quantity',part.unit);
    let requestId=null;
    if (body.partsRequestId) { const pr=await byId('parts_requests',body.partsRequestId); if (!pr||pr.ticket_id!==to.ticketId) bad('The parts request must be on the same ticket'); requestId=pr.id; }
    const moves=await takeFromPlant(u,part,plant.id,given(body.bin)?binOf(body.bin):null,qty,{type:'issue',ticketId:to.ticketId??null,equipmentId:to.equipmentId,pmJobId:to.pmJobId??null,partsRequestId:requestId,reason:text(body.note,'note',500)});
    if (to.ticketId) await ticketEvent(to.ticketId,u,'part_issued',`${fmt(qty)} ${part.unit} ${part.part_number} ${part.name} from stock (${plant.name})`);
    await checkReorder(part.id);
    return created({movements:moves,part:await view(part)});
  },{offline:true});
  r.post('/spare-parts/:id/return',async ({u,body,params})=>{
    const part=await partForIssue(u,params.id,body), to=await targetOf(u,part,body), qty=quantityOf(body.quantity,'quantity',part.unit);
    const net=await netIssued(part.id,to);
    if (qty>net) bad(`Only ${fmt(net)} ${part.unit} of ${part.part_number} ${net===1?'was':'were'} issued to this ${to.ticketId?'ticket':'job'} and not returned yet`);
    const last=await one(`SELECT plant_id,bin,unit_cost_minor FROM spare_movements WHERE part_id=? AND type='issue' AND ${to.ticketId?'ticket_id':'pm_job_id'}=? ORDER BY seq DESC LIMIT 1`,part.id,to.ticketId||to.pmJobId);
    const plant=body.plantId?await plantFor(part,body.plantId):await byId('plants',last.plant_id);
    const bin=given(body.bin)?binOf(body.bin):plant.id===last.plant_id?last.bin:'';
    // Returned at the cost it was issued at, so the ticket's parts cost nets out.
    const m=await record(u,{part,plantId:plant.id,bin,type:'return',quantity:qty,ticketId:to.ticketId??null,equipmentId:to.equipmentId,pmJobId:to.pmJobId??null,reason:text(body.reason,'reason',500),unitCostMinor:last.unit_cost_minor});
    if (to.ticketId) await ticketEvent(to.ticketId,u,'part_returned',`${fmt(qty)} ${part.unit} ${part.part_number} returned to stock (${plant.name}${bin?' '+bin:''})`);
    await checkReorder(part.id);
    return created({movements:[m],part:await view(part)});
  },{offline:true});
  r.post('/spare-parts/:id/adjust',async ({u,body,params})=>{
    const part=await getPart(u,params.id,true), plant=await plantFor(part,body.plantId), bin=binOf(body.bin), reason=required(body.reason,'reason',500);
    const current=q3(await binBalance(part.id,plant.id,bin)), counted=given(body.countedQuantity), delta0=given(body.delta);
    if (counted===delta0) bad('Give either countedQuantity (the quantity counted) or delta (the change)');
    const delta=counted?q3(quantityOf(body.countedQuantity,'countedQuantity',part.unit,{zero:true})-current):quantityOf(body.delta,'delta',part.unit,{signed:true});
    if (delta===0) bad('The count matches the stock; nothing to adjust');
    const negative=canGoNegative(u,part.company_id);
    if (q3(current+delta)<0&&!negative) bad(`Not enough stock: ${fmt(current)} ${part.unit} in ${plant.name}${bin?` bin ${bin}`:''}. Only an administrator can adjust stock below zero.`);
    const m=await record(u,{part,plantId:plant.id,bin,type:'adjust',quantity:delta,reason,reference:text(body.reference,'reference',200),allowNegative:negative});
    await checkReorder(part.id);
    return created({movements:[m],part:await view(part)});
  });
  r.post('/spare-parts/:id/transfer',async ({u,body,params})=>{
    const part=await getPart(u,params.id,true), from=await plantFor(part,body.fromPlantId,'fromPlantId'), to=await plantFor(part,body.toPlantId,'toPlantId');
    const fromBin=binOf(body.fromBin), toBin=binOf(body.toBin), qty=quantityOf(body.quantity,'quantity',part.unit), reference=text(body.reference,'reference',200), transferId=id();
    if (from.id===to.id&&fromBin===toBin) bad('Choose a different plant or bin to transfer to');
    const out=await record(u,{part,plantId:from.id,bin:fromBin,type:'transfer_out',quantity:-qty,transferId,reference,reason:`To ${to.name}${toBin?' '+toBin:''}`});
    const inn=await record(u,{part,plantId:to.id,bin:toBin,type:'transfer_in',quantity:qty,transferId,reference,reason:`From ${from.name}${fromBin?' '+fromBin:''}`});
    await checkReorder(part.id);
    return created({movements:[out,inn],part:await view(part)});
  });

  // ---------- Purchase orders (stock on order) ----------
  r.get('/spare-orders',async ({u,query})=>{
    const ids=await viewCompanies(u); if (!ids.length) return [];
    const status=query.get('status')||'open'; choice(status,'status',['open','received','cancelled','all']);
    return (await all(`SELECT o.*,p.part_number,p.name,p.unit,pl.name plant_name FROM spare_orders o JOIN spare_parts p ON p.id=o.part_id JOIN plants pl ON pl.id=o.plant_id
      WHERE o.company_id IN (${ids.map(()=>'?').join(',')})${status==='all'?'':' AND o.status=?'} ORDER BY o.created_at DESC LIMIT 500`,...ids,...(status==='all'?[]:[status]))).map(o=>({...o,quantity:q3(o.quantity),received_qty:q3(o.received_qty)}));
  });
  r.post('/spare-parts/:id/orders',async ({u,body,params})=>{
    const part=await getPart(u,params.id,true); if (!part.active) bad('This part is inactive; reactivate it in the catalogue first');
    const plant=await plantFor(part,body.plantId), qty=quantityOf(body.quantity,'quantity',part.unit), key=id(), at=now();
    const expected=optionalDate(body.expectedAt,'expectedAt')??new Date(Date.now()+Number(part.lead_time_days||0)*86400000).toISOString();
    await run('INSERT INTO spare_orders (id,company_id,part_id,plant_id,quantity,supplier,reference,status,expected_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      key,part.company_id,part.id,plant.id,qty,text(body.supplier??part.supplier,'supplier',120),text(body.reference,'reference',200),'open',expected,u.id,at,at);
    await audit(u,'stock.order.create','spare_order',key,part.company_id,{partId:part.id,quantity:qty,plantId:plant.id});
    await checkReorder(part.id);
    return created(await byId('spare_orders',key));
  });
  r.post('/spare-orders/:id/cancel',async ({u,params})=>{
    const o=await byId('spare_orders',params.id); if (!o) missing(); if (!canManageStock(u,o.company_id)) deny();
    if (o.status!=='open') bad(`This order is already ${o.status}`);
    await run("UPDATE spare_orders SET status='cancelled',updated_at=? WHERE id=?",now(),o.id);
    await audit(u,'stock.order.cancel','spare_order',o.id,o.company_id,{partId:o.part_id});
    await checkReorder(o.part_id);
    return await byId('spare_orders',o.id);
  });

  // ---------- Tickets and preventive maintenance ----------
  // Parts for the job in hand (field app): by scanned code, by search text, or else those that fit the ticket's machine,
  // with the stock at the ticket's plant and what is already issued to the ticket.
  r.get('/tickets/:id/spare-parts',async ({u,params,query})=>{
    const t=await getTicket(u,params.id); if (isProvider(u)||!(canCompany(u,t.company_id)||(u.role==='engineer'&&t.assigned_user_id===u.id))) deny();
    const asset=await byId('equipment',t.equipment_id), code=String(query.get('code')||'').trim(), q=String(query.get('q')||'').trim().toLowerCase();
    const listed=new Set((await all('SELECT part_id FROM spare_part_fits WHERE equipment_id=?',t.equipment_id)).map(x=>x.part_id));
    let parts=(await all('SELECT * FROM spare_parts WHERE company_id=? AND active=1 ORDER BY part_number',t.company_id)).map(p=>({...p,fits:listed.has(p.id)||JSON.parse(p.fits_types||'[]').includes(asset?.machine_type)}));
    if (code) parts=parts.filter(p=>p.qr_code===code||(p.barcode&&p.barcode===code)||p.part_number.toLowerCase()===code.toLowerCase());
    else if (q) parts=parts.filter(p=>`${p.part_number} ${p.name} ${p.maker} ${p.category} ${p.barcode||''}`.toLowerCase().includes(q));
    else parts=parts.filter(p=>p.fits);
    parts.sort((a,b)=>b.fits-a.fits);
    return await mapSeq(parts.slice(0,30),async p=>({id:p.id,partNumber:p.part_number,name:p.name,maker:p.maker,unit:p.unit,category:p.category,qrCode:p.qr_code,barcode:p.barcode,fitsThisMachine:p.fits,
      onHand:await plantBalance(p.id,t.plant_id),bins:(await all('SELECT bin,on_hand FROM spare_stock WHERE part_id=? AND plant_id=? AND on_hand<>0 ORDER BY bin',p.id,t.plant_id)).map(b=>({bin:b.bin,onHand:q3(b.on_hand)})),
      issuedToTicket:await netIssued(p.id,{ticketId:t.id})}));
  });
  // A ticket's parts request fulfilled from stock: the part is issued to the ticket and the request closes as fulfilled.
  r.post('/parts/:id/issue-from-stock',async ({u,body,params})=>{
    const pr=await byId('parts_requests',params.id); if (!pr) missing();
    const t=await getTicket(u,pr.ticket_id); if (isProvider(u)||!(canCompany(u,t.company_id)||(u.role==='engineer'&&t.assigned_user_id===u.id))) deny();
    if (['fulfilled','rejected'].includes(pr.status)) bad(`A ${pr.status} request cannot be fulfilled from stock`);
    const part=body.sparePartId?await byId('spare_parts',body.sparePartId)
      :pr.spare_part_id?await byId('spare_parts',pr.spare_part_id):await one('SELECT * FROM spare_parts WHERE company_id=? AND lower(part_number)=lower(?) AND active=1',t.company_id,pr.part_number);
    if (!part||part.company_id!==t.company_id) bad('No part in the stock catalogue matches this request; choose the part to issue');
    if (part.unit!==pr.unit) bad(`The request is in ${pr.unit} but ${part.part_number} is counted in ${part.unit}`);
    const plant=body.plantId?await plantFor(part,body.plantId):await byId('plants',t.plant_id), qty=q3(pr.quantity);
    const moves=await takeFromPlant(u,part,plant.id,given(body.bin)?binOf(body.bin):null,qty,{type:'issue',ticketId:t.id,equipmentId:t.equipment_id,partsRequestId:pr.id});
    await run("UPDATE quotations SET status='superseded' WHERE request_id=? AND status='pending'",pr.id);
    await run("UPDATE parts_requests SET status='fulfilled',spare_part_id=?,fulfilment_reference=?,updated_at=? WHERE id=?",part.id,`From stock: ${plant.name}${moves.map(m=>m.bin).filter(Boolean).length?' '+[...new Set(moves.map(m=>m.bin).filter(Boolean))].join(', '):''}`.slice(0,200),now(),pr.id);
    await audit(u,'parts.fulfilled','parts_request',pr.id,pr.company_id,{fromStock:true,partId:part.id,plantId:plant.id,movements:moves.map(m=>m.id)});
    await ticketEvent(t.id,u,'part_issued',`${fmt(qty)} ${part.unit} ${part.part_number} ${part.name} from stock (${plant.name}) for the parts request`);
    await checkReorder(part.id);
    return {...await byId('parts_requests',pr.id),movements:moves};
  },{offline:true});
  // All the parts on a PM plan's list, issued to its open job from the plan's plant (all or nothing).
  r.post('/pm/jobs/:id/issue-parts',async ({u,params})=>{
    const j=await byId('pm_jobs',params.id); if (!j) missing(); if (!canCompany(u,j.company_id)) deny();
    if (j.status!=='open') bad('This job is already completed');
    const plan=await byId('pm_plans',j.plan_id), list=await all('SELECT part_id,quantity FROM pm_plan_parts WHERE plan_id=?',plan.id);
    if (!list.length) bad('This plan has no parts list');
    if (await one("SELECT 1 FROM spare_movements WHERE pm_job_id=? AND type='issue'",j.id)) bad('Parts were already issued to this job; issue or return single parts from the stock page');
    const moves=[];
    for (const x of list) { const part=await byId('spare_parts',x.part_id); moves.push(...await takeFromPlant(u,part,plan.plant_id,null,q3(x.quantity),{type:'issue',pmJobId:j.id,equipmentId:j.equipment_id,reason:`PM: ${plan.title}`})); }
    await forEachSeq([...new Set(list.map(x=>x.part_id))],p=>checkReorder(p));
    return created({movements:moves});
  });
}
