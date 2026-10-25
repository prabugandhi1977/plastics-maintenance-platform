// IATF 16949 maintenance evidence pack: one company, one period, everything an auditor asks for under
// 8.5.1.5 (total productive maintenance) and 8.5.1.6 (tooling management), plus the breakdown records behind 10.2.
// It is built only from recorded data, lists the gaps an auditor would raise, and carries a SHA-256 fingerprint of
// its content so a printed copy can be matched to the system. Downloads are written to the audit trail.
import { createHash } from 'node:crypto';
import { one, all, mapSeq } from '../../../common/db.js';
import { canCompany, isCustomer } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { bad, choice, date, deny, missing } from '../../../common/validate.js';
import { machineOee } from '../../factory/production.js';
import { planState, compliance } from './pm.js';
import { partViews } from '../stock.js';

const DAY=86400000, HOUR=3600000;
const round=(n,d=1)=>n==null||!Number.isFinite(n)?null:Math.round(n*10**d)/10**d;
const label=e=>e?`${e.asset_tag?e.asset_tag+' · ':''}${e.make} ${e.model}`:'—';
const specsOf=e=>{ try { return JSON.parse(e.specs||'{}'); } catch { return {}; } };

function period(query) {
  // Up to now by default; a date-only "to" includes that whole day.
  const toRaw=query.get('to'), toMs=toRaw?Date.parse(date(toRaw,'to'))+(toRaw.includes('T')?0:DAY):Date.now();
  const fromMs=query.get('from')?Date.parse(date(query.get('from'),'from')):toMs-90*DAY;
  if (fromMs>=toMs) bad('from must be before to');
  if (toMs-fromMs>366*DAY) bad('The period can be at most one year');
  return {fromMs,toMs:Math.min(toMs,Date.now()),from:new Date(fromMs).toISOString(),to:new Date(Math.min(toMs,Date.now())).toISOString()};
}
async function companyFor(u,query) {
  const key=query.get('companyId')||(isCustomer(u)?u.company_id:null);
  if (!key) bad('companyId is required');
  const c=await byId('companies',key); if (!c) missing(); if (!canCompany(u,c.id)) deny(); return c;
}

// Breakdown KPIs (EN 15341) for a set of tickets over a number of machine-hours.
function kpis(tickets,machineHours) {
  const repaired=tickets.filter(t=>t.completed_at), downtimeH=tickets.reduce((n,t)=>n+(t.downtime_minutes||0),0)/60;
  return {breakdowns:tickets.length,downtimeHours:round(downtimeH),
    mttrHours:repaired.length?round(repaired.reduce((n,t)=>n+(Date.parse(t.completed_at)-Date.parse(t.occurred_at||t.created_at)),0)/repaired.length/HOUR):null,
    mtbfHours:tickets.length&&machineHours?Math.round((machineHours-downtimeH)/tickets.length):null,
    availabilityPct:machineHours?round(Math.max(0,100*(1-downtimeH/machineHours))):null};
}

export async function buildPack(company,{fromMs,toMs,from,to},u) {
  const hours=(toMs-fromMs)/HOUR;
  const plants=await all('SELECT id,name,timezone FROM plants WHERE company_id=? ORDER BY name',company.id);
  const equipment=await all("SELECT * FROM equipment WHERE company_id=? AND status<>'decommissioned' ORDER BY asset_tag,make",company.id);
  const tickets=await all(`SELECT t.*,s.signer_name,s.signed_at FROM tickets t LEFT JOIN signoffs s ON s.ticket_id=t.id
    WHERE t.company_id=? AND COALESCE(t.occurred_at,t.created_at)>=? AND COALESCE(t.occurred_at,t.created_at)<? ORDER BY COALESCE(t.occurred_at,t.created_at)`,company.id,from,to);
  const plans=await all('SELECT * FROM pm_plans WHERE company_id=? ORDER BY created_at',company.id);
  const jobs=await all('SELECT j.*,u.name completed_by_name FROM pm_jobs j LEFT JOIN users u ON u.id=j.completed_by WHERE j.company_id=? AND j.due_at>=? AND j.due_at<? ORDER BY j.due_at',company.id,from,to);
  const byMachine=id=>equipment.find(e=>e.id===id);

  // 8.5.1.5: the plan register, each plan's jobs in the period, and compliance.
  const planRows=await mapSeq(plans,async p=>{ const s=await planState(p,to), own=jobs.filter(j=>j.plan_id===p.id);
    return {id:p.id,machine:label(byMachine(p.equipment_id)||await byId('equipment',p.equipment_id)),equipmentId:p.equipment_id,title:p.title,trigger:p.trigger,interval:p.interval_value,unit:s.unit,active:!!p.active,
      lastService:p.last_done_at,usage:s.usage,progressPct:round(s.progress*100,0),status:p.active?s.status:'inactive',checklistItems:JSON.parse(p.checklist).length,
      jobsDue:own.length,jobsOnTime:own.filter(j=>j.status==='completed'&&j.on_time).length,jobsLate:own.filter(j=>j.status==='completed'&&!j.on_time).length,jobsOpen:own.filter(j=>j.status==='open').length}; });
  const jobRows=jobs.map(j=>{ const p=plans.find(x=>x.id===j.plan_id), results=JSON.parse(j.results);
    return {plan:p?.title,machine:label(byMachine(j.equipment_id)),dueAt:j.due_at,status:j.status,completedAt:j.completed_at,completedBy:j.completed_by_name||null,
      progressPct:j.progress_at_completion==null?null:round(j.progress_at_completion*100,0),onTime:j.status==='completed'?!!j.on_time:null,
      itemsDone:results.filter(r=>r.done).length,itemsSkipped:results.filter(r=>!r.done).map(r=>`${r.item}: ${r.note}`),notes:j.notes}; });

  // Maintenance KPIs and OEE per machine (moulds have no running time of their own).
  const machines=await mapSeq(equipment.filter(e=>e.machine_type!=='mould'),async e=>{
    let oee=null; try { const o=await machineOee(e,fromMs,toMs); oee=o.plannedMs?{oeePct:round(o.oee*100),availabilityPct:round(o.availability*100),performancePct:round(o.performance*100),qualityPct:round(o.quality*100)}:null; } catch { oee=null; }
    return {machine:label(e),equipmentId:e.id,type:e.machine_type,criticality:e.criticality,...kpis(tickets.filter(t=>t.equipment_id===e.id),hours),oee};
  });
  const totals=kpis(tickets.filter(t=>byMachine(t.equipment_id)?.machine_type!=='mould'),hours*machines.length);

  // 8.5.1.6: every mould with its shot count, PM interval, plan and breakdowns.
  const tooling=await mapSeq(equipment.filter(e=>e.machine_type==='mould'),async e=>{ const s=specsOf(e), plan=planRows.find(p=>p.equipmentId===e.id&&p.active);
    return {mould:label(e),equipmentId:e.id,mouldNumber:s.mouldNumber||null,cavities:s.cavities??null,recordedShots:s.shotCount??null,pmIntervalShots:s.pmIntervalShots??null,
      plan:plan?{title:plan.title,usage:plan.usage,interval:plan.interval,unit:plan.unit,status:plan.status,lastService:plan.lastService}:null,
      pmJobsDone:jobRows.filter(j=>j.status==='completed'&&plan&&j.plan===plan.title).length,breakdowns:tickets.filter(t=>t.equipment_id===e.id).length}; });

  // 10.2: breakdown records with cause and action.
  const breakdowns=tickets.map(t=>({id:t.id,occurredAt:t.occurred_at||t.created_at,machine:label(byMachine(t.equipment_id)),title:t.title,priority:t.priority,safetyIssue:!!t.safety_issue,
    failureCategory:t.failure_category,failureMode:t.failure_mode,rootCause:t.root_cause,actionTaken:t.action_taken,downtimeMinutes:t.downtime_minutes,status:t.status,completedAt:t.completed_at,signedOffBy:t.signer_name||null}));
  const parts=await all('SELECT p.item,p.part_number,p.quantity,p.unit,p.urgency,p.status,p.created_at,p.updated_at,t.equipment_id FROM parts_requests p JOIN tickets t ON t.id=p.ticket_id WHERE p.company_id=? AND p.created_at>=? AND p.created_at<? ORDER BY p.created_at',company.id,from,to);

  // 8.5.1.5 replacement parts from stock: what was taken per machine in the period (issues less returns, at the cost
  // when issued), and the spares held for criticality A machines with their reorder state when the pack is generated.
  const issued=(await all(`SELECT m.equipment_id,p.part_number,p.name,p.unit,SUM(-m.quantity) qty,SUM(-m.quantity*m.unit_cost_minor) cost,COUNT(DISTINCT m.ticket_id) tickets,COUNT(DISTINCT m.pm_job_id) jobs
    FROM spare_movements m JOIN spare_parts p ON p.id=m.part_id WHERE m.company_id=? AND m.type IN ('issue','return') AND m.created_at>=? AND m.created_at<?
    GROUP BY m.equipment_id,p.part_number,p.name,p.unit HAVING SUM(-m.quantity)<>0 ORDER BY p.part_number`,company.id,from,to))
    .map(x=>({machine:label(byMachine(x.equipment_id)),partNumber:x.part_number,name:x.name,unit:x.unit,quantity:round(x.qty,3),costMinor:Math.round(x.cost),tickets:x.tickets,pmJobs:x.jobs}));
  const keyMachines=equipment.filter(e=>e.criticality==='A');
  const keySpares=(await partViews([company.id])).filter(p=>p.active&&keyMachines.some(e=>p.fitsEquipmentIds.includes(e.id)||p.fitsTypes.includes(e.machine_type)))
    .map(p=>({partNumber:p.part_number,name:p.name,unit:p.unit,machines:keyMachines.filter(e=>p.fitsEquipmentIds.includes(e.id)||p.fitsTypes.includes(e.machine_type)).map(label),onHand:p.onHand,onOrder:p.onOrder,reorderPoint:p.reorder_point,low:p.low}));
  const spareStock={currency:company.currency,stockAt:new Date().toISOString(),issued,issuedCostMinor:issued.reduce((n,x)=>n+x.costMinor,0),keySpares};

  // What an auditor would raise, each with the records behind it.
  const gaps=[];
  const gap=(clause,finding,items)=>{ if (items.length) gaps.push({clause,finding,count:items.length,items:items.slice(0,50)}); };
  gap('8.5.1.5','Criticality A machines without an active preventive maintenance plan',equipment.filter(e=>e.machine_type!=='mould'&&e.criticality==='A'&&!plans.some(p=>p.equipment_id===e.id&&p.active)).map(label));
  gap('8.5.1.6','Moulds without an active preventive maintenance plan',equipment.filter(e=>e.machine_type==='mould'&&!plans.some(p=>p.equipment_id===e.id&&p.active)).map(label));
  gap('8.5.1.5','Preventive maintenance overdue at the end of the period',planRows.filter(p=>p.status==='overdue').map(p=>`${p.machine}: ${p.title} (${p.progressPct} %)`));
  gap('8.5.1.5','Preventive maintenance jobs completed late',jobRows.filter(j=>j.onTime===false).map(j=>`${j.machine}: ${j.plan} (${j.progressPct} %)`));
  gap('8.5.1.5','Checklist items not done on completed jobs',jobRows.flatMap(j=>j.itemsSkipped.map(s=>`${j.machine}: ${s}`)));
  gap('8.5.1.5','Spare parts for criticality A machines below their reorder point',keySpares.filter(p=>p.low).map(p=>`${p.partNumber} ${p.name}: ${p.onHand} ${p.unit} on hand, ${p.onOrder} on order, reorder point ${p.reorderPoint}`));
  gap('10.2','Completed breakdowns without a recorded root cause or action',breakdowns.filter(b=>b.status==='completed'&&(!b.rootCause||!b.actionTaken)).map(b=>`${b.machine}: ${b.title}`));
  gap('10.2','Completed breakdowns without customer sign-off',breakdowns.filter(b=>b.status==='completed'&&!b.signedOffBy).map(b=>`${b.machine}: ${b.title}`));

  const pack={standard:'IATF 16949:2016',company:{id:company.id,name:company.name,country:company.country},period:{from,to,days:round((toMs-fromMs)/DAY)},
    plants:plants.map(p=>p.name),generatedAt:new Date().toISOString(),generatedBy:u.name,
    pm:{compliance:await compliance([company.id],(toMs-fromMs)/DAY,to),plans:planRows,jobs:jobRows},
    kpis:{totals,machines},tooling,breakdowns,spareParts:parts.map(p=>({...p,machine:label(byMachine(p.equipment_id))})),spareStock,gaps};
  return {...pack,fingerprint:createHash('sha256').update(JSON.stringify(pack)).digest('hex')};
}

const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const day=iso=>iso?String(iso).slice(0,10):'—';
const pct=v=>v==null?'—':`${v} %`;
const num=v=>v==null?'—':Number(v).toLocaleString('en');
const money=(minor,code)=>{ try { const d=new Intl.NumberFormat('en',{style:'currency',currency:code}).resolvedOptions().maximumFractionDigits; return esc(new Intl.NumberFormat('en',{style:'currency',currency:code}).format(minor/10**d)); } catch { return esc(minor); } };
const words=v=>esc(v==null?v:String(v).replaceAll('_',' '));
const table=(head,rows,empty='None in this period.')=>rows.length?`<table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`:`<p class="muted">${esc(empty)}</p>`;
// A self-contained, printable document (print to PDF from the browser). Every value is escaped.
export function packHtml(p) {
  const c=p.pm.compliance, t=p.kpis.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(`IATF 16949 maintenance evidence – ${p.company.name} – ${day(p.period.from)} to ${day(p.period.to)}`)}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#1b2b30;margin:32px;max-width:1100px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:2px solid #007e85;padding-bottom:4px}
.muted{color:#5b6d72}table{border-collapse:collapse;width:100%;margin:6px 0 12px}th,td{border:1px solid #cfd8da;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eef4f4;font-size:12px}
.kpis{display:flex;flex-wrap:wrap;gap:10px}.kpi{border:1px solid #cfd8da;border-radius:6px;padding:8px 12px;min-width:140px}.kpi b{display:block;font-size:20px}.gap{border-left:4px solid #a34531;padding:4px 10px;margin:8px 0;background:#fbf1ee}
.ok{border-left:4px solid #1b6547;padding:4px 10px;background:#eef8f2}footer{margin-top:32px;font-size:11px;color:#5b6d72;word-break:break-all}@media print{body{margin:12mm}h2{break-after:avoid}tr{break-inside:avoid}}</style></head><body>
<h1>Maintenance evidence for IATF 16949</h1><p class="muted">${esc(p.company.name)} · ${esc(p.plants.join(', ')||'—')} · ${day(p.period.from)} to ${day(p.period.to)} (${p.period.days} days) · generated ${esc(p.generatedAt.slice(0,16).replace('T',' '))} UTC by ${esc(p.generatedBy)}</p>
<div class="kpis"><div class="kpi">PM compliance<b>${pct(c.compliancePct)}</b><span class="muted">${c.onTime} of ${c.due} on time</span></div><div class="kpi">Breakdowns<b>${t.breakdowns}</b><span class="muted">${t.downtimeHours} h downtime</span></div>
<div class="kpi">MTTR<b>${t.mttrHours==null?'—':t.mttrHours+' h'}</b></div><div class="kpi">MTBF<b>${t.mtbfHours==null?'—':t.mtbfHours+' h'}</b></div><div class="kpi">Availability<b>${pct(t.availabilityPct)}</b></div><div class="kpi">Open gaps<b>${p.gaps.length}</b></div></div>
<h2>Findings to address before the audit</h2>${p.gaps.length?p.gaps.map(g=>`<div class="gap"><b>${esc(g.clause)} · ${esc(g.finding)} (${g.count})</b><br>${g.items.map(esc).join('<br>')}</div>`).join(''):'<div class="ok">No gaps found in the recorded data.</div>'}
<h2>8.5.1.5 Total productive maintenance: preventive maintenance plans</h2>${table(['Machine','Plan','Counted by','Interval','Since last service','Status','Last service','Jobs due','On time','Late','Open'],p.pm.plans.map(x=>[esc(x.machine),esc(x.title),esc(x.trigger),`${num(x.interval)} ${esc(x.unit)}`,`${num(x.usage)} ${esc(x.unit)} (${x.progressPct} %)`,words(x.status),day(x.lastService),x.jobsDue,x.jobsOnTime,x.jobsLate,x.jobsOpen]),'No preventive maintenance plans.')}
<h2>8.5.1.5 Preventive maintenance jobs in the period</h2>${table(['Due','Machine','Plan','Status','Completed','By','At % of interval','On time','Checklist','Notes'],p.pm.jobs.map(j=>[day(j.dueAt),esc(j.machine),esc(j.plan),words(j.status),day(j.completedAt),esc(j.completedBy),pct(j.progressPct),j.onTime==null?'—':j.onTime?'Yes':'<b>No</b>',`${j.itemsDone} done${j.itemsSkipped.length?`<br>Not done: ${j.itemsSkipped.map(esc).join('<br>')}`:''}`,esc(j.notes||'—')]))}
<h2>8.5.1.5 Maintenance objectives: KPIs and OEE by machine</h2>${table(['Machine','Type','Criticality','Breakdowns','Downtime','MTTR','MTBF','Availability','OEE','A · P · Q'],p.kpis.machines.map(m=>[esc(m.machine),esc(m.type),esc(m.criticality),m.breakdowns,`${m.downtimeHours} h`,m.mttrHours==null?'—':m.mttrHours+' h',m.mtbfHours==null?'—':m.mtbfHours+' h',pct(m.availabilityPct),m.oee?pct(m.oee.oeePct):'—',m.oee?`${pct(m.oee.availabilityPct)} · ${pct(m.oee.performancePct)} · ${pct(m.oee.qualityPct)}`:'no production data']))}
<p class="muted">MTTR: mean time from failure to completion. MTBF: (machine-hours − downtime) ÷ breakdowns. Availability: share of calendar hours not lost to breakdowns. OEE from machine states and production counts within shifts.</p>
<h2>8.5.1.6 Tooling management: moulds</h2>${table(['Mould','Number','Cavities','Recorded shots','PM interval','Plan','Since last service','Status','PM jobs done','Breakdowns'],p.tooling.map(m=>[esc(m.mould),esc(m.mouldNumber),esc(m.cavities),m.recordedShots==null?'—':Number(m.recordedShots).toLocaleString('en'),m.pmIntervalShots==null?'—':Number(m.pmIntervalShots).toLocaleString('en')+' shots',esc(m.plan?.title),m.plan?`${Number(m.plan.usage).toLocaleString('en')} / ${Number(m.plan.interval).toLocaleString('en')} ${esc(m.plan.unit)}`:'—',words(m.plan?.status||'no plan'),m.pmJobsDone,m.breakdowns]),'No moulds registered.')}
<h2>10.2 Breakdown records</h2>${table(['Occurred','Machine','Fault','Priority','Category · mode','Root cause','Action','Downtime','Status','Signed off'],p.breakdowns.map(b=>[day(b.occurredAt),esc(b.machine),`${esc(b.title)}${b.safetyIssue?' <b>(safety)</b>':''}`,esc(b.priority),`${words(b.failureCategory)} · ${words(b.failureMode)}`,words(b.rootCause),words(b.actionTaken),`${num(b.downtimeMinutes)} min`,words(b.status),esc(b.signedOffBy)]))}
<h2>8.5.1.5 Replacement parts</h2>${table(['Requested','Machine','Part','Quantity','Urgency','Status','Updated'],p.spareParts.map(x=>[day(x.created_at),esc(x.machine),`${esc(x.item)}<br><span class="muted">${esc(x.part_number)}</span>`,`${x.quantity} ${esc(x.unit)}`,words(x.urgency),words(x.status),day(x.updated_at)]))}
<h2>8.5.1.5 Replacement parts used from stock</h2>${table(['Machine','Part','Quantity','Tickets','PM jobs','Cost'],p.spareStock.issued.map(x=>[esc(x.machine),`${esc(x.name)}<br><span class="muted">${esc(x.partNumber)}</span>`,`${num(x.quantity)} ${esc(x.unit)}`,x.tickets,x.pmJobs,money(x.costMinor,p.spareStock.currency)]))}
<h2>8.5.1.5 Spare parts held for criticality A machines</h2><p class="muted">Stock when this pack was generated (${esc(p.spareStock.stockAt.slice(0,16).replace('T',' '))} UTC).</p>${table(['Part','For','On hand','On order','Reorder point','Status'],p.spareStock.keySpares.map(x=>[`${esc(x.name)}<br><span class="muted">${esc(x.partNumber)}</span>`,x.machines.map(esc).join('<br>'),`${num(x.onHand)} ${esc(x.unit)}`,num(x.onOrder),num(x.reorderPoint),x.low?'<b>Below reorder point</b>':'OK']),'No spare parts in the stock catalogue fit a criticality A machine.')}
<footer>Built from the records in MouldCare at the time shown. SHA-256 fingerprint of the data: ${esc(p.fingerprint)}</footer></body></html>`;
}

export function register(r) {
  r.get('/reports/iatf',async ({u,query})=>await buildPack(await companyFor(u,query),period(query),u));
  r.get('/reports/iatf/download',async ({u,query,res})=>{
    const company=await companyFor(u,query), format=choice(query.get('format')||'html','format',['html','json']), pack=await buildPack(company,period(query),u);
    await audit(u,'report.iatf','company',company.id,company.id,{from:pack.period.from,to:pack.period.to,fingerprint:pack.fingerprint});
    const name=`iatf-maintenance-evidence-${company.name.replace(/[^\w]+/g,'-').toLowerCase()}-${pack.period.from.slice(0,10)}-to-${pack.period.to.slice(0,10)}.${format}`;
    res.writeHead(200,{'content-type':format==='html'?'text/html; charset=utf-8':'application/json; charset=utf-8','content-disposition':`attachment; filename="${name}"`,'cache-control':'no-store','x-content-type-options':'nosniff',
      ...(format==='html'?{'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"}:{})});
    res.end(format==='html'?packHtml(pack):JSON.stringify(pack,null,2));
  },{writes:true});
}
