// Feature table for the Python ML service (ml/). One definition, used both to export training data and to score a
// machine live, so the two can never drift apart. A row describes one machine at one moment from its own history:
// how far each signal is from its learned normal, how fast it is moving, and how the machine has been stopping.
// Label (training only): did the machine break down within the next 7 days?
import { all, one } from '../../common/db.js';
import { CONDITION_PARAMETERS, PRODUCTION_MACHINES } from '../../common/catalog.js';
import { limitsFor } from '../factory/condition.js';
import { assessSignal } from './stats.js';
import { runningReadings, DAY } from './insights.js';

export const HORIZON_DAYS=7, HOUR=3600000;
const PARAMS=Object.keys(CONDITION_PARAMETERS);
export const BREAKDOWN_REASONS=['breakdown','mould_fault','auxiliary_fault'];
export const FEATURE_NAMES=[...PARAMS.flatMap(p=>[`${p}_z`,`${p}_slope`]),'max_abs_z','signals_flagged','down_hours_24h','stops_24h','running_share_24h','days_since_breakdown'];

const iso=ms=>new Date(ms).toISOString();
// Features for one machine at `at`, or null while it has no learned baseline yet (nothing to say about it).
export async function featureRow(e,at=Date.now()) {
  const limits=Object.fromEntries((await limitsFor(e.id)).map(l=>[l.parameter,l])), f=Object.fromEntries(FEATURE_NAMES.map(n=>[n,0]));
  let judged=0, flagged=0;
  for (const p of PARAMS) {
    if (!CONDITION_PARAMETERS[p].types.includes(e.machine_type)) continue;
    const a=assessSignal(await runningReadings(e,p,at),{limit:limits[p]||null,now:at});
    if (a.status==='learning') continue;
    judged++; f[`${p}_z`]=a.score; f[`${p}_slope`]=a.slopePerDay==null?0:Math.round(a.slopePerDay/a.spread*100)/100;
    f.max_abs_z=Math.max(f.max_abs_z,Math.abs(a.score)); if (a.status!=='normal') flagged++;
  }
  if (!judged) return null;
  f.signals_flagged=flagged;
  const from=at-DAY, states=await all('SELECT state,reason_code,started_at,ended_at FROM machine_states WHERE equipment_id=? AND started_at<? AND (ended_at IS NULL OR ended_at>?)',e.id,iso(at),iso(from));
  let down=0, running=0, covered=0, stops=0;
  for (const s of states) {
    const st=Math.max(Date.parse(s.started_at),from), en=Math.min(s.ended_at?Date.parse(s.ended_at):at,at), ms=Math.max(0,en-st); covered+=ms;
    if (s.state==='running') running+=ms; if (s.state==='down') down+=ms; if (s.state==='down'&&Date.parse(s.started_at)>=from) stops++;
  }
  f.down_hours_24h=Math.round(down/HOUR*10)/10; f.stops_24h=stops; f.running_share_24h=covered?Math.round(running/covered*100)/100:0;
  const last=await one(`SELECT started_at FROM machine_states WHERE equipment_id=? AND state='down' AND reason_code IN (${BREAKDOWN_REASONS.map(()=>'?').join(',')}) AND started_at<? ORDER BY started_at DESC LIMIT 1`,e.id,...BREAKDOWN_REASONS,iso(at));
  f.days_since_breakdown=last?Math.min(60,Math.round((at-Date.parse(last.started_at))/DAY*10)/10):60;
  return f;
}
// Did a breakdown start in (at, at+horizon]? A breakdown already seen settles it (1); no breakdown is only known (0)
// once the whole horizon has passed, otherwise null (not yet knowable).
export async function breakdownWithin(e,at,now=Date.now(),days=HORIZON_DAYS) {
  const hit=await one(`SELECT 1 x FROM machine_states WHERE equipment_id=? AND state='down' AND reason_code IN (${BREAKDOWN_REASONS.map(()=>'?').join(',')}) AND started_at>? AND started_at<=?`,e.id,...BREAKDOWN_REASONS,iso(at),iso(Math.min(now,at+days*DAY)));
  return hit?1:at+days*DAY>now?null:0;
}
const machines=async companyId=>await all(`SELECT * FROM equipment WHERE machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')}) AND status<>'decommissioned'${companyId?' AND company_id=?':''} ORDER BY id`,...PRODUCTION_MACHINES,...(companyId?[companyId]:[]));
// Rows every `stepHours` over the last `days` days. A machine that is down at that moment is skipped (already failing).
export async function exportFeatureTable({companyId=null,days=60,stepHours=6,now=Date.now()}={}) {
  const rows=[];
  for (const e of await machines(companyId)) for (let at=Math.floor((now-days*DAY)/HOUR)*HOUR; at<=now; at+=stepHours*HOUR) {
    if (await one("SELECT 1 x FROM machine_states WHERE equipment_id=? AND state='down' AND started_at<=? AND (ended_at IS NULL OR ended_at>?)",e.id,iso(at),iso(at))) continue;
    const features=await featureRow(e,at); if (!features) continue;
    rows.push({companyId:e.company_id,equipmentId:e.id,at:iso(at),features,label:await breakdownWithin(e,at,now)});
  }
  return {version:1,task:'failure',horizonDays:HORIZON_DAYS,generatedAt:iso(now),featureNames:FEATURE_NAMES,rows};
}
