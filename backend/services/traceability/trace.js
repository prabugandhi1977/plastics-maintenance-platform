// Traceability: material lots → production batches → output, with everything that happened on the machine while a
// batch ran. Backward genealogy answers "what went into batch B?", forward "which batches used lot L?"; quarantining
// a lot puts exactly those batches on hold (a targeted recall instead of blocking everything).
import { now, one, all, run, transaction, mapSeq } from '../../common/db.js';
import { raiseAlert } from '../factory/alerts.js';
import { machineOee, lossList } from '../factory/production.js';

// Output of a batch: stored when it was completed, otherwise counted from the machine's production in its window.
export async function batchOutput(b) {
  if (b.good_qty!=null) return {good:b.good_qty,scrap:b.scrap_qty??0};
  const c=await one('SELECT sum(total_qty) t,sum(scrap_qty) s FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<?',b.equipment_id,b.started_at,b.ended_at||now());
  return {good:Math.round(((c.t||0)-(c.s||0))*10)/10,scrap:Math.round((c.s||0)*10)/10};
}
const lotsOf=async batchId=>await all('SELECT l.*,bm.quantity_kg used_kg FROM batch_materials bm JOIN material_lots l ON l.id=bm.lot_id WHERE bm.batch_id=? ORDER BY l.lot_number',batchId);
export const batchSummary=async b=>{ const p=await one('SELECT part_number,name,unit FROM products WHERE id=?',b.product_id), m=await one('SELECT asset_tag,make,model FROM equipment WHERE id=?',b.equipment_id); return {...b,process_params:JSON.parse(b.process_params||'{}'),product:p,machine:m,...await batchOutput(b),lots:(await lotsOf(b.id)).map(l=>({id:l.id,lotNumber:l.lot_number,material:l.material,status:l.status}))}; };

// Backward genealogy plus the context an investigation needs: maintenance, alerts, downtime and camera results on
// the machine (and mould) while the batch ran.
export async function genealogy(b) {
  const from=b.started_at, to=b.ended_at||now(), machine=await one('SELECT * FROM equipment WHERE id=?',b.equipment_id), assets=[b.equipment_id,b.mould_id].filter(Boolean);
  const inWindow=async (table,col)=>await all(`SELECT * FROM ${table} WHERE equipment_id IN (${assets.map(()=>'?').join(',')}) AND ${col}>=? AND ${col}<? ORDER BY ${col}`,...assets,from,to);
  const oee=await machineOee(machine,Date.parse(from),Date.parse(to)), vision=(await all('SELECT sum(inspected) i,sum(rejected) r FROM vision_results WHERE equipment_id=? AND period_start>=? AND period_start<?',b.equipment_id,from,to))[0];
  return {...await batchSummary(b),lots:await lotsOf(b.id),mould:b.mould_id?await one('SELECT id,asset_tag,make,model FROM equipment WHERE id=?',b.mould_id):null,
    tickets:await all(`SELECT id,title,status,priority,created_at,equipment_id FROM tickets WHERE equipment_id IN (${assets.map(()=>'?').join(',')}) AND created_at<? AND (completed_at IS NULL OR completed_at>?) ORDER BY created_at`,...assets,to,from),
    alerts:(await inWindow('alerts','created_at')).map(a=>({id:a.id,title:a.title,severity:a.severity,module:a.module,created_at:a.created_at})),
    downtime:lossList(oee.losses).filter(l=>l.state!=='planned_stop'),oee:oee.oee==null?null:oee.oee*100,
    vision:{inspected:vision.i||0,rejected:vision.r||0}};
}
// Forward: every batch that used a lot.
export const lotUsage=async lotId=>(await mapSeq((await all('SELECT b.* FROM batch_materials bm JOIN batches b ON b.id=bm.batch_id WHERE bm.lot_id=? ORDER BY b.started_at',lotId)), batchSummary));

export async function quarantineLot(lot,reason,u) {
  const affected=(await lotUsage(lot.id)).filter(b=>['running','completed','released'].includes(b.status));
  await transaction(async ()=>{
    await run("UPDATE material_lots SET status='quarantined' WHERE id=?",lot.id);
    for (const b of affected) await run("UPDATE batches SET status='on_hold',hold_reason=? WHERE id=?",`Lot ${lot.lot_number} quarantined: ${reason}`.slice(0,300),b.id);
    await raiseAlert({companyId:lot.company_id,module:'quality',severity:'warning',title:`Lot ${lot.lot_number} quarantined: ${affected.length} batch${affected.length===1?'':'es'} on hold`,detail:`${lot.material} from ${lot.supplier}. Reason: ${reason}. Batches on hold: ${affected.map(b=>b.batch_number).join(', ')||'none'}.`,dedupeKey:`lot-quarantine:${lot.id}`});
  });
  return affected.map(b=>({id:b.id,batchNumber:b.batch_number,previousStatus:b.status}));
}
