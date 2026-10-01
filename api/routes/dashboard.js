// Operational dashboard, computed only from what the caller may see: open work, response times against contract
// targets, downtime, repeat faults, maintenance and renewals due, and machine-data health.
import { one, all } from '../db.js';
import { isCustomer, isProvider } from '../security.js';
import { isDispatch, visibleTickets } from '../access.js';
import { telemetry } from '../iot/ingest.js';
import { coverageFor, responseTarget } from './contracts.js';

const DAY=86400000, PRIORITIES=['low','medium','high','critical'];
const average=list=>list.length?Math.round(list.reduce((a,b)=>a+b,0)/list.length):null;
const top=(counts,label,min=1)=>Object.entries(counts).filter(([,n])=>n>=min).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([equipmentId,n])=>({equipmentId,label:label(equipmentId),value:n}));

export function register(r) {
  r.get('/dashboard',({u})=>{
    const tickets=visibleTickets(u), open=tickets.filter(t=>t.status!=='completed'), at=Date.now();
    const responseMinutes=t=>(Date.parse(t.first_response_at)-Date.parse(t.created_at))/60000, responded=tickets.filter(t=>t.first_response_at);
    const label=equipmentId=>{ const e=one('SELECT make,model FROM equipment WHERE id=?',equipmentId); return `${e.make} ${e.model}`; };
    const repeat={}, downtime={};
    for (const t of tickets) { if (at-Date.parse(t.created_at)<=90*DAY) repeat[t.equipment_id]=(repeat[t.equipment_id]||0)+1; if (t.downtime_minutes) downtime[t.equipment_id]=(downtime[t.equipment_id]||0)+t.downtime_minutes; }
    const breached=open.filter(t=>responseTarget(t,coverageFor(t),at).responseBreached);
    const companyIds=isCustomer(u)?[u.company_id]:isProvider(u)||u.role==='engineer'?[]:all('SELECT id FROM companies').map(c=>c.id), nowIso=new Date(at).toISOString();
    const visits=(sql,...args)=>companyIds.flatMap(c=>all(`SELECT v.*,e.make,e.model,p.timezone FROM visits v JOIN equipment e ON e.id=v.equipment_id JOIN plants p ON p.id=e.plant_id WHERE v.company_id=? AND v.status='scheduled' AND ${sql} ORDER BY v.due_at LIMIT 10`,c,...args));
    const fleet=(isCustomer(u)?all('SELECT id FROM equipment WHERE company_id=?',u.company_id):isDispatch(u)?all('SELECT id FROM equipment'):[]).map(e=>telemetry(e.id,at)), fleetCount=s=>fleet.filter(x=>x.status===s).length;
    const repeatFaults=top(repeat,label,2);
    return {
      openTickets:open.length,escalated:open.filter(t=>t.status==='escalated').length,unassigned:open.filter(t=>t.status==='open').length,
      byPriority:Object.fromEntries(PRIORITIES.map(p=>[p,open.filter(t=>t.priority===p).length])),
      averageResponseMinutes:average(responded.map(responseMinutes)),
      responseByPriority:Object.fromEntries(PRIORITIES.map(p=>[p,average(responded.filter(t=>t.priority===p).map(responseMinutes))])),
      responseBreaches:breached.length,breachedTickets:breached.slice(0,5).map(t=>({id:t.id,title:t.title,priority:t.priority})),
      downtimeMinutes:tickets.reduce((n,t)=>n+t.downtime_minutes,0),downtimeByAsset:top(downtime,label),
      repeatFaultAssets:repeatFaults.length,repeatFaults,
      upcomingMaintenance:visits('v.due_at>=?',nowIso),overdueVisits:visits('v.due_at<?',nowIso),
      upcomingRenewals:companyIds.flatMap(c=>all("SELECT id,title,company_id,renews_at FROM contracts WHERE company_id=? AND status='active' AND renews_at>=? AND renews_at<? ORDER BY renews_at",c,nowIso,new Date(at+90*DAY).toISOString())),
      telemetry:{current:fleetCount('current'),stale:fleetCount('stale'),missing:fleetCount('missing'),unmapped:fleetCount('unmapped'),activeAlarms:fleet.reduce((n,x)=>n+x.activeAlarms.length,0)},
      tickets:open.slice(0,8)
    };
  });
}
