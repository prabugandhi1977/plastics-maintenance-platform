// Condition monitoring: readings per machine and parameter, judged against warning/critical limits.
// Normal clears the alert; warning raises one; critical upgrades it (and emails) and raises a maintenance ticket
// automatically when the limit allows it — so a failing pump becomes planned work before it becomes a breakdown.
import { id, now, one, all, run } from '../db.js';
import { bad } from '../validate.js';
import { CONDITION_PARAMETERS, parametersFor } from '../catalog.js';
import { raiseAlert, resolveAlertKey, escalateAlert } from './alerts.js';

export const FRESH_MS=60*60000;
const SYSTEM={id:'u-system'};
export const limitsFor=equipmentId=>all('SELECT * FROM sensor_limits WHERE equipment_id=?',equipmentId);
// ok | warning | critical for a value against one limit row (unset bounds are ignored).
export function judge(value,l) {
  if (!l) return 'ok';
  if ((l.crit_high!=null&&value>=l.crit_high)||(l.crit_low!=null&&value<=l.crit_low)) return 'critical';
  if ((l.warn_high!=null&&value>=l.warn_high)||(l.warn_low!=null&&value<=l.warn_low)) return 'warning';
  return 'ok';
}
const fmt=(v,unit)=>`${Math.round(v*10)/10} ${unit}`;
const limitText=(l,unit,status)=>{ const hi=status==='critical'?l.crit_high:l.warn_high, lo=status==='critical'?l.crit_low:l.warn_low; return hi!=null&&lo!=null?`outside ${fmt(lo,unit)}–${fmt(hi,unit)}`:hi!=null?`at or above ${fmt(hi,unit)}`:`at or below ${fmt(lo,unit)}`; };

export function recordCondition(e,parameter,value,at,source,{evaluate=true}={}) {
  const def=CONDITION_PARAMETERS[parameter]; if (!def) bad(`Unknown parameter ${parameter}`);
  if (!Number.isFinite(value)) bad('value must be a number');
  const r=run('INSERT OR IGNORE INTO condition_readings (equipment_id,parameter,observed_at,value,company_id,source) VALUES (?,?,?,?,?,?)',e.id,parameter,at,value,e.company_id,source);
  if (!r.changes) return 'duplicate';
  if (evaluate) evaluateReading(e,parameter,value,at);
  return 'accepted';
}

export function evaluateReading(e,parameter,value,at=now()) {
  const def=CONDITION_PARAMETERS[parameter], limit=one('SELECT * FROM sensor_limits WHERE equipment_id=? AND parameter=?',e.id,parameter), status=judge(value,limit), key=`condition:${e.id}:${parameter}`;
  const open=one("SELECT * FROM alerts WHERE dedupe_key=? AND status<>'resolved'",key);
  if (status==='ok') { if (open) resolveAlertKey(key,at); return status; }
  const title=`${def.label} ${status==='critical'?'critical':'high'}: ${fmt(value,def.unit)}`;
  const detail=`${e.asset_tag||''} ${e.make} ${e.model}: ${def.label.toLowerCase()} is ${fmt(value,def.unit)}, ${limitText(limit,def.unit,status)} (${status} limit). ${status==='critical'?'Plan a repair now to avoid a breakdown.':'Keep an eye on it and plan an inspection.'}`;
  let alertId=open?.id;
  if (!open) alertId=raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'condition',severity:status,equipmentId:e.id,title,detail,dedupeKey:key,at});
  else if (status==='critical'&&open.severity!=='critical') escalateAlert(open.id,{severity:'critical',title,detail});
  if (status==='critical'&&limit.auto_ticket) autoTicket(e,one('SELECT * FROM alerts WHERE id=?',alertId),def,value,at);
  return status;
}

// One automatic ticket per problem: reuse an open ticket already raised for the same machine and parameter.
function autoTicket(e,alert,def,value,at) {
  if (!alert||alert.ticket_id) return alert?.ticket_id;
  const existing=one("SELECT t.id FROM tickets t JOIN alerts a ON a.ticket_id=t.id WHERE a.dedupe_key=? AND t.status<>'completed' LIMIT 1",alert.dedupe_key);
  const ticketId=existing?.id??id();
  if (!existing) {
    run("INSERT INTO tickets (id,company_id,plant_id,equipment_id,title,priority,symptoms,error_codes,production_impact,status,created_by,created_at,downtime_minutes,failure_category,machine_state,safety_issue,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,'open','u-system',?,0,?,'running',0,?)",
      ticketId,e.company_id,e.plant_id,e.id,`Condition alarm: ${def.label} ${fmt(value,def.unit)}`.slice(0,160),'high',alert.detail,'','Machine still running. Repair before it fails to avoid unplanned downtime.',now(),def.category,at);
    run('INSERT INTO ticket_events (id,ticket_id,actor_id,event_type,detail,created_at) VALUES (?,?,?,?,?,?)',id(),ticketId,SYSTEM.id,'alert',`Raised automatically by condition monitoring: ${alert.title}`,now());
    run('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)',id(),SYSTEM.id,e.company_id,'ticket.auto_create','ticket',ticketId,JSON.stringify({alertId:alert.id}),now());
  }
  run("UPDATE alerts SET ticket_id=? WHERE id=?",ticketId,alert.id);
  return ticketId;
}

// Health of one machine: each monitored parameter's latest reading judged against its limits.
// Unknown = no limit set, or no reading in the last hour.
export function machineHealth(e,at=Date.now()) {
  const limits=Object.fromEntries(limitsFor(e.id).map(l=>[l.parameter,l]));
  const params=[...new Set([...parametersFor(e.machine_type).map(p=>p.key),...Object.keys(limits)])].map(key=>{
    const def=CONDITION_PARAMETERS[key], last=one('SELECT value,observed_at FROM condition_readings WHERE equipment_id=? AND parameter=? ORDER BY observed_at DESC LIMIT 1',e.id,key);
    const fresh=last&&at-Date.parse(last.observed_at)<=FRESH_MS, l=limits[key];
    return {parameter:key,label:def.label,unit:def.unit,value:last?.value??null,observedAt:last?.observed_at??null,limit:l?{warnLow:l.warn_low,warnHigh:l.warn_high,critLow:l.crit_low,critHigh:l.crit_high,autoTicket:!!l.auto_ticket}:null,
      status:!l?'no_limit':!last?'no_data':!fresh?'stale':judge(last.value,l)};
  });
  const rank={critical:3,warning:2,ok:1}, worst=params.reduce((w,p)=>(rank[p.status]||0)>(rank[w]||0)?p.status:w,null);
  return {status:worst||'unknown',parameters:params};
}
// Readings for a chart: raw points for up to two days, hourly averages beyond that.
export function trend(e,parameter,hours) {
  const from=new Date(Date.now()-hours*3600000).toISOString();
  if (hours<=48) return all('SELECT observed_at t,value v FROM condition_readings WHERE equipment_id=? AND parameter=? AND observed_at>=? ORDER BY observed_at',e.id,parameter,from);
  return all("SELECT substr(observed_at,1,13)||':00:00.000Z' t,round(avg(value),2) v FROM condition_readings WHERE equipment_id=? AND parameter=? AND observed_at>=? GROUP BY substr(observed_at,1,13) ORDER BY 1",e.id,parameter,from);
}
