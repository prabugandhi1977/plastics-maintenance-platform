// Traceability suite, on top of lots → batches (trace.js):
// - Real time: process windows per product, live readings, deviations with disposition, SPC (Cp/Cpk), quality gates
//   with digital check sheets, release enforcement.
// - Backward: FIFO validation of material lots, supplier scorecards, the signed-in operator.
// - Forward: serialised parts/boxes/pallets with QR labels, dispatch with scan validation (released batches only, right
//   customer, finished-goods FIFO), recall scope down to customers and boxes, field returns and warranty authentication,
//   correlation of field returns with lots, suppliers, machines, moulds and process settings.
import { id, now, one, all, run, transaction, mapSeq } from '../../common/db.js';
import { bad } from '../../common/validate.js';
import { raiseAlert, resolveAlertKey } from '../factory/alerts.js';
import { batchSummary, lotUsage } from './trace.js';

export const GATES={first_article:'First-article inspection',in_process:'In-process check',final_qc:'Final QC',packaging:'Packaging check'};
export const CHANNELS={oem:'OEM (direct)',tier1:'Tier-1 supplier',distributor:'Distributor',aftermarket:'Aftermarket / spare parts',internal:'Internal / other plant'};
export const RETURN_KINDS={complaint:'Customer complaint (0-km / line)',warranty_claim:'Warranty claim',field_failure:'Field failure'};
const DAY=86400000;
const J=(s,d)=>{ try { return JSON.parse(s||''); } catch { return d; } };
const round=(x,d=2)=>x==null||!Number.isFinite(x)?null:Math.round(x*10**d)/10**d;

// ---------- Product settings ----------
export const windowOf=p=>J(p?.process_window,{});
export const sheetsOf=p=>J(p?.check_sheets,{});
export function validWindow(v,params) {
  if (v==null) return {}; if (typeof v!=='object'||Array.isArray(v)) bad('processWindow must be an object');
  const keys=new Set(params.map(([k])=>k)), out={};
  for (const [k,w] of Object.entries(v)) { if (!keys.has(k)) bad(`processWindow.${k} is not a setting of this machine type`); if (!w||typeof w!=='object') continue;
    const min=w.min===''||w.min==null?null:Number(w.min), max=w.max===''||w.max==null?null:Number(w.max);
    if ((min!=null&&!Number.isFinite(min))||(max!=null&&!Number.isFinite(max))) bad(`processWindow.${k} must have numeric min/max`);
    if (min!=null&&max!=null&&min>=max) bad(`processWindow.${k}: min must be below max`);
    if (min!=null||max!=null) out[k]={min,max}; }
  return out;
}
export function validSheets(v) {
  if (v==null) return {}; if (typeof v!=='object'||Array.isArray(v)) bad('checkSheets must be an object');
  const out={};
  for (const [gate,items] of Object.entries(v)) { if (!GATES[gate]) bad(`checkSheets: unknown gate ${gate}`); if (!Array.isArray(items)||items.length>40) bad(`checkSheets.${gate} must be a list of up to 40 items`);
    if (!items.length) continue;
    out[gate]=items.map((it,i)=>{ const label=String(it?.label??'').trim(); if (!label||label.length>160) bad(`checkSheets.${gate}[${i}].label is required`);
      const type=['ok','measure'].includes(it.type)?it.type:bad(`checkSheets.${gate}[${i}].type must be ok or measure`);
      if (type==='ok') return {label,type};
      const min=it.min===''||it.min==null?null:Number(it.min), max=it.max===''||it.max==null?null:Number(it.max);
      if ((min!=null&&!Number.isFinite(min))||(max!=null&&!Number.isFinite(max))||(min==null&&max==null)) bad(`checkSheets.${gate}[${i}] needs a numeric min and/or max`);
      return {label,type,min,max,unit:String(it.unit??'').slice(0,12)}; }); }
  return out;
}

// ---------- Quality gates ----------
// Every gate with a check sheet on the product is required; the latest result of each must be a pass to release.
export async function gateStatus(b,product) {
  if (product===undefined) product=await one('SELECT * FROM products WHERE id=?',b.product_id);
  const sheets=sheetsOf(product), checks=await all('SELECT c.*,u.name checked_by_name FROM batch_checks c LEFT JOIN users u ON u.id=c.checked_by WHERE batch_id=? ORDER BY checked_at',b.id);
  return Object.keys(GATES).map(gate=>{ const mine=checks.filter(c=>c.gate===gate), latest=mine.at(-1);
    return {gate,label:GATES[gate],required:!!sheets[gate],items:sheets[gate]||[],attempts:mine.length,firstTimePass:mine[0]?.result==='pass',
      latest:latest?{id:latest.id,result:latest.result,at:latest.checked_at,by:latest.checked_by_name,note:latest.note,answers:J(latest.answers,[])}:null}; });
}
export const gatesOpen=gates=>gates.filter(g=>g.required&&g.latest?.result!=='pass');

export async function recordCheck(u,b,gate,answers,note='') {
  if (!GATES[gate]) bad('Unknown gate'); if (['scrapped'].includes(b.status)) bad('This batch is scrapped');
  const product=await one('SELECT * FROM products WHERE id=?',b.product_id), sheet=sheetsOf(product)[gate];
  if (!sheet) bad(`${product.part_number} has no ${GATES[gate]} check sheet. Set it up under Products.`);
  if (!Array.isArray(answers)||answers.length!==sheet.length) bad(`Answer all ${sheet.length} items of the check sheet`);
  const graded=sheet.map((it,i)=>{ const a=answers[i];
    if (it.type==='ok') { if (typeof a?.ok!=='boolean') bad(`Item ${i+1} (${it.label}): choose OK or Not OK`); return {label:it.label,ok:a.ok}; }
    const v=Number(a?.value); if (a?.value===''||a?.value==null||!Number.isFinite(v)) bad(`Item ${i+1} (${it.label}): enter the measured value`);
    return {label:it.label,value:v,unit:it.unit,min:it.min,max:it.max,ok:(it.min==null||v>=it.min)&&(it.max==null||v<=it.max)}; });
  const result=graded.every(x=>x.ok)?'pass':'fail', key=id(), at=now();
  await transaction(async ()=>{
    await run('INSERT INTO batch_checks (id,company_id,batch_id,gate,result,answers,note,checked_by,checked_at) VALUES (?,?,?,?,?,?,?,?,?)',key,b.company_id,b.id,gate,result,JSON.stringify(graded),String(note||'').slice(0,500),u.id,at);
    if (result==='fail') {
      // A failed gate stops the batch from shipping until it is checked again and passes, or a manager decides.
      // A running batch keeps running (the gate blocks its release); a finished one goes on hold.
      if (['completed','released'].includes(b.status)) await run("UPDATE batches SET status='on_hold',hold_reason=? WHERE id=?",`${GATES[gate]} failed: ${graded.filter(x=>!x.ok).map(x=>x.label).join(', ')}`.slice(0,300),b.id);
      await raiseAlert({companyId:b.company_id,module:'quality',severity:'warning',equipmentId:b.equipment_id,title:`${GATES[gate]} failed on batch ${b.batch_number}`,detail:graded.filter(x=>!x.ok).map(x=>`${x.label}${x.value!=null?`: ${x.value} ${x.unit||''} (limits ${x.min??'–'}…${x.max??'–'})`:''}`).join('\n'),dedupeKey:`gate:${b.id}:${gate}`});
    } else await resolveAlertKey(`gate:${b.id}:${gate}`);
  });
  return {id:key,gate,result,answers:graded};
}

// ---------- Process readings, deviations, SPC ----------
export async function recordReadings(b,readings,source='machine',{inTransaction=false}={}) {
  if (b.status!=='running') bad('Readings can only be recorded for a running batch');
  if (!Array.isArray(readings)||!readings.length||readings.length>500) bad('readings must be a list of 1-500 readings');
  const product=await one('SELECT * FROM products WHERE id=?',b.product_id), win=windowOf(product), opened=[];
  const rows=readings.map((r,i)=>{ const v=Number(r?.value), t=r?.observedAt?new Date(r.observedAt):new Date();
    if (typeof r?.parameter!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(r.parameter)) bad(`readings[${i}].parameter is invalid`);
    if (!Number.isFinite(v)) bad(`readings[${i}].value must be a number`); if (Number.isNaN(t.getTime())||t.getTime()>Date.now()+120000) bad(`readings[${i}].observedAt is invalid`);
    return {parameter:r.parameter,value:v,at:t.toISOString()}; }).sort((a,b)=>a.at<b.at?-1:1);
  const work=async ()=>{
    for (const r of rows) {
      await run('INSERT INTO process_readings (batch_id,observed_at,parameter,value,source) VALUES (?,?,?,?,?) ON CONFLICT (batch_id,parameter,observed_at) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source',b.id,r.at,r.parameter,r.value,source);
      const w=win[r.parameter]; if (!w) continue;
      const out=(w.min!=null&&r.value<w.min)||(w.max!=null&&r.value>w.max);
      const cur=await one('SELECT * FROM process_deviations WHERE batch_id=? AND parameter=? AND ended_at IS NULL',b.id,r.parameter);
      if (out&&cur) { const worse=Math.abs(r.value-((w.min!=null&&r.value<w.min)?w.min:w.max))>Math.abs(cur.value-((w.min!=null&&cur.value<w.min)?w.min:w.max)); await run(`UPDATE process_deviations SET readings=readings+1${worse?',value=?':''} WHERE id=?`,...(worse?[r.value]:[]),cur.id); }
      else if (out) { const key=id(); await run('INSERT INTO process_deviations (id,company_id,batch_id,parameter,value,min,max,started_at) VALUES (?,?,?,?,?,?,?,?)',key,b.company_id,b.id,r.parameter,r.value,w.min,w.max,r.at); opened.push({id:key,parameter:r.parameter,value:r.value,min:w.min,max:w.max});
        await raiseAlert({companyId:b.company_id,module:'quality',severity:product.hold_on_deviation?'critical':'warning',equipmentId:b.equipment_id,title:`${r.parameter} out of window on batch ${b.batch_number}`,detail:`${r.value} (window ${w.min??'–'}…${w.max??'–'}) at ${r.at}. ${product.hold_on_deviation?'The batch goes on hold when completed until the deviation is decided.':'Decide whether the parts made meanwhile are acceptable.'}`,dedupeKey:`deviation:${key}`}); }
      else if (cur) await run('UPDATE process_deviations SET ended_at=? WHERE id=?',r.at,cur.id);
    }
  };
  if (inTransaction) await work(); else await transaction(work);
  return {recorded:rows.length,deviations:opened};
}
export async function decideDeviation(u,dev,decision,disposition) {
  if (dev.status!=='open') bad('This deviation is already decided');
  await run('UPDATE process_deviations SET status=?,disposition=?,decided_by=?,decided_at=?,ended_at=COALESCE(ended_at,?) WHERE id=?',decision,String(disposition).slice(0,500),u.id,now(),now(),dev.id);
  await resolveAlertKey(`deviation:${dev.id}`);
}
export const deviationsOf=async batchId=>await all('SELECT d.*,u.name decided_by_name FROM process_deviations d LEFT JOIN users u ON u.id=d.decided_by WHERE batch_id=? ORDER BY started_at',batchId);

// Statistics per setting from the readings: mean, spread, Cp/Cpk against the window, ±3σ control limits and the series.
export async function spc(batchIds,product) {
  const win=windowOf(product), params=[...new Set(batchIds.length?(await all(`SELECT DISTINCT parameter FROM process_readings WHERE batch_id IN (${batchIds.map(()=>'?').join(',')})`,...batchIds)).map(r=>r.parameter):[])];
  return (await mapSeq(params, async p=>{ const xs=await all(`SELECT observed_at t,value v,batch_id FROM process_readings WHERE parameter=? AND batch_id IN (${batchIds.map(()=>'?').join(',')}) ORDER BY observed_at`,p,...batchIds);
    const n=xs.length, mean=xs.reduce((s,x)=>s+x.v,0)/n, sd=n>1?Math.sqrt(xs.reduce((s,x)=>s+(x.v-mean)**2,0)/(n-1)):0, w=win[p]||{};
    const cp=w.min!=null&&w.max!=null&&sd>0?(w.max-w.min)/(6*sd):null, cpk=sd>0&&(w.min!=null||w.max!=null)?Math.min(...[w.max!=null?(w.max-mean)/(3*sd):Infinity,w.min!=null?(mean-w.min)/(3*sd):Infinity]):null;
    return {parameter:p,n,mean:round(mean,3),sd:round(sd,3),min:round(Math.min(...xs.map(x=>x.v)),3),max:round(Math.max(...xs.map(x=>x.v)),3),lsl:w.min??null,usl:w.max??null,
      ucl:round(mean+3*sd,3),lcl:round(mean-3*sd,3),cp:round(cp),cpk:round(cpk),outside:xs.filter(x=>(w.min!=null&&x.v<w.min)||(w.max!=null&&x.v>w.max)).length,
      capability:cpk==null?'no window':cpk>=1.67?'capable (≥ 1.67)':cpk>=1.33?'capable (≥ 1.33)':cpk>=1?'marginal':'not capable',
      series:xs.slice(-240).map(x=>({t:x.t,v:x.v}))}; }));
}

// ---------- Release rules ----------
// Why a batch may not be released yet; empty when it may.
export async function releaseBlockers(b) {
  const out=[];
  if ((await all("SELECT 1 FROM batch_materials bm JOIN material_lots l ON l.id=bm.lot_id WHERE bm.batch_id=? AND l.status='quarantined'",b.id)).length) out.push('A material lot of this batch is quarantined');
  for (const g of gatesOpen(await gateStatus(b))) out.push(g.latest?`${g.label} failed – check again`:`${g.label} not done`);
  const devs=await deviationsOf(b.id); if (devs.some(d=>d.status==='open')) out.push('Process deviations are waiting for a decision'); if (devs.some(d=>d.status==='rejected')) out.push('A process deviation was rejected – scrap or sort the batch');
  return out;
}

// ---------- FIFO (material) ----------
const remainingKg=async lotId=>{ const l=await one('SELECT quantity_kg FROM material_lots WHERE id=?',lotId), used=(await one('SELECT coalesce(sum(quantity_kg),0) u FROM batch_materials WHERE lot_id=?',lotId)).u; return l.quantity_kg-used; };
// Older released lots of the same material (and company) that still have stock and were not chosen.
export async function fifoWarnings(lots) {
  const chosen=new Set(lots.map(l=>l.id)), out=[];
  for (const l of lots) for (const o of await all("SELECT * FROM material_lots WHERE company_id=? AND material=? AND status='released' AND received_at<? AND id<>? ORDER BY received_at",l.company_id,l.material,l.received_at,l.id))
    if (!chosen.has(o.id)&&await remainingKg(o.id)>0.5&&!out.some(x=>x.olderLotId===o.id)) out.push({lot:l.lot_number,material:l.material,olderLot:o.lot_number,olderLotId:o.id,olderReceivedAt:o.received_at,remainingKg:round(await remainingKg(o.id),0)});
  return out;
}

// ---------- Labels: parts, boxes, pallets ----------
export async function createUnits(u,b,{kind='box',count,perUnit}) {
  if (!['part','box'].includes(kind)) bad('kind must be part or box');
  if (!['running','completed','released'].includes(b.status)) bad(`A ${b.status.replace('_',' ')} batch cannot be packed`);
  if (!Number.isInteger(count)||count<1||count>(kind==='part'?5000:500)) bad(`count must be 1-${kind==='part'?5000:500}`);
  const product=await one('SELECT * FROM products WHERE id=?',b.product_id), qty=kind==='part'?1:Number(perUnit??product.pack_qty);
  if (!Number.isFinite(qty)||qty<=0) bad('Give the quantity per box (or set the pack quantity on the product)');
  const summary=await batchSummary(b), limit=b.status==='running'?b.planned_qty:summary.good, already=(await all("SELECT coalesce(sum(quantity),0) q FROM trace_units WHERE batch_id=? AND kind=?",b.id,kind))[0].q;
  if (already+count*qty>limit+1e-9) bad(`That would label ${already+count*qty} ${product.unit}, more than the batch's ${b.status==='running'?'planned':'good'} quantity (${limit})`);
  const prefix=kind==='part'?`${b.batch_number}-P`:`${b.batch_number}-`, start=(await one('SELECT count(*) n FROM trace_units WHERE batch_id=? AND kind=?',b.id,kind)).n, at=now(), made=[];
  await transaction(async ()=>{ for (let i=1;i<=count;i++) { const serial=`${prefix}${String(start+i).padStart(4,'0')}`, key=id();
    await run('INSERT INTO trace_units (id,company_id,batch_id,serial,kind,quantity,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,b.company_id,b.id,serial,kind,qty,'packed',u.id,at); made.push({id:key,serial,kind,quantity:qty}); } });
  return made;
}
export async function createPallet(u,companyId,serials) {
  if (!Array.isArray(serials)||!serials.length||serials.length>200) bad('Scan 1-200 boxes for the pallet');
  const boxes=(await mapSeq(serials, async s=>{ const x=await one("SELECT * FROM trace_units WHERE company_id=? AND serial=?",companyId,String(s).trim().toUpperCase()); if (!x) bad(`Unknown label ${s}`); if (x.kind!=='box') bad(`${x.serial} is not a box`); if (x.parent_id) bad(`${x.serial} is already on a pallet`); if (x.status!=='packed') bad(`${x.serial} is ${x.status}`); return x; }));
  const n=(await one("SELECT count(*) n FROM trace_units WHERE company_id=? AND kind='pallet'",companyId)).n, serial=`PAL-${new Date().toISOString().slice(2,10).replaceAll('-','')}-${String(n+1).padStart(4,'0')}`, key=id();
  await transaction(async ()=>{ await run('INSERT INTO trace_units (id,company_id,batch_id,serial,kind,quantity,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,companyId,boxes[0].batch_id,serial,'pallet',boxes.reduce((s,x)=>s+x.quantity,0),'packed',u.id,now());
    for (const x of boxes) await run('UPDATE trace_units SET parent_id=? WHERE id=?',key,x.id); });
  return {id:key,serial,boxes:boxes.length,quantity:boxes.reduce((s,x)=>s+x.quantity,0),batches:[...new Set(boxes.map(x=>x.batch_id))].length};
}
export const unitView=async x=>{ const b=await one('SELECT * FROM batches WHERE id=?',x.batch_id), p=await one('SELECT part_number,name,unit,customer FROM products WHERE id=?',b.product_id);
  return {id:x.id,serial:x.serial,kind:x.kind,quantity:x.quantity,status:x.status,parentId:x.parent_id,shipmentId:x.shipment_id,createdAt:x.created_at,batch:{id:b.id,batchNumber:b.batch_number,status:b.status,startedAt:b.started_at},product:p}; };

// ---------- Dispatch ----------
const children=async unit=>unit.kind==='pallet'?await all('SELECT * FROM trace_units WHERE parent_id=?',unit.id):[unit];
// Checks a scanned label against the shipment: only packed units of released batches without quarantined material,
// for the shipment's customer. Older packed stock of the same product is a FIFO warning (not a block).
export async function checkUnitForShipment(unit,shipment) {
  if (unit.status!=='packed') bad(`${unit.serial} is ${unit.status}${unit.shipment_id?' (already on a shipment)':''}`);
  if (unit.kind!=='pallet'&&unit.parent_id) bad(`${unit.serial} is on a pallet – scan the pallet label`);
  const warnings=[];
  for (const x of await children(unit)) {
    const b=await one('SELECT * FROM batches WHERE id=?',x.batch_id), p=await one('SELECT * FROM products WHERE id=?',b.product_id);
    if (b.status!=='released') bad(`${x.serial}: batch ${b.batch_number} is ${b.status.replace('_',' ')} – only released batches may ship${b.hold_reason?` (${b.hold_reason})`:''}`);
    const blockers=await releaseBlockers(b); if (blockers.length) bad(`${x.serial}: ${blockers[0]}`);
    if (p.customer&&p.customer.toLowerCase()!==shipment.customer.toLowerCase()) bad(`${x.serial}: ${p.part_number} is made for ${p.customer}, not ${shipment.customer} – wrong part for this shipment`);
    const older=await one(`SELECT b2.batch_number,b2.started_at FROM trace_units t JOIN batches b2 ON b2.id=t.batch_id WHERE t.company_id=? AND t.status='packed' AND t.shipment_id IS NULL AND b2.product_id=? AND b2.status='released' AND b2.started_at<? ORDER BY b2.started_at LIMIT 1`,unit.company_id,b.product_id,b.started_at);
    if (older&&!warnings.some(w=>w.includes(older.batch_number))) warnings.push(`FIFO: older stock of ${p.part_number} from batch ${older.batch_number} is still in the warehouse`);
  }
  return warnings;
}
export async function shipmentView(s) {
  const units=(await mapSeq((await all('SELECT * FROM trace_units WHERE shipment_id=? ORDER BY created_at',s.id)), unitView));
  const lines={}; for (const x of units) if (x.kind!=='pallet') { const k=`${x.product.part_number}|${x.batch.batchNumber}`; (lines[k]??={partNumber:x.product.part_number,name:x.product.name,unit:x.product.unit,batchNumber:x.batch.batchNumber,batchId:x.batch.id,units:0,quantity:0}); lines[k].units++; lines[k].quantity+=x.quantity; }
  return {...s,channelLabel:CHANNELS[s.channel],units,lines:Object.values(lines),quantity:Object.values(lines).reduce((t,l)=>t+l.quantity,0)};
}
export async function addToShipment(s,unit) {
  if (s.status!=='loading') bad('This shipment is already closed');
  const warnings=await checkUnitForShipment(unit,s);
  await transaction(async ()=>{ for (const x of [unit,...(unit.kind==='pallet'?await children(unit):[])]) await run('UPDATE trace_units SET shipment_id=? WHERE id=?',s.id,x.id); });
  return warnings;
}
export async function removeFromShipment(s,unit) {
  if (s.status!=='loading') bad('This shipment is already closed'); if (unit.shipment_id!==s.id) bad(`${unit.serial} is not on this shipment`);
  if (unit.kind!=='pallet'&&unit.parent_id) bad('Remove the pallet, not a box on it');
  for (const x of [unit,...(unit.kind==='pallet'?await children(unit):[])]) await run('UPDATE trace_units SET shipment_id=NULL WHERE id=?',x.id);
}
export async function shipShipment(s) {
  if (s.status!=='loading') bad('This shipment is already closed');
  const units=await all('SELECT * FROM trace_units WHERE shipment_id=?',s.id); if (!units.length) bad('Scan at least one label before shipping');
  // Re-check at the gate: a batch may have been put on hold after it was loaded.
  for (const x of units.filter(x=>x.kind!=='pallet')) { const b=await one('SELECT * FROM batches WHERE id=?',x.batch_id); if (b.status!=='released') bad(`${x.serial}: batch ${b.batch_number} is now ${b.status.replace('_',' ')} – unload it`); }
  const at=now(); await transaction(async ()=>{ await run("UPDATE shipments SET status='shipped',shipped_at=? WHERE id=?",at,s.id); await run("UPDATE trace_units SET status='shipped' WHERE shipment_id=?",s.id); });
}

// ---------- Recall scope ----------
// Exactly what a lot or batch reached: batches, labels in stock, shipped quantities per customer and shipment. Compared
// with the scope without traceability: everything made of the same product while the lot (or batch) was in use.
export async function recallScope({lot,batch}) {
  const batches=lot?await lotUsage(lot.id):[await batchSummary(batch)];
  const ids=batches.map(b=>b.id), q=ids.map(()=>'?').join(',');
  const units=ids.length?await all(`SELECT * FROM trace_units WHERE batch_id IN (${q}) AND kind<>'pallet'`,...ids):[];
  const shipments=ids.length?await all(`SELECT s.*,sum(t.quantity) qty,count(*) labels FROM trace_units t JOIN shipments s ON s.id=t.shipment_id WHERE t.batch_id IN (${q}) AND t.kind<>'pallet' AND s.status='shipped' GROUP BY s.id ORDER BY s.shipped_at`,...ids):[];
  const customers={}; for (const s of shipments) { (customers[s.customer]??={customer:s.customer,channel:CHANNELS[s.channel],shipments:0,quantity:0}); customers[s.customer].shipments++; customers[s.customer].quantity+=s.qty; }
  const affectedQty=batches.reduce((t,b)=>t+(b.good||0),0);
  let naive=affectedQty;
  if (batches.length) { const from=batches.reduce((m,b)=>b.started_at<m?b.started_at:m,batches[0].started_at), to=batches.reduce((m,b)=>(b.ended_at||now())>m?(b.ended_at||now()):m,'');
    const products=[...new Set(batches.map(b=>b.product_id))];
    // Without lot records a recall covers the whole production of the product from 30 days before to 30 days after.
    naive=(await mapSeq((await all(`SELECT * FROM batches WHERE company_id=? AND product_id IN (${products.map(()=>'?').join(',')}) AND started_at<? AND coalesce(ended_at,?)>?`,batches[0].company_id,...products,new Date(Date.parse(to)+30*DAY).toISOString(),now(),new Date(Date.parse(from)-30*DAY).toISOString())), batchSummary)).reduce((t,b)=>t+(b.good||0),0); }
  return {batches:batches.map(b=>({id:b.id,batchNumber:b.batch_number,product:b.product,status:b.status,good:b.good,startedAt:b.started_at})),
    inStock:{labels:units.filter(x=>x.status==='packed').length,quantity:units.filter(x=>x.status==='packed').reduce((t,x)=>t+x.quantity,0)},
    shipped:{labels:units.filter(x=>['shipped','returned'].includes(x.status)).length,quantity:units.filter(x=>['shipped','returned'].includes(x.status)).reduce((t,x)=>t+x.quantity,0)},
    shipments:shipments.map(s=>({id:s.id,shipmentNumber:s.shipment_number,customer:s.customer,channel:CHANNELS[s.channel],shippedAt:s.shipped_at,quantity:s.qty,labels:s.labels})),
    customers:Object.values(customers),affectedQty,scopeWithoutTraceability:naive,reductionPct:naive>0?round((1-affectedQty/naive)*100,1):null};
}

// ---------- Warranty authentication and field returns ----------
export async function authenticate(companyId,serial,customer,reportedAt=now(),excludeId=null) {
  const s=String(serial||'').trim().toUpperCase(), checks=[];
  const unit=s?await one('SELECT * FROM trace_units WHERE company_id=? AND serial=?',companyId,s):null;
  if (!unit) return {authenticity:'not_found',unit:null,batch:null,checks:[{check:'Label is one of ours',ok:false,detail:s?`${s} was never printed by this plant – possibly counterfeit or a typing error`:'No serial given'}]};
  checks.push({check:'Label is one of ours',ok:true,detail:`${unit.kind} ${unit.serial}, printed ${unit.created_at.slice(0,10)}`});
  const b=await one('SELECT * FROM batches WHERE id=?',unit.batch_id), p=await one('SELECT * FROM products WHERE id=?',b.product_id), sh=unit.shipment_id?await one('SELECT * FROM shipments WHERE id=?',unit.shipment_id):null;
  checks.push({check:'Made in a released batch',ok:['released'].includes(b.status)||(b.status==='on_hold'&&!!sh),detail:`Batch ${b.batch_number} (${b.status.replace('_',' ')})`});
  checks.push({check:'Shipped by us',ok:!!sh&&sh.status==='shipped',detail:sh?`${sh.shipment_number} on ${sh.shipped_at?.slice(0,10)||'—'}`:'Never shipped – still in stock or scrapped'});
  if (sh) checks.push({check:'Shipped to this customer',ok:!customer||sh.customer.toLowerCase()===String(customer).toLowerCase(),detail:`Shipped to ${sh.customer} (${CHANNELS[sh.channel]})`});
  if (sh?.shipped_at) { const ends=new Date(Date.parse(sh.shipped_at)); ends.setUTCMonth(ends.getUTCMonth()+p.warranty_months);
    checks.push({check:'Within warranty',ok:Date.parse(reportedAt)<=ends.getTime(),detail:`${p.warranty_months} months from shipment, until ${ends.toISOString().slice(0,10)}`}); }
  const dup=await all("SELECT reference FROM field_returns WHERE unit_id=? AND kind='warranty_claim' AND status<>'rejected' AND id<>?",unit.id,excludeId||'');
  checks.push({check:'Not claimed before',ok:!dup.length,detail:dup.length?`Already claimed in ${dup.map(d=>d.reference).join(', ')}`:'First claim for this label'});
  return {authenticity:checks.every(c=>c.ok)?'genuine':'suspicious',unit,batch:b,checks};
}
export async function nextReference(companyId) {
  const y=new Date().getUTCFullYear(), n=(await one("SELECT count(*) n FROM field_returns WHERE company_id=? AND reference ILIKE ?",companyId,`FR-${y}-%`)).n;
  return `FR-${y}-${String(n+1).padStart(4,'0')}`;
}

// Field returns per 1,000 shipped, by what the returned parts had in common.
export async function fieldCorrelation(companyIds) {
  const q=companyIds.map(()=>'?').join(',');
  const shipped=await all(`SELECT batch_id,sum(quantity) q FROM trace_units WHERE company_id IN (${q}) AND status IN ('shipped','returned') AND kind<>'pallet' GROUP BY batch_id`,...companyIds);
  const returned=await all(`SELECT batch_id,sum(quantity) q,count(*) n FROM field_returns WHERE company_id IN (${q}) AND batch_id IS NOT NULL AND status<>'rejected' GROUP BY batch_id`,...companyIds);
  const ship=Object.fromEntries(shipped.map(r=>[r.batch_id,r.q])), ret=Object.fromEntries(returned.map(r=>[r.batch_id,r.q]));
  const batchIds=[...new Set([...Object.keys(ship),...Object.keys(ret)])], factors={};
  const add=(dim,key,label,b)=>{ const f=(factors[dim]??={})[key]??={key,label,shipped:0,returned:0,batches:0}; f.shipped+=ship[b]||0; f.returned+=ret[b]||0; f.batches++; };
  for (const bid of batchIds) { const b=await one('SELECT * FROM batches WHERE id=?',bid), p=await one('SELECT part_number FROM products WHERE id=?',b.product_id), m=await one('SELECT asset_tag,model FROM equipment WHERE id=?',b.equipment_id), mould=b.mould_id?await one('SELECT asset_tag,model FROM equipment WHERE id=?',b.mould_id):null;
    add('product',b.product_id,p.part_number,bid); add('machine',b.equipment_id,m.asset_tag||m.model,bid); if (mould) add('mould',b.mould_id,mould.asset_tag||mould.model,bid); add('operator',b.operator_name,b.operator_name,bid);
    for (const l of await all('SELECT l.* FROM batch_materials bm JOIN material_lots l ON l.id=bm.lot_id WHERE bm.batch_id=?',bid)) { add('lot',l.id,`${l.lot_number} (${l.material})`,bid); add('supplier',l.supplier,l.supplier,bid); }
    for (const [k,v] of Object.entries(J(b.process_params,{}))) { const band=v>=100?Math.round(v/10)*10:v>=10?Math.round(v):Math.round(v*10)/10; add('setting',`${k}:${band}`,`${k} ≈ ${band}`,bid); } }
  const totalShipped=Object.values(ship).reduce((a,b)=>a+b,0), totalReturned=Object.values(ret).reduce((a,b)=>a+b,0), avg=totalShipped?totalReturned/totalShipped*1000:0;
  const rank=Object.entries(factors).flatMap(([dim,m])=>Object.values(m).map(f=>({dimension:dim,...f,per1000:f.shipped?round(f.returned/f.shipped*1000,2):null,vsAverage:f.shipped&&avg?round(f.returned/f.shipped*1000/avg,1):null})))
    .filter(f=>f.returned>0&&f.shipped>0).sort((a,b)=>b.per1000-a.per1000);
  return {totalShipped,totalReturned,per1000:round(avg,2),ppm:totalShipped?Math.round(totalReturned/totalShipped*1e6):0,factors:rank.slice(0,25)};
}

export async function supplierScorecard(companyIds) {
  const q=companyIds.map(()=>'?').join(',');
  const lots=await all(`SELECT * FROM material_lots WHERE company_id IN (${q})`,...companyIds), out={};
  for (const l of lots) { const s=out[l.supplier]??={supplier:l.supplier,lots:0,kg:0,quarantined:0,materials:new Set(),batches:new Set(),returns:0,lastDelivery:null};
    s.lots++; s.kg+=l.quantity_kg; if (l.status==='quarantined') s.quarantined++; s.materials.add(l.material); if (!s.lastDelivery||l.received_at>s.lastDelivery) s.lastDelivery=l.received_at;
    for (const b of await all('SELECT batch_id FROM batch_materials WHERE lot_id=?',l.id)) s.batches.add(b.batch_id); }
  return (await mapSeq(Object.values(out), async s=>{ const ids=[...s.batches], q2=ids.map(()=>'?').join(',');
    const returns=ids.length?(await one(`SELECT count(*) n FROM field_returns WHERE batch_id IN (${q2}) AND status<>'rejected'`,...ids)).n:0;
    const devs=ids.length?(await one(`SELECT count(*) n FROM process_deviations WHERE batch_id IN (${q2})`,...ids)).n:0;
    const held=ids.length?(await one(`SELECT count(*) n FROM batches WHERE id IN (${q2}) AND status IN ('on_hold','scrapped')`,...ids)).n:0;
    const score=Math.max(0,100-s.quarantined/Math.max(1,s.lots)*60-returns*5-held*3);
    return {supplier:s.supplier,lots:s.lots,kg:Math.round(s.kg),materials:[...s.materials],batches:ids.length,quarantinedLots:s.quarantined,batchesHeld:held,deviations:devs,fieldReturns:returns,lastDelivery:s.lastDelivery,score:Math.round(score),rating:score>=90?'A':score>=75?'B':'C'}; }))
    .sort((a,b)=>a.score-b.score);
}

// ---------- One search for any code ----------
// A serial, box, pallet, batch, lot, shipment or return reference → the whole chain, backward and forward.
export async function traceAny(companyIds,code) {
  const c=String(code||'').trim().toUpperCase(); if (c.length<2) bad('Scan or type a code');
  const q=companyIds.map(()=>'?').join(','), started=process.hrtime.bigint();
  const find=async (sql,...a)=>await one(sql.replace('%C',`company_id IN (${q})`),...companyIds,...a);
  let found=null, batches=[];
  const unit=await find('SELECT * FROM trace_units WHERE %C AND serial=?',c);
  if (unit) { found={type:unit.kind,label:unit.serial,id:unit.id}; batches=unit.kind==='pallet'?[...new Set((await all('SELECT batch_id FROM trace_units WHERE parent_id=?',unit.id)).map(x=>x.batch_id))]:[unit.batch_id]; }
  const batch=!found&&await find('SELECT * FROM batches WHERE %C AND batch_number=?',c); if (batch) { found={type:'batch',label:batch.batch_number,id:batch.id}; batches=[batch.id]; }
  const lot=!found&&await find('SELECT * FROM material_lots WHERE %C AND lot_number=?',c); if (lot) { found={type:'lot',label:lot.lot_number,id:lot.id}; batches=(await lotUsage(lot.id)).map(b=>b.id); }
  const sh=!found&&await find('SELECT * FROM shipments WHERE %C AND shipment_number=?',c); if (sh) { found={type:'shipment',label:sh.shipment_number,id:sh.id}; batches=[...new Set((await all("SELECT batch_id FROM trace_units WHERE shipment_id=? AND kind<>'pallet'",sh.id)).map(x=>x.batch_id))]; }
  const fr=!found&&await find('SELECT * FROM field_returns WHERE %C AND reference=?',c); if (fr) { found={type:'return',label:fr.reference,id:fr.id}; batches=fr.batch_id?[fr.batch_id]:[]; }
  if (!found) { const like=`%${c}%`; return {found:null,suggestions:[
    ...await all(`SELECT serial code,kind type FROM trace_units WHERE company_id IN (${q}) AND serial ILIKE ? LIMIT 6`,...companyIds,like),
    ...await all(`SELECT batch_number code,'batch' type FROM batches WHERE company_id IN (${q}) AND batch_number ILIKE ? LIMIT 6`,...companyIds,like),
    ...await all(`SELECT lot_number code,'lot' type FROM material_lots WHERE company_id IN (${q}) AND lot_number ILIKE ? LIMIT 6`,...companyIds,like),
    ...await all(`SELECT shipment_number code,'shipment' type FROM shipments WHERE company_id IN (${q}) AND shipment_number ILIKE ? LIMIT 6`,...companyIds,like),
    ...await all(`SELECT reference code,'return' type FROM field_returns WHERE company_id IN (${q}) AND reference ILIKE ? LIMIT 6`,...companyIds,like)]}; }
  const bq=batches.map(()=>'?').join(',');
  const chain={
    lots:batches.length?await all(`SELECT DISTINCT l.id,l.lot_number,l.material,l.supplier,l.certificate,l.status,l.received_at FROM batch_materials bm JOIN material_lots l ON l.id=bm.lot_id WHERE bm.batch_id IN (${bq}) ORDER BY l.received_at`,...batches):[],
    batches:(await mapSeq(batches, async id=>{ const b=await one('SELECT * FROM batches WHERE id=?',id), s=await batchSummary(b), gates=await gateStatus(b);
      return {id:b.id,batchNumber:b.batch_number,status:b.status,holdReason:b.hold_reason,product:s.product,machine:s.machine,mould:b.mould_id?await one('SELECT asset_tag,model FROM equipment WHERE id=?',b.mould_id):null,
        operator:b.operator_name,startedBy:b.started_by?(await one('SELECT name FROM users WHERE id=?',b.started_by))?.name:null,startedAt:b.started_at,endedAt:b.ended_at,good:s.good,scrap:s.scrap,processParams:J(b.process_params,{}),
        gates:gates.filter(g=>g.required||g.latest).map(g=>({gate:g.gate,label:g.label,result:g.latest?.result||null,at:g.latest?.at||null,by:g.latest?.by||null})),
        deviations:(await deviationsOf(b.id)).map(d=>({parameter:d.parameter,value:d.value,min:d.min,max:d.max,status:d.status,startedAt:d.started_at})),fifoOverride:b.fifo_override}; })),
    units:batches.length?(await all(`SELECT * FROM trace_units WHERE batch_id IN (${bq}) ORDER BY kind DESC,serial LIMIT 400`,...batches)).map(x=>({serial:x.serial,kind:x.kind,quantity:x.quantity,status:x.status,shipmentId:x.shipment_id})):[],
    shipments:batches.length?(await all(`SELECT DISTINCT s.* FROM trace_units t JOIN shipments s ON s.id=t.shipment_id WHERE t.batch_id IN (${bq}) ORDER BY s.created_at`,...batches)).map(s=>({id:s.id,shipmentNumber:s.shipment_number,customer:s.customer,channel:CHANNELS[s.channel],destination:s.destination,status:s.status,shippedAt:s.shipped_at})):[],
    returns:batches.length?(await all(`SELECT * FROM field_returns WHERE batch_id IN (${bq}) ORDER BY reported_at`,...batches)).map(r=>({id:r.id,reference:r.reference,kind:r.kind,customer:r.customer,defect:r.defect,status:r.status,authenticity:r.authenticity,reportedAt:r.reported_at})):[]};
  if (unit) chain.focusUnit={serial:unit.serial,kind:unit.kind,quantity:unit.quantity,status:unit.status,pallet:unit.parent_id?(await one('SELECT serial FROM trace_units WHERE id=?',unit.parent_id))?.serial:null,shipment:unit.shipment_id?await one('SELECT shipment_number,customer FROM shipments WHERE id=?',unit.shipment_id):null};
  return {found,chain,traceMs:Number(process.hrtime.bigint()-started)/1e6};
}

// ---------- Headline figures ----------
export async function traceKpis(companyIds,days=90) {
  const q=companyIds.map(()=>'?').join(','), since=new Date(Date.now()-days*DAY).toISOString();
  const done=await all(`SELECT * FROM batches WHERE company_id IN (${q}) AND started_at>=? AND status IN ('completed','released','on_hold','scrapped')`,...companyIds,since);
  let complete=0, firstTime=0; const missing={};
  for (const b of done) { const gates=await gateStatus(b), lots=(await one('SELECT count(*) n FROM batch_materials WHERE batch_id=?',b.id)).n, params=Object.keys(J(b.process_params,{})).length, devs=await deviationsOf(b.id);
    const gaps=[!lots&&'material lots',!params&&'process settings',!b.operator_name&&'operator',...gates.filter(g=>g.required&&!g.latest).map(g=>g.label),devs.some(d=>d.status==='open')&&'Process deviation decisions'].filter(Boolean);
    if (!gaps.length) complete++; for (const g of gaps) missing[g]=(missing[g]||0)+1;
    if (gates.filter(g=>g.required).every(g=>g.firstTimePass)&&!devs.length&&!['on_hold','scrapped'].includes(b.status)) firstTime++; }
  const corr=await fieldCorrelation(companyIds), lotsQ=await all(`SELECT id FROM material_lots WHERE company_id IN (${q}) AND status='quarantined'`,...companyIds);
  const recall=(await mapSeq((await all(`SELECT id FROM material_lots WHERE company_id IN (${q})`,...companyIds)), async l=>await recallScope({lot:await one('SELECT * FROM material_lots WHERE id=?',l.id)}))).filter(r=>r.reductionPct!=null);
  return {periodDays:days,batches:done.length,compliancePct:done.length?round(complete/done.length*100,1):null,missing:Object.entries(missing).map(([what,n])=>({what,batches:n})).sort((a,b)=>b.batches-a.batches),
    firstTimeQualityPct:done.length?round(firstTime/done.length*100,1):null,
    openDeviations:(await one(`SELECT count(*) n FROM process_deviations WHERE company_id IN (${q}) AND status='open'`,...companyIds)).n,
    gatesFailedOpen:(await one(`SELECT count(DISTINCT batch_id) n FROM batch_checks c WHERE company_id IN (${q}) AND result='fail' AND NOT EXISTS (SELECT 1 FROM batch_checks c2 WHERE c2.batch_id=c.batch_id AND c2.gate=c.gate AND c2.checked_at>c.checked_at)`,...companyIds)).n,
    quarantinedLots:lotsQ.length,labelsInStock:(await one(`SELECT count(*) n FROM trace_units WHERE company_id IN (${q}) AND status='packed' AND kind<>'pallet'`,...companyIds)).n,
    shipments:(await one(`SELECT count(*) n FROM shipments WHERE company_id IN (${q}) AND status='shipped' AND shipped_at>=?`,...companyIds,since)).n,
    openReturns:(await one(`SELECT count(*) n FROM field_returns WHERE company_id IN (${q}) AND status='open'`,...companyIds)).n,
    fieldPpm:corr.ppm,recallReductionPct:recall.length?round(recall.reduce((s,r)=>s+r.reductionPct,0)/recall.length,1):null};
}
