// Safety: events detected by cameras, wearables and sensors, and reported by people. Warning and critical events
// raise alerts; every event is investigated and closed with a root cause and corrective action. Near misses and
// unsafe conditions are leading indicators – the more are reported and fixed, the fewer injuries follow.
import { id, now, one, all, run } from '../db.js';
import { SAFETY_EVENTS } from '../catalog.js';
import { raiseAlert, resolveAlertKey } from './alerts.js';

const DAY=86400000;
export function recordSafety({companyId,plantId,zoneId=null,equipmentId=null,eventType,severity=SAFETY_EVENTS[eventType],source,description,occurredAt,reportedBy=null,lostTime=false},{alert=true}={}) {
  const key=id();
  run('INSERT INTO safety_events (id,company_id,plant_id,zone_id,equipment_id,event_type,severity,source,description,occurred_at,reported_by,status,lost_time,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,companyId,plantId,zoneId,equipmentId,eventType,severity,source,description.slice(0,2000),occurredAt,reportedBy,'open',lostTime?1:0,now());
  if (alert&&severity!=='info') raiseAlert({companyId,plantId,module:'safety',severity,equipmentId,title:`Safety: ${eventType.replaceAll('_',' ')}${zoneId?` in ${one('SELECT name FROM zones WHERE id=?',zoneId)?.name||'zone'}`:''}`,detail:`${description} (${source==='person'?'reported':'detected by '+source} at ${occurredAt}). Investigate and record the corrective action.`,dedupeKey:`safety:${key}`,at:occurredAt});
  return key;
}
export function closeSafety(ev,{rootCause,correctiveAction},u) {
  run("UPDATE safety_events SET status='closed',root_cause=?,corrective_action=?,closed_by=?,closed_at=? WHERE id=?",rootCause,correctiveAction,u.id,now(),ev.id);
  resolveAlertKey(`safety:${ev.id}`);
}
// Summary for a set of companies (and optionally one plant) over a period.
export function safetyReport(companyIds,{plantId=null,from,to}) {
  if (!companyIds.length) return {total:0,byType:[],bySeverity:{},open:0,nearMisses:0,daysSinceLostTime:null,events:[]};
  const where=`company_id IN (${companyIds.map(()=>'?').join(',')})${plantId?' AND plant_id=?':''}`, args=[...companyIds,...(plantId?[plantId]:[])];
  const events=all(`SELECT s.*,z.name zone_name,e.asset_tag,u.name reporter FROM safety_events s LEFT JOIN zones z ON z.id=s.zone_id LEFT JOIN equipment e ON e.id=s.equipment_id LEFT JOIN users u ON u.id=s.reported_by WHERE s.${where.replaceAll(' AND plant_id',' AND s.plant_id')} AND s.occurred_at>=? AND s.occurred_at<? ORDER BY s.occurred_at DESC`,...args,new Date(from).toISOString(),new Date(to).toISOString());
  const lastLti=one(`SELECT max(occurred_at) t FROM safety_events WHERE ${where} AND lost_time=1`,...args).t;
  const byType={}; for (const e of events) byType[e.event_type]=(byType[e.event_type]||0)+1;
  return {total:events.length,byType:Object.entries(byType).map(([type,count])=>({type,count})).sort((a,b)=>b.count-a.count),
    bySeverity:Object.fromEntries(['critical','warning','info'].map(s=>[s,events.filter(e=>e.severity===s).length])),
    open:one(`SELECT count(*) n FROM safety_events WHERE ${where} AND status<>'closed'`,...args).n,
    nearMisses:events.filter(e=>['near_miss','unsafe_condition','unsafe_act'].includes(e.event_type)).length,
    daysSinceLostTime:lastLti?Math.floor((Date.now()-Date.parse(lastLti))/DAY):null,events};
}
