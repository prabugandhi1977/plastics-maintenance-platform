// Production monitoring: recording machine states and output (the single ingest path used by the simulator now and
// by PLC/sensor adapters later), and OEE analytics.
//
// OEE (Overall Equipment Effectiveness) = Availability × Performance × Quality, within planned production time:
//   Planned time  = shift time − planned stops (breaks, no production planned) − time without data
//   Availability  = running time ÷ planned time                       (losses: breakdowns, set-ups, idling)
//   Performance   = ideal time for the output made ÷ running time     (losses: small stops, slow cycles)
//   Quality       = good output ÷ total output                         (losses: start-up and production rejects)
// "Ideal time" is output ÷ ideal rate, so machines making different products — counted in parts or in kg — can be
// combined: plant OEE = Σ(ideal time × quality) ÷ Σ planned time.
import { id, one, all, run } from '../db.js';
import { bad } from '../validate.js';
import { shiftWindows, inShift, localDays } from './time.js';
import { raiseAlert, resolveAlertKey } from './alerts.js';

const HOUR=3600000;
export const plantOf=e=>one('SELECT * FROM plants WHERE id=?',e.plant_id);

// Opens a new state interval and closes the previous one; repeating the current state changes nothing.
export function recordState(e,state,reason,at,source) {
  const open=one('SELECT * FROM machine_states WHERE equipment_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',e.id);
  if (open&&open.state===state&&(open.reason_code||null)===(reason||null)) return {changed:false,previous:open};
  if (open&&at<open.started_at) bad(`State change at ${at} is earlier than the current state (${open.started_at})`);
  if (open) run('UPDATE machine_states SET ended_at=? WHERE id=?',at,open.id);
  run('INSERT INTO machine_states (id,company_id,equipment_id,state,reason_code,started_at,source) VALUES (?,?,?,?,?,?,?)',id(),e.company_id,e.id,state,reason||null,at,source);
  return {changed:true,previous:open};
}
// A machine stopping for a fault raises one alert; it resolves itself when the machine leaves the stopped state.
const STOP_ALERT_REASONS=['breakdown','mould_fault','auxiliary_fault','power_failure'];
export function stateAlerts(e,state,reason,change,at) {
  if (!change.changed) return;
  if (state==='down'&&STOP_ALERT_REASONS.includes(reason)) raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'production',severity:'warning',equipmentId:e.id,title:`Machine stopped: ${reason.replaceAll('_',' ')}`,detail:`${e.asset_tag||''} ${e.make} ${e.model} stopped at ${at} (${reason.replaceAll('_',' ')}). Raise a maintenance ticket if it is not running again soon.`,dedupeKey:`production-down:${e.id}`,at});
  if (change.previous?.state==='down'&&state!=='down') resolveAlertKey(`production-down:${e.id}`,at);
}
// One count per machine per period; a repeated period is ignored (idempotent replays).
export function recordCount(e,{periodStart,periodMinutes,totalQty,scrapQty,unit,idealRatePerHour,productId=null},source) {
  const r=run('INSERT OR IGNORE INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id(),e.company_id,e.id,productId,periodStart,periodMinutes,totalQty,scrapQty,unit,idealRatePerHour,source);
  return r.changes?'accepted':'duplicate';
}

// What a machine is making: the product assigned to it, else a rate from its own data sheet.
export function currentProduct(e) {
  const p=one('SELECT * FROM products WHERE default_machine_id=? AND active=1 ORDER BY created_at LIMIT 1',e.id);
  if (p) return p;
  const specs=JSON.parse(e.specs||'{}');
  if (e.machine_type==='extrusion') return {id:null,name:'Extrudate',unit:'kg',ideal_rate_per_hour:specs.outputKgH||100};
  return {id:null,name:'Moulded part',unit:'parts',ideal_rate_per_hour:e.machine_type==='blow'?400:240};
}

export function machineOee(e,from,to,plant=plantOf(e)) {
  const windows=shiftWindows(plant,from,to), plannedWindow=windows.reduce((n,w)=>n+w.end-w.start,0), until=Math.min(to,Date.now());
  const ms={running:0,idle:0,down:0,setup:0,planned_stop:0,offline:0}, losses={};
  for (const s of all('SELECT state,reason_code,started_at,ended_at FROM machine_states WHERE equipment_id=? AND started_at<? AND (ended_at IS NULL OR ended_at>?)',e.id,new Date(to).toISOString(),new Date(from).toISOString())) {
    const start=Date.parse(s.started_at), end=s.ended_at?Date.parse(s.ended_at):until;
    for (const w of windows) { const overlap=Math.max(0,Math.min(end,w.end)-Math.max(start,w.start)); if (!overlap) continue; ms[s.state]+=overlap; if (s.state!=='running'&&s.state!=='offline') { const k=`${s.state}:${s.reason_code||'unspecified'}`; losses[k]=(losses[k]||0)+overlap; } }
  }
  const elapsedWindow=windows.reduce((n,w)=>n+Math.max(0,Math.min(w.end,until)-w.start),0);
  const covered=Object.values(ms).reduce((a,b)=>a+b,0), noData=Math.max(0,elapsedWindow-covered);
  const planned=Math.max(0,elapsedWindow-ms.planned_stop-ms.offline-noData);
  let total=0,scrap=0,idealHours=0,unit=null;
  for (const c of all('SELECT period_start,total_qty,scrap_qty,unit,ideal_rate_per_hour FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,new Date(from).toISOString(),new Date(to).toISOString())) {
    if (!inShift(windows,Date.parse(c.period_start))) continue;
    total+=c.total_qty; scrap+=c.scrap_qty; idealHours+=c.total_qty/c.ideal_rate_per_hour; unit=unit&&unit!==c.unit?'mixed':c.unit;
  }
  const availability=planned?ms.running/planned:null, performance=ms.running?Math.min(1,idealHours/(ms.running/HOUR)):null, quality=total?(total-scrap)/total:null;
  return {equipmentId:e.id,plannedMs:planned,runningMs:ms.running,stateMs:ms,noDataMs:noData,losses,total,scrap,good:total-scrap,unit,idealHours,
    availability,performance,quality,oee:availability!=null&&performance!=null&&quality!=null?availability*performance*quality:null};
}
// Combines machines: time-weighted, so a plant figure is never a plain average of percentages.
export function combine(list) {
  const sum=k=>list.reduce((n,x)=>n+(x[k]||0),0), planned=sum('plannedMs'), running=sum('runningMs'), ideal=sum('idealHours');
  const goodIdeal=list.reduce((n,x)=>n+(x.quality==null?0:x.idealHours*x.quality),0);
  const losses={}; for (const x of list) for (const [k,v] of Object.entries(x.losses)) losses[k]=(losses[k]||0)+v;
  const availability=planned?running/planned:null, performance=running?Math.min(1,ideal/(running/HOUR)):null, quality=ideal?goodIdeal/ideal:null;
  return {plannedMs:planned,runningMs:running,idealHours:ideal,losses,availability,performance,quality,oee:availability!=null&&performance!=null&&quality!=null?availability*performance*quality:null};
}
// OEE per local day across machines (days follow the first machine's plant time zone).
export function dailyOee(machines,from,to) {
  if (!machines.length) return [];
  const plant=plantOf(machines[0]);
  return localDays(plant,from,to).map(d=>({date:d.date,...combine(machines.map(e=>machineOee(e,d.start,d.end)))}));
}
export const lossList=losses=>Object.entries(losses).map(([k,ms])=>{ const [state,reason]=k.split(':'); return {state,reason,minutes:Math.round(ms/60000)}; }).filter(x=>x.minutes>0).sort((a,b)=>b.minutes-a.minutes);
