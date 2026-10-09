// Smart factory: live floor, OEE analytics, products, shifts, alerts, machine-data intake and the simulator.
import { recordReadings } from '../../traceability/traceability.js';
import { timingSafeEqual } from 'node:crypto';
import { id, now, one, all, run, transaction, mapSeq } from '../../../common/db.js';
import { isCustomer, isPlatform } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { HttpError, bad, choice, deny, instant, missing, required, array } from '../../../common/validate.js';
import { PRODUCTION_MACHINES, LIVE_STATES, DOWNTIME_REASONS, PRODUCT_UNITS, CONDITION_PARAMETERS, parametersFor, DEFECT_TYPES, SAFETY_EVENTS } from '../../../common/catalog.js';
import { recordCondition, machineHealth, trend, limitsFor } from '../condition.js';
import { machineInsights, oeeInsights, shiftForecast } from '../../ml/insights.js';
import { scoreMachine, mlConfigured } from '../../ml/remote.js';
import { assessScrap, explainScrap } from '../../ml/quality.js';
import { explainMachine, aiHttpError } from '../../ml/explain.js';
import { recordEnergy, energyReport } from '../energy.js';
import { recordState, recordCount, machineOee, combine, dailyOee, lossList, currentProduct, plantOf, stateAlerts } from '../production.js';
import { currentShift, shiftsFor } from '../time.js';
import { simulateAll, simulatorEnabled } from '../simulator.js';
import { recordVision } from '../quality.js';
import { recordSafety } from '../safety.js';
import { recordSighting } from '../assets.js';

const DAY=86400000;
async function safetyEvent(ev,where,index) {
  const eventType=choice(ev.eventType,'eventType',Object.keys(SAFETY_EVENTS)), source=choice(ev.source??'camera','source',['camera','wearable','sensor']), at=instant(ev.at,'at');
  // Devices resend after a lost connection: the same event type at the same place and time is stored once.
  if (await one('SELECT 1 FROM safety_events WHERE plant_id=? AND event_type=? AND occurred_at=? AND source=? AND zone_id IS ? AND equipment_id IS ?',where.plantId,eventType,at,source,where.zoneId??null,where.equipmentId??null)) return {index,status:'duplicate'};
  await recordSafety({...where,eventType,source,description:ev.description?required(ev.description,'description',500):`${eventType.replaceAll('_',' ')} detected by ${source}`,occurredAt:at});
  return {index,status:'accepted'};
}
// Factory data belongs to the customer: their own staff and the platform's internal team see it.
const canView=u=>isCustomer(u)||isDispatch(u);
const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
async function machinesFor(u,{plantId,equipmentId}={}) {
  if (!canView(u)) deny();
  const where=[`machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,"status<>'decommissioned'"], args=[...PRODUCTION_MACHINES];
  if (isCustomer(u)) { where.push('company_id=?'); args.push(u.company_id); }
  if (plantId) { where.push('plant_id=?'); args.push(plantId); }
  if (equipmentId) { where.push('id=?'); args.push(equipmentId); }
  return await all(`SELECT * FROM equipment WHERE ${where.join(' AND ')} ORDER BY asset_tag`,...args);
}
const pct=x=>x==null?null:Math.round(x*1000)/10;
const summary=o=>({availability:pct(o.availability),performance:pct(o.performance),quality:pct(o.quality),oee:pct(o.oee),plannedHours:Math.round(o.plannedMs/360000)/10,runningHours:Math.round(o.runningMs/360000)/10});
function range(query) {
  const to=query.get('to')?Date.parse(instant(query.get('to'),'to')):Date.now(), from=query.get('from')?Date.parse(instant(query.get('from'),'from')):to-7*DAY;
  if (!(from<to)) bad('from must be before to'); if (to-from>92*DAY) bad('Choose a range of at most 92 days');
  return {from,to};
}
function requireIntegrationKey(req) {
  const expected=process.env.MOULDCARE_INTEGRATION_KEY, actual=req.headers['x-integration-key'];
  if (!expected||typeof actual!=='string'||Buffer.byteLength(expected)!==Buffer.byteLength(actual)||!timingSafeEqual(Buffer.from(expected),Buffer.from(actual))) throw new HttpError(401,'Integration key required');
}
// prefix: the table alias when the query joins (e.g. 'a.'); '1=1' and '0=1' take none.
const alertScope=(u,prefix='')=>isDispatch(u)?['1=1',[]]:isCustomer(u)?[`${prefix}company_id=?`,[u.company_id]]:['0=1',[]];

export function register(r) {
  // Live floor: every production machine's state now and its OEE for the current shift.
  r.get('/factory/floor',async ({u,query})=>(await mapSeq((await machinesFor(u,{plantId:query.get('plantId')||null})), async e=>{
    const plant=await plantOf(e), shift=await currentShift(plant), state=await one('SELECT state,reason_code,started_at FROM machine_states WHERE equipment_id=? AND ended_at IS NULL',e.id);
    const o=shift?await machineOee(e,shift.start,Math.min(shift.end,Date.now()),plant):null, product=await currentProduct(e);
    return {id:e.id,assetTag:e.asset_tag,make:e.make,model:e.model,machineType:e.machine_type,plantId:e.plant_id,plantName:plant.name,location:e.location,
      state:state?.state||'offline',reason:state?.reason_code||null,since:state?.started_at||null,product:{name:product.name,partNumber:product.part_number||null,unit:product.unit},
      shift:shift?{name:shift.name,start:new Date(shift.start).toISOString(),end:new Date(shift.end).toISOString(),...(o?summary(o):{}),good:o?.good??0,scrap:o?.scrap??0}:null,
      openAlerts:(await one("SELECT count(*) n FROM alerts WHERE equipment_id=? AND status='open'",e.id)).n,health:(await machineHealth(e)).status};
  })));
  // OEE for a period: per machine, combined, per day, and the losses behind it (Pareto).
  r.get('/factory/oee',async ({u,query})=>{
    const {from,to}=range(query), machines=await machinesFor(u,{plantId:query.get('plantId')||null,equipmentId:query.get('equipmentId')||null}), per=(await mapSeq(machines, async e=>await machineOee(e,from,to)));
    const total=combine(per);
    return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),total:{...summary(total)},losses:lossList(total.losses),
      machines:per.map((o,i)=>({id:machines[i].id,assetTag:machines[i].asset_tag,name:`${machines[i].make} ${machines[i].model}`,...summary(o),good:o.good,scrap:o.scrap,unit:o.unit,downHours:Math.round((o.stateMs.down+o.stateMs.idle+o.stateMs.setup)/360000)/10})),
      daily:(await dailyOee(machines,from,to)).map(d=>({date:d.date,...summary(d)}))};
  });

  // Condition monitoring: health of every machine, the readings behind it, and limits.
  r.get('/factory/condition',async ({u,query})=>(await mapSeq((await machinesFor(u,{plantId:query.get('plantId')||null})), async e=>({id:e.id,assetTag:e.asset_tag,make:e.make,model:e.model,machineType:e.machine_type,plantName:(await plantOf(e)).name,location:e.location,companyId:e.company_id,...await machineHealth(e),openAlerts:(await one("SELECT count(*) n FROM alerts WHERE equipment_id=? AND module='condition' AND status<>'resolved'",e.id)).n}))));
  // Learned-baseline insights: unusual or degrading signals and the time left before a limit.
  r.get('/factory/condition-insights',async ({u,query})=>Object.fromEntries((await mapSeq((await machinesFor(u,{plantId:query.get('plantId')||null})), async e=>[e.id,await machineInsights(e)]))));
  // Predictions from the trained models in the Python ML service (empty when it is not configured).
  r.get('/factory/ml-predictions',async({u,query})=>mlConfigured()?Object.fromEntries(await Promise.all((await mapSeq((await machinesFor(u,{plantId:query.get('plantId')||null})), async e=>[e.id,await scoreMachine(e)])))):{});
  r.get('/factory/scrap-insights',async ({u,query})=>Object.fromEntries((await mapSeq((await machinesFor(u,{plantId:query.get('plantId')||null})), async e=>{ const a=await assessScrap(e); return [e.id,{...a,explanation:explainScrap(a)}]; }))));
  // Claude's evidence-based explanation of one machine (a rule-built summary when no API key is set).
  r.post('/factory/machines/:id/explain',async({u,params})=>{
    const [e]=await machinesFor(u,{equipmentId:params.id}); if (!e) missing();
    const locale=u.locale||(await one('SELECT locale FROM companies WHERE id=?',e.company_id))?.locale||'en', predictions=mlConfigured()?await scoreMachine(e):null;
    try { const out=await explainMachine(e,{predictions,locale}); await audit(u,'machine.explain','equipment',e.id,e.company_id,{source:out.source}); return out; } catch (err) { throw aiHttpError(err); }
  });
  r.get('/factory/oee-insights',async ({u,query})=>{ const ms=await machinesFor(u,{plantId:query.get('plantId')||null}), forecasts=Object.fromEntries((await mapSeq(ms, async e=>[e.id,await shiftForecast(e)]))); return (await oeeInsights(ms)).map(o=>({...o,forecast:forecasts[o.equipmentId]})); });
  r.get('/factory/condition/:id/trend',async ({u,params,query})=>{
    const [e]=await machinesFor(u,{equipmentId:params.id}); if (!e) missing();
    const parameter=choice(query.get('parameter'),'parameter',Object.keys(CONDITION_PARAMETERS)), hours=Number(query.get('hours')||24); if (![24,168].includes(hours)) bad('hours must be 24 or 168');
    const l=await one('SELECT * FROM sensor_limits WHERE equipment_id=? AND parameter=?',e.id,parameter);
    return {parameter,...CONDITION_PARAMETERS[parameter],hours,limit:l?{warnLow:l.warn_low,warnHigh:l.warn_high,critLow:l.crit_low,critHigh:l.crit_high}:null,points:await trend(e,parameter,hours)};
  });
  r.get('/equipment/:id/limits',async ({u,params})=>{ const [e]=await machinesFor(u,{equipmentId:params.id}); if (!e) missing(); const set=Object.fromEntries((await limitsFor(e.id)).map(l=>[l.parameter,l]));
    return parametersFor(e.machine_type).map(p=>{ const l=set[p.key]; return {parameter:p.key,label:p.label,unit:p.unit,recommended:p.limits,warnLow:l?.warn_low??null,warnHigh:l?.warn_high??null,critLow:l?.crit_low??null,critHigh:l?.crit_high??null,autoTicket:l?!!l.auto_ticket:true,configured:!!l}; }); });
  // Replace a machine's limits. A parameter left without any bound is not monitored.
  r.patch('/equipment/:id/limits',async ({u,body,params})=>{
    const [e]=await machinesFor(u,{equipmentId:params.id}); if (!e) missing(); if (!canManage(u,e.company_id)&&!isDispatch(u)) deny();
    const allowed=parametersFor(e.machine_type).map(p=>p.key), num=(v,n)=>{ if (v==null||v==='') return null; const x=typeof v==='string'?Number(v):v; if (!Number.isFinite(x)) bad(`${n} must be a number`); return x; };
    const rows=array(body.limits,'limits').map(x=>{
      const parameter=choice(x.parameter,'parameter',allowed), label=CONDITION_PARAMETERS[parameter].label, l={parameter,warnLow:num(x.warnLow,label+' warning low'),warnHigh:num(x.warnHigh,label+' warning high'),critLow:num(x.critLow,label+' critical low'),critHigh:num(x.critHigh,label+' critical high'),autoTicket:x.autoTicket!==false};
      if (l.warnHigh!=null&&l.critHigh!=null&&l.critHigh<l.warnHigh) bad(`${label}: the critical high limit must be at or above the warning high limit`);
      if (l.warnLow!=null&&l.critLow!=null&&l.critLow>l.warnLow) bad(`${label}: the critical low limit must be at or below the warning low limit`);
      if (l.warnLow!=null&&l.warnHigh!=null&&l.warnLow>=l.warnHigh) bad(`${label}: the warning low limit must be below the warning high limit`);
      return l; }).filter(l=>[l.warnLow,l.warnHigh,l.critLow,l.critHigh].some(v=>v!=null));
    if (new Set(rows.map(r=>r.parameter)).size!==rows.length) bad('Each parameter can appear once');
    await transaction(async ()=>{ await run('DELETE FROM sensor_limits WHERE equipment_id=?',e.id); for (const l of rows) await run('INSERT INTO sensor_limits (id,company_id,equipment_id,parameter,warn_low,warn_high,crit_low,crit_high,auto_ticket,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',id(),e.company_id,e.id,l.parameter,l.warnLow,l.warnHigh,l.critLow,l.critHigh,l.autoTicket?1:0,now()); });
    await audit(u,'equipment.limits','equipment',e.id,e.company_id,{parameters:rows.map(r=>r.parameter)}); return await machineHealth(e);
  });

  // Energy: kWh, kWh per kg, wasted energy, peak power, CO2 and cost for a period.
  r.get('/factory/energy',async ({u,query})=>{ const {from,to}=range(query); return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),...await energyReport(await machinesFor(u,{plantId:query.get('plantId')||null,equipmentId:query.get('equipmentId')||null}),from,to)}; });

  r.get('/plants/:id/shifts',async ({u,params})=>{ const p=await byId('plants',params.id); if (!p) missing(); if (!(isDispatch(u)||u.company_id===p.company_id)) deny(); return await shiftsFor(p); });
  // Replace a plant's shifts. An empty list returns the plant to the defaults of its operating pattern.
  r.patch('/plants/:id/shifts',async ({u,body,params})=>{
    const p=await byId('plants',params.id); if (!p) missing(); if (!canManage(u,p.company_id)) deny();
    const time=(v,n)=>{ if (typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) bad(`${n} must be a time like 06:00`); return v; };
    const shifts=array(body.shifts,'shifts').map((s,i)=>{ const days=array(s.days,`shift ${i+1} days`); if (!days.length||days.some(d=>!Number.isInteger(d)||d<1||d>7)) bad(`shift ${i+1}: choose days 1 (Mon) to 7 (Sun)`); const start=time(s.start,`shift ${i+1} start`), end=time(s.end,`shift ${i+1} end`); if (start===end) bad(`shift ${i+1} must not start and end at the same time`); return {name:required(s.name,`shift ${i+1} name`,20),start,end,days:[...new Set(days)].sort()}; });
    if (shifts.length>6) bad('At most 6 shifts per plant');
    await transaction(async ()=>{ await run('DELETE FROM shifts WHERE plant_id=?',p.id); for (const s of shifts) await run('INSERT INTO shifts (id,plant_id,name,start_time,end_time,days,created_at) VALUES (?,?,?,?,?,?,?)',id(),p.id,s.name,s.start,s.end,JSON.stringify(s.days),now()); });
    await audit(u,'plant.shifts','plant',p.id,p.company_id,{shifts:shifts.length}); return await shiftsFor(p);
  });

  // Products: what is made, and the ideal rate OEE performance is measured against.
  r.get('/products',async ({u})=>{ if (!canView(u)) deny(); return isDispatch(u)?await all('SELECT * FROM products ORDER BY part_number'):await all('SELECT * FROM products WHERE company_id=? ORDER BY part_number',u.company_id); });
  const productBody=async (u,body,existing)=>{
    const companyId=existing?.company_id??required(body.companyId,'companyId'); if (!canManage(u,companyId)) deny();
    const unit=choice(body.unit??existing?.unit??'parts','unit',PRODUCT_UNITS), num=(v,n,min,max)=>{ const x=typeof v==='string'?Number(v):v; if (!Number.isFinite(x)||x<min||x>max) bad(`${n} must be a number from ${min} to ${max}`); return x; };
    const machine=async k=>{ if (!body[k]) return null; const e=await byId('equipment',body[k]); if (!e||e.company_id!==companyId) bad(`${k} must be equipment of the same company`); return e; };
    const mould=await machine('mouldId'), defaultMachine=await machine('defaultMachineId');
    if (mould&&mould.machine_type!=='mould') bad('mouldId must be a mould'); if (defaultMachine&&!PRODUCTION_MACHINES.includes(defaultMachine.machine_type)) bad('defaultMachineId must be a production machine');
    // Discrete parts: ideal rate = 3600 ÷ ideal cycle time × cavities. Continuous output (kg, m): rate given directly.
    let cycle=null, cavities=1, rate;
    if (unit==='parts') { cycle=num(body.idealCycleS??existing?.ideal_cycle_s,'idealCycleS',0.5,3600); cavities=Math.round(num(body.cavities??existing?.cavities??1,'cavities',1,512)); rate=3600/cycle*cavities; }
    else rate=num(body.idealRatePerHour??existing?.ideal_rate_per_hour,'idealRatePerHour',0.1,100000);
    return {companyId,partNumber:required(body.partNumber??existing?.part_number,'partNumber',60).toUpperCase(),name:required(body.name??existing?.name,'name',120),material:required(body.material??existing?.material,'material',60),weight:body.partWeightG==null||body.partWeightG===''?existing?.part_weight_g??null:num(body.partWeightG,'partWeightG',0.001,1000000),unit,cycle,cavities,rate,mould:mould?.id??(body.mouldId===undefined?existing?.mould_id??null:null),machine:defaultMachine?.id??(body.defaultMachineId===undefined?existing?.default_machine_id??null:null)};
  };
  r.post('/products',async ({u,body})=>{
    const p=await productBody(u,body); if (await one('SELECT 1 FROM products WHERE company_id=? AND part_number=?',p.companyId,p.partNumber)) bad(`Part number ${p.partNumber} already exists`);
    const key=id(); await run('INSERT INTO products (id,company_id,part_number,name,material,part_weight_g,unit,ideal_cycle_s,cavities,ideal_rate_per_hour,mould_id,default_machine_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',key,p.companyId,p.partNumber,p.name,p.material,p.weight,p.unit,p.cycle,p.cavities,p.rate,p.mould,p.machine,now());
    await audit(u,'product.create','product',key,p.companyId); return created(await byId('products',key));
  });
  r.patch('/products/:id',async ({u,body,params})=>{
    const existing=await byId('products',params.id); if (!existing) missing(); const p=await productBody(u,body,existing);
    if (p.partNumber!==existing.part_number&&await one('SELECT 1 FROM products WHERE company_id=? AND part_number=? AND id<>?',p.companyId,p.partNumber,existing.id)) bad(`Part number ${p.partNumber} already exists`);
    await run('UPDATE products SET part_number=?,name=?,material=?,part_weight_g=?,unit=?,ideal_cycle_s=?,cavities=?,ideal_rate_per_hour=?,mould_id=?,default_machine_id=?,active=? WHERE id=?',p.partNumber,p.name,p.material,p.weight,p.unit,p.cycle,p.cavities,p.rate,p.mould,p.machine,body.active===false?0:body.active===true?1:existing.active,existing.id);
    await audit(u,'product.update','product',existing.id,existing.company_id); return await byId('products',existing.id);
  });

  // Alerts from all monitoring modules.
  r.get('/alerts',async ({u,query})=>{ const [where,args]=alertScope(u,'a.'), status=query.get('status')||'active'; choice(status,'status',['active','all']);
    return await all(`SELECT a.*,e.asset_tag,e.make,e.model FROM alerts a LEFT JOIN equipment e ON e.id=a.equipment_id WHERE ${where} ${status==='active'?"AND a.status<>'resolved'":''} ORDER BY a.created_at DESC LIMIT 300`,...args); });
  r.get('/alerts/summary',async ({u})=>{ const [where,args]=alertScope(u); return Object.fromEntries((await mapSeq(['critical','warning','info'], async s=>[s,(await one(`SELECT count(*) n FROM alerts WHERE ${where} AND status='open' AND severity=?`,...args,s)).n]))); });
  const alertFor=async (u,key)=>{ const a=await byId('alerts',key); if (!a) missing(); if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===a.company_id))) deny(); return a; };
  r.post('/alerts/:id/acknowledge',async ({u,params})=>{ const a=await alertFor(u,params.id); if (a.status!=='open') bad(`This alert is already ${a.status}`); await run("UPDATE alerts SET status='acknowledged',acknowledged_by=?,acknowledged_at=? WHERE id=?",u.id,now(),a.id); await audit(u,'alert.acknowledge','alert',a.id,a.company_id); return await byId('alerts',a.id); });
  r.post('/alerts/:id/resolve',async ({u,params})=>{ const a=await alertFor(u,params.id); if (a.status==='resolved') bad('This alert is already resolved'); await run("UPDATE alerts SET status='resolved',resolved_at=? WHERE id=?",now(),a.id); await audit(u,'alert.resolve','alert',a.id,a.company_id); return await byId('alerts',a.id); });
  r.get('/alerts/emails',async ({u})=>{ if (!isPlatform(u)) deny(); return await all('SELECT id,alert_id,recipient,subject,status,error,created_at,sent_at FROM notification_outbox ORDER BY created_at DESC LIMIT 100'); });

  // Machine-data intake (server-to-server): the same path the simulator uses. Devices are mapped to machines under
  // IoT integration → Device mappings. Events: {type:'state', deviceId, at, state, reason} or
  // {type:'count', deviceId, periodStart, periodMinutes, totalQty, scrapQty, partNumber?}.
  r.post('/integrations/factory/events',async ({req,body})=>{
    requireIntegrationKey(req);
    const events=array(body.events,'events'); if (!events.length||events.length>1000) bad('Send 1-1000 events per request');
    const results=await transaction(async ()=>(await mapSeq(events, async (ev,index)=>{ try {
      // Asset tags are identified by tag and reader, not by a machine's device id.
      if (ev?.type==='sighting') { const at=instant(ev.at,'at'); const opt=(v,k,min,max)=>{ if (v==null) return null; if (!Number.isFinite(v)||v<min||v>max) bad(`${k} must be ${min} to ${max}`); return v; };
        return {index,status:await recordSighting({tagId:required(ev.tagId,'tagId',60),readerId:required(ev.readerId,'readerId',60),at,rssi:opt(ev.rssi,'rssi',-130,20),batteryPct:opt(ev.batteryPct,'batteryPct',0,100)})}; }
      // Safety events from cameras, wearables or sensors: located by the zone's reader or by a mapped machine.
      if (ev?.type==='safety'&&ev.readerId!=null) { const z=await one('SELECT * FROM zones WHERE reader_id=?',String(ev.readerId)); if (!z) bad('Unknown readerId'); return await safetyEvent(ev,{companyId:z.company_id,plantId:z.plant_id,zoneId:z.id},index); }
      const map=typeof ev?.deviceId==='string'&&await one('SELECT * FROM device_mappings WHERE external_device_id=? AND active=1',ev.deviceId); if (!map) bad('Unknown or inactive deviceId');
      const e=await byId('equipment',map.equipment_id);
      if (ev.type==='state') { const state=choice(ev.state,'state',LIVE_STATES); if (ev.reason!=null&&!(DOWNTIME_REASONS[state]||[]).includes(ev.reason)) bad(`reason must be one of: ${(DOWNTIME_REASONS[state]||[]).join(', ')||'(none for this state)'}`);
        const at=instant(ev.at,'at'), change=await recordState(e,state,ev.reason||null,at,'device'); await stateAlerts(e,state,ev.reason||null,change,at); return {index,status:change.changed?'accepted':'unchanged'}; }
      if (ev.type==='count') { const product=ev.partNumber?await one('SELECT * FROM products WHERE company_id=? AND part_number=?',e.company_id,String(ev.partNumber).toUpperCase()):await currentProduct(e); if (!product) bad('Unknown partNumber'); const n=(v,k)=>{ if (!Number.isFinite(v)||v<0) bad(`${k} must be a non-negative number`); return v; }; const total=n(ev.totalQty,'totalQty'), scrap=n(ev.scrapQty??0,'scrapQty'); if (scrap>total) bad('scrapQty cannot exceed totalQty'); const minutes=n(ev.periodMinutes,'periodMinutes'); if (!minutes||minutes>1440) bad('periodMinutes must be 1-1440');
        return {index,status:await recordCount(e,{periodStart:instant(ev.periodStart,'periodStart'),periodMinutes:minutes,totalQty:total,scrapQty:scrap,unit:product.unit,idealRatePerHour:product.ideal_rate_per_hour,productId:product.id},'device')}; }
      if (ev.type==='condition') { const parameter=choice(ev.parameter,'parameter',Object.keys(CONDITION_PARAMETERS)); if (!Number.isFinite(ev.value)) bad('value must be a number'); return {index,status:await recordCondition(e,parameter,ev.value,instant(ev.at,'at'),'device')}; }
      if (ev.type==='energy') { const kwh=ev.kwh, minutes=ev.periodMinutes; if (!Number.isFinite(kwh)||kwh<0) bad('kwh must be a non-negative number'); if (!Number.isFinite(minutes)||minutes<=0||minutes>1440) bad('periodMinutes must be 1-1440'); if (ev.peakKw!=null&&(!Number.isFinite(ev.peakKw)||ev.peakKw<0)) bad('peakKw must be a non-negative number');
        return {index,status:await recordEnergy(e,{periodStart:instant(ev.periodStart,'periodStart'),periodMinutes:minutes,kwh,peakKw:ev.peakKw??null},'device')}; }
      if (ev.type==='vision') { const n=(v,k)=>{ if (!Number.isInteger(v)||v<0) bad(`${k} must be a non-negative integer`); return v; }; const inspected=n(ev.inspected,'inspected'), rejected=n(ev.rejected,'rejected'); if (rejected>inspected) bad('rejected cannot exceed inspected'); const minutes=ev.periodMinutes; if (!Number.isFinite(minutes)||minutes<=0||minutes>1440) bad('periodMinutes must be 1-1440');
        const defects=ev.defects??{}; if (typeof defects!=='object'||Array.isArray(defects)) bad('defects must be an object of defect → count'); const allowed=DEFECT_TYPES[e.machine_type]||[]; for (const [k,v] of Object.entries(defects)) { if (!allowed.includes(k)) bad(`defect must be one of: ${allowed.join(', ')}`); n(v,`defects.${k}`); }
        return {index,status:await recordVision(e,{station:required(ev.station??'Camera 1','station',60),periodStart:instant(ev.periodStart,'periodStart'),periodMinutes:minutes,inspected,rejected,defects},'device')}; }
      if (ev.type==='safety') return await safetyEvent(ev,{companyId:e.company_id,plantId:e.plant_id,equipmentId:e.id},index);
      // Process settings per shot/cycle (e.g. from an OPC UA / Euromap 77 gateway) go to the batch running on the machine.
      if (ev.type==='process') { const b=await one("SELECT * FROM batches WHERE equipment_id=? AND status='running'",e.id); if (!b) bad('No batch is running on this machine');
        if (!ev.values||typeof ev.values!=='object'||Array.isArray(ev.values)) bad('values must be an object of setting → number'); const at=instant(ev.at,'at');
        const r=await recordReadings(b,Object.entries(ev.values).map(([parameter,value])=>({parameter,value,observedAt:at})),'machine',{inTransaction:true}); return {index,status:'accepted',batch:b.batch_number,deviations:r.deviations.length}; }
      bad('type must be state, count, condition, energy, vision, safety, process or sighting');
    } catch(err) { if (err instanceof HttpError) return {index,status:'rejected',error:err.message}; throw err; } })));
    const count=s=>results.filter(x=>x.status===s).length;
    return {accepted:await count('accepted'),unchanged:await count('unchanged'),duplicates:await count('duplicate'),rejected:await count('rejected'),results};
  },{public:true});

  r.get('/factory/simulator',({u})=>{ if (!isPlatform(u)) deny(); return {enabled:simulatorEnabled()}; });
  r.post('/factory/simulator/run',async ({u})=>{ if (!isPlatform(u)) deny(); if (!simulatorEnabled()) bad('The factory simulator is off. Set FACTORY_SIMULATOR=true on the server to use simulated machine data.'); return {slots:await simulateAll()}; });
}
