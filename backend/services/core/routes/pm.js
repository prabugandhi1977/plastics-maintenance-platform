// Preventive maintenance plans: by calendar days, by machine running hours, or by mould shots. A plan creates a job
// when it falls due and raises an alert once it is 10 % past its interval; completing the job restarts the count.
// PM compliance is the share of jobs that came due and were done on time (at or before 110 % of the interval).
import { id, now, one, all, run, mapSeq, forEachSeq } from '../../../common/db.js';
import { canCompany, canManageCompany, isCustomer } from '../../../common/security.js';
import { audit, byId, getEquipment, isDispatch } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { bad, choice, date, deny, integer, missing, required } from '../../../common/validate.js';
import { raiseAlert, resolveAlertKey } from '../../factory/alerts.js';
import { planParts, setPlanParts } from '../stock.js';

export const TRIGGERS={calendar:{unit:'days',min:1,max:3650},runtime:{unit:'hours',min:1,max:100000},shots:{unit:'shots',min:100,max:100000000}};
// Moulds count shots (or calendar time); machines count running hours (or calendar time).
const triggersFor=type=>type==='mould'?['shots','calendar']:['runtime','calendar'];
const DUE_SOON=0.9, DUE=1, OVERDUE=1.1;
export const statusOf=p=>p>=OVERDUE?'overdue':p>=DUE?'due':p>=DUE_SOON?'due_soon':'ok';
const specsOf=e=>{ try { return JSON.parse(e.specs||'{}'); } catch { return {}; } };
const canPlan=(u,companyId)=>isDispatch(u)||canManageCompany(u,companyId)||(u.role==='plant_manager'&&u.company_id===companyId);

// Running hours since a moment, from the machine-state history (open states count up to now).
async function runningHours(equipmentId,since,at) {
  const rows=await all("SELECT started_at,ended_at FROM machine_states WHERE equipment_id=? AND state='running' AND started_at<? AND (ended_at IS NULL OR ended_at>?)",equipmentId,at,since);
  const from=Date.parse(since), to=Date.parse(at);
  return rows.reduce((h,r)=>h+Math.max(0,Math.min(Date.parse(r.ended_at||at),to)-Math.max(Date.parse(r.started_at),from)),0)/3600000;
}
// Shots on a mould since a moment: parts counted while it was in a batch on that machine, or for a product made with
// it, divided by its cavities.
async function mouldShots(mould,since,at) {
  const parts=(await one(`SELECT COALESCE(SUM(pc.total_qty),0) n FROM production_counts pc WHERE pc.period_start>=? AND pc.period_start<? AND (
      EXISTS (SELECT 1 FROM batches b WHERE b.mould_id=? AND b.equipment_id=pc.equipment_id AND pc.period_start>=b.started_at AND (b.ended_at IS NULL OR pc.period_start<b.ended_at))
      OR pc.product_id IN (SELECT id FROM products WHERE mould_id=?))`,since,at,mould.id,mould.id)).n;
  return parts/Math.max(1,Number(specsOf(mould).cavities)||1);
}

// Where a plan stands now: usage since the last service, its progress against the interval, and the status.
export async function planState(plan,at=now()) {
  const e=await byId('equipment',plan.equipment_id);
  const used=plan.trigger==='calendar'?Math.max(0,(Date.parse(at)-Date.parse(plan.last_done_at))/86400000)
    :plan.trigger==='runtime'?await runningHours(plan.equipment_id,plan.last_done_at,at)
    :await mouldShots(e,plan.last_done_at,at);
  const usage=plan.start_usage+used, progress=usage/plan.interval_value;
  return {usage:Math.round(usage*10)/10,progress:Math.round(progress*1000)/1000,status:statusOf(progress),remaining:Math.max(0,Math.round((plan.interval_value-usage)*10)/10),unit:TRIGGERS[plan.trigger].unit};
}

// Opens a job when a plan falls due and raises the overdue alert; both are idempotent.
export async function syncPlan(plan,at=now()) {
  if (!plan.active) return null;
  const s=await planState(plan,at);
  if (s.progress>=DUE&&!(await one("SELECT 1 FROM pm_jobs WHERE plan_id=? AND status='open'",plan.id)))
    await run('INSERT INTO pm_jobs (id,plan_id,company_id,equipment_id,status,due_at,created_at) VALUES (?,?,?,?,?,?,?)',id(),plan.id,plan.company_id,plan.equipment_id,'open',at,at);
  if (s.progress>=OVERDUE) {
    const e=await byId('equipment',plan.equipment_id);
    await raiseAlert({companyId:plan.company_id,plantId:plan.plant_id,module:'maintenance',severity:'warning',equipmentId:plan.equipment_id,dedupeKey:`pm-overdue:${plan.id}`,
      title:`Preventive maintenance overdue: ${plan.title}`,detail:`${e?.asset_tag||''} ${e?.make||''} ${e?.model||''}: ${s.usage} of ${plan.interval_value} ${s.unit} since the last service (${Math.round(s.progress*100)} %).`.trim()});
  }
  return s;
}
export async function syncAll(at=now()) { await forEachSeq(await all('SELECT * FROM pm_plans WHERE active=1'),p=>syncPlan(p,at)); }

const visiblePlans=async u=>isDispatch(u)?await all('SELECT * FROM pm_plans ORDER BY created_at'):isCustomer(u)?await all('SELECT * FROM pm_plans WHERE company_id=? ORDER BY created_at',u.company_id):[];
async function getPlan(u,key) { const p=await byId('pm_plans',key); if (!p) missing(); if (!canCompany(u,p.company_id)) deny(); return p; }
async function present(plan,at) {
  const s=plan.active?await syncPlan(plan,at):await planState(plan,at);
  const job=await one("SELECT id FROM pm_jobs WHERE plan_id=? AND status='open'",plan.id);
  // Spare parts the service needs, and whether the plan's plant has them in stock (null when no parts are listed).
  const parts=await planParts(plan);
  return {...plan,checklist:JSON.parse(plan.checklist),...s,status:plan.active?s.status:'inactive',openJobId:job?.id??null,parts,stockSufficient:parts.length?parts.every(p=>p.sufficient):null};
}
const checklistOf=v=>{ if (!Array.isArray(v)||v.length>50||v.some(x=>typeof x!=='string'||!x.trim()||x.length>200)) bad('checklist must be up to 50 items of 1-200 characters'); return v.map(x=>x.trim()); };
const numberOf=(v,name,max)=>{ const n=typeof v==='string'&&v.trim()?Number(v):v; if (typeof n!=='number'||!Number.isFinite(n)||n<0||n>max) bad(`${name} must be a number from 0 to ${max}`); return n; };
const intervalOf=(v,trigger)=>{ const r=TRIGGERS[trigger]; return integer(typeof v==='string'?Number(v):v,'intervalValue',r.min,r.max); };

// Compliance over the last `days` for the given companies: jobs that came due, on time, late, and still open past due.
export async function compliance(companyIds,days=90,at=now()) {
  if (!companyIds.length) return {periodDays:days,due:0,onTime:0,late:0,openOverdue:0,compliancePct:null};
  const since=new Date(Date.parse(at)-days*86400000).toISOString(), marks=companyIds.map(()=>'?').join(',');
  const jobs=await all(`SELECT j.*,p.interval_value,p.trigger FROM pm_jobs j JOIN pm_plans p ON p.id=j.plan_id WHERE j.company_id IN (${marks}) AND j.due_at>=? AND j.due_at<=?`,...companyIds,since,at);
  const onTime=jobs.filter(j=>j.status==='completed'&&j.on_time).length, late=jobs.filter(j=>j.status==='completed'&&!j.on_time).length;
  const openOverdue=(await mapSeq(jobs.filter(j=>j.status==='open'),async j=>(await planState(await byId('pm_plans',j.plan_id),at)).status==='overdue')).filter(Boolean).length;
  const due=onTime+late+openOverdue;
  return {periodDays:days,due,onTime,late,openOverdue,compliancePct:due?Math.round(onTime/due*1000)/10:null};
}
const companiesOf=async u=>isDispatch(u)?(await all('SELECT id FROM companies')).map(c=>c.id):isCustomer(u)?[u.company_id]:[];

export function register(r) {
  r.get('/pm/plans',async ({u})=>{ const at=now(); return await mapSeq(await visiblePlans(u),p=>present(p,at)); },{writes:true});
  r.get('/pm/plans/:id',async ({u,params})=>{ const p=await getPlan(u,params.id); return {...await present(p,now()),jobs:(await all('SELECT * FROM pm_jobs WHERE plan_id=? ORDER BY due_at DESC',p.id)).map(j=>({...j,results:JSON.parse(j.results)}))}; },{writes:true});
  r.post('/pm/plans',async ({u,body})=>{
    const e=await getEquipment(u,body.equipmentId); if (!canPlan(u,e.company_id)) deny();
    if (e.status==='decommissioned') bad('This machine is decommissioned');
    const trigger=choice(body.trigger,'trigger',triggersFor(e.machine_type)), interval=intervalOf(body.intervalValue,trigger);
    const checklist=body.checklist==null?(await all('SELECT item FROM checklist_templates WHERE machine_type=? ORDER BY position',e.machine_type)).map(x=>x.item):checklistOf(body.checklist);
    // A mould's shots since its last service default to its recorded shot count past the last whole interval.
    const shotCount=Number(specsOf(e).shotCount);
    const startUsage=body.startUsage!=null&&body.startUsage!==''?numberOf(body.startUsage,'startUsage',TRIGGERS[trigger].max*10):trigger==='shots'&&Number.isFinite(shotCount)?shotCount%interval:0;
    const lastDone=body.lastDoneAt?date(body.lastDoneAt,'lastDoneAt'):now();
    if (lastDone>now()) bad('lastDoneAt cannot be in the future');
    const key=id(), title=body.title?required(body.title,'title',200):`Every ${interval} ${TRIGGERS[trigger].unit}`;
    await run('INSERT INTO pm_plans (id,company_id,plant_id,equipment_id,title,trigger,interval_value,checklist,start_usage,last_done_at,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)',
      key,e.company_id,e.plant_id,e.id,title,trigger,interval,JSON.stringify(checklist),startUsage,lastDone,u.id,now(),now());
    if (body.parts!=null) await setPlanParts(await byId('pm_plans',key),body.parts);
    await audit(u,'pm.plan.create','pm_plan',key,e.company_id,{trigger,interval});
    return created(await present(await byId('pm_plans',key),now()));
  });
  r.patch('/pm/plans/:id',async ({u,body,params})=>{
    const p=await getPlan(u,params.id); if (!canPlan(u,p.company_id)) deny();
    const next={title:body.title!=null?required(body.title,'title',200):p.title,interval:body.intervalValue!=null?intervalOf(body.intervalValue,p.trigger):p.interval_value,
      checklist:body.checklist!=null?JSON.stringify(checklistOf(body.checklist)):p.checklist,active:body.active!=null?(body.active?1:0):p.active};
    await run('UPDATE pm_plans SET title=?,interval_value=?,checklist=?,active=?,updated_at=? WHERE id=?',next.title,next.interval,next.checklist,next.active,now(),p.id);
    if (body.parts!=null) await setPlanParts(p,body.parts);
    // A paused plan has nothing due: its open job is withdrawn and its overdue alert cleared.
    if (!next.active) { await run("DELETE FROM pm_jobs WHERE plan_id=? AND status='open'",p.id); await resolveAlertKey(`pm-overdue:${p.id}`); }
    await audit(u,'pm.plan.update','pm_plan',p.id,p.company_id,{interval:next.interval,active:next.active,...(body.parts!=null?{parts:body.parts.length}:{})});
    return await present(await byId('pm_plans',p.id),now());
  });
  r.get('/pm/jobs',async ({u,query})=>{
    const ids=await companiesOf(u); if (!ids.length) return [];
    const status=query.get('status'); if (status) choice(status,'status',['open','completed']);
    const rows=await all(`SELECT j.*,p.title,p.trigger,p.interval_value,p.checklist FROM pm_jobs j JOIN pm_plans p ON p.id=j.plan_id WHERE j.company_id IN (${ids.map(()=>'?').join(',')})${status?' AND j.status=?':''} ORDER BY j.due_at DESC LIMIT 500`,...ids,...(status?[status]:[]));
    return rows.map(j=>({...j,checklist:JSON.parse(j.checklist),results:JSON.parse(j.results)}));
  });
  r.post('/pm/jobs/:id/complete',async ({u,body,params})=>{
    const j=await byId('pm_jobs',params.id); if (!j) missing(); if (!canCompany(u,j.company_id)) deny();
    if (j.status!=='open') bad('This job is already completed');
    const plan=await byId('pm_plans',j.plan_id), items=JSON.parse(plan.checklist);
    // One result per checklist item: done, or not done with a note.
    const results=Array.isArray(body.results)?body.results:[];
    if (results.length!==items.length||results.some(x=>typeof x?.done!=='boolean')) bad(`results must give done true or false for each of the ${items.length} checklist items`);
    if (results.some(x=>!x.done&&!String(x.note??'').trim())) bad('Add a note to each checklist item that was not done');
    const at=now(), s=await planState(plan,at), onTime=s.progress<=OVERDUE?1:0;
    await run("UPDATE pm_jobs SET status='completed',completed_at=?,completed_by=?,progress_at_completion=?,on_time=?,notes=?,results=? WHERE id=?",at,u.id,s.progress,onTime,String(body.notes??'').trim().slice(0,2000),
      JSON.stringify(items.map((item,i)=>({item,done:results[i].done,note:String(results[i].note??'').trim().slice(0,500)}))),j.id);
    await run('UPDATE pm_plans SET last_done_at=?,start_usage=0,updated_at=? WHERE id=?',at,at,plan.id);
    await resolveAlertKey(`pm-overdue:${plan.id}`,at);
    await audit(u,'pm.job.complete','pm_job',j.id,j.company_id,{onTime:!!onTime,progress:s.progress});
    return {...await byId('pm_jobs',j.id),onTime:!!onTime};
  });
  r.get('/pm/compliance',async ({u,query})=>await compliance(await companiesOf(u),integer(Number(query.get('days')||90),'days',7,730)));
}
