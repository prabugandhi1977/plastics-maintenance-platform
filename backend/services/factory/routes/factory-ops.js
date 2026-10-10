// Smart factory, stages 3–4: traceability, vision quality, safety, and asset tracking routes.
import { id, now, one, all, run, transaction, mapSeq } from '../../../common/db.js';
import { isCustomer, isPlatform } from '../../../common/security.js';
import { audit, byId, isDispatch, visibleTickets } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { HttpError, bad, choice, date, deny, missing, required, array, instant } from '../../../common/validate.js';
import { PRODUCTION_MACHINES, PROCESS_PARAMS, SAFETY_EVENTS, ZONE_KINDS, ASSET_KINDS, TAG_TYPES } from '../../../common/catalog.js';
import { batchSummary, genealogy, lotUsage, quarantineLot } from '../../traceability/trace.js';
import { fifoWarnings, windowOf, releaseBlockers, deviationsOf } from '../../traceability/traceability.js';
import { qualityReport } from '../quality.js';
import { recordSafety, closeSafety, safetyReport } from '../safety.js';
import { checkMissing, assetView } from '../assets.js';
import { plantOf } from '../production.js';

const DAY=86400000;
const canView=u=>isCustomer(u)||isDispatch(u);
const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
const canRecord=(u,companyId)=>isPlatform(u)||(isCustomer(u)&&u.company_id===companyId);
const view=u=>{ if (!canView(u)) deny(); };
const companyFilter=(u,alias='')=>isDispatch(u)?['1=1',[]]:[`${alias}company_id=?`,[u.company_id]];
const owned=(u,row)=>{ if (!row) missing(); if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===row.company_id))) deny(); return row; };
const companyOf=(u,body)=>isCustomer(u)?u.company_id:required(body.companyId,'companyId');
const num=(v,n,min=0,max=1e9)=>{ const x=typeof v==='string'&&v!==''?Number(v):v; if (!Number.isFinite(x)||x<min||x>max) bad(`${n} must be a number from ${min} to ${max}`); return x; };
const code=(v,n)=>{ const c=required(v,n,60).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(c)) bad(`${n} may contain letters, digits, dot, dash, slash or underscore`); return c; };
async function machines(u,{plantId,equipmentId}={}) {
  view(u); const where=[`machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,"status<>'decommissioned'"], args=[...PRODUCTION_MACHINES];
  if (isCustomer(u)) { where.push('company_id=?'); args.push(u.company_id); } if (plantId) { where.push('plant_id=?'); args.push(plantId); } if (equipmentId) { where.push('id=?'); args.push(equipmentId); }
  return await all(`SELECT * FROM equipment WHERE ${where.join(' AND ')} ORDER BY asset_tag`,...args);
}
function range(query,days=7) { const to=query.get('to')?Date.parse(instant(query.get('to'),'to')):Date.now(), from=query.get('from')?Date.parse(instant(query.get('from'),'from')):to-days*DAY; if (!(from<to)) bad('from must be before to'); if (to-from>366*DAY) bad('Choose a range of at most a year'); return {from,to}; }

export function register(r) {
  // ---------- Traceability ----------
  r.get('/trace/lots',async ({u})=>{ view(u); const [w,a]=companyFilter(u); return await all(`SELECT l.*,(SELECT count(*) FROM batch_materials bm WHERE bm.lot_id=l.id) batches FROM material_lots l WHERE ${w} ORDER BY received_at DESC LIMIT 500`,...a); });
  r.post('/trace/lots',async ({u,body})=>{
    const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny(); if (!await byId('companies',companyId)) bad('Unknown company');
    const lot=code(body.lotNumber,'lotNumber'); if (await one('SELECT 1 FROM material_lots WHERE company_id=? AND lot_number=?',companyId,lot)) bad(`Lot ${lot} is already registered`);
    const key=id(); await run('INSERT INTO material_lots (id,company_id,lot_number,material,supplier,received_at,quantity_kg,status,certificate,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',key,companyId,lot,required(body.material,'material',80),required(body.supplier,'supplier',120),date(body.receivedAt,'receivedAt'),num(body.quantityKg,'quantityKg',0.001,1e7),'released',String(body.certificate??'').trim().slice(0,120),now());
    await audit(u,'lot.create','material_lot',key,companyId); return created(await byId('material_lots',key));
  });
  r.get('/trace/lots/:id',async ({u,params})=>{ view(u); const lot=owned(u,await byId('material_lots',params.id)); return {...lot,batches:await lotUsage(lot.id)}; });
  r.post('/trace/lots/:id/quarantine',async ({u,body,params})=>{ const lot=owned(u,await byId('material_lots',params.id)); if (!canManage(u,lot.company_id)) deny(); if (lot.status==='quarantined') bad('This lot is already quarantined');
    const affected=await quarantineLot(lot,required(body.reason,'reason',300),u); await audit(u,'lot.quarantine','material_lot',lot.id,lot.company_id,{batches:affected.length}); return {lot:await byId('material_lots',lot.id),affected}; });
  r.post('/trace/lots/:id/release',async ({u,params})=>{ const lot=owned(u,await byId('material_lots',params.id)); if (!canManage(u,lot.company_id)) deny(); if (lot.status!=='quarantined') bad('Only a quarantined lot can be released');
    await run("UPDATE material_lots SET status='released' WHERE id=?",lot.id); await audit(u,'lot.release','material_lot',lot.id,lot.company_id); return await byId('material_lots',lot.id); });

  r.get('/trace/batches',async ({u,query})=>{ view(u); const [w,a]=companyFilter(u,'b.'), status=query.get('status'); if (status) choice(status,'status',['running','completed','on_hold','released','scrapped']);
    return (await mapSeq((await all(`SELECT b.* FROM batches b WHERE ${w} ${status?'AND b.status=?':''} ORDER BY b.started_at DESC LIMIT 300`,...a,...(status?[status]:[]))), batchSummary)); });
  // Starting a batch records what it is made from and with: product, machine, mould, operator, material lots and the
  // process settings of its machine type (all mandatory).
  r.post('/trace/batches',async ({u,body})=>{
    const product=await byId('products',body.productId); if (!product) bad('Unknown product'); if (!canRecord(u,product.company_id)) deny();
    const machine=await byId('equipment',body.equipmentId); if (!machine||machine.company_id!==product.company_id||!PRODUCTION_MACHINES.includes(machine.machine_type)) bad('equipmentId must be a production machine of the same company');
    let mould=null; if (body.mouldId) { mould=await byId('equipment',body.mouldId); if (!mould||mould.company_id!==product.company_id||mould.machine_type!=='mould') bad('mouldId must be a mould of the same company'); }
    if (machine.machine_type==='injection'&&!mould) bad('Injection moulding batches must record the mould used');
    const batchNumber=code(body.batchNumber,'batchNumber'); if (await one('SELECT 1 FROM batches WHERE company_id=? AND batch_number=?',product.company_id,batchNumber)) bad(`Batch ${batchNumber} already exists`);
    if (await one("SELECT 1 FROM batches WHERE equipment_id=? AND status='running'",machine.id)) bad(`${machine.asset_tag||machine.model} already has a running batch; complete it first`);
    const lots=array(body.lots,'lots'); if (!lots.length) bad('Record at least one material lot');
    const lotRows=(await mapSeq(lots, async (l,i)=>{ const lot=await byId('material_lots',l.lotId); if (!lot||lot.company_id!==product.company_id) bad(`lots[${i}]: unknown lot`); if (lot.status!=='released') bad(`Lot ${lot.lot_number} is ${lot.status} and cannot be used`); return {lot,qty:l.quantityKg==null||l.quantityKg===''?null:num(l.quantityKg,`lots[${i}].quantityKg`,0,1e7)}; }));
    const params=Object.fromEntries(PROCESS_PARAMS[machine.machine_type].map(([k,label])=>[k,num(body.processParams?.[k],label,0,100000)]));
    // Real-time validation: start settings must sit inside the product's validated process window.
    const win=windowOf(product), outside=PROCESS_PARAMS[machine.machine_type].filter(([k])=>win[k]&&((win[k].min!=null&&params[k]<win[k].min)||(win[k].max!=null&&params[k]>win[k].max)));
    if (outside.length) bad(`Outside the validated process window of ${product.part_number}: ${outside.map(([k,label,unit])=>`${label} ${params[k]} ${unit} (allowed ${win[k].min??'–'}…${win[k].max??'–'})`).join('; ')}`);
    // FIFO: older lots of the same material with stock left must be used first, unless a reason is given.
    const fifo=await fifoWarnings(lotRows.map(r=>r.lot)), fifoOverride=typeof body.fifoOverride==='string'&&body.fifoOverride.trim()?body.fifoOverride.trim().slice(0,300):null;
    if (fifo.length&&!fifoOverride) bad(`FIFO: ${fifo.map(f=>`use older lot ${f.olderLot} (${f.remainingKg} kg left) before ${f.lot}`).join('; ')}. Or give a reason to override FIFO.`);
    const zone=(await plantOf(machine)).timezone, startedAt=body.startedAt?date(body.startedAt,'startedAt',zone):now(), key=id();
    await transaction(async ()=>{
      await run('INSERT INTO batches (id,company_id,batch_number,product_id,equipment_id,mould_id,operator_name,planned_qty,status,started_at,process_params,created_at,started_by,fifo_override) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,product.company_id,batchNumber,product.id,machine.id,mould?.id??null,required(body.operatorName,'operatorName',120),num(body.plannedQty,'plannedQty',1,1e9),'running',startedAt,JSON.stringify(params),now(),u.id,fifo.length?`${fifoOverride} (skipped ${fifo.map(f=>f.olderLot).join(', ')})`:null);
      for (const {lot,qty} of lotRows) await run('INSERT INTO batch_materials (batch_id,lot_id,quantity_kg) VALUES (?,?,?)',key,lot.id,qty);
    });
    await audit(u,'batch.start','batch',key,product.company_id,fifo.length?{fifoOverride}:{}); return created(await batchSummary(await byId('batches',key)));
  });
  r.get('/trace/batches/:id',async ({u,params})=>{ view(u); return await genealogy(owned(u,await byId('batches',params.id))); });
  r.post('/trace/batches/:id/complete',async ({u,body,params})=>{
    const b=owned(u,await byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny(); if (b.status!=='running') bad('Only a running batch can be completed');
    const endedAt=body.endedAt?date(body.endedAt,'endedAt',(await plantOf(await byId('equipment',b.equipment_id))).timezone):now(); if (endedAt<=b.started_at) bad('The end must be after the start');
    // Output from the machine's own counts unless entered by hand.
    const counted=await batchSummary({...b,ended_at:endedAt});
    // Undecided process deviations put the batch on hold when the product asks for it.
    const hold=(await byId('products',b.product_id)).hold_on_deviation&&(await deviationsOf(b.id)).some(d=>d.status==='open');
    await run("UPDATE batches SET status=?,hold_reason=?,ended_at=?,good_qty=?,scrap_qty=? WHERE id=?",hold?'on_hold':'completed',hold?'Process deviations need a decision':null,endedAt,body.goodQty==null||body.goodQty===''?counted.good:num(body.goodQty,'goodQty'),body.scrapQty==null||body.scrapQty===''?counted.scrap:num(body.scrapQty,'scrapQty'),b.id);
    await audit(u,'batch.complete','batch',b.id,b.company_id); return await batchSummary(await byId('batches',b.id));
  });
  // Quality release decisions: release a completed or held batch, hold it, or scrap it.
  r.post('/trace/batches/:id/status',async ({u,body,params})=>{
    const b=owned(u,await byId('batches',params.id)); if (!canManage(u,b.company_id)) deny();
    const status=choice(body.status,'status',['released','on_hold','scrapped']);
    if (status==='released'&&!['completed','on_hold'].includes(b.status)) bad('Only a completed or held batch can be released');
    if (status==='released') { const blockers=await releaseBlockers(b); if (blockers.length) bad(`Cannot release ${b.batch_number}: ${blockers.join('; ')}`); }
    if (status!=='released'&&!body.reason) bad('Give a reason to hold or scrap a batch');
    await run('UPDATE batches SET status=?,hold_reason=?,released_by=?,released_at=? WHERE id=?',status,status==='released'?null:String(body.reason).slice(0,300),status==='released'?u.id:b.released_by,status==='released'?now():b.released_at,b.id); await audit(u,`batch.${status}`,'batch',b.id,b.company_id,{reason:body.reason??null});
    return await batchSummary(await byId('batches',b.id));
  });
  r.get('/trace/search',async ({u,query})=>{ view(u); const q=`%${String(query.get('q')||'').trim().toUpperCase()}%`; if (q.length<4) bad('Type at least 2 characters'); const [w,a]=companyFilter(u);
    return {lots:await all(`SELECT id,lot_number,material,status FROM material_lots WHERE ${w} AND lot_number ILIKE ? LIMIT 20`,...a,q),batches:await all(`SELECT id,batch_number,status,started_at FROM batches WHERE ${w} AND batch_number ILIKE ? LIMIT 20`,...a,q)}; });

  // ---------- Vision quality ----------
  r.get('/factory/quality',async ({u,query})=>{ const {from,to}=range(query); return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),...await qualityReport(await machines(u,{plantId:query.get('plantId')||null,equipmentId:query.get('equipmentId')||null}),from,to)}; });

  // ---------- Safety ----------
  r.get('/safety',async ({u,query})=>{ view(u); const {from,to}=range(query,90); const companyIds=isDispatch(u)?(await all('SELECT id FROM companies')).map(c=>c.id):[u.company_id]; return await safetyReport(companyIds,{plantId:query.get('plantId')||null,from,to}); });
  // Anyone working in the plant can report: its own staff, the platform's team, and engineers or providers with open work there.
  r.post('/safety/events',async ({u,body})=>{
    const plant=await byId('plants',body.plantId); if (!plant) bad('Unknown plant');
    // Field staff with current (or last week's) work at the plant; a report queued offline still arrives after close-out.
    const onSite=(await visibleTickets(u)).some(t=>t.plant_id===plant.id&&(t.status!=='completed'||Date.parse(t.completed_at||0)>Date.now()-7*86400000));
    if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===plant.company_id)||onSite)) deny();
    const eventType=choice(body.eventType,'eventType',Object.keys(SAFETY_EVENTS));
    let zoneId=null; if (body.zoneId) { const z=await byId('zones',body.zoneId); if (!z||z.plant_id!==plant.id) bad('Zone must be in the same plant'); zoneId=z.id; }
    let equipmentId=null; if (body.equipmentId) { const e=await byId('equipment',body.equipmentId); if (!e||e.plant_id!==plant.id) bad('Machine must be in the same plant'); equipmentId=e.id; }
    const occurredAt=body.occurredAt?date(body.occurredAt,'occurredAt',plant.timezone):now(); if (occurredAt>new Date(Date.now()+5*60000).toISOString()) bad('The time cannot be in the future');
    const lostTime=body.lostTime===true; if (lostTime&&eventType!=='injury') bad('Only an injury can be a lost-time case');
    const key=await recordSafety({companyId:plant.company_id,plantId:plant.id,zoneId,equipmentId,eventType,source:'person',description:required(body.description,'description',2000),occurredAt,reportedBy:u.id,lostTime});
    await audit(u,'safety.report','safety_event',key,plant.company_id,{eventType}); return created(await byId('safety_events',key));
  },{offline:true});
  r.post('/safety/events/:id/investigate',async ({u,params})=>{ const ev=owned(u,await byId('safety_events',params.id)); if (!canManage(u,ev.company_id)) deny(); if (ev.status!=='open') bad(`This event is already ${ev.status}`); await run("UPDATE safety_events SET status='investigating' WHERE id=?",ev.id); await audit(u,'safety.investigate','safety_event',ev.id,ev.company_id); return await byId('safety_events',ev.id); });
  r.post('/safety/events/:id/close',async ({u,body,params})=>{ const ev=owned(u,await byId('safety_events',params.id)); if (!canManage(u,ev.company_id)) deny(); if (ev.status==='closed') bad('This event is already closed');
    await closeSafety(ev,{rootCause:required(body.rootCause,'rootCause',1000),correctiveAction:required(body.correctiveAction,'correctiveAction',1000)},u); await audit(u,'safety.close','safety_event',ev.id,ev.company_id); return await byId('safety_events',ev.id); });

  // ---------- Asset tracking ----------
  r.get('/zones',async ({u})=>{ view(u); const [w,a]=companyFilter(u); return await all(`SELECT * FROM zones WHERE ${w} ORDER BY name`,...a); });
  r.post('/zones',async ({u,body})=>{
    const plant=await byId('plants',body.plantId); if (!plant) bad('Unknown plant'); if (!canManage(u,plant.company_id)) deny();
    const reader=required(body.readerId,'readerId',60); if (await one('SELECT 1 FROM zones WHERE reader_id=?',reader)) bad(`Reader ${reader} already covers another zone`);
    const key=id(); await run('INSERT INTO zones (id,company_id,plant_id,name,kind,reader_id,created_at) VALUES (?,?,?,?,?,?,?)',key,plant.company_id,plant.id,required(body.name,'name',80),choice(body.kind,'kind',ZONE_KINDS),reader,now());
    await audit(u,'zone.create','zone',key,plant.company_id); return created(await byId('zones',key));
  });
  // A replaced reader or gateway gets its new ID here; sightings already recorded stay with the zone.
  r.patch('/zones/:id',async ({u,body,params})=>{ const z=owned(u,await byId('zones',params.id)); if (!canManage(u,z.company_id)) deny();
    const reader=body.readerId==null?z.reader_id:required(body.readerId,'readerId',60); if (reader!==z.reader_id&&await one('SELECT 1 FROM zones WHERE reader_id=? AND id<>?',reader,z.id)) bad(`Reader ${reader} already covers another zone`);
    await run('UPDATE zones SET name=?,kind=?,reader_id=? WHERE id=?',body.name==null?z.name:required(body.name,'name',80),body.kind==null?z.kind:choice(body.kind,'kind',ZONE_KINDS),reader,z.id); await audit(u,'zone.update','zone',z.id,z.company_id,reader!==z.reader_id?{readerId:reader}:{}); return await byId('zones',z.id); });
  r.get('/assets',async ({u})=>{ view(u); await checkMissing(); const [w,a]=companyFilter(u); return (await mapSeq((await all(`SELECT * FROM tracked_assets WHERE ${w} ORDER BY name`,...a)), assetView)); },{writes:true});
  const assetBody=async (u,body,existing)=>{
    const plant=await byId('plants',body.plantId??existing?.plant_id); if (!plant) bad('Unknown plant'); if (!canManage(u,plant.company_id)) deny(); if (existing&&plant.company_id!==existing.company_id) bad('An asset cannot move to another company');
    let equipmentId=body.equipmentId===undefined?existing?.equipment_id??null:body.equipmentId||null; if (equipmentId) { const e=await byId('equipment',equipmentId); if (!e||e.company_id!==plant.company_id) bad('Linked equipment must belong to the same company'); }
    let home=body.homeZoneId===undefined?existing?.home_zone_id??null:body.homeZoneId||null; if (home) { const z=await byId('zones',home); if (!z||z.plant_id!==plant.id) bad('Home zone must be in the same plant'); }
    return {plant,equipmentId,home,name:required(body.name??existing?.name,'name',120),kind:choice(body.kind??existing?.kind,'kind',ASSET_KINDS),tagType:choice(body.tagType??existing?.tag_type,'tagType',TAG_TYPES),missingAfter:num(body.missingAfterHours??existing?.missing_after_hours??24,'missingAfterHours',1,720)};
  };
  r.post('/assets',async ({u,body})=>{ const a=await assetBody(u,body), tag=required(body.tagId,'tagId',60); if (await one('SELECT 1 FROM tracked_assets WHERE tag_id=?',tag)) bad(`Tag ${tag} is already on another asset`);
    const key=id(); await run('INSERT INTO tracked_assets (id,company_id,plant_id,tag_id,tag_type,kind,name,equipment_id,home_zone_id,missing_after_hours,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,a.plant.company_id,a.plant.id,tag,a.tagType,a.kind,a.name,a.equipmentId,a.home,Math.round(a.missingAfter),now());
    await audit(u,'asset.create','tracked_asset',key,a.plant.company_id); return created(await assetView(await byId('tracked_assets',key))); });
  // A replaced tag (lost or flat beacon) gets its new ID here; the location history stays with the asset.
  r.patch('/assets/:id',async ({u,body,params})=>{ const existing=owned(u,await byId('tracked_assets',params.id)), a=await assetBody(u,body,existing);
    const tag=body.tagId==null?existing.tag_id:required(body.tagId,'tagId',60); if (tag!==existing.tag_id&&await one('SELECT 1 FROM tracked_assets WHERE tag_id=? AND id<>?',tag,existing.id)) bad(`Tag ${tag} is already on another asset`);
    await run('UPDATE tracked_assets SET plant_id=?,name=?,kind=?,tag_id=?,tag_type=?,equipment_id=?,home_zone_id=?,missing_after_hours=? WHERE id=?',a.plant.id,a.name,a.kind,tag,a.tagType,a.equipmentId,a.home,Math.round(a.missingAfter),existing.id);
    await audit(u,'asset.update','tracked_asset',existing.id,existing.company_id,tag!==existing.tag_id?{tagId:tag}:{}); return await assetView(await byId('tracked_assets',existing.id)); });
  // Where an asset has been: consecutive sightings in the same zone are merged into stays.
  r.get('/assets/:id/history',async ({u,params,query})=>{ view(u); const a=owned(u,await byId('tracked_assets',params.id)), hours=Number(query.get('hours')||48); if (!(hours>0&&hours<=720)) bad('hours must be 1-720');
    const stays=[]; for (const s of await all('SELECT s.seen_at,s.zone_id,z.name,z.kind FROM asset_sightings s JOIN zones z ON z.id=s.zone_id WHERE s.asset_id=? AND s.seen_at>=? ORDER BY s.seen_at',a.id,new Date(Date.now()-hours*3600000).toISOString())) { const last=stays[stays.length-1]; if (last&&last.zoneId===s.zone_id) last.to=s.seen_at; else stays.push({zoneId:s.zone_id,zone:s.name,kind:s.kind,from:s.seen_at,to:s.seen_at}); }
    return {asset:await assetView(a),stays:stays.reverse()}; });
}

