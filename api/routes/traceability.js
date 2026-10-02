// Traceability suite routes: trace search, KPIs, product rules (process window, check sheets, warranty, packing),
// quality gates, process readings and deviations, SPC, labels and pallets, dispatch, recall scope, field returns
// and warranty authentication, supplier scorecards and field-return correlation.
import { id, now, one, all, run } from '../db.js';
import { isCustomer, isPlatform } from '../security.js';
import { audit, byId, isDispatch } from '../access.js';
import { created } from '../http.js';
import { bad, choice, deny, missing, required, integer } from '../validate.js';
import { PROCESS_PARAMS } from '../catalog.js';
import { batchSummary } from '../factory/trace.js';
import * as T from '../factory/traceability.js';

const canView=u=>isCustomer(u)||isDispatch(u);
const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
const canRecord=(u,companyId)=>isPlatform(u)||(isCustomer(u)&&u.company_id===companyId);
const view=u=>{ if (!canView(u)) deny(); };
const companies=u=>isDispatch(u)?all('SELECT id FROM companies').map(c=>c.id):[u.company_id];
const owned=(u,row)=>{ if (!row) missing(); if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===row.company_id))) deny(); return row; };
const companyOf=(u,body)=>isCustomer(u)?u.company_id:required(body.companyId,'companyId');
const J=(s,d)=>{ try { return JSON.parse(s||''); } catch { return d; } };
const productRules=p=>({id:p.id,companyId:p.company_id,partNumber:p.part_number,name:p.name,unit:p.unit,customer:p.customer,warrantyMonths:p.warranty_months,packQty:p.pack_qty,
  processWindow:T.windowOf(p),checkSheets:T.sheetsOf(p),holdOnDeviation:!!p.hold_on_deviation,machineType:p.default_machine_id?one('SELECT machine_type FROM equipment WHERE id=?',p.default_machine_id)?.machine_type:null});
const unitBy=(u,serial)=>{ const s=String(serial||'').trim().toUpperCase(); if (!s) bad('Scan a label'); const x=one(`SELECT * FROM trace_units WHERE serial=? AND company_id IN (${companies(u).map(()=>'?').join(',')})`,s,...companies(u)); if (!x) bad(`Label ${s} not found`); return x; };

export function register(r) {
  r.get('/trace/catalog',({u})=>{ view(u); return {gates:T.GATES,channels:T.CHANNELS,returnKinds:T.RETURN_KINDS}; });
  r.get('/trace/kpis',({u})=>{ view(u); return T.traceKpis(companies(u)); });
  r.get('/trace/find',({u,query})=>{ view(u); return T.traceAny(companies(u),query.get('code')); });

  // ---------- Product rules ----------
  r.get('/trace/products',({u})=>{ view(u); const c=companies(u); return all(`SELECT * FROM products WHERE company_id IN (${c.map(()=>'?').join(',')}) AND active=1 ORDER BY part_number`,...c).map(productRules); });
  r.put('/trace/products/:id',({u,body,params})=>{
    const p=owned(u,byId('products',params.id)); if (!canManage(u,p.company_id)) deny();
    const type=p.default_machine_id?one('SELECT machine_type FROM equipment WHERE id=?',p.default_machine_id)?.machine_type:null;
    const window=T.validWindow(body.processWindow,PROCESS_PARAMS[type]||Object.values(PROCESS_PARAMS).flat()), sheets=T.validSheets(body.checkSheets);
    const warranty=body.warrantyMonths==null?p.warranty_months:integer(Number(body.warrantyMonths),'warrantyMonths',0,240), pack=body.packQty==null||body.packQty===''?null:integer(Number(body.packQty),'packQty',1,10000000);
    run('UPDATE products SET customer=?,warranty_months=?,pack_qty=?,process_window=?,check_sheets=?,hold_on_deviation=? WHERE id=?',String(body.customer??p.customer).trim().slice(0,120),warranty,pack,JSON.stringify(window),JSON.stringify(sheets),body.holdOnDeviation?1:0,p.id);
    audit(u,'product.trace_rules','product',p.id,p.company_id); return productRules(byId('products',p.id));
  });

  // ---------- Batch: gates, readings, deviations, SPC ----------
  r.get('/trace/batches/:id/quality',({u,params})=>{ view(u); const b=owned(u,byId('batches',params.id)), p=byId('products',b.product_id);
    return {batch:batchSummary(b),gates:T.gateStatus(b,p),deviations:T.deviationsOf(b.id),spc:T.spc([b.id],p),window:T.windowOf(p),releaseBlockers:T.releaseBlockers(b),
      units:all('SELECT * FROM trace_units WHERE batch_id=? ORDER BY kind DESC,serial',b.id).map(T.unitView)}; });
  r.post('/trace/batches/:id/checks',({u,body,params})=>{ const b=owned(u,byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny();
    const res=T.recordCheck(u,b,body.gate,body.answers,body.note); audit(u,`batch.gate.${res.result}`,'batch',b.id,b.company_id,{gate:body.gate}); return created(res); });
  r.post('/trace/batches/:id/readings',({u,body,params})=>{ const b=owned(u,byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny();
    return T.recordReadings(b,body.readings,body.source==='manual'?'manual':'machine'); });
  r.post('/trace/deviations/:id/decision',({u,body,params})=>{ const d=owned(u,byId('process_deviations',params.id)); if (!canManage(u,d.company_id)) deny();
    const decision=choice(body.decision,'decision',['accepted','rejected']); T.decideDeviation(u,d,decision,required(body.disposition,'disposition',500)); audit(u,`deviation.${decision}`,'batch',d.batch_id,d.company_id,{parameter:d.parameter}); return byId('process_deviations',d.id); });
  r.get('/trace/spc',({u,query})=>{ view(u); const p=owned(u,byId('products',query.get('productId')));
    const days=Math.min(365,Math.max(1,Number(query.get('days'))||30)), ids=all('SELECT id FROM batches WHERE product_id=? AND started_at>=? ORDER BY started_at',p.id,new Date(Date.now()-days*86400000).toISOString()).map(b=>b.id);
    return {product:productRules(p),batches:ids.length,spc:T.spc(ids,p)}; });
  r.get('/trace/deviations',({u})=>{ view(u); const c=companies(u);
    return all(`SELECT d.*,b.batch_number,b.equipment_id,b.product_id,p.part_number FROM process_deviations d JOIN batches b ON b.id=d.batch_id JOIN products p ON p.id=b.product_id WHERE d.company_id IN (${c.map(()=>'?').join(',')}) ORDER BY d.status='open' DESC,d.started_at DESC LIMIT 300`,...c); });
  r.get('/trace/fifo',({u,query})=>{ view(u); const lots=String(query.get('lotIds')||'').split(',').filter(Boolean).slice(0,20).map(x=>owned(u,byId('material_lots',x))); return T.fifoWarnings(lots); });

  // ---------- Labels ----------
  r.post('/trace/batches/:id/units',({u,body,params})=>{ const b=owned(u,byId('batches',params.id)); if (!canRecord(u,b.company_id)) deny();
    const made=T.createUnits(u,b,{kind:body.kind||'box',count:Number(body.count),perUnit:body.perUnit}); audit(u,'units.create','batch',b.id,b.company_id,{kind:body.kind||'box',count:made.length}); return created(made); });
  r.post('/trace/pallets',({u,body})=>{ const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny(); const p=T.createPallet(u,companyId,body.serials); audit(u,'pallet.create','unit',p.id,companyId); return created(p); });
  r.get('/trace/units/:serial',({u,params})=>{ view(u); const x=unitBy(u,params.serial); return {...T.unitView(x),contents:x.kind==='pallet'?all('SELECT * FROM trace_units WHERE parent_id=?',x.id).map(T.unitView):[]}; });
  r.get('/trace/stock',({u})=>{ view(u); const c=companies(u);
    return all(`SELECT * FROM trace_units WHERE company_id IN (${c.map(()=>'?').join(',')}) AND status='packed' AND parent_id IS NULL ORDER BY created_at LIMIT 1000`,...c).map(T.unitView); });

  // ---------- Dispatch ----------
  r.get('/trace/shipments',({u})=>{ view(u); const c=companies(u); return all(`SELECT * FROM shipments WHERE company_id IN (${c.map(()=>'?').join(',')}) ORDER BY created_at DESC LIMIT 300`,...c).map(T.shipmentView); });
  r.post('/trace/shipments',({u,body})=>{ const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny();
    const n=one('SELECT count(*) n FROM shipments WHERE company_id=?',companyId).n, number=String(body.shipmentNumber||'').trim().toUpperCase()||`DN-${new Date().getUTCFullYear()}-${String(n+1).padStart(5,'0')}`;
    if (!/^[A-Z0-9][A-Z0-9._/-]{0,59}$/.test(number)) bad('shipmentNumber may contain letters, digits, dot, dash, slash or underscore');
    if (one('SELECT 1 FROM shipments WHERE company_id=? AND shipment_number=?',companyId,number)) bad(`Shipment ${number} already exists`);
    const key=id(); run('INSERT INTO shipments (id,company_id,shipment_number,customer,channel,destination,customer_po,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',key,companyId,number,required(body.customer,'customer',120),choice(body.channel,'channel',Object.keys(T.CHANNELS)),String(body.destination||'').slice(0,200),String(body.customerPo||'').slice(0,60),'loading',u.id,now());
    audit(u,'shipment.create','shipment',key,companyId); return created(T.shipmentView(byId('shipments',key))); });
  r.post('/trace/shipments/:id/scan',({u,body,params})=>{ const s=owned(u,byId('shipments',params.id)); if (!canRecord(u,s.company_id)) deny();
    const unit=unitBy(u,body.serial); if (unit.company_id!==s.company_id) bad('This label belongs to another company'); const warnings=T.addToShipment(s,unit);
    return {shipment:T.shipmentView(byId('shipments',s.id)),added:unit.serial,warnings}; });
  r.post('/trace/shipments/:id/remove',({u,body,params})=>{ const s=owned(u,byId('shipments',params.id)); if (!canRecord(u,s.company_id)) deny(); T.removeFromShipment(s,unitBy(u,body.serial)); return T.shipmentView(byId('shipments',s.id)); });
  r.post('/trace/shipments/:id/ship',({u,params})=>{ const s=owned(u,byId('shipments',params.id)); if (!canRecord(u,s.company_id)) deny(); T.shipShipment(s); audit(u,'shipment.ship','shipment',s.id,s.company_id); return T.shipmentView(byId('shipments',s.id)); });
  r.post('/trace/shipments/:id/cancel',({u,params})=>{ const s=owned(u,byId('shipments',params.id)); if (!canManage(u,s.company_id)) deny(); if (s.status!=='loading') bad('Only a shipment still loading can be cancelled');
    run('UPDATE trace_units SET shipment_id=NULL WHERE shipment_id=?',s.id); run("UPDATE shipments SET status='cancelled' WHERE id=?",s.id); audit(u,'shipment.cancel','shipment',s.id,s.company_id); return T.shipmentView(byId('shipments',s.id)); });

  // ---------- Recall scope ----------
  r.get('/trace/recall',({u,query})=>{ view(u); const lot=query.get('lotId')?owned(u,byId('material_lots',query.get('lotId'))):null, batch=!lot&&query.get('batchId')?owned(u,byId('batches',query.get('batchId'))):null;
    if (!lot&&!batch) bad('Give lotId or batchId'); return {lot:lot?{id:lot.id,lotNumber:lot.lot_number,material:lot.material,supplier:lot.supplier,status:lot.status}:null,batch:batch?{id:batch.id,batchNumber:batch.batch_number}:null,...T.recallScope({lot,batch})}; });

  // ---------- Field returns and warranty ----------
  r.get('/trace/authenticate',({u,query})=>{ view(u); const c=companies(u); const res=c.map(cid=>T.authenticate(cid,query.get('serial'),query.get('customer'))).find(x=>x.unit)||T.authenticate(c[0],query.get('serial'),query.get('customer'));
    return {...res,unit:res.unit?T.unitView(res.unit):null,batch:res.batch?{id:res.batch.id,batchNumber:res.batch.batch_number,status:res.batch.status}:null}; });
  r.get('/trace/returns',({u})=>{ view(u); const c=companies(u);
    return all(`SELECT f.*,b.batch_number FROM field_returns f LEFT JOIN batches b ON b.id=f.batch_id WHERE f.company_id IN (${c.map(()=>'?').join(',')}) ORDER BY f.reported_at DESC LIMIT 300`,...c).map(f=>({...f,checks:J(f.checks,[])})); });
  r.post('/trace/returns',({u,body})=>{ const companyId=companyOf(u,body); if (!canRecord(u,companyId)) deny();
    const kind=choice(body.kind,'kind',Object.keys(T.RETURN_KINDS)), customer=required(body.customer,'customer',120), reportedAt=body.reportedAt?new Date(body.reportedAt).toISOString():now();
    const auth=T.authenticate(companyId,body.serial,customer,reportedAt);
    let batch=auth.batch; if (!batch&&body.batchNumber) { batch=one('SELECT * FROM batches WHERE company_id=? AND batch_number=?',companyId,String(body.batchNumber).trim().toUpperCase()); if (!batch) bad(`Batch ${body.batchNumber} not found`); }
    if (!auth.unit&&!batch) bad('Give the serial on the label, or the batch number printed on the part');
    const key=id(), reference=T.nextReference(companyId);
    run('INSERT INTO field_returns (id,company_id,reference,kind,customer,serial,unit_id,batch_id,quantity,defect,description,reported_at,authenticity,checks,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,companyId,reference,kind,customer,String(body.serial||'').trim().toUpperCase(),auth.unit?.id??null,batch?.id??null,Number(body.quantity)>0?Number(body.quantity):1,required(body.defect,'defect',120),String(body.description||'').slice(0,2000),reportedAt,
      auth.unit?auth.authenticity:(kind==='warranty_claim'?'not_found':'genuine'),JSON.stringify(auth.checks),'open',u.id,now());
    if (auth.unit) run("UPDATE trace_units SET status='returned' WHERE id=? AND status='shipped'",auth.unit.id);
    audit(u,'return.create','field_return',key,companyId,{kind,authenticity:auth.authenticity}); const f=byId('field_returns',key); return created({...f,checks:J(f.checks,[])}); });
  r.patch('/trace/returns/:id',({u,body,params})=>{ const f=owned(u,byId('field_returns',params.id)); if (!canManage(u,f.company_id)) deny();
    const status=body.status==null?f.status:choice(body.status,'status',['open','accepted','rejected','closed']);
    run('UPDATE field_returns SET status=?,root_cause=?,corrective_action=? WHERE id=?',status,body.rootCause==null?f.root_cause:String(body.rootCause).slice(0,1000),body.correctiveAction==null?f.corrective_action:String(body.correctiveAction).slice(0,1000),f.id);
    audit(u,`return.${status}`,'field_return',f.id,f.company_id); const x=byId('field_returns',f.id); return {...x,checks:J(x.checks,[])}; });
  r.get('/trace/correlation',({u})=>{ view(u); return T.fieldCorrelation(companies(u)); });
  r.get('/trace/suppliers',({u})=>{ view(u); return T.supplierScorecard(companies(u)); });
}
