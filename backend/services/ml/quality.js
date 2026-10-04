// Quality insights: is a machine's scrap rate drifting above its own normal, which defects are growing, and what else
// changed on the machine at the same time? Plus the feature table for the trained "scrap spike" model (ml/).
// Scrap is counted per 15-minute slot (production_counts); defect types come from the camera station (vision_results).
import { all, one } from '../../common/db.js';
import { PRODUCTION_MACHINES } from '../../common/catalog.js';
import { raiseAlert, resolveAlertKey } from '../factory/alerts.js';
import { median, mad } from './stats.js';
import { machineInsights } from './insights.js';
import { featureRow, FEATURE_NAMES } from './features.js';

const HOUR=3600000, DAY=24*HOUR, iso=ms=>new Date(ms).toISOString();
export const SCRAP_HORIZON_HOURS=4;
export const SCRAP_FEATURE_NAMES=[...FEATURE_NAMES,'scrap_share_4h','scrap_share_24h','scrap_z','minutes_since_restart','setup_in_last_4h','running_share_4h'];

// Scrap per hour (while producing) in [from,to): [{t,total,scrap}] oldest first.
export function hourlyScrap(e,from,to) {
  return all("SELECT substr(period_start,1,13) h,sum(total_qty) total,sum(scrap_qty) scrap,count(*) slots FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<? GROUP BY h ORDER BY h",e.id,iso(from),iso(to))
    .map(r=>({t:Date.parse(r.h+':00:00Z'),total:r.total,scrap:r.scrap,slots:r.slots}));
}
const share=hours=>{ const t=hours.reduce((n,h)=>n+h.total,0); return t>0?hours.reduce((n,h)=>n+h.scrap,0)/t:null; };

// Recent scrap share against the machine's own hourly history (median and spread, so a few bad hours do not distort it).
export function assessScrap(e,at=Date.now(),{recentHours=8,minBaselineHours=24,minRecentHours=4,threshold=3}={}) {
  const hours=hourlyScrap(e,at-7*DAY,at+1), cut=at-recentHours*HOUR, base=hours.filter(h=>h.t<cut&&h.total>0), recent=hours.filter(h=>h.t>=cut&&h.total>0);
  if (base.length<minBaselineHours||recent.length<minRecentHours) return {status:'learning',baselineHours:base.length,recentHours:recent.length};
  const shares=base.map(h=>h.scrap/h.total), bm=median(shares), spread=Math.max(mad(shares,bm),0.1*bm,0.003), rs=share(recent), score=(rs-bm)/spread;
  const out={status:score>=threshold&&rs>=bm*1.3?'elevated':'normal',score:Math.round(score*10)/10,baselinePct:Math.round(bm*1000)/10,recentPct:Math.round(rs*1000)/10};
  if (out.status==='elevated') { out.growingDefects=growingDefects(e,at,recentHours); out.alongside=machineInsights(e,at).filter(i=>i.status==='unusual'||i.status==='degrading').map(i=>({parameter:i.parameter,label:i.label,status:i.status})); }
  return out;
}
// Defect types whose share of rejects is higher in the recent window than in the week before.
function growingDefects(e,at,recentHours) {
  const tally=(from,to)=>{ const d={}; let n=0; for (const v of all('SELECT defects FROM vision_results WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,iso(from),iso(to))) for (const [k,c] of Object.entries(JSON.parse(v.defects||'{}'))) { d[k]=(d[k]||0)+c; n+=c; } return {d,n}; };
  const r=tally(at-recentHours*HOUR,at+1), b=tally(at-7*DAY,at-recentHours*HOUR);
  if (r.n<5||b.n<20) return [];
  return Object.entries(r.d).map(([defect,c])=>({defect,recentPct:Math.round(c/r.n*100),baselinePct:Math.round((b.d[defect]||0)/b.n*100)})).filter(x=>x.recentPct-x.baselinePct>=10).sort((a,b)=>(b.recentPct-b.baselinePct)-(a.recentPct-a.baselinePct)).slice(0,3);
}
const words=s=>s.replaceAll('_',' ');
export function explainScrap(a) {
  if (a.status==='learning') return 'Still learning this machine\'s normal scrap rate.';
  if (a.status==='normal') return `Normal: scrap ${a.recentPct} % against a usual ${a.baselinePct} %.`;
  const d=a.growingDefects?.length?` Growing defects: ${a.growingDefects.map(x=>`${words(x.defect)} (${x.baselinePct} % → ${x.recentPct} % of rejects)`).join(', ')}.`:'';
  const s=a.alongside?.length?` At the same time: ${a.alongside.map(x=>`${x.label.toLowerCase()} ${x.status}`).join(', ')}.`:'';
  return `Scrap is ${a.recentPct} % against a usual ${a.baselinePct} %.${d}${s}`;
}

export function raiseScrapAlerts(machines,at=Date.now()) {
  let raised=0;
  for (const e of machines) {
    const key=`ml-scrap:${e.id}`, a=assessScrap(e,at);
    if (a.status!=='elevated') { resolveAlertKey(key,iso(at)); continue; }
    if (raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'quality',severity:'warning',equipmentId:e.id,title:`Predictive: scrap rate rising, ${a.recentPct} % (usual ${a.baselinePct} %)`,detail:`${e.asset_tag||''} ${e.make} ${e.model}: ${explainScrap(a)} Check the process settings, material and mould before more scrap is made.`,dedupeKey:key,at:iso(at)})) raised++;
  }
  return raised;
}

// ---- Feature table for the trained scrap-spike model -------------------------------------------------------------
// Row = a running machine at a moment; label = did scrap in the next 4 hours exceed 1.5x the machine's normal?
function recentShare(e,from,to) { const r=one('SELECT sum(total_qty) t,sum(scrap_qty) s FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,iso(from),iso(to)); return r.t>0?{share:r.s/r.t,total:r.t}:null; }
export function scrapFeatureRow(e,at=Date.now()) {
  const base=featureRow(e,at); if (!base) return null;
  const cur=one('SELECT state FROM machine_states WHERE equipment_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>?)',e.id,iso(at),iso(at));
  if (cur?.state!=='running') return null;
  const s4=recentShare(e,at-4*HOUR,at), s24=recentShare(e,at-DAY,at); if (!s4||!s24) return null;
  const hours=hourlyScrap(e,at-7*DAY,at-4*HOUR).filter(h=>h.total>0), shares=hours.map(h=>h.scrap/h.total), bm=median(shares), spread=Math.max(mad(shares,bm)||0,0.1*(bm||0),0.003);
  const restart=one("SELECT ended_at FROM machine_states WHERE equipment_id=? AND state<>'running' AND ended_at IS NOT NULL AND ended_at<=? ORDER BY ended_at DESC LIMIT 1",e.id,iso(at));
  const setup=one("SELECT 1 x FROM machine_states WHERE equipment_id=? AND state='setup' AND started_at<? AND (ended_at IS NULL OR ended_at>?)",e.id,iso(at),iso(at-4*HOUR));
  const run4=all("SELECT started_at,ended_at FROM machine_states WHERE equipment_id=? AND state='running' AND started_at<? AND (ended_at IS NULL OR ended_at>?)",e.id,iso(at),iso(at-4*HOUR)).reduce((n,s)=>n+Math.max(0,Math.min(s.ended_at?Date.parse(s.ended_at):at,at)-Math.max(Date.parse(s.started_at),at-4*HOUR)),0);
  return {...base,scrap_share_4h:Math.round(s4.share*10000)/10000,scrap_share_24h:Math.round(s24.share*10000)/10000,scrap_z:bm==null?0:Math.round((s4.share-bm)/spread*10)/10,
    minutes_since_restart:restart?Math.min(480,Math.round((at-Date.parse(restart.ended_at))/60000)):480,setup_in_last_4h:setup?1:0,running_share_4h:Math.round(run4/(4*HOUR)*100)/100};
}
const machines=companyId=>all(`SELECT * FROM equipment WHERE machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')}) AND status<>'decommissioned'${companyId?' AND company_id=?':''} ORDER BY id`,...PRODUCTION_MACHINES,...(companyId?[companyId]:[]));
export function exportScrapTable({companyId=null,days=60,stepHours=2,now=Date.now()}={}) {
  const rows=[];
  for (const e of machines(companyId)) {
    const all_=hourlyScrap(e,now-days*DAY,now).filter(h=>h.total>0).map(h=>h.scrap/h.total), normal=median(all_); if (normal==null) continue;
    const limit=Math.max(normal*1.5,normal+0.005);
    for (let at=Math.floor((now-days*DAY)/HOUR)*HOUR; at<=now; at+=stepHours*HOUR) {
      const f=scrapFeatureRow(e,at); if (!f) continue;
      const end=at+SCRAP_HORIZON_HOURS*HOUR, next=end<=now?recentShare(e,at,end):null, enough=next&&all('SELECT 1 FROM production_counts WHERE equipment_id=? AND period_start>=? AND period_start<?',e.id,iso(at),iso(end)).length>=8;
      rows.push({companyId:e.company_id,equipmentId:e.id,at:iso(at),features:f,label:end>now?null:enough?(next.share>=limit?1:0):null});
    }
  }
  return {version:1,task:'scrap',horizonDays:SCRAP_HORIZON_HOURS/24,generatedAt:iso(now),featureNames:SCRAP_FEATURE_NAMES,rows};
}

// Background scan over every active production machine.
export const scanQuality=(at=Date.now())=>raiseScrapAlerts(machines(null),at);
