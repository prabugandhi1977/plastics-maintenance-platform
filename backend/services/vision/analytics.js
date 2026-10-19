// False-alarm analytics: how often each kind of incident turned out to be a false alarm, how that depends on the
// detector's confidence, which cameras and hours are noisy, and what confidence threshold would bring false alarms
// under the target, with what it would cost in real incidents lost. Computed from incidents people have closed
// ("resolved" = real, "false_alarm" = false); open incidents say nothing yet.
import { all } from '../../common/db.js';
import { MODULES, MODULE_KEYS } from './vision.js';

export const MIN_DECIDED=30, MIN_KEPT=20;
const EDGES=[0.5,0.6,0.7,0.8,0.9];
const pct=(n,d)=>d?Math.round(n/d*1000)/10:null;

// Recommend the lowest threshold whose kept incidents are at or under the target false share, with the trade-off.
export function recommendThreshold(list,targetPct) {
  const total=list.length, falses=list.filter(e=>e.false).length, current=pct(falses,total);
  if (current!=null&&current<=targetPct) return {status:'ok',currentFalsePct:current,note:`False alarms are ${current} % of incidents, within the ${targetPct} % target.`};
  const options=EDGES.map(t=>{ const kept=list.filter(e=>e.confidence>=t), lost=list.filter(e=>e.confidence<t);
    return {threshold:t,keptIncidents:kept.length,falsePctAfter:pct(kept.filter(e=>e.false).length,kept.length),falseAlarmsRemoved:lost.filter(e=>e.false).length,realIncidentsLost:lost.filter(e=>!e.false).length}; });
  const pick=options.find(o=>o.keptIncidents>=MIN_KEPT&&o.falsePctAfter!=null&&o.falsePctAfter<=targetPct);
  if (!pick) return {status:'no_threshold',currentFalsePct:current,note:'No confidence threshold reaches the target without discarding almost every incident: the model needs retraining or the camera view needs work, not just a threshold.',options};
  return {status:'raise',currentFalsePct:current,...pick,note:`Raising the minimum confidence to ${Math.round(pick.threshold*100)} % would cut false alarms from ${current} % to ${pick.falsePctAfter} % of incidents, removing ${pick.falseAlarmsRemoved} false alarms and losing ${pick.realIncidentsLost} real ones.`,options};
}

export async function falseAlarmReport(companyIds,{days=30,targetPct=10,now=Date.now()}={}) {
  const from=new Date(now-days*86400000).toISOString(), where=companyIds?`AND e.company_id IN (${companyIds.map(()=>'?').join(',')})`:'';
  const rows=(await all(`SELECT e.module,e.type,e.camera_id,c.name camera,e.confidence,e.occurred_at,e.status FROM vision_events e JOIN vision_cameras c ON c.id=e.camera_id
    WHERE e.status IN ('resolved','false_alarm') AND e.module<>'system' AND e.occurred_at>=? ${where}`,from,...(companyIds||[])))
    .map(r=>({...r,false:r.status==='false_alarm',hour:new Date(r.occurred_at).getUTCHours()}));
  const modules=MODULE_KEYS.map(module=>{
    const list=rows.filter(r=>r.module===module), decided=list.length, falses=list.filter(r=>r.false).length;
    const base={module,label:MODULES[module].label,decided,falseAlarms:falses,falsePct:pct(falses,decided)};
    if (decided<MIN_DECIDED) return {...base,status:'not_enough_data',note:`${decided} closed incidents so far; about ${MIN_DECIDED} are needed before advice is meaningful.`};
    const withConf=list.filter(r=>r.confidence!=null);
    const buckets=[0,...EDGES].map((lo,i,a)=>{ const hi=a[i+1]??1.001, b=withConf.filter(r=>r.confidence>=lo&&r.confidence<hi); return {from:lo,to:Math.min(hi,1),decided:b.length,falseAlarms:b.filter(r=>r.false).length,falsePct:pct(b.filter(r=>r.false).length,b.length)}; }).filter(b=>b.decided);
    const byCamera=[...new Set(list.map(r=>r.camera_id))].map(id=>{ const c=list.filter(r=>r.camera_id===id); return {cameraId:id,camera:c[0].camera,decided:c.length,falseAlarms:c.filter(r=>r.false).length,falsePct:pct(c.filter(r=>r.false).length,c.length)}; })
      .filter(c=>c.decided>=5).sort((a,b)=>b.falsePct-a.falsePct||b.falseAlarms-a.falseAlarms).slice(0,5);
    const byType=[...new Set(list.map(r=>r.type))].map(type=>{ const c=list.filter(r=>r.type===type); return {type,decided:c.length,falseAlarms:c.filter(r=>r.false).length,falsePct:pct(c.filter(r=>r.false).length,c.length)}; });
    const hours=[...Array(24).keys()].map(h=>{ const c=list.filter(r=>r.hour===h); return {hour:h,decided:c.length,falsePct:pct(c.filter(r=>r.false).length,c.length)}; }).filter(h=>h.decided>=5&&h.falsePct>=falsePctOf(list)*1.5&&h.falsePct>=targetPct).sort((a,b)=>b.falsePct-a.falsePct).slice(0,3);
    return {...base,status:'ok',buckets,byCamera,byType,noisyHoursUtc:hours,recommendation:withConf.length>=MIN_DECIDED?recommendThreshold(withConf,targetPct):{status:'no_confidence',note:'These incidents carry no confidence score, so a threshold cannot be advised.'}};
  });
  return {days,targetPct,generatedAt:new Date(now).toISOString(),totalDecided:rows.length,modules};
}
const falsePctOf=list=>pct(list.filter(r=>r.false).length,list.length)||0;
