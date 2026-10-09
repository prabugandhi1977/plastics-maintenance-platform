// Traceability suite routes: trace search, KPIs, product rules (process window, check sheets, warranty, packing),
// quality gates, process readings and deviations, SPC, labels and pallets, dispatch, recall scope, field returns
// and warranty authentication, supplier scorecards and field-return correlation.
import { id, now, one, all, run, mapSeq } from '../../../common/db.js';
import { isCustomer, isPlatform } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { bad, choice, deny, missing, required, integer } from '../../../common/validate.js';
import { PROCESS_PARAMS } from '../../../common/catalog.js';
import { batchSummary } from '../trace.js';
import * as T from '../traceability.js';

const canView=u=>isCustomer(u)||isDispatch(u);
const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
const canRecord=(u,companyId)=>isPlatform(u)||(isCustomer(u)&&u.company_id===companyId);
const view=u=>{ if (!canView(u)) deny(); };
const companies=async u=>isDispatch(u)?(await all('SELECT id FROM companies')).map(c=>c.id):[u.company_id];
const owned=(u,row)=>{ if (!row) missing(); if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===row.company_id))) deny(); return row; };
const companyOf=(u,body)=>isCustomer(u)?u.company_id:required(body.companyId,'companyId');
const J=(s,d)=>{ try { return JSON.parse(s||''); } catch { return d; } };
const productRules=async p=>({id:p.id,companyId:p.company_id,partNumber:p.part_number,name:p.name,unit:p.unit,customer:p.customer,warrantyMonths:p.warranty_months,packQty:p.pack_qty,
  processWindow:T.windowOf(p),checkSheets:T.sheetsOf(p),holdOnDeviation:!!p.hold_on_deviation,machineType:p.default_machine_id?(await one('SELECT machine_type FROM equipment WHERE id=?',p.default_machine_id))?.machine_type:null});
const unitBy=async (u,serial)=>{ const s=String(serial||'').trim().toUpperCase(); if (!s) bad('Scan a label'); const x=await one(`SELECT * FROM trace_units WHERE serial=? AND company_id IN (${(await companies(u)).map(()=>'?').join(',')})`,s,...await companies(u)); if (!x) bad(`Label ${s} not found`); return x; };

export function register(r) {
  r.get('/trace/catalog',({u})=>{ view(u); return {gates:T.GATES,channels:T.CHANNELS,returnKinds:T.RETURN_KINDS}; });
  r.get('/trace/kpis',async ({u})=>{ view(u); return await T.traceKpis(await companies(u)); });
  r.get('/trace/find',async ({u,query})=>{ view(u); return await T.traceAny(await companies(u),query.get('code')); });

  // ---------- Product rules ----------
  r.get('/trace/products',async ({u})=>{ view(u); const c=await companies(u); return (await mapSeq((await all(`SELECT * FROM products WHERE company_id IN (${c.map(()=>'?').join(',')}) AND active=1 ORDER BY part_number`,...c)), productRules)); });
  r.put('/trace/products/:id',async ({u,body,params})=>{
    const p=owned(u,await byId('products',params.id)); if (!canManage(u,p.company_id)) deny();
    const type=p.default_machine_id?(await one('SELECT machine_type FROM equipment WHERE id=?',p.default_machine_id))?.machine_type:null;
    const window=T.validWindow(body.processWindow,PROCESS_PARAMS[type]||Object.values(PROCESS_PARAMS).flat()), sheets=T.validSheets(body.checkSheets);
    const warranty=body.warrantyMonths==null?p.warranty_months:integer(Number(body.warrantyMonths),'warrantyMonths',0,240), pack=body.packQty==null||body.packQty===''?null:integer(Number(body.packQty),'packQty',1,10000000);
    await run('UPDATE products SET customer=?,warranty_months=?,pack_qty=?,process_window=?,check_sheets=?,hold_on_deviation=? WHERE id=?',String(body.customer??p.customer).trim().slice(0,120),warranty,pack,JSON.stringify(window),JSON.stringify(sheets),body.holdOnDeviation?1:0,p.id);
    await audit(u,'product.trace_rules','product',p.id,p.company_id); return await productRules(await byId('products',p.id));
  });

  // ---------- Batch: gates, readings, deviations, SPC ----------
  r.get('/trace/batches/:id/quality',async ({u,params})=>{ view(u); const b=owned(u,await byId('batches',params.id)), p=await byId('products',b.product_id);
    return {batch:await batchSummary(b),gates:await T.gateStatus(b,p),deviations:await T.deviationsOf(b.id),spc:await T.spc([b.id],p),window:T.windowOf(p),releaseBlockers:await T.releaseBlockers(b),
      units:(await all('SELECT * FROM trace_units WHERE batch_id=? ORDER BY kind DESC,serial',b.id)).map(T.unitView)}; });
  r.post('/trace/batches/:id/checks',async ({u,body,params})=>{ const b=owned(u,await byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny();
    const res=await T.recordCheck(u,b,body.gate,body.answers,body.note); await audit(u,`batch.gate.${res.result}`,'batch',b.id,b.company_id,{gate:body.gate}); return created(res); });
  r.post('/trace/batches/:id/readings',async ({u,body,params})=>{ const b=owned(u,await byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny();
    return await T.recordReadings(b,body.readings,body.source==='manual'?'manual':'machine'); });
  r.post('/trace/deviations/:id/decision',async ({u,body,params})=>{ const d=owned(u,await byId('process_deviations',params.id)); if (!canManage(u,d.company_id)) deny();
    const decision=choice(body.decision,'decision',['accepted','rejected']); await T.decideDeviation(u,d,decision,required(body.disposition,'disposition',500)); await audit(u,`deviation.${decision}`,'batch',d.batch_id,d.company_id,{parameter:d.parameter}); return await byId('process_deviations',d.id); });
  r.get('/trace/spc',async ({u,query})=>{ view(u); const p=owned(u,await byId('products',query.get('productId')));
    const days=Math.min(365,Math.max(1,Number(query.get('days'))||30)), ids=(await all('SELECT id FROM batches WHERE product_id=? AND started_at>=? ORDER BY started_at',p.id,new Date(Date.now()-days*86400000).toISOString())).map(b=>b.id);
    return {product:await productRules(p),batches:ids.length,spc:await T.spc(ids,p)}; });
  r.get('/trace/deviations',async ({u})=>{ view(u); const c=await companies(u);
    return await all(`SELECT d.*,b.batch_number,b.equipment_id,b.product_id,p.part_number FROM process_deviations d JOIN batches b ON b.id=d.batch_id JOIN products p ON p.id=b.product_id WHERE d.company_id IN (${c.map(()=>'?').join(',')}) ORDER BY d.status='open' DESC,d.started_at DESC LIMIT 300`,...c); });
  r.get('/trace/fifo',async ({u,query})=>{ view(u); const lots=(await mapSeq(String(query.get('lotIds')||'').split(',').filter(Boolean).slice(0,20), async x=>owned(u,await byId('material_lots',x)))); return await T.fifoWarnings(lots); });

  // ---------- Labels ----------
  r.post('/trace/batches/:id/units',async ({u,body,params})=>{ const b=owned(u,await byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny();
    const made=await T.createUnits(u,b,{kind:body.kind||'box',count:Number(body.count),perUnit:body.perUnit}); await audit(u,'units.create','batch',b.id,b.company_id,{kind:body.kind||'box',count:made.length}); return created(made); });
  r.post('/trace/pallets',async ({u,body})=>{ const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny(); const p=await T.createPallet(u,companyId,body.serials); await audit(u,'pallet.create','unit',p.id,companyId); return created(p); });
  r.get('/trace/units/:serial',async ({u,params})=>{ view(u); const x=await unitBy(u,params.serial); return {...await T.unitView(x),contents:x.kind==='pallet'?(await all('SELECT * FROM trace_units WHERE parent_id=?',x.id)).map(T.unitView):[]}; });
  r.get('/trace/stock',async ({u})=>{ view(u); const c=await companies(u);
    return (await all(`SELECT * FROM trace_units WHERE company_id IN (${c.map(()=>'?').join(',')}) AND status='packed' AND parent_id IS NULL ORDER BY created_at LIMIT 1000`,...c)).map(T.unitView); });

  // ---------- Dispatch ----------
  r.get('/trace/shipments',async ({u})=>{ view(u); const c=await companies(u); return (await all(`SELECT * FROM shipments WHERE company_id IN (${c.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT 300`,...c)).map(T.shipmentView); });
  r.post('/trace/shipments',async ({u,body})=>{ const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny();
    const n=(await one('SELECT count(*) n FROM shipments WHERE company_id=?',companyId)).n, number=String(body.shipmentNumber||'').trim().toUpperCase()||`DN-${new Date().getUTCFullYear()}-${String(n+1).padStart(5,'0')}`;
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,59}$/.test(number)) bad('shipmentNumber may contain letters, digits, dot, dash, slash or underscore');
    if (await one('SELECT 1 FROM shipments WHERE company_id=? AND shipment_number=?',companyId,number)) bad(`Shipment ${number} already exists`);
    const key=id(); await run('INSERT INTO shipments (id,company_id,shipment_number,customer,channel,destination,customer_po,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',key,companyId,number,required(body.customer,'customer',120),choice(body.channel,'channel',Object.keys(T.CHANNELS)),String(body.destination||'').slice(0,200),String(body.customerPo||'').slice(0,60),'loading',u.id,now());
    await audit(u,'shipment.create','shipment',key,companyId); return created(await T.shipmentView(await byId('shipments',key))); });
  r.post('/trace/shipments/:id/scan',async ({u,body,params})=>{ const s=owned(u,await byId('shipments',params.id)); if (!canRecord(u,s.company_id)) deny();
    const unit=await unitBy(u,body.serial); if (unit.company_id!==s.company_id) bad('This label belongs to another company'); const warnings=await T.addToShipment(s,unit);
    return {shipment:await T.shipmentView(await byId('shipments',s.id)),added:unit.serial,warnings}; });
  r.post('/trace/shipments/:id/remove',async ({u,body,params})=>{ const s=owned(u,await byId('shipments',params.id)); if (!canRecord(u,s.company_id)) deny(); await T.removeFromShipment(s,await unitBy(u,body.serial)); return await T.shipmentView(await byId('shipments',s.id)); });
  r.post('/trace/shipments/:id/ship',async ({u,params})=>{ const s=owned(u,await byId('shipments',params.id)); if (!canRecord(u,s.company_id)) deny(); await T.shipShipment(s); await audit(u,'shipment.ship','shipment',s.id,s.company_id); return await T.shipmentView(await byId('shipments',s.id)); });
  r.post('/trace/shipments/:id/cancel',async ({u,params})=>{ const s=owned(u,await byId('shipments',params.id)); if (!canManage(u,s.company_id)) deny(); if (s.status!=='loading') bad('Only a shipment still loading can be cancelled');
    await run('UPDATE trace_units SET shipment_id=NULL WHERE shipment_id=?',s.id); await run("UPDATE shipments SET status='cancelled' WHERE id=?",s.id); await audit(u,'shipment.cancel','shipment',s.id,s.company_id); return await T.shipmentView(await byId('shipments',s.id)); });

  // ---------- Recall scope ----------
  r.get('/trace/recall',async ({u,query})=>{ view(u); const lot=query.get('lotId')?owned(u,await byId('material_lots',query.get('lotId'))):null, batch=!lot&&query.get('batchId')?owned(u,await byId('batches',query.get('batchId'))):null;
    if (!lot&&!batch) bad('Give lotId or batchId'); return {lot:lot?{id:lot.id,lotNumber:lot.lot_number,material:lot.material,supplier:lot.supplier,status:lot.status}:null,batch:batch?{id:batch.id,batchNumber:batch.batch_number}:null,...await T.recallScope({lot,batch})}; });

  // ---------- Field returns and warranty ----------
  r.get('/trace/authenticate',async ({u,query})=>{ view(u); const c=await companies(u); const res=(await mapSeq(c, async cid=>await T.authenticate(cid,query.get('serial'),query.get('customer')))).find(x=>x.unit)||await T.authenticate(c[0],query.get('serial'),query.get('customer'));
    return {...res,unit:res.unit?await T.unitView(res.unit):null,batch:res.batch?{id:res.batch.id,batchNumber:res.batch.batch_number,status:res.batch.status}:null}; });
  r.get('/trace/returns',async ({u})=>{ view(u); const c=await companies(u);
    return (await all(`SELECT f.*,b.batch_number FROM field_returns f LEFT JOIN batches b ON b.id=f.batch_id WHERE f.company_id IN (${c.map(()=>'?').join(',')}) ORDER BY f.reported_at DESC LIMIT 300`,...c)).map(f=>({...f,checks:J(f.checks,[])})); });
  r.post('/trace/returns',async ({u,body})=>{ const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny();
    const kind=choice(body.kind,'kind',Object.keys(T.RETURN_KINDS)), customer=required(body.customer,'customer',120), reportedAt=body.reportedAt?new Date(body.reportedAt).toISOString():now();
    const auth=await T.authenticate(companyId,body.serial,customer,reportedAt);
    let batch=auth.batch; if (!batch&&body.batchNumber) { batch=await one('SELECT * FROM batches WHERE company_id=? AND batch_number=?',companyId,String(body.batchNumber).trim().toUpperCase()); if (!batch) bad(`Batch ${body.batchNumber} not found`); }
    if (!auth.unit&&!batch) bad('Give the serial on the label, or the batch number printed on the part');
    const key=id(), reference=await T.nextReference(companyId);
    await run('INSERT INTO field_returns (id,company_id,reference,kind,customer,serial,unit_id,batch_id,quantity,defect,description,reported_at,authenticity,checks,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,companyId,reference,kind,customer,String(body.serial||'').trim().toUpperCase(),auth.unit?.id??null,batch?.id??null,Number(body.quantity)>0?Number(body.quantity):1,required(body.defect,'defect',120),String(body.description||'').slice(0,2000),reportedAt,
      auth.unit?auth.authenticity:(kind==='warranty_claim'?'not_found':'genuine'),JSON.stringify(auth.checks),'open',u.id,now());
    if (auth.unit) await run("UPDATE trace_units SET status='returned' WHERE id=? AND status='shipped'",auth.unit.id);
    await audit(u,'return.create','field_return',key,companyId,{kind,authenticity:auth.authenticity}); const f=await byId('field_returns',key); return created({...f,checks:J(f.checks,[])}); });
  r.patch('/trace/returns/:id',async ({u,body,params})=>{ const f=owned(u,await byId('field_returns',params.id)); if (!canManage(u,f.company_id)) deny();
    const status=body.status==null?f.status:choice(body.status,'status',['open','accepted','rejected','closed']);
    await run('UPDATE field_returns SET status=?,root_cause=?,corrective_action=? WHERE id=?',status,body.rootCause==null?f.root_cause:String(body.rootCause).slice(0,1000),body.correctiveAction==null?f.corrective_action:String(body.correctiveAction).slice(0,1000),f.id);
    await audit(u,`return.${status}`,'field_return',f.id,f.company_id); const x=await byId('field_returns',f.id); return {...x,checks:J(x.checks,[])}; });
  r.get('/trace/correlation',async ({u})=>{ view(u); return await T.fieldCorrelation(await companies(u)); });
  r.get('/trace/suppliers',async ({u})=>{ view(u); return await T.supplierScorecard(await companies(u)); });
}
