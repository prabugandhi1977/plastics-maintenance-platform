// Machine-learning insights on top of the plant's own data: learned normal behaviour per machine and signal (so
// trouble is flagged before a fixed limit is crossed), remaining-time estimates, and OEE drops against a machine's own
// history. Computed from stored readings; nothing here changes plant data except the advisory predictive alerts.
import { all, mapSeq } from '../../common/db.js';
import { PRODUCTION_MACHINES, parametersFor } from '../../common/catalog.js';
import { raiseAlert, resolveAlertKey } from '../factory/alerts.js';
import { limitsFor, judge } from '../factory/condition.js';
import { machineOee, lossList, plantOf } from '../factory/production.js';
import { localDays, currentShift, shiftWindows } from '../factory/time.js';
import { assessSignal, assessDaily, median } from './stats.js';

export const DAY=86400000, WINDOW_DAYS=7;
// Readings taken while the machine was running (idle and stopped periods have different, expected values).
export async function runningReadings(e,parameter,at) {
  const from=new Date(at-WINDOW_DAYS*DAY).toISOString();
  const runs=(await all("SELECT started_at,ended_at FROM machine_states WHERE equipment_id=? AND state='running' AND (ended_at IS NULL OR ended_at>?) ORDER BY started_at",e.id,from)).map(s=>[Date.parse(s.started_at),s.ended_at?Date.parse(s.ended_at):Infinity]);
  const out=[]; let i=0;
  for (const r of await all('SELECT observed_at,value FROM condition_readings WHERE equipment_id=? AND parameter=? AND observed_at>=? ORDER BY observed_at',e.id,parameter,from)) {
    const t=Date.parse(r.observed_at); while (i<runs.length&&runs[i][1]<t) i++;
    if (i<runs.length&&runs[i][0]<=t) out.push({t,v:r.value});
  }
  return out;
}
const fmt=v=>Math.round(v*10)/10;
const hoursText=h=>h<48?`about ${h} hours`:`about ${Math.round(h/24)} days`;
export function explainSignal(def,a) {
  if (a.status==='learning') return 'Still learning this machine\'s normal behaviour.';
  const moved=`${def.label.toLowerCase()} now runs at ${fmt(a.recent)} ${def.unit}, against a normal ${fmt(a.baseline)} ${def.unit} (typical spread ±${fmt(a.spread)})`;
  if (a.status==='normal') return `Normal: ${moved}.`;
  const eta=a.hoursToCritical!=null?` At the current trend it reaches the critical limit in ${hoursText(a.hoursToCritical)}.`:a.hoursToWarning!=null?` At the current trend it reaches the warning limit in ${hoursText(a.hoursToWarning)}.`:'';
  return `${a.status==='degrading'?'Degrading':'Unusual'}: ${moved}.${eta}`;
}

// Per signal assessment for one machine.
export async function machineInsights(e,at=Date.now()) {
  const limits=Object.fromEntries((await limitsFor(e.id)).map(l=>[l.parameter,l]));
  return (await mapSeq(parametersFor(e.machine_type), async p=>{
    const a=assessSignal(await runningReadings(e,p.key,at),{limit:limits[p.key]||null,now:at});
    return {parameter:p.key,label:p.label,unit:p.unit,...a,explanation:explainSignal(p,a)};
  }));
}

// Advisory alerts: one per machine and signal while it is unusual or degrading but still inside its fixed limits.
// Once the limit is crossed the normal condition alert takes over; once the signal is normal again this one clears.
export async function raisePredictiveAlerts(machines,at=Date.now()) {
  let raised=0;
  for (const e of machines) {
    const limits=Object.fromEntries((await limitsFor(e.id)).map(l=>[l.parameter,l]));
    for (const p of parametersFor(e.machine_type)) {
      const key=`ml-condition:${e.id}:${p.key}`, a=assessSignal(await runningReadings(e,p.key,at),{limit:limits[p.key]||null,now:at});
      const last=(await all('SELECT value FROM condition_readings WHERE equipment_id=? AND parameter=? ORDER BY observed_at DESC LIMIT 1',e.id,p.key))[0];
      const flagged=(a.status==='unusual'||a.status==='degrading')&&(!last||!limits[p.key]||judge(last.value,limits[p.key])==='ok');
      if (!flagged) { await resolveAlertKey(key,new Date(at).toISOString()); continue; }
      const eta=a.hoursToCritical!=null?` — critical limit in ${hoursText(a.hoursToCritical)}`:'';
      if (await raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'condition',severity:'warning',equipmentId:e.id,title:`Predictive: ${p.label} ${a.status==='degrading'?'degrading':'unusual'}${eta}`,detail:`${e.asset_tag||''} ${e.make} ${e.model}: ${explainSignal(p,a)} Raised by the learned baseline, before any fixed limit is crossed. Plan an inspection.`,dedupeKey:key,at:new Date(at).toISOString()})) raised++;
    }
  }
  return raised;
}

// OEE per machine against its own recent days: flags a drop and names the biggest loss in the latest day.
export async function oeeInsights(machines,days=14,at=Date.now()) {
  return (await mapSeq(machines, async e=>{
    const plant=await plantOf(e), list=localDays(plant,at-days*DAY,at);
    const per=(await mapSeq(list, async d=>({date:d.date,o:await machineOee(e,d.start,d.end)}))).filter(d=>d.o.oee!=null&&d.o.plannedMs>=2*3600000);
    const a=assessDaily(per.map(d=>d.o.oee)), who={equipmentId:e.id,assetTag:e.asset_tag,name:`${e.make} ${e.model}`};
    if (a.status==='learning') return {...who,status:'learning',days:a.days};
    const latest=per.at(-1), top=lossList(latest.o.losses)[0]||null, drivers=lossDrivers(per.slice(0,-1).map(d=>d.o.losses),latest.o.losses);
    return {...who,status:a.status,date:latest.date,oee:Math.round(a.latest*1000)/10,baseline:Math.round(a.baseline*1000)/10,deltaPoints:Math.round((a.latest-a.baseline)*1000)/10,score:a.score,
      topLoss:top&&{state:top.state,reason:top.reason,minutes:top.minutes},drivers};
  }));
}

// Which losses grew the most against a typical earlier day (minutes per day), biggest increase first.
export function lossDrivers(earlier,latest) {
  const keys=new Set([...earlier.flatMap(l=>Object.keys(l)),...Object.keys(latest)]);
  return [...keys].map(k=>{ const [state,reason]=k.split(':'), normal=median(earlier.map(l=>(l[k]||0)/60000)), now=(latest[k]||0)/60000;
    return {state,reason,minutes:Math.round(now),normalMinutes:Math.round(normal),extraMinutes:Math.round(now-normal)}; })
    .filter(d=>d.extraMinutes>=15).sort((a,b)=>b.extraMinutes-a.extraMinutes).slice(0,3);
}

// Output forecast for the shift in progress: what is made so far, what the rest of the shift is likely to add at the
// recent pace (stops included), and how that compares with the machine's typical output for the same shift.
export async function shiftForecast(e,at=Date.now()) {
  const plant=await plantOf(e), shift=await currentShift(plant,at); if (!shift) return null;
  const good=async (from,to)=>{ const r=(await all('SELECT sum(total_qty-scrap_qty) g,max(unit) u FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,new Date(from).toISOString(),new Date(to).toISOString()))[0]; return {g:r.g||0,unit:r.u}; };
  const so=await good(shift.start,at), elapsed=at-shift.start; if (elapsed<2*3600000) return {status:'too_early',shift:shift.name,unit:so.unit};
  const recentFrom=Math.max(shift.start,at-2*3600000), pace=(await good(recentFrom,at)).g/((at-recentFrom)/3600000), projected=so.g+pace*((shift.end-at)/3600000);
  const past=(await mapSeq((await shiftWindows(plant,at-8*DAY,at)).filter(w=>w.name===shift.name&&w.fullEnd<=at), async w=>(await good(w.fullStart,w.fullEnd)).g)).filter(g=>g>0);
  if (past.length<3) return {status:'learning',shift:shift.name,unit:so.unit,producedSoFar:Math.round(so.g),projected:Math.round(projected)};
  const typical=median(past), ratio=projected/typical;
  return {status:ratio<0.9?'behind':ratio>1.1?'ahead':'on_track',shift:shift.name,unit:so.unit,producedSoFar:Math.round(so.g),projected:Math.round(projected),typical:Math.round(typical),vsTypicalPct:Math.round((ratio-1)*100)};
}

// Background scan over every active production machine (the server runs it every few minutes).
export const scanPredictive=async (at=Date.now())=>await raisePredictiveAlerts(await all(`SELECT * FROM equipment WHERE machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')}) AND status<>'decommissioned'`,...PRODUCTION_MACHINES),at);
