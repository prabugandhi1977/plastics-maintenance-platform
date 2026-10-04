// Annual maintenance contracts: contract number, covered equipment, coverage hours, response/restore targets,
// scheduled visits, commitments, exclusions, renewal and notice period.
import { id, now, one, all, run, transaction } from '../../../common/db.js';
import { canManageCompany } from '../../../common/security.js';
import { audit, byId, isDispatch, scope } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { array, bad, choice, date, deny, integer, missing, required } from '../../../common/validate.js';
import { COVERAGE_HOURS } from '../../../common/catalog.js';
import { defaultResponseHours } from './settings.js';

const plantZone=equipmentId=>one('SELECT p.timezone FROM plants p JOIN equipment e ON e.plant_id=p.id WHERE e.id=?',equipmentId).timezone;
const canManageContract=(u,companyId)=>canManageCompany(u,companyId)||isDispatch(u);
const coveredIds=contractId=>all('SELECT equipment_id FROM contract_equipment WHERE contract_id=?',contractId).map(x=>x.equipment_id);
const hours=(v,name)=>integer(typeof v==='string'?Number(v):v,name,1,720);
const whole=(v,name,min,max)=>integer(typeof v==='string'?Number(v):v,name,min,max);
const contractNumber=v=>{ const n=required(v,'contractNumber',40).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._/-]*$/.test(n)) bad('Contract number may contain letters, digits, dot, dash, slash or underscore'); return n; };
// Zone-less visit times are local to the asset's plant; the visit must fall inside the contract period.
function visitTime(contract,v) {
  const dueAt=date(v.dueAt,'dueAt',plantZone(v.equipmentId));
  if (dueAt<contract.starts_at||dueAt>=contract.renews_at) bad('Visit must be within the contract period');
  return dueAt;
}
const withSchedule=c=>{ const days=Math.ceil((Date.parse(c.renews_at)-Date.now())/86400000); return {...c,daysToRenewal:days,renewalNoticeDue:c.status==='active'&&days<=c.notice_days,missing:[...(!c.contract_number?['Contract number']:[]),...(!c.response_hours?['Response target']:[])]}; };

// The active contract covering a ticket's asset when the ticket was raised.
export function coverageFor(t) {
  const c=one("SELECT c.id,c.title,c.contract_number,c.response_hours,c.restore_hours,c.coverage_hours,c.commitments,c.exclusions FROM contracts c JOIN contract_equipment ce ON ce.contract_id=c.id WHERE ce.equipment_id=? AND c.status='active' AND c.starts_at<=? AND c.renews_at>? ORDER BY c.starts_at DESC LIMIT 1",t.equipment_id,t.created_at,t.created_at);
  return c?{contractId:c.id,title:c.title,contractNumber:c.contract_number,responseHours:c.response_hours,restoreHours:c.restore_hours,coverageHours:c.coverage_hours,commitments:c.commitments,exclusions:c.exclusions}:null;
}
// Response target: the covering contract's, otherwise the platform default for the ticket's priority (Settings).
// Restore target (time to return the asset to service) applies only when the contract sets one.
export function responseTarget(t,coverage=coverageFor(t),at=Date.now()) {
  const responseHours=coverage?.responseHours??defaultResponseHours()[t.priority];
  const raised=Date.parse(t.created_at), due=raised+responseHours*3600000, responded=t.first_response_at?Date.parse(t.first_response_at):null;
  const out={responseHours,responseSource:coverage?.responseHours?'contract':'default',responseDueAt:new Date(due).toISOString(),responseBreached:responded!=null?responded>due:at>due,restoreDueAt:null,restoreBreached:false};
  if (coverage?.restoreHours) { const rdue=raised+coverage.restoreHours*3600000, done=t.completed_at?Date.parse(t.completed_at):null; out.restoreDueAt=new Date(rdue).toISOString(); out.restoreBreached=done!=null?done>rdue:at>rdue; }
  return out;
}

export function register(r) {
  r.get('/contracts',({u})=>scope(u,'contracts').map(c=>({...withSchedule(c),equipmentIds:coveredIds(c.id),visits:all('SELECT * FROM visits WHERE contract_id=? ORDER BY due_at',c.id)})));
  r.post('/contracts',({u,body})=>{
    const companyId=required(body.companyId,'companyId'); if (!canManageContract(u,companyId)) deny();
    const equipmentIds=array(body.equipmentIds,'equipmentIds'); if (!equipmentIds.length) bad('At least one covered asset is required');
    for (const key of equipmentIds) { const e=byId('equipment',key); if (!e||e.company_id!==companyId) bad('Covered asset belongs to another company'); }
    const contract={starts_at:date(body.startsAt,'startsAt'),renews_at:date(body.renewsAt,'renewsAt')}; if (contract.renews_at<=contract.starts_at) bad('Renewal must be after start');
    const visits=array(body.visits||[],'visits').map(v=>{ if (!equipmentIds.includes(v.equipmentId)) bad('Visit asset must be covered'); return {...v,dueAt:visitTime(contract,v)}; });
    const number=contractNumber(body.contractNumber); if (one('SELECT 1 FROM contracts WHERE company_id=? AND contract_number=?',companyId,number)) bad(`Contract number ${number} is already used for this company`);
    const responseHours=hours(body.responseHours,'responseHours'), restoreHours=body.restoreHours==null||body.restoreHours===''?null:hours(body.restoreHours,'restoreHours');
    if (restoreHours!=null&&restoreHours<responseHours) bad('Restore target cannot be shorter than the response target');
    const key=id();
    transaction(()=>{
      run('INSERT INTO contracts (id,company_id,title,starts_at,renews_at,commitments,exclusions,status,created_at,response_hours,contract_number,coverage_hours,restore_hours,visits_per_year,notice_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        key,companyId,required(body.title,'title',160),contract.starts_at,contract.renews_at,required(body.commitments,'commitments',2000),required(body.exclusions,'exclusions',2000),'active',now(),responseHours,number,choice(body.coverageHours,'coverageHours',COVERAGE_HOURS),restoreHours,whole(body.visitsPerYear,'visitsPerYear',0,52),whole(body.noticeDays,'noticeDays',0,365));
      for (const e of [...new Set(equipmentIds)]) run('INSERT INTO contract_equipment (contract_id,equipment_id) VALUES (?,?)',key,e);
      for (const v of visits) run('INSERT INTO visits (id,contract_id,company_id,equipment_id,due_at,status,notes) VALUES (?,?,?,?,?,?,?)',id(),key,companyId,v.equipmentId,v.dueAt,'scheduled',String(v.notes||'').slice(0,1000));
    });
    audit(u,'contract.create','contract',key,companyId); return created(withSchedule(byId('contracts',key)));
  });
  // Renewal: extend renewsAt (or lapse/cancel via status) and adjust terms; existing visits must stay in the period.
  r.patch('/contracts/:id',({u,body,params})=>{
    const c=byId('contracts',params.id); if (!c) missing(); if (!canManageContract(u,c.company_id)) deny();
    const renewsAt=body.renewsAt==null?c.renews_at:date(body.renewsAt,'renewsAt'); if (renewsAt<=c.starts_at) bad('Renewal must be after start');
    if (one("SELECT 1 FROM visits WHERE contract_id=? AND status='scheduled' AND due_at>=?",c.id,renewsAt)) bad('Scheduled visits fall after the new renewal date');
    const status=body.status==null?c.status:choice(body.status,'status',['active','expired','cancelled']);
    const responseHours=body.responseHours==null||body.responseHours===''?c.response_hours:hours(body.responseHours,'responseHours');
    const restoreHours=body.restoreHours===undefined?c.restore_hours:body.restoreHours===null||body.restoreHours===''?null:hours(body.restoreHours,'restoreHours');
    if (restoreHours!=null&&responseHours!=null&&restoreHours<responseHours) bad('Restore target cannot be shorter than the response target');
    let number=c.contract_number; if (body.contractNumber!=null) { number=contractNumber(body.contractNumber); if (one('SELECT 1 FROM contracts WHERE company_id=? AND contract_number=? AND id<>?',c.company_id,number,c.id)) bad(`Contract number ${number} is already used for this company`); }
    run('UPDATE contracts SET renews_at=?,status=?,response_hours=?,restore_hours=?,commitments=?,exclusions=?,contract_number=?,coverage_hours=?,visits_per_year=?,notice_days=? WHERE id=?',
      renewsAt,status,responseHours,restoreHours,body.commitments==null?c.commitments:required(body.commitments,'commitments',2000),body.exclusions==null?c.exclusions:required(body.exclusions,'exclusions',2000),number,
      body.coverageHours==null?c.coverage_hours:choice(body.coverageHours,'coverageHours',COVERAGE_HOURS),body.visitsPerYear==null||body.visitsPerYear===''?c.visits_per_year:whole(body.visitsPerYear,'visitsPerYear',0,52),body.noticeDays==null||body.noticeDays===''?c.notice_days:whole(body.noticeDays,'noticeDays',0,365),c.id);
    audit(u,'contract.update','contract',c.id,c.company_id,{renewsAt,status,responseHours}); return withSchedule(byId('contracts',c.id));
  });
  r.post('/contracts/:id/visits',({u,body,params})=>{
    const c=byId('contracts',params.id); if (!c) missing(); if (!canManageContract(u,c.company_id)) deny();
    if (c.status!=='active') bad('Visits can only be added to an active contract');
    if (!coveredIds(c.id).includes(body.equipmentId)) bad('Visit asset must be covered by this contract');
    const key=id(); run('INSERT INTO visits (id,contract_id,company_id,equipment_id,due_at,status,notes) VALUES (?,?,?,?,?,?,?)',key,c.id,c.company_id,body.equipmentId,visitTime(c,body),'scheduled',String(body.notes||'').slice(0,1000));
    audit(u,'visit.create','visit',key,c.company_id); return created(byId('visits',key));
  });
  r.patch('/visits/:id',({u,body,params})=>{
    const visit=byId('visits',params.id); if (!visit) missing(); if (!canManageContract(u,visit.company_id)) deny();
    const status=choice(body.status,'status',['scheduled','completed','cancelled']);
    run('UPDATE visits SET status=?,notes=? WHERE id=?',status,String(body.notes??visit.notes).slice(0,1000),visit.id);
    audit(u,'visit.update','visit',visit.id,visit.company_id,{status}); return byId('visits',visit.id);
  });
}
