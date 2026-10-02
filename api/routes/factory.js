// Smart factory: live floor, OEE analytics, products, shifts, alerts, machine-data intake and the simulator.
import { timingSafeEqual } from 'node:crypto';
import { id, now, one, all, run, transaction } from '../db.js';
import { isCustomer, isPlatform } from '../security.js';
import { audit, byId, isDispatch } from '../access.js';
import { created } from '../http.js';
import { HttpError, bad, choice, deny, instant, missing, required, array } from '../validate.js';
import { PRODUCTION_MACHINES, LIVE_STATES, DOWNTIME_REASONS, PRODUCT_UNITS } from '../catalog.js';
import { recordState, recordCount, machineOee, combine, dailyOee, lossList, currentProduct, plantOf, stateAlerts } from '../factory/production.js';
import { currentShift, shiftsFor } from '../factory/time.js';
import { simulateAll, simulatorEnabled } from '../factory/simulator.js';

const DAY=86400000;
// Factory data belongs to the customer: their own staff and the platform's internal team see it.
const canView=u=>isCustomer(u)||isDispatch(u);
const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
function machinesFor(u,{plantId,equipmentId}={}) {
  if (!canView(u)) deny();
  const where=[`machine_type IN (${PRODUCTION_MACHINES.map(()=>'?').join(',')})`,"status<>'decommissioned'"], args=[...PRODUCTION_MACHINES];
  if (isCustomer(u)) { where.push('company_id=?'); args.push(u.company_id); }
  if (plantId) { where.push('plant_id=?'); args.push(plantId); }
  if (equipmentId) { where.push('id=?'); args.push(equipmentId); }
  return all(`SELECT * FROM equipment WHERE ${where.join(' AND ')} ORDER BY asset_tag`,...args);
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
const alertScope=u=>isDispatch(u)?['1=1',[]]:isCustomer(u)?['company_id=?',[u.company_id]]:['0=1',[]];

export function register(r) {
  // Live floor: every production machine's state now and its OEE for the current shift.
  r.get('/factory/floor',({u,query})=>machinesFor(u,{plantId:query.get('plantId')||null}).map(e=>{
    const plant=plantOf(e), shift=currentShift(plant), state=one('SELECT state,reason_code,started_at FROM machine_states WHERE equipment_id=? AND ended_at IS NULL',e.id);
    const o=shift?machineOee(e,shift.start,Math.min(shift.end,Date.now()),plant):null, product=currentProduct(e);
    return {id:e.id,assetTag:e.asset_tag,make:e.make,model:e.model,machineType:e.machine_type,plantId:e.plant_id,plantName:plant.name,location:e.location,
      state:state?.state||'offline',reason:state?.reason_code||null,since:state?.started_at||null,product:{name:product.name,partNumber:product.part_number||null,unit:product.unit},
      shift:shift?{name:shift.name,start:new Date(shift.start).toISOString(),end:new Date(shift.end).toISOString(),...(o?summary(o):{}),good:o?.good??0,scrap:o?.scrap??0}:null,
      openAlerts:one("SELECT count(*) n FROM alerts WHERE equipment_id=? AND status='open'",e.id).n};
  }));
  // OEE for a period: per machine, combined, per day, and the losses behind it (Pareto).
  r.get('/factory/oee',({u,query})=>{
    const {from,to}=range(query), machines=machinesFor(u,{plantId:query.get('plantId')||null,equipmentId:query.get('equipmentId')||null}), per=machines.map(e=>machineOee(e,from,to));
    const total=combine(per);
    return {from:new Date(from).toISOString(),to:new Date(to).toISOString(),total:{...summary(total)},losses:lossList(total.losses),
      machines:per.map((o,i)=>({id:machines[i].id,assetTag:machines[i].asset_tag,name:`${machines[i].make} ${machines[i].model}`,...summary(o),good:o.good,scrap:o.scrap,unit:o.unit,downHours:Math.round((o.stateMs.down+o.stateMs.idle+o.stateMs.setup)/360000)/10})),
      daily:dailyOee(machines,from,to).map(d=>({date:d.date,...summary(d)}))};
  });

  r.get('/plants/:id/shifts',({u,params})=>{ const p=byId('plants',params.id); if (!p) missing(); if (!(isDispatch(u)||u.company_id===p.company_id)) deny(); return shiftsFor(p); });
  // Replace a plant's shifts. An empty list returns the plant to the defaults of its operating pattern.
  r.patch('/plants/:id/shifts',({u,body,params})=>{
    const p=byId('plants',params.id); if (!p) missing(); if (!canManage(u,p.company_id)) deny();
    const time=(v,n)=>{ if (typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) bad(`${n} must be a time like 06:00`); return v; };
    const shifts=array(body.shifts,'shifts').map((s,i)=>{ const days=array(s.days,`shift ${i+1} days`); if (!days.length||days.some(d=>!Number.isInteger(d)||d<1||d>7)) bad(`shift ${i+1}: choose days 1 (Mon) to 7 (Sun)`); const start=time(s.start,`shift ${i+1} start`), end=time(s.end,`shift ${i+1} end`); if (start===end) bad(`shift ${i+1} must not start and end at the same time`); return {name:required(s.name,`shift ${i+1} name`,20),start,end,days:[...new Set(days)].sort()}; });
    if (shifts.length>6) bad('At most 6 shifts per plant');
    transaction(()=>{ run('DELETE FROM shifts WHERE plant_id=?',p.id); for (const s of shifts) run('INSERT INTO shifts (id,plant_id,name,start_time,end_time,days,created_at) VALUES (?,?,?,?,?,?,?)',id(),p.id,s.name,s.start,s.end,JSON.stringify(s.days),now()); });
    audit(u,'plant.shifts','plant',p.id,p.company_id,{shifts:shifts.length}); return shiftsFor(p);
  });

  // Products: what is made, and the ideal rate OEE performance is measured against.
  r.get('/products',({u})=>{ if (!canView(u)) deny(); return isDispatch(u)?all('SELECT * FROM products ORDER BY part_number'):all('SELECT * FROM products WHERE company_id=? ORDER BY part_number',u.company_id); });
  const productBody=(u,body,existing)=>{
    const companyId=existing?.company_id??required(body.companyId,'companyId'); if (!canManage(u,companyId)) deny();
    const unit=choice(body.unit??existing?.unit??'parts','unit',PRODUCT_UNITS), num=(v,n,min,max)=>{ const x=typeof v==='string'?Number(v):v; if (!Number.isFinite(x)||x<min||x>max) bad(`${n} must be a number from ${min} to ${max}`); return x; };
    const machine=k=>{ if (!body[k]) return null; const e=byId('equipment',body[k]); if (!e||e.company_id!==companyId) bad(`${k} must be equipment of the same company`); return e; };
    const mould=machine('mouldId'), defaultMachine=machine('defaultMachineId');
    if (mould&&mould.machine_type!=='mould') bad('mouldId must be a mould'); if (defaultMachine&&!PRODUCTION_MACHINES.includes(defaultMachine.machine_type)) bad('defaultMachineId must be a production machine');
    // Discrete parts: ideal rate = 3600 ÷ ideal cycle time × cavities. Continuous output (kg, m): rate given directly.
    let cycle=null, cavities=1, rate;
    if (unit==='parts') { cycle=num(body.idealCycleS??existing?.ideal_cycle_s,'idealCycleS',0.5,3600); cavities=Math.round(num(body.cavities??existing?.cavities??1,'cavities',1,512)); rate=3600/cycle*cavities; }
    else rate=num(body.idealRatePerHour??existing?.ideal_rate_per_hour,'idealRatePerHour',0.1,100000);
    return {companyId,partNumber:required(body.partNumber??existing?.part_number,'partNumber',60).toUpperCase(),name:required(body.name??existing?.name,'name',120),material:required(body.material??existing?.material,'material',60),weight:body.partWeightG==null||body.partWeightG===''?existing?.part_weight_g??null:num(body.partWeightG,'partWeightG',0.001,1000000),unit,cycle,cavities,rate,mould:mould?.id??(body.mouldId===undefined?existing?.mould_id??null:null),machine:defaultMachine?.id??(body.defaultMachineId===undefined?existing?.default_machine_id??null:null)};
  };
  r.post('/products',({u,body})=>{
    const p=productBody(u,body); if (one('SELECT 1 FROM products WHERE company_id=? AND part_number=?',p.companyId,p.partNumber)) bad(`Part number ${p.partNumber} already exists`);
    const key=id(); run('INSERT INTO products (id,company_id,part_number,name,material,part_weight_g,unit,ideal_cycle_s,cavities,ideal_rate_per_hour,mould_id,default_machine_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',key,p.companyId,p.partNumber,p.name,p.material,p.weight,p.unit,p.cycle,p.cavities,p.rate,p.mould,p.machine,now());
    audit(u,'product.create','product',key,p.companyId); return created(byId('products',key));
  });
  r.patch('/products/:id',({u,body,params})=>{
    const existing=byId('products',params.id); if (!existing) missing(); const p=productBody(u,body,existing);
    if (p.partNumber!==existing.part_number&&one('SELECT 1 FROM products WHERE company_id=? AND part_number=? AND id<>?',p.companyId,p.partNumber,existing.id)) bad(`Part number ${p.partNumber} already exists`);
    run('UPDATE products SET part_number=?,name=?,material=?,part_weight_g=?,unit=?,ideal_cycle_s=?,cavities=?,ideal_rate_per_hour=?,mould_id=?,default_machine_id=?,active=? WHERE id=?',p.partNumber,p.name,p.material,p.weight,p.unit,p.cycle,p.cavities,p.rate,p.mould,p.machine,body.active===false?0:body.active===true?1:existing.active,existing.id);
    audit(u,'product.update','product',existing.id,existing.company_id); return byId('products',existing.id);
  });

  // Alerts from all monitoring modules.
  r.get('/alerts',({u,query})=>{ const [where,args]=alertScope(u), status=query.get('status')||'active'; choice(status,'status',['active','all']);
    return all(`SELECT a.*,e.asset_tag,e.make,e.model FROM alerts a LEFT JOIN equipment e ON e.id=a.equipment_id WHERE a.${where} ${status==='active'?"AND a.status<>'resolved'":''} ORDER BY a.created_at DESC LIMIT 300`,...args); });
  r.get('/alerts/summary',({u})=>{ const [where,args]=alertScope(u); return Object.fromEntries(['critical','warning','info'].map(s=>[s,one(`SELECT count(*) n FROM alerts WHERE ${where} AND status='open' AND severity=?`,...args,s).n])); });
  const alertFor=(u,key)=>{ const a=byId('alerts',key); if (!a) missing(); if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===a.company_id))) deny(); return a; };
  r.post('/alerts/:id/acknowledge',({u,params})=>{ const a=alertFor(u,params.id); if (a.status!=='open') bad(`This alert is already ${a.status}`); run("UPDATE alerts SET status='acknowledged',acknowledged_by=?,acknowledged_at=? WHERE id=?",u.id,now(),a.id); audit(u,'alert.acknowledge','alert',a.id,a.company_id); return byId('alerts',a.id); });
  r.post('/alerts/:id/resolve',({u,params})=>{ const a=alertFor(u,params.id); if (a.status==='resolved') bad('This alert is already resolved'); run("UPDATE alerts SET status='resolved',resolved_at=? WHERE id=?",now(),a.id); audit(u,'alert.resolve','alert',a.id,a.company_id); return byId('alerts',a.id); });
  r.get('/alerts/emails',({u})=>{ if (!isPlatform(u)) deny(); return all('SELECT id,alert_id,recipient,subject,status,error,created_at,sent_at FROM notification_outbox ORDER BY created_at DESC LIMIT 100'); });

  // Machine-data intake (server-to-server): the same path the simulator uses. Devices are mapped to machines under
  // IoT integration → Device mappings. Events: {type:'state', deviceId, at, state, reason} or
  // {type:'count', deviceId, periodStart, periodMinutes, totalQty, scrapQty, partNumber?}.
  r.post('/integrations/factory/events',({req,body})=>{
    requireIntegrationKey(req);
    const events=array(body.events,'events'); if (!events.length||events.length>1000) bad('Send 1-1000 events per request');
    const results=transaction(()=>events.map((ev,index)=>{ try {
      const map=typeof ev?.deviceId==='string'&&one('SELECT * FROM device_mappings WHERE external_device_id=? AND active=1',ev.deviceId); if (!map) bad('Unknown or inactive deviceId');
      const e=byId('equipment',map.equipment_id);
      if (ev.type==='state') { const state=choice(ev.state,'state',LIVE_STATES); if (ev.reason!=null&&!(DOWNTIME_REASONS[state]||[]).includes(ev.reason)) bad(`reason must be one of: ${(DOWNTIME_REASONS[state]||[]).join(', ')||'(none for this state)'}`);
        const at=instant(ev.at,'at'), change=recordState(e,state,ev.reason||null,at,'device'); stateAlerts(e,state,ev.reason||null,change,at); return {index,status:change.changed?'accepted':'unchanged'}; }
      if (ev.type==='count') { const product=ev.partNumber?one('SELECT * FROM products WHERE company_id=? AND part_number=?',e.company_id,String(ev.partNumber).toUpperCase()):currentProduct(e); if (!product) bad('Unknown partNumber'); const n=(v,k)=>{ if (!Number.isFinite(v)||v<0) bad(`${k} must be a non-negative number`); return v; }; const total=n(ev.totalQty,'totalQty'), scrap=n(ev.scrapQty??0,'scrapQty'); if (scrap>total) bad('scrapQty cannot exceed totalQty'); const minutes=n(ev.periodMinutes,'periodMinutes'); if (!minutes||minutes>1440) bad('periodMinutes must be 1-1440');
        return {index,status:recordCount(e,{periodStart:instant(ev.periodStart,'periodStart'),periodMinutes:minutes,totalQty:total,scrapQty:scrap,unit:product.unit,idealRatePerHour:product.ideal_rate_per_hour,productId:product.id},'device')}; }
      bad('type must be state or count');
    } catch(err) { if (err instanceof HttpError) return {index,status:'rejected',error:err.message}; throw err; } }));
    const count=s=>results.filter(x=>x.status===s).length;
    return {accepted:count('accepted'),unchanged:count('unchanged'),duplicates:count('duplicate'),rejected:count('rejected'),results};
  },{public:true});

  r.get('/factory/simulator',({u})=>{ if (!isPlatform(u)) deny(); return {enabled:simulatorEnabled()}; });
  r.post('/factory/simulator/run',({u})=>{ if (!isPlatform(u)) deny(); if (!simulatorEnabled()) bad('The factory simulator is off. Set FACTORY_SIMULATOR=true on the server to use simulated machine data.'); return {slots:simulateAll()}; });
}
