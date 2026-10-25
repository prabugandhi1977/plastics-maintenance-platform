// Operator tablet and andon: station sign-in (code + short PIN, scoped to the station's machines), what operators record
// at the machine (downtime reasons, scrap, jobs and mould changes), andon calls with timed escalation, and the reports.
//
// Stations act as the system user ('u-system') in audit_events and tickets; the station, its name and the operator's
// name go in the detail, so every action is traceable to the tablet and the person at it.
import { randomInt } from 'node:crypto';
import { id, now, one, all, run, mapSeq } from '../../common/db.js';
import { hashPassword, verifyPassword, signScoped, verifyScoped, isCustomer, isPlatform } from '../../common/security.js';
import { audit, byId, ticketEvent, isDispatch } from '../../common/access.js';
import { HttpError, bad, choice, deny, missing, required, zonedToUtc } from '../../common/validate.js';
import { PRODUCTION_MACHINES, DOWNTIME_REASONS, DEFECT_TYPES, MACHINE_STATES, codes } from '../../common/catalog.js';
import { raiseAlert, resolveAlertKey, notifyRoles } from './alerts.js';
import { recordState, stateAlerts, machineOee, currentProduct, plantOf } from './production.js';
import { currentShift, localDate } from './time.js';

export const SYSTEM={id:'u-system'};
const MIN=60000, HOUR=3600000;
export const ANDON_TYPES=['maintenance','quality','material','supervisor','safety'];
export const NOTIFY_ROLES=['maintenance','plant_manager','customer_admin','dispatcher'];
// Defaults: who is called first, and who next when nobody has acknowledged after the given minutes. Safety is always
// critical. Companies change these under Production › Andon › Escalation.
export const DEFAULT_ANDON={
  maintenance:{severity:'warning',notify:['maintenance'],escalation:[{afterMinutes:5,roles:['plant_manager']},{afterMinutes:15,roles:['customer_admin','dispatcher']}]},
  quality:{severity:'warning',notify:['plant_manager'],escalation:[{afterMinutes:10,roles:['customer_admin']}]},
  material:{severity:'warning',notify:['plant_manager'],escalation:[{afterMinutes:10,roles:['customer_admin']}]},
  supervisor:{severity:'warning',notify:['plant_manager'],escalation:[{afterMinutes:5,roles:['customer_admin']}]},
  safety:{severity:'critical',notify:['plant_manager','customer_admin','maintenance'],escalation:[{afterMinutes:2,roles:['dispatcher']}]}
};
// Scrap reasons offered on the tablet: the defects cameras classify for the process, plus start-up scrap and other.
export const scrapReasons=e=>[...(DEFECT_TYPES[e.machine_type]||[]),'start_up_scrap','material_contamination','other'];
const AUTOMATIC=['simulator','device'];
const STOP_STATES=Object.keys(DOWNTIME_REASONS);

// ---------- Stations: codes, PINs, tokens ----------
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normCode=v=>String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
export async function newStationCode() {
  for (;;) { const code=Array.from({length:8},()=>CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''); if (!await one('SELECT 1 FROM operator_stations WHERE code=?',code)) return code; }
}
// 4-8 digits, not one repeated digit and not a run like 1234 or 9876 (the first PINs anyone tries).
export function validPin(v) {
  const pin=typeof v==='number'?String(v):v;
  if (typeof pin!=='string'||!/^\d{4,8}$/.test(pin)) bad('PIN must be 4 to 8 digits');
  const d=[...pin].map(Number), step=d[1]-d[0];
  if (new Set(d).size===1||(Math.abs(step)===1&&d.every((x,i)=>i===0||x-d[i-1]===step))) bad('Choose a PIN that is not one repeated digit or a simple sequence like 1234');
  return pin;
}
export const hashPin=pin=>hashPassword(pin);
export const MAX_PIN_FAILURES=5, LOCK_MS=15*MIN;
const TOKEN_HOURS={tablet:12,board:24*30};
export function stationToken(s) {
  const payload=Buffer.from(JSON.stringify({st:s.id,sv:s.session_version,exp:Date.now()+TOKEN_HOURS[s.kind]*HOUR})).toString('base64url');
  return `st1.${payload}.${signScoped('station',payload)}`;
}
// The station behind a request's bearer token, with the machines it may act on; null for any other token.
export async function authenticateStation(req) {
  const token=(req.headers.authorization||'').replace(/^Bearer /,''); const [kind,payload,signature]=token.split('.');
  if (kind!=='st1'||!payload||!signature||!verifyScoped('station',payload,signature)) return null;
  try {
    const claims=JSON.parse(Buffer.from(payload,'base64url').toString()); if (claims.exp<Date.now()) return null;
    const s=await one('SELECT * FROM operator_stations WHERE id=? AND active=1',claims.st);
    if (!s||s.session_version!==claims.sv) return null;
    return {...s,machineIds:await stationMachineIds(s)};
  } catch { return null; }
}
async function stationMachineIds(s) {
  if (s.kind==='board') return (await all(`SELECT id FROM equipment WHERE plant_id=? AND company_id=? AND status<>'decommissioned' AND machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,s.plant_id,s.company_id,...PRODUCTION_MACHINES)).map(r=>r.id);
  return (await all('SELECT m.equipment_id FROM operator_station_machines m JOIN equipment e ON e.id=m.equipment_id WHERE m.station_id=? ORDER BY e.asset_tag',s.id)).map(r=>r.equipment_id);
}
export const stationOut=async s=>({id:s.id,companyId:s.company_id,plantId:s.plant_id,plantName:(await byId('plants',s.plant_id))?.name||'',name:s.name,kind:s.kind,code:s.code,active:!!s.active,
  locked:!!(s.locked_until&&s.locked_until>now()),lockedUntil:s.locked_until&&s.locked_until>now()?s.locked_until:null,failedAttempts:s.failed_attempts,lastLoginAt:s.last_login_at,createdAt:s.created_at,
  equipmentIds:s.kind==='board'?[]:(await all('SELECT equipment_id FROM operator_station_machines WHERE station_id=?',s.id)).map(r=>r.equipment_id)});

// Who did it: a person signed in, or a station (as the system user, with the station and operator named).
export function actorOf({u,station,body}) {
  const operator=typeof body?.operator==='string'?body.operator.trim().slice(0,80):'';
  if (station) return {user:SYSTEM,stationId:station.id,operator,name:operator||station.name,detail:{via:'station',stationId:station.id,station:station.name,...(operator?{operator}:{})}};
  return {user:u,stationId:null,operator:operator||u.name,name:u.name,detail:operator&&operator!==u.name?{operator}:{}};
}
// Users who may see and act on a company's shop floor: its own staff and the platform's internal team.
export const canFloor=(u,companyId)=>isDispatch(u)||(isCustomer(u)&&u.company_id===companyId);
export const canManageFloor=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);

// A production machine the caller may act on: a tablet only on its own machines, a person within their company.
export async function machineFor(ctx,equipmentId,{write=false}={}) {
  const e=await byId('equipment',equipmentId); if (!e||!PRODUCTION_MACHINES.includes(e.machine_type)||e.status==='decommissioned') missing();
  if (ctx.station) { if (!ctx.station.machineIds.includes(e.id)||(write&&ctx.station.kind!=='tablet')) deny(); }
  else if (!canFloor(ctx.u,e.company_id)) deny();
  return e;
}
// Machines visible to the caller (optionally one plant).
export async function machinesOf(ctx,plantId=null) {
  if (ctx.station) return ctx.station.machineIds.length?await all(`SELECT * FROM equipment WHERE id IN (${ctx.station.machineIds.map(()=>'?').join(',')}) ORDER BY asset_tag`,...ctx.station.machineIds):[];
  const u=ctx.u, where=[`machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,"status<>'decommissioned'"], args=[...PRODUCTION_MACHINES];
  if (!isDispatch(u)) { if (!isCustomer(u)) return []; where.push('company_id=?'); args.push(u.company_id); }
  if (plantId) { where.push('plant_id=?'); args.push(plantId); }
  return await all(`SELECT * FROM equipment WHERE ${where.join(' AND ')} ORDER BY asset_tag`,...args);
}

// ---------- Andon settings ----------
export async function andonSettings(companyId) {
  const row=await one('SELECT config FROM andon_settings WHERE company_id=?',companyId); let saved={};
  try { saved=row?JSON.parse(row.config):{}; } catch { saved={}; }
  return Object.fromEntries(ANDON_TYPES.map(t=>[t,{...DEFAULT_ANDON[t],...(saved[t]||{}),...(t==='safety'?{severity:'critical'}:{})}]));
}
export function settingsBody(input) {
  if (!input||typeof input!=='object'||Array.isArray(input)) bad('types must be an object of andon type → settings');
  const roles=(v,name,min=1)=>{ if (!Array.isArray(v)||v.length<min||v.some(r=>!NOTIFY_ROLES.includes(r))) bad(`${name} must list ${min?'at least one of':'only'}: ${NOTIFY_ROLES.join(', ')}`); return [...new Set(v)]; };
  const out={};
  for (const [type,c] of Object.entries(input)) {
    choice(type,'andon type',ANDON_TYPES); if (!c||typeof c!=='object') bad(`${type}: settings must be an object`);
    const escalation=c.escalation==null?[]:c.escalation; if (!Array.isArray(escalation)||escalation.length>3) bad(`${type}: at most 3 escalation levels`);
    let last=0; const levels=escalation.map((l,i)=>{ const m=l?.afterMinutes; if (!Number.isInteger(m)||m<1||m>1440) bad(`${type}: escalation level ${i+1} needs afterMinutes from 1 to 1440`); if (m<=last) bad(`${type}: each escalation level must come later than the one before`); last=m; return {afterMinutes:m,roles:roles(l.roles,`${type} level ${i+1} roles`)}; });
    out[type]={severity:type==='safety'?'critical':choice(c.severity??'warning',`${type} severity`,['warning','critical']),notify:roles(c.notify,`${type} notify`),escalation:levels};
  }
  return out;
}

// ---------- Machine view for the tablet ----------
const iso=ms=>new Date(ms).toISOString();
const minutesBetween=(a,b)=>a&&b?Math.round((Date.parse(b)-Date.parse(a))/MIN*10)/10:null;
export async function openState(e) { return await one('SELECT * FROM machine_states WHERE equipment_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',e.id); }
const isManual=st=>!st||!AUTOMATIC.includes(st.source);
export async function todayCounts(e,plant) {
  const start=zonedToUtc(`${localDate(Date.now(),plant.timezone)}T00:00`,plant.timezone);
  const r=await one('SELECT COALESCE(sum(total_qty),0) t,COALESCE(sum(scrap_qty),0) s FROM production_counts WHERE equipment_id=? AND period_start>=?',e.id,start);
  return {total:r.t,scrap:r.s,good:r.t-r.s};
}
export const callView=async c=>{
  const e=await byId('equipment',c.equipment_id), end=c.resolved_at||now();
  return {id:c.id,companyId:c.company_id,plantId:c.plant_id,equipmentId:c.equipment_id,assetTag:e?.asset_tag||'',machine:e?`${e.make} ${e.model}`:'',stationId:c.station_id,type:c.call_type,severity:c.severity,status:c.status,level:c.level,note:c.note,
    machineState:c.machine_state,machineReason:c.machine_reason,operator:c.operator_name,raisedAt:c.raised_at,shift:c.shift_name,shiftDate:c.shift_date,escalatedAt:c.escalated_at,
    acknowledgedAt:c.acknowledged_at,acknowledgedBy:c.acknowledged_name,resolvedAt:c.resolved_at,resolution:c.resolution,ticketId:c.ticket_id,alertId:c.alert_id,
    responseMinutes:minutesBetween(c.raised_at,c.acknowledged_at),resolveMinutes:minutesBetween(c.raised_at,c.resolved_at),openMinutes:minutesBetween(c.raised_at,end)};
};
export async function machineView(e) {
  const plant=await plantOf(e), st=await openState(e), product=await currentProduct(e), shift=await currentShift(plant);
  const o=shift?await machineOee(e,shift.start,Math.min(shift.end,Date.now()),plant):null;
  const job=await one("SELECT * FROM operator_jobs WHERE equipment_id=? AND kind='job' AND ended_at IS NULL",e.id), mc=await one("SELECT * FROM operator_jobs WHERE equipment_id=? AND kind='mould_change' AND ended_at IS NULL",e.id);
  // Cycle time: the ideal from the product, the actual from the shift's speed (ideal ÷ performance).
  const idealCycle=product.unit==='parts'&&product.ideal_cycle_s?product.ideal_cycle_s:null, perf=o?.performance;
  const since=Date.now()-12*HOUR;
  const stops=(await all("SELECT s.*,(SELECT max(created_at) FROM operator_events oe WHERE oe.state_id=s.id AND oe.kind='downtime') classified_at FROM machine_states s WHERE s.equipment_id=? AND s.state IN ('down','idle','setup','planned_stop') AND COALESCE(s.reason_code,'')<>'no_production_planned' AND (s.ended_at IS NULL OR s.ended_at>?) ORDER BY s.started_at DESC LIMIT 15",e.id,iso(since)))
    .map(s=>({id:s.id,state:s.state,reason:s.reason_code,startedAt:s.started_at,endedAt:s.ended_at,minutes:minutesBetween(s.started_at,s.ended_at||now()),source:s.source,classified:!!s.classified_at,open:!s.ended_at}));
  const calls=await mapSeq(await all("SELECT * FROM andon_calls WHERE equipment_id=? AND status<>'resolved' ORDER BY raised_at",e.id),callView);
  const pct=x=>x==null?null:Math.round(x*1000)/10;
  return {machine:{id:e.id,assetTag:e.asset_tag,make:e.make,model:e.model,machineType:e.machine_type,location:e.location,companyId:e.company_id,plantId:e.plant_id,plantName:plant.name,timezone:plant.timezone},
    state:{state:st?.state||'offline',reason:st?.reason_code||null,since:st?.started_at||null,stateId:st?.id||null,source:st?.source||null,manual:isManual(st)},
    product:{id:product.id,partNumber:product.part_number||null,name:product.name,unit:product.unit,idealCycleS:idealCycle,cavities:product.cavities||null,idealRatePerHour:product.ideal_rate_per_hour},
    job:job?{id:job.id,startedAt:job.started_at,productId:job.product_id}:null,mouldChange:mc?{id:mc.id,startedAt:mc.started_at,minutes:minutesBetween(mc.started_at,now())}:null,
    cycle:{idealS:idealCycle,actualS:idealCycle&&perf?Math.round(idealCycle/perf*10)/10:null,idealRate:product.ideal_rate_per_hour,actualRate:perf!=null?Math.round(product.ideal_rate_per_hour*perf*10)/10:null},
    today:{...await todayCounts(e,plant),unit:product.unit},
    shift:shift?{name:shift.name,start:iso(shift.start),end:iso(shift.end),oee:pct(o?.oee),availability:pct(o?.availability),performance:pct(o?.performance),quality:pct(o?.quality),good:o?.good??0,scrap:o?.scrap??0}:null,
    stops,calls,reasons:DOWNTIME_REASONS,scrapReasons:scrapReasons(e),andonTypes:ANDON_TYPES,
    products:(await all('SELECT id,part_number,name,unit FROM products WHERE company_id=? AND active=1 ORDER BY part_number',e.company_id)).map(p=>({id:p.id,partNumber:p.part_number,name:p.name,unit:p.unit}))};
}

// ---------- Operator entries ----------
async function operatorEvent(e,actor,{kind,state=null,reason=null,quantity=null,stateId=null,productId=null,note=''}) {
  const plant=await plantOf(e), shift=await currentShift(plant), key=id();
  await run('INSERT INTO operator_events (id,company_id,plant_id,equipment_id,station_id,kind,state,reason,quantity,state_id,product_id,note,operator_name,created_by,shift_name,shift_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    key,e.company_id,e.plant_id,e.id,actor.stationId,kind,state,reason,quantity,stateId,productId,String(note||'').slice(0,500),actor.operator||'',actor.user.id,shift?.name||null,shift?.date||null,now());
  await audit(actor.user,`operator.${kind}`,'equipment',e.id,e.company_id,{...actor.detail,...(state?{state}:{}),...(reason?{reason}:{}),...(quantity!=null?{quantity}:{}),...(stateId?{stateId}:{}),...(productId?{productId}:{})});
  return key;
}
const noteOf=v=>v==null||v===''?'':typeof v==='string'&&v.length<=500?v.trim():bad('note must be text of at most 500 characters');
// Downtime reason. Machines with machine data (PLC or simulator) are not overruled: the operator classifies a stop
// they reported (the current one, or one from the last 12 hours by stateId). A machine without machine data is
// stopped by the operator here and started again with resume.
export async function recordDowntime(e,body,actor) {
  const state=choice(body.state,'state',STOP_STATES), reason=choice(body.reason,'reason',DOWNTIME_REASONS[state]), note=noteOf(body.note);
  let target;
  if (body.stateId!=null) {
    target=await one('SELECT * FROM machine_states WHERE id=? AND equipment_id=?',String(body.stateId),e.id); if (!target) bad('Unknown stop for this machine');
    if (target.ended_at&&target.ended_at<iso(Date.now()-12*HOUR)) bad('Stops can be classified for 12 hours after they end');
  } else target=await openState(e);
  if (target&&!['running','offline'].includes(target.state)) {
    if (target.state==='planned_stop'&&target.reason_code==='no_production_planned') bad('No production is planned now; there is no stop to classify');
    await run('UPDATE machine_states SET state=?,reason_code=? WHERE id=?',state,reason,target.id);
  } else {
    if (body.stateId!=null) bad('That interval is not a stop');
    const open=await openState(e);
    if (!isManual(open)) throw new HttpError(409,'The machine data shows this machine running. Choose the stop to classify from the list, or raise an andon call.');
    const at=now(), change=await recordState(e,state,reason,at,'operator'); await stateAlerts(e,state,reason,change,at);
    target=await openState(e);
  }
  await operatorEvent(e,actor,{kind:'downtime',state,reason,stateId:target.id,note});
  return target.id;
}
export async function resumeMachine(e,actor) {
  const open=await openState(e);
  if (!isManual(open)) throw new HttpError(409,'This machine reports its own state; it shows running again when the machine data does.');
  if (open?.state==='running') bad('The machine is already running');
  const at=now(), change=await recordState(e,'running',null,at,'operator'); await stateAlerts(e,'running',null,change,at);
  await audit(actor.user,'operator.resume','equipment',e.id,e.company_id,actor.detail);
}
// Scrap found after the machine counted the parts as good: stored as a production count with no output, so OEE quality
// and the scrap reports include it. It cannot exceed today's good output.
export async function recordScrap(e,body,actor) {
  const reason=choice(body.reason,'reason',scrapReasons(e)), note=noteOf(body.note), q=typeof body.quantity==='string'?Number(body.quantity):body.quantity;
  const product=await currentProduct(e);
  if (!Number.isFinite(q)||q<=0||q>1000000||(product.unit==='parts'&&!Number.isInteger(q))) bad(product.unit==='parts'?'quantity must be a whole number of parts above 0':'quantity must be a number above 0');
  const today=await todayCounts(e,await plantOf(e)); if (q>today.good) bad(`Scrap cannot be more than today's good output so far (${Math.round(today.good*10)/10} ${product.unit})`);
  let at=Date.now(); while (await one('SELECT 1 FROM production_counts WHERE equipment_id=? AND period_start=?',e.id,iso(at))) at++;
  await run('INSERT INTO production_counts (id,company_id,equipment_id,product_id,period_start,period_minutes,total_qty,scrap_qty,unit,ideal_rate_per_hour,source) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id(),e.company_id,e.id,product.id,iso(at),1,0,q,product.unit,product.ideal_rate_per_hour,'operator');
  return await operatorEvent(e,actor,{kind:'scrap',reason,quantity:q,productId:product.id,note});
}
// Jobs and mould changes. Starting a job sets the product the machine makes (and is measured against); a mould change
// ends the running job and, when finished, can start the next one.
export async function jobAction(e,body,actor) {
  const action=choice(body.action,'action',['start','finish']), kind=choice(body.kind??'job','kind',['job','mould_change']), at=now();
  const open=async k=>await one('SELECT * FROM operator_jobs WHERE equipment_id=? AND kind=? AND ended_at IS NULL',e.id,k);
  const product=async ()=>{ const p=await byId('products',required(body.productId,'productId',100)); if (!p||p.company_id!==e.company_id||!p.active) bad('productId must be an active product of this company'); return p; };
  const close=async (j)=>{ await run('UPDATE operator_jobs SET ended_at=?,ended_by=? WHERE id=?',at,actor.user.id,j.id); await operatorEvent(e,actor,{kind:`${j.kind}_finish`,productId:j.product_id}); };
  const startJob=async p=>{ const j=await open('job'); if (j) await close(j); await run('INSERT INTO operator_jobs (id,company_id,equipment_id,kind,product_id,started_at,started_by) VALUES (?,?,?,?,?,?,?)',id(),e.company_id,e.id,'job',p.id,at,actor.user.id); await operatorEvent(e,actor,{kind:'job_start',productId:p.id}); };
  const st=await openState(e);
  if (kind==='job') {
    if (action==='start') return await startJob(await product());
    const j=await open('job'); if (!j) bad('No job is running on this machine'); return await close(j);
  }
  if (action==='start') {
    if (await open('mould_change')) bad('A mould change is already in progress');
    const j=await open('job'); if (j) await close(j);
    await run('INSERT INTO operator_jobs (id,company_id,equipment_id,kind,product_id,started_at,started_by) VALUES (?,?,?,?,?,?,?)',id(),e.company_id,e.id,'mould_change',null,at,actor.user.id);
    if (isManual(st)) { const change=await recordState(e,'setup','mould_change',at,'operator'); await stateAlerts(e,'setup','mould_change',change,at); }
    else if (st&&!['running','offline'].includes(st.state)) await run("UPDATE machine_states SET state='setup',reason_code='mould_change' WHERE id=?",st.id);
    return await operatorEvent(e,actor,{kind:'mould_change_start',stateId:st?.id||null});
  }
  const mc=await open('mould_change'); if (!mc) bad('No mould change is in progress');
  const next=body.productId?await product():null;
  await close(mc);
  if (next) await startJob(next);
  if (isManual(st)) { const change=await recordState(e,'running',null,at,'operator'); await stateAlerts(e,'running',null,change,at); }
}

// ---------- Andon calls ----------
const machineText=e=>[e.asset_tag,e.make,e.model].filter(Boolean).join(' ');
const typeText=t=>t.charAt(0).toUpperCase()+t.slice(1);
export async function raiseAndon(e,body,actor) {
  const type=choice(body.type,'type',ANDON_TYPES), note=noteOf(body.note);
  // A second tap (or a second operator) on the same call type joins the open call instead of raising another.
  const existing=await one("SELECT * FROM andon_calls WHERE equipment_id=? AND call_type=? AND status<>'resolved'",e.id,type);
  if (existing) return {call:existing,created:false};
  const cfg=(await andonSettings(e.company_id))[type], plant=await plantOf(e), shift=await currentShift(plant), st=await openState(e), at=now(), key=id();
  const title=`Andon: ${type} call at ${e.asset_tag||e.model}`, detail=`${machineText(e)} (${plant.name}${e.location?', '+e.location:''}): ${typeText(type)} help requested${actor.operator?` by ${actor.operator}`:''} at ${at}${note?`: ${note}`:''}. Machine ${st?.state||'offline'}${st?.reason_code?` (${st.reason_code.replaceAll('_',' ')})`:''}.`;
  const alertId=await raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'andon',severity:cfg.severity,equipmentId:e.id,title,detail,dedupeKey:`andon:${key}`,at,notify:false});
  await run('INSERT INTO andon_calls (id,company_id,plant_id,equipment_id,station_id,call_type,severity,status,level,note,machine_state,machine_reason,operator_name,raised_by,raised_at,shift_name,shift_date,alert_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    key,e.company_id,e.plant_id,e.id,actor.stationId,type,cfg.severity,'open',0,note,st?.state||'offline',st?.reason_code||null,actor.operator||'',actor.user.id,at,shift?.name||null,shift?.date||null,alertId);
  const sent=alertId?await notifyRoles(await byId('alerts',alertId),cfg.notify):{emails:0,whatsapp:0};
  await audit(actor.user,'andon.raise','andon_call',key,e.company_id,{...actor.detail,type,severity:cfg.severity,equipmentId:e.id,notified:cfg.notify,...sent});
  return {call:await byId('andon_calls',key),created:true};
}
// Escalation (run every minute): an open call nobody has acknowledged moves up one level for each level whose minutes
// have passed, notifying that level's roles and turning critical. Acknowledging stops it.
export async function checkAndonEscalations(at=Date.now()) {
  let n=0; const settings={};
  for (const c of await all("SELECT * FROM andon_calls WHERE status='open' ORDER BY raised_at")) {
    const levels=(settings[c.company_id]??=await andonSettings(c.company_id))[c.call_type].escalation, elapsed=(at-Date.parse(c.raised_at))/MIN;
    const target=levels.filter(l=>l.afterMinutes<=elapsed).length; if (target<=c.level) continue;
    const e=await byId('equipment',c.equipment_id), stamp=iso(at);
    for (let level=c.level+1; level<=target; level++) {
      await run("UPDATE andon_calls SET level=?,escalated_at=?,severity='critical' WHERE id=?",level,stamp,c.id);
      let sent={emails:0,whatsapp:0};
      if (c.alert_id) { await run("UPDATE alerts SET severity='critical',title=? WHERE id=?",`Andon escalated (level ${level}): ${c.call_type} call at ${e.asset_tag||e.model}, ${Math.floor(elapsed)} min without response`.slice(0,200),c.alert_id); sent=await notifyRoles(await byId('alerts',c.alert_id),levels[level-1].roles); }
      await audit(SYSTEM,'andon.escalate','andon_call',c.id,c.company_id,{level,afterMinutes:levels[level-1].afterMinutes,notified:levels[level-1].roles,...sent}); n++;
    }
  }
  return n;
}
// A call the caller may act on: a tablet only on its own machines' calls (a board never), a person within their company.
export async function callFor(ctx,key) {
  const c=await byId('andon_calls',key); if (!c) missing();
  if (ctx.station) { if (ctx.station.kind!=='tablet'||!ctx.station.machineIds.includes(c.equipment_id)) deny(); }
  else if (!canFloor(ctx.u,c.company_id)) deny();
  return c;
}
export async function acknowledgeCall(c,actor,{at=now()}={}) {
  if (c.status!=='open') bad(`This call is already ${c.status}`);
  await run("UPDATE andon_calls SET status='acknowledged',acknowledged_at=?,acknowledged_by=?,acknowledged_name=? WHERE id=?",at,actor.user.id,actor.name,c.id);
  if (c.alert_id) await run("UPDATE alerts SET status='acknowledged',acknowledged_by=?,acknowledged_at=? WHERE id=? AND status='open'",actor.user.id,at,c.alert_id);
  await audit(actor.user,'andon.acknowledge','andon_call',c.id,c.company_id,{...actor.detail,responseMinutes:minutesBetween(c.raised_at,at)});
}
export async function resolveCall(c,body,actor,{at=now()}={}) {
  if (c.status==='resolved') bad('This call is already resolved');
  const resolution=body.resolution==null||body.resolution===''?'':required(body.resolution,'resolution',500);
  // Resolving without a separate acknowledgement counts the response at the same moment.
  await run("UPDATE andon_calls SET status='resolved',resolved_at=?,resolved_by=?,resolution=?,acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_name=COALESCE(acknowledged_name,?) WHERE id=?",at,actor.user.id,resolution,at,actor.user.id,actor.name,c.id);
  await resolveAlertKey(`andon:${c.id}`,at);
  await audit(actor.user,'andon.resolve','andon_call',c.id,c.company_id,{...actor.detail,resolveMinutes:minutesBetween(c.raised_at,at)});
}
// Alerts page: acknowledging or resolving an andon alert there does the same to its call.
export async function alertChanged(alert,status,u) {
  if (alert.module!=='andon') return;
  const c=await one('SELECT * FROM andon_calls WHERE alert_id=?',alert.id); if (!c||c.status==='resolved') return;
  const actor={user:u,stationId:null,operator:u.name,name:u.name,detail:{via:'alert'}};
  if (status==='acknowledged'&&c.status==='open') await run("UPDATE andon_calls SET status='acknowledged',acknowledged_at=?,acknowledged_by=?,acknowledged_name=? WHERE id=?",now(),u.id,u.name,c.id);
  if (status==='resolved') await run("UPDATE andon_calls SET status='resolved',resolved_at=?,resolved_by=?,acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_name=COALESCE(acknowledged_name,?) WHERE id=?",now(),u.id,now(),u.id,u.name,c.id);
  await audit(u,`andon.${status==='resolved'?'resolve':'acknowledge'}`,'andon_call',c.id,c.company_id,actor.detail);
}
// One tap: a maintenance call becomes a breakdown ticket with the machine, its state and the call time filled in.
const CATEGORY_BY_REASON={mould_fault:'tooling',auxiliary_fault:'other',power_failure:'electrical',breakdown:'mechanical',quality_stop:'other'};
export async function ticketFromCall(c,body,actor) {
  if (c.call_type!=='maintenance') bad('Only maintenance calls become breakdown tickets');
  if (c.ticket_id) return {ticketId:c.ticket_id,created:false};
  const e=await byId('equipment',c.equipment_id), plant=await plantOf(e), st=await openState(e), stamp=now();
  const state=st?.state||c.machine_state||'offline', reason=st?.reason_code||c.machine_reason, stopped=state!=='running';
  const categories=await codes('failure_categories'), guess=CATEGORY_BY_REASON[reason];
  const category=body.failureCategory!=null?choice(body.failureCategory,'failureCategory',categories):categories.includes(guess)?guess:categories.includes('other')?'other':categories[0];
  const priority=body.priority!=null?choice(body.priority,'priority',['low','medium','high','critical']):stopped?'high':'medium';
  const machineState=body.machineState!=null?choice(body.machineState,'machineState',MACHINE_STATES):stopped?'stopped':'running';
  const title=body.title!=null?required(body.title,'title',160):`Andon: ${e.asset_tag||e.model} ${reason?reason.replaceAll('_',' '):'maintenance call'}`.slice(0,160);
  const symptoms=body.symptoms!=null?required(body.symptoms,'symptoms',3000):`${c.note||'Maintenance help requested at the machine by andon.'}${c.operator_name?` (operator: ${c.operator_name})`:''}`;
  const impact=stopped?`Machine ${state.replaceAll('_',' ')}${reason?` (${reason.replaceAll('_',' ')})`:''} since ${st?.started_at||c.raised_at}`:'Machine running; maintenance requested by the operator';
  const key=id();
  await run('INSERT INTO tickets (id,company_id,plant_id,equipment_id,title,priority,symptoms,error_codes,production_impact,status,created_by,created_at,downtime_minutes,failure_category,machine_state,safety_issue,occurred_at,raised_via) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    key,e.company_id,plant.id,e.id,title,priority,symptoms,'',impact,'open',actor.user.id,stamp,0,category,machineState,0,c.raised_at,'andon');
  await ticketEvent(key,actor.user,'andon',`Raised from andon call (${c.call_type}, ${c.raised_at})${actor.stationId?` at station ${actor.detail.station}`:''}${actor.operator?` by ${actor.operator}`:''}`,stamp);
  await run('UPDATE andon_calls SET ticket_id=? WHERE id=?',key,c.id);
  if (c.alert_id) await run('UPDATE alerts SET ticket_id=? WHERE id=?',key,c.alert_id);
  if (c.status==='open') await acknowledgeCall({...c,ticket_id:key},actor,{at:stamp});
  await audit(actor.user,'ticket.create','ticket',key,e.company_id,{...actor.detail,priority,raisedVia:'andon',andonCallId:c.id});
  return {ticketId:key,created:true};
}

// ---------- Board and reports ----------
export async function boardFor(machines,plant) {
  const shift=await currentShift(plant);
  const tiles=await mapSeq(machines,async e=>{
    const st=await openState(e), product=await currentProduct(e), o=shift?await machineOee(e,shift.start,Math.min(shift.end,Date.now()),plant):null;
    const calls=(await all("SELECT id,call_type,severity,status,level,raised_at,acknowledged_at,acknowledged_name FROM andon_calls WHERE equipment_id=? AND status<>'resolved' ORDER BY raised_at",e.id))
      .map(c=>({id:c.id,type:c.call_type,severity:c.severity,status:c.status,level:c.level,raisedAt:c.raised_at,acknowledgedAt:c.acknowledged_at,acknowledgedBy:c.acknowledged_name}));
    return {id:e.id,assetTag:e.asset_tag,name:`${e.make} ${e.model}`,location:e.location,state:st?.state||'offline',reason:st?.reason_code||null,since:st?.started_at||null,
      product:product.part_number||product.name,oee:o?.oee==null?null:Math.round(o.oee*1000)/10,good:o?.good??0,scrap:o?.scrap??0,unit:product.unit,calls};
  });
  return {plant:{id:plant.id,name:plant.name,timezone:plant.timezone},shift:shift?{name:shift.name,start:iso(shift.start),end:iso(shift.end)}:null,at:now(),tiles};
}
const mean=xs=>{ const v=xs.filter(x=>x!=null); return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length*10)/10:null; };
const groupStats=(calls,keyOf)=>{ const g={}; for (const c of calls) (g[keyOf(c)]??=[]).push(c);
  return Object.entries(g).map(([key,list])=>({key,count:list.length,open:list.filter(c=>c.status!=='resolved').length,escalated:list.filter(c=>c.level>0).length,meanResponseMinutes:mean(list.map(c=>c.responseMinutes)),meanResolveMinutes:mean(list.map(c=>c.resolveMinutes))})).sort((a,b)=>b.count-a.count); };
export async function andonReport(companyIds,{plantId=null,from,to}) {
  if (!companyIds.length) return {total:{count:0},byType:[],byMachine:[],byShift:[],downtime:[],scrap:[]};
  const where=`company_id IN (${companyIds.map(()=>'?').join(',')})${plantId?' AND plant_id=?':''}`, args=[...companyIds,...(plantId?[plantId]:[])], range=[iso(from),iso(to)];
  const calls=await mapSeq(await all(`SELECT * FROM andon_calls WHERE ${where} AND raised_at>=? AND raised_at<? ORDER BY raised_at DESC`,...args,...range),callView);
  // Downtime Pareto from operator entries: each stop counted once, with the reason the operator gave last.
  const stops=await all(`SELECT DISTINCT ON (oe.state_id) oe.state_id,s.state,s.reason_code,s.started_at,s.ended_at FROM operator_events oe JOIN machine_states s ON s.id=oe.state_id WHERE oe.${where.replaceAll(' AND plant_id',' AND oe.plant_id')} AND oe.kind='downtime' AND oe.created_at>=? AND oe.created_at<? ORDER BY oe.state_id,oe.created_at DESC`,...args,...range);
  const pareto={}; for (const s of stops) { const k=`${s.state}:${s.reason_code}`, p=pareto[k]??={state:s.state,reason:s.reason_code,stops:0,minutes:0}; p.stops++; p.minutes+=Math.max(0,(Date.parse(s.ended_at||now())-Date.parse(s.started_at))/MIN); }
  const downtime=Object.values(pareto).map(p=>({...p,minutes:Math.round(p.minutes)})).sort((a,b)=>b.minutes-a.minutes);
  let cum=0; const totalMin=downtime.reduce((n,p)=>n+p.minutes,0); for (const p of downtime) { cum+=p.minutes; p.cumulativePct=totalMin?Math.round(cum/totalMin*1000)/10:null; }
  const scrap=(await all(`SELECT reason,count(*) entries,sum(quantity) quantity FROM operator_events WHERE ${where} AND kind='scrap' AND created_at>=? AND created_at<? GROUP BY reason ORDER BY sum(quantity) DESC`,...args,...range)).map(r=>({reason:r.reason,entries:r.entries,quantity:r.quantity}));
  const machineLabel=Object.fromEntries(calls.map(c=>[c.equipmentId,c.assetTag||c.machine]));
  return {from:iso(from),to:iso(to),total:{count:calls.length,open:calls.filter(c=>c.status!=='resolved').length,escalated:calls.filter(c=>c.level>0).length,meanResponseMinutes:mean(calls.map(c=>c.responseMinutes)),meanResolveMinutes:mean(calls.map(c=>c.resolveMinutes))},
    byType:groupStats(calls,c=>c.type).map(g=>({type:g.key,...g})),byMachine:groupStats(calls,c=>c.equipmentId).map(g=>({equipmentId:g.key,assetTag:machineLabel[g.key],...g})),byShift:groupStats(calls,c=>c.shift||'—').map(g=>({shift:g.key,...g})),
    downtime,scrap,calls:calls.slice(0,200)};
}
