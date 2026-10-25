// Spare parts stock: the ledger and everything derived from it. Every change to a quantity on hand goes through
// record(), which writes one immutable movement, updates the plant/bin balance in the same transaction, refuses a
// negative balance (unless an admin adjusts with a reason), writes the audit entry and re-checks the reorder alert.
// Routes are in routes/stock.js; PM plans, tickets, parts requests and the IATF pack use the helpers below.
import { id, now, one, all, run, mapSeq, forEachSeq } from '../../common/db.js';
import { audit } from '../../common/access.js';
import { bad } from '../../common/validate.js';
import { raiseAlert, resolveAlertKey } from '../factory/alerts.js';

export const MOVEMENT_TYPES=['receive','issue','return','adjust','transfer_out','transfer_in'];
const WHOLE=['pcs','set'];
export const q3=n=>Math.round(Number(n)*1000)/1000;
const fmt=n=>String(q3(n));

// A quantity as typed (number or numeric string): positive unless signed, at most 3 decimals, whole for pcs and sets.
export function quantityOf(v,name,unit,{signed=false,zero=false}={}) {
  const n=typeof v==='string'&&v.trim()?Number(v):v;
  if (typeof n!=='number'||!Number.isFinite(n)) bad(`${name} must be a number`);
  if (Math.abs(n)>10000000) bad(`${name} must be at most 10,000,000`);
  if (!signed&&n<0) bad(`${name} cannot be negative`);
  if (!zero&&n===0) bad(`${name} must not be zero`);
  if (Math.abs(Math.round(n*1000)-n*1000)>1e-6) bad(`${name} can have at most 3 decimals`);
  if (unit&&WHOLE.includes(unit)&&!Number.isInteger(n)) bad(`${name} must be a whole number of ${unit}`);
  return q3(n);
}
// Storage location inside a plant (shelf, rack, bin). Upper case, so "a-01" and "A-01" are one bin.
export const binOf=v=>{ const b=String(v??'').trim().toUpperCase(); if (b.length>40) bad('bin must be at most 40 characters'); return b; };

export async function binBalance(partId,plantId,bin) { return (await one('SELECT on_hand FROM spare_stock WHERE part_id=? AND plant_id=? AND bin=?',partId,plantId,bin))?.on_hand??0; }
export async function plantBalance(partId,plantId) { return q3((await one('SELECT COALESCE(SUM(on_hand),0) n FROM spare_stock WHERE part_id=? AND plant_id=?',partId,plantId)).n); }
export async function totals(partId) {
  const onHand=(await one('SELECT COALESCE(SUM(on_hand),0) n FROM spare_stock WHERE part_id=?',partId)).n;
  const onOrder=(await one("SELECT COALESCE(SUM(GREATEST(quantity-received_qty,0)),0) n FROM spare_orders WHERE part_id=? AND status='open'",partId)).n;
  return {onHand:q3(onHand),onOrder:q3(onOrder),available:q3(onHand+onOrder)};
}
// Order enough to get back above the reorder point, and at least the usual reorder quantity.
export const suggestedQty=(part,available)=>q3(Math.max(Number(part.reorder_qty)||0,Number(part.reorder_point)-available));
export const isLow=(part,available)=>!!part.active&&Number(part.reorder_point)>0&&available<Number(part.reorder_point);

// The low-stock alert: raised once when on hand + on order drops below the reorder point (the shared alert dedupe key
// keeps it to one open alert), resolved when an order or a receipt brings it back up, or the part is made inactive.
export async function checkReorder(partId,at=now()) {
  const part=await one('SELECT * FROM spare_parts WHERE id=?',partId); if (!part) return null;
  const t=await totals(partId), key=`stock-low:${partId}`;
  if (!isLow(part,t.available)) { await resolveAlertKey(key,at); return false; }
  await raiseAlert({companyId:part.company_id,module:'stock',severity:'warning',dedupeKey:key,at,
    title:`Spare part below reorder point: ${part.part_number} ${part.name}`,
    detail:`${fmt(t.onHand)} ${part.unit} on hand and ${fmt(t.onOrder)} on order, reorder point ${fmt(part.reorder_point)}. Suggested order: ${fmt(suggestedQty(part,t.available))} ${part.unit}${part.supplier?` from ${part.supplier}`:''}${part.lead_time_days?` (lead time ${part.lead_time_days} days)`:''}.`});
  return true;
}

// One movement. quantity is signed (negative takes stock away). Returns the movement row.
export async function record(u,{part,plantId,bin='',type,quantity,ticketId=null,equipmentId=null,partsRequestId=null,pmJobId=null,orderId=null,transferId=null,reason='',reference='',unitCostMinor=null,allowNegative=false,at=now()}) {
  if (!MOVEMENT_TYPES.includes(type)) bad('Unknown movement type');
  const row=await one('SELECT * FROM spare_stock WHERE part_id=? AND plant_id=? AND bin=?',part.id,plantId,bin);
  const before=row?.on_hand??0, after=q3(before+quantity);
  if (after<0&&!allowNegative) {
    const plant=await one('SELECT name FROM plants WHERE id=?',plantId);
    bad(`Not enough stock: ${fmt(before)} ${part.unit} of ${part.part_number} in ${plant?.name||'this plant'}${bin?` bin ${bin}`:''}`);
  }
  if (row) await run('UPDATE spare_stock SET on_hand=?,updated_at=? WHERE id=?',after,at,row.id);
  else await run('INSERT INTO spare_stock (id,company_id,part_id,plant_id,bin,on_hand,updated_at) VALUES (?,?,?,?,?,?,?)',id(),part.company_id,part.id,plantId,bin,after,at);
  const key=id(), cost=unitCostMinor??part.unit_cost_minor;
  await run(`INSERT INTO spare_movements (id,company_id,part_id,plant_id,bin,type,quantity,balance_after,unit_cost_minor,ticket_id,equipment_id,parts_request_id,pm_job_id,order_id,transfer_id,reason,reference,user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,part.company_id,part.id,plantId,bin,type,quantity,after,cost,ticketId,equipmentId,partsRequestId,pmJobId,orderId,transferId,String(reason).slice(0,500),String(reference).slice(0,200),u.id,at);
  await audit(u,`stock.${type}`,'spare_part',part.id,part.company_id,{movementId:key,plantId,bin,quantity,balanceAfter:after,...(ticketId?{ticketId}:{}),...(pmJobId?{pmJobId}:{}),...(reason?{reason}:{}),...(reference?{reference}:{})});
  return await one('SELECT * FROM spare_movements WHERE id=?',key);
}

// Takes `quantity` from a plant: from the given bin, or else from the fullest bins first. Refuses if the plant has too
// little in total. Returns the movements written.
export async function takeFromPlant(u,part,plantId,bin,quantity,link) {
  const rows=bin!=null&&bin!==''?[{bin,on_hand:await binBalance(part.id,plantId,bin)}]
    :await all('SELECT bin,on_hand FROM spare_stock WHERE part_id=? AND plant_id=? AND on_hand>0 ORDER BY on_hand DESC,bin',part.id,plantId);
  const have=q3(rows.reduce((n,r)=>n+Number(r.on_hand),0));
  if (have<quantity) { const plant=await one('SELECT name FROM plants WHERE id=?',plantId); bad(`Not enough stock: ${fmt(have)} ${part.unit} of ${part.part_number} in ${plant?.name||'this plant'}${bin?` bin ${bin}`:''}, ${fmt(quantity)} needed`); }
  const out=[]; let left=quantity;
  for (const r of rows) { if (left<=0) break; const take=q3(Math.min(left,Number(r.on_hand))); if (take<=0) continue; out.push(await record(u,{...link,part,plantId,bin:r.bin,type:link.type||'issue',quantity:-take})); left=q3(left-take); }
  return out;
}

// Ledger and balances agree: the sum of movements per part, plant and bin equals the stored quantity on hand.
export async function reconcile(companyIds) {
  if (!companyIds.length) return {checked:0,mismatches:[]};
  const marks=companyIds.map(()=>'?').join(',');
  const rows=await all(`SELECT COALESCE(s.part_id,m.part_id) part_id,COALESCE(s.plant_id,m.plant_id) plant_id,COALESCE(s.bin,m.bin) bin,COALESCE(s.on_hand,0) on_hand,COALESCE(m.total,0) ledger
    FROM (SELECT * FROM spare_stock WHERE company_id IN (${marks})) s
    FULL JOIN (SELECT part_id,plant_id,bin,SUM(quantity) total FROM spare_movements WHERE company_id IN (${marks}) GROUP BY 1,2,3) m ON m.part_id=s.part_id AND m.plant_id=s.plant_id AND m.bin=s.bin`,...companyIds,...companyIds);
  return {checked:rows.length,mismatches:rows.filter(r=>q3(r.on_hand)!==q3(r.ledger)).map(r=>({partId:r.part_id,plantId:r.plant_id,bin:r.bin,onHand:q3(r.on_hand),ledger:q3(r.ledger)}))};
}

const parse=v=>{ try { return JSON.parse(v||'[]'); } catch { return []; } };
// Catalogue rows with their stock, open orders and reorder state, for one or more companies in one pass.
export async function partViews(companyIds,{partIds=null}={}) {
  if (!companyIds.length) return [];
  const marks=companyIds.map(()=>'?').join(','), only=partIds?` AND id IN (${partIds.map(()=>'?').join(',')||"''"})`:'';
  const parts=await all(`SELECT * FROM spare_parts WHERE company_id IN (${marks})${only} ORDER BY part_number`,...companyIds,...(partIds||[]));
  if (!parts.length) return [];
  const ids=parts.map(p=>p.id), pm=ids.map(()=>'?').join(',');
  const stock=await all(`SELECT s.part_id,s.plant_id,s.bin,s.on_hand,p.name plant_name FROM spare_stock s JOIN plants p ON p.id=s.plant_id WHERE s.part_id IN (${pm}) ORDER BY p.name,s.bin`,...ids);
  const orders=await all(`SELECT part_id,SUM(GREATEST(quantity-received_qty,0)) n FROM spare_orders WHERE status='open' AND part_id IN (${pm}) GROUP BY part_id`,...ids);
  const fits=await all(`SELECT part_id,equipment_id FROM spare_part_fits WHERE part_id IN (${pm})`,...ids);
  const companies=Object.fromEntries((await all(`SELECT id,name,currency FROM companies WHERE id IN (${marks})`,...companyIds)).map(c=>[c.id,c]));
  return parts.map(p=>{
    const rows=stock.filter(s=>s.part_id===p.id), onHand=q3(rows.reduce((n,s)=>n+Number(s.on_hand),0)), onOrder=q3(orders.find(o=>o.part_id===p.id)?.n??0), available=q3(onHand+onOrder);
    const byPlant=[...new Set(rows.map(s=>s.plant_id))].map(pid=>({plantId:pid,plantName:rows.find(s=>s.plant_id===pid).plant_name,onHand:q3(rows.filter(s=>s.plant_id===pid).reduce((n,s)=>n+Number(s.on_hand),0))}));
    return {...p,reorder_point:Number(p.reorder_point),reorder_qty:Number(p.reorder_qty),fitsTypes:parse(p.fits_types),fitsEquipmentIds:fits.filter(f=>f.part_id===p.id).map(f=>f.equipment_id),
      companyName:companies[p.company_id]?.name,currency:companies[p.company_id]?.currency||'USD',
      stock:rows.map(s=>({plantId:s.plant_id,plantName:s.plant_name,bin:s.bin,onHand:q3(s.on_hand)})),byPlant,onHand,onOrder,available,
      low:isLow(p,available),suggestedQty:isLow(p,available)?suggestedQty(p,available):0,valueMinor:Math.round(onHand*p.unit_cost_minor)};
  });
}

// Parts taken for a ticket (issues less returns), with their cost at the time of issue, in the company currency.
export async function ticketStock(ticketId) {
  const rows=await all(`SELECT m.part_id,p.part_number,p.name,p.unit,SUM(-m.quantity) qty,SUM(-m.quantity*m.unit_cost_minor) cost FROM spare_movements m JOIN spare_parts p ON p.id=m.part_id
    WHERE m.ticket_id=? AND m.type IN ('issue','return') GROUP BY m.part_id,p.part_number,p.name,p.unit ORDER BY p.part_number`,ticketId);
  const movements=await all(`SELECT m.id,m.part_id,p.part_number,m.type,m.quantity,m.unit_cost_minor,m.plant_id,m.bin,m.created_at,u.name user_name FROM spare_movements m JOIN spare_parts p ON p.id=m.part_id LEFT JOIN users u ON u.id=m.user_id
    WHERE m.ticket_id=? ORDER BY m.seq`,ticketId);
  const t=await one('SELECT c.currency FROM tickets t JOIN companies c ON c.id=t.company_id WHERE t.id=?',ticketId);
  const lines=rows.filter(r=>q3(r.qty)!==0).map(r=>({partId:r.part_id,partNumber:r.part_number,name:r.name,unit:r.unit,quantity:q3(r.qty),costMinor:Math.round(r.cost)}));
  return {lines,totalMinor:lines.reduce((n,l)=>n+l.costMinor,0),currency:t?.currency||'USD',movements:movements.map(m=>({...m,quantity:q3(m.quantity)}))};
}
// Net quantity of a part issued to a ticket or PM job (what can still be returned).
export async function netIssued(partId,{ticketId=null,pmJobId=null}) {
  const r=await one(`SELECT COALESCE(SUM(-quantity),0) n FROM spare_movements WHERE part_id=? AND type IN ('issue','return') AND ${ticketId?'ticket_id=?':'pm_job_id=?'}`,partId,ticketId||pmJobId);
  return q3(r.n);
}

// Parts a PM plan needs, with what its plant holds.
export async function planParts(plan) {
  const rows=await all('SELECT pp.part_id,pp.quantity,p.part_number,p.name,p.unit,p.active FROM pm_plan_parts pp JOIN spare_parts p ON p.id=pp.part_id WHERE pp.plan_id=? ORDER BY p.part_number',plan.id);
  return await mapSeq(rows,async r=>{ const onHand=await plantBalance(r.part_id,plan.plant_id); return {partId:r.part_id,partNumber:r.part_number,name:r.name,unit:r.unit,quantity:q3(r.quantity),onHand,sufficient:onHand>=q3(r.quantity)}; });
}
// Replaces a plan's parts list: [{partId, quantity}], every part from the plan's company.
export async function setPlanParts(plan,list) {
  if (!Array.isArray(list)||list.length>50) bad('parts must be a list of up to 50 parts');
  const seen=new Set(), rows=[];
  for (const x of list) {
    const part=await one('SELECT * FROM spare_parts WHERE id=?',x?.partId);
    if (!part||part.company_id!==plan.company_id) bad('Each part must be from the spare parts catalogue of the same company');
    if (seen.has(part.id)) bad(`${part.part_number} is listed twice`); seen.add(part.id);
    rows.push([part.id,quantityOf(x.quantity,`quantity of ${part.part_number}`,part.unit)]);
  }
  await run('DELETE FROM pm_plan_parts WHERE plan_id=?',plan.id);
  await forEachSeq(rows,([partId,qty])=>run('INSERT INTO pm_plan_parts (plan_id,part_id,quantity) VALUES (?,?,?)',plan.id,partId,qty));
}

// A ticket's parts request matched to the catalogue (by its linked part, else by part number) and the stock at the ticket's plant.
export async function stockMatch(request,plantId) {
  const part=request.spare_part_id?await one('SELECT * FROM spare_parts WHERE id=?',request.spare_part_id)
    :request.part_number?await one('SELECT * FROM spare_parts WHERE company_id=? AND lower(part_number)=lower(?) AND active=1',request.company_id,request.part_number):null;
  if (!part||part.company_id!==request.company_id) return null;
  return {partId:part.id,partNumber:part.part_number,unit:part.unit,onHand:await plantBalance(part.id,plantId),unitCostMinor:part.unit_cost_minor};
}
