// Operational dashboard, computed only from what the caller may see: open work, response times against targets,
// maintenance KPIs (EN 15341: MTTR, MTBF, availability), downtime, repeat faults, a 12-week breakdown trend,
// maintenance and renewals due, incomplete master data, and machine-data health.
import { one, all } from '../../../common/db.js';
import { isCustomer, isProvider } from '../../../common/security.js';
import { isDispatch, visibleTickets } from '../../../common/access.js';
import { telemetry } from '../../iot/ingest.js';
import { missingEquipmentData } from '../../../common/catalog.js';
import { coverageFor, responseTarget } from './contracts.js';

const DAY=86400000, HOUR=3600000, PERIOD_DAYS=90, PRIORITIES=['low','medium','high','critical'];
const average=list=>list.length?Math.round(list.reduce((a,b)=>a+b,0)/list.length):null;
const round1=n=>n==null?null:Math.round(n*10)/10;
const top=(counts,label,min=1)=>Object.entries(counts).filter(([,n])=>n>=min).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([equipmentId,n])=>({equipmentId,label:label(equipmentId),value:n}));
// Monday 00:00 UTC of the week containing t.
const weekStart=t=>{ const d=new Date(t); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)); return d.getTime(); };

// MTTR: mean time from failure start to completion. MTBF: (asset-hours in the period - downtime) / breakdowns.
// Availability: share of asset-hours not lost to breakdown downtime. Calendar hours are used (24x7 basis).
function kpis(tickets,assetCount,at) {
  const since=at-PERIOD_DAYS*DAY, inPeriod=tickets.filter(t=>Date.parse(t.occurred_at||t.created_at)>=since);
  const repaired=inPeriod.filter(t=>t.completed_at), downtimeH=inPeriod.reduce((n,t)=>n+(t.downtime_minutes||0),0)/60, assetHours=assetCount*PERIOD_DAYS*24;
  return {
    periodDays:PERIOD_DAYS,breakdowns:inPeriod.length,
    mttrHours:repaired.length?round1(repaired.reduce((n,t)=>n+(Date.parse(t.completed_at)-Date.parse(t.occurred_at||t.created_at)),0)/repaired.length/HOUR):null,
    mtbfHours:assetCount&&inPeriod.length?Math.round((assetHours-downtimeH)/inPeriod.length):null,
    availabilityPct:assetCount?round1(Math.max(0,100*(1-downtimeH/assetHours))):null,
    safetyIssues:inPeriod.filter(t=>t.safety_issue).length
  };
}

export function register(r) {
  r.get('/dashboard',({u})=>{
    const tickets=visibleTickets(u), open=tickets.filter(t=>t.status!=='completed'), at=Date.now();
    const responseMinutes=t=>(Date.parse(t.first_response_at)-Date.parse(t.created_at))/60000, responded=tickets.filter(t=>t.first_response_at);
    const label=equipmentId=>{ const e=one('SELECT make,model,asset_tag FROM equipment WHERE id=?',equipmentId); return `${e.asset_tag?e.asset_tag+' · ':''}${e.make} ${e.model}`; };
    const repeat={}, downtime={};
    for (const t of tickets) { if (at-Date.parse(t.created_at)<=PERIOD_DAYS*DAY) { repeat[t.equipment_id]=(repeat[t.equipment_id]||0)+1; if (t.downtime_minutes) downtime[t.equipment_id]=(downtime[t.equipment_id]||0)+t.downtime_minutes; } }
    const breached=open.filter(t=>responseTarget(t,coverageFor(t),at).responseBreached);
    const companyIds=isCustomer(u)?[u.company_id]:isProvider(u)||u.role==='engineer'?[]:all('SELECT id FROM companies').map(c=>c.id), nowIso=new Date(at).toISOString();
    const visits=(sql,...args)=>companyIds.flatMap(c=>all(`SELECT v.*,e.make,e.model,e.asset_tag,p.timezone FROM visits v JOIN equipment e ON e.id=v.equipment_id JOIN plants p ON p.id=e.plant_id WHERE v.company_id=? AND v.status='scheduled' AND ${sql} ORDER BY v.due_at LIMIT 10`,c,...args));
    const assets=isCustomer(u)?all("SELECT * FROM equipment WHERE company_id=? AND status<>'decommissioned'",u.company_id):isDispatch(u)?all("SELECT * FROM equipment WHERE status<>'decommissioned'"):[];
    const fleet=assets.map(e=>telemetry(e.id,at)), fleetCount=s=>fleet.filter(x=>x.status===s).length;
    const repeatFaults=top(repeat,label,2), firstWeek=weekStart(at)-11*7*DAY;
    const weekly=Array.from({length:12},(_,i)=>{ const start=firstWeek+i*7*DAY; return {weekStart:new Date(start).toISOString().slice(0,10),breakdowns:tickets.filter(t=>{ const c=Date.parse(t.occurred_at||t.created_at); return c>=start&&c<start+7*DAY; }).length}; });
    return {
      openTickets:open.length,escalated:open.filter(t=>t.status==='escalated').length,unassigned:open.filter(t=>t.status==='open').length,safetyOpen:open.filter(t=>t.safety_issue).length,
      byPriority:Object.fromEntries(PRIORITIES.map(p=>[p,open.filter(t=>t.priority===p).length])),
      averageResponseMinutes:average(responded.map(responseMinutes)),
      responseByPriority:Object.fromEntries(PRIORITIES.map(p=>[p,average(responded.filter(t=>t.priority===p).map(responseMinutes))])),
      responseBreaches:breached.length,breachedTickets:breached.slice(0,5).map(t=>({id:t.id,title:t.title,priority:t.priority})),
      kpi:kpis(tickets,isProvider(u)||u.role==='engineer'?0:assets.length,at),weekly,
      downtimeMinutes:tickets.reduce((n,t)=>n+t.downtime_minutes,0),downtimeByAsset:top(downtime,label),
      repeatFaultAssets:repeatFaults.length,repeatFaults,
      upcomingMaintenance:visits('v.due_at>=?',nowIso),overdueVisits:visits('v.due_at<?',nowIso),
      upcomingRenewals:companyIds.flatMap(c=>all("SELECT id,title,company_id,renews_at,contract_number,notice_days FROM contracts WHERE company_id=? AND status='active' AND renews_at>=? AND renews_at<? ORDER BY renews_at",c,nowIso,new Date(at+120*DAY).toISOString())).map(c=>({...c,noticeDue:Math.ceil((Date.parse(c.renews_at)-at)/DAY)<=c.notice_days})),
      incompleteAssets:assets.filter(e=>missingEquipmentData(e).length).map(e=>({id:e.id,label:label(e.id),missing:missingEquipmentData(e)})).slice(0,10),
      telemetry:{current:fleetCount('current'),stale:fleetCount('stale'),missing:fleetCount('missing'),unmapped:fleetCount('unmapped'),activeAlarms:fleet.reduce((n,x)=>n+x.activeAlarms.length,0)},
      tickets:open.slice(0,8)
    };
  });
}
