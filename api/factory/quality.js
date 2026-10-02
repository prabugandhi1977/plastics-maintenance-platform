// Vision quality: camera inspection results per machine and station. First-pass yield (FPY) = parts passing first
// time ÷ parts inspected; the defect Pareto shows which defect to attack first. A rising reject rate raises an
// alert (warning at 3 %, critical at 8 %, over at least 50 inspected parts) and clears below 1.5 %.
import { id, one, all, run } from '../db.js';
import { raiseAlert, resolveAlertKey, escalateAlert } from './alerts.js';
import { localDays } from './time.js';
import { plantOf } from './production.js';

export const REJECT_WARN=0.03, REJECT_CRIT=0.08, REJECT_CLEAR=0.015, MIN_SAMPLE=50;
export function recordVision(e,{station,periodStart,periodMinutes,inspected,rejected,defects={}},source,{evaluate=true}={}) {
  const r=run('INSERT OR IGNORE INTO vision_results (id,company_id,equipment_id,station,period_start,period_minutes,inspected,rejected,defects,source) VALUES (?,?,?,?,?,?,?,?,?,?)',id(),e.company_id,e.id,station,periodStart,periodMinutes,inspected,rejected,JSON.stringify(defects),source);
  if (!r.changes) return 'duplicate';
  if (evaluate&&inspected>=MIN_SAMPLE) {
    const rate=rejected/inspected, key=`quality:${e.id}:${station}`, open=one("SELECT * FROM alerts WHERE dedupe_key=? AND status<>'resolved'",key);
    const top=Object.entries(defects).sort((a,b)=>b[1]-a[1])[0];
    const severity=rate>=REJECT_CRIT?'critical':rate>=REJECT_WARN?'warning':null, title=`Reject rate ${Math.round(rate*1000)/10} % at ${station}`, detail=`${e.asset_tag||''} ${e.make} ${e.model}: ${rejected} of ${inspected} parts rejected${top?`, mostly ${top[0].replaceAll('_',' ')} (${top[1]})`:''}. Check the process settings and the mould.`;
    if (severity&&!open) raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'quality',severity,equipmentId:e.id,title,detail,dedupeKey:key,at:periodStart});
    else if (severity==='critical'&&open&&open.severity!=='critical') escalateAlert(open.id,{severity,title,detail});
    else if (rate<REJECT_CLEAR&&open) resolveAlertKey(key,periodStart);
  }
  return 'accepted';
}
export function qualityReport(machines,from,to) {
  const fromIso=new Date(from).toISOString(), toIso=new Date(to).toISOString(), pareto={};
  const per=machines.map(e=>{ let inspected=0,rejected=0; const defects={};
    for (const v of all('SELECT inspected,rejected,defects FROM vision_results WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,fromIso,toIso)) { inspected+=v.inspected; rejected+=v.rejected; for (const [k,n] of Object.entries(JSON.parse(v.defects))) { defects[k]=(defects[k]||0)+n; pareto[k]=(pareto[k]||0)+n; } }
    return {equipmentId:e.id,assetTag:e.asset_tag,name:`${e.make} ${e.model}`,inspected,rejected,fpy:inspected?(inspected-rejected)/inspected*100:null,topDefect:Object.entries(defects).sort((a,b)=>b[1]-a[1])[0]?.[0]||null}; });
  const inspected=per.reduce((n,m)=>n+m.inspected,0), rejected=per.reduce((n,m)=>n+m.rejected,0);
  const daily=machines.length?localDays(plantOf(machines[0]),from,to).map(d=>{ const r=one(`SELECT sum(inspected) i,sum(rejected) r FROM vision_results WHERE equipment_id IN (${machines.map(()=>'?').join(',')}) AND period_start>=? AND period_start<?`,...machines.map(e=>e.id),new Date(d.start).toISOString(),new Date(d.end).toISOString()); return {date:d.date,inspected:r.i||0,fpy:r.i?(r.i-r.r)/r.i*100:null}; }):[];
  return {total:{inspected,rejected,fpy:inspected?(inspected-rejected)/inspected*100:null,ppm:inspected?Math.round(rejected/inspected*1e6):null},pareto:Object.entries(pareto).map(([defect,count])=>({defect,count})).sort((a,b)=>b.count-a.count),machines:per,daily};
}
