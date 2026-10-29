// Energy audit API: audits, meters, cycle templates, company tables, and the meter data intake.
// People use /energy-audits, /energy-audit/*. Meters send data to /integrations/* with a company integration key that has
// the "energy" scope (hashed, shown once; see core/routes/intake.js), or a signed-in phone relays it (BLE) to the meter's relay URL.
import { id, now, one, all, run, mapSeq } from '../../../common/db.js';
import { isPlatform } from '../../../common/security.js';
import { audit, byId } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { HttpError, array, bad, choice, deny, instant, missing, required } from '../../../common/validate.js';
import { companyKey } from '../../core/routes/intake.js';
import { canWrite, canManage, canRead, auditFor, meterFor } from '../access.js';
import * as A from '../analysis.js';
import * as I from '../ingest.js';
import { settingsOf, present, summary, finalize, meterOf, json, iso, meterOut, productOf } from '../audits.js';
import { reportHtml } from '../report.js';

const DAY=86400000;
const requireWriter=u=>{ if (!isPlatform(u)&&!['customer_admin','plant_manager','maintenance'].includes(u.role)) deny(); };
const num=(v,name,lo,hi,{nullable=false}={})=>{ if (nullable&&(v==null||v==='')) return null; const x=typeof v==='string'&&v.trim()!==''?Number(v):v; if (typeof x!=='number'||!Number.isFinite(x)||x<lo||x>hi) bad(`${name} must be a number from ${lo} to ${hi}`); return x; };
const text=(v,name,max,{required:req=false}={})=>{ if (v==null||v==='') { if (req) bad(`${name} is required`); return ''; } if (typeof v!=='string'||v.length>max) bad(`${name} must be text of at most ${max} characters`); return v.trim(); };

// ---------- Validation of bodies ----------
function nameplateBody(v,old={}) {
  const b={...old,...(v||{})}, out={};
  if (b.motorKw!=null&&b.motorKw!=='') out.motorKw=num(b.motorKw,'motorKw',0.1,5000);
  if (b.pumpType!=null&&b.pumpType!=='') out.pumpType=choice(b.pumpType,'pumpType',A.PUMP_TYPES);
  if (b.clampTonnes!=null&&b.clampTonnes!=='') out.clampTonnes=num(b.clampTonnes,'clampTonnes',1,10000);
  if (b.screwDiameterMm!=null&&b.screwDiameterMm!=='') out.screwDiameterMm=num(b.screwDiameterMm,'screwDiameterMm',5,300);
  if (b.yearBuilt!=null&&b.yearBuilt!=='') out.yearBuilt=num(b.yearBuilt,'yearBuilt',1950,2100);
  return out;
}
function assumptionsBody(v,old={}) {
  const b={...old,...(v||{})}, out={};
  if (b.lineVoltage!=null&&b.lineVoltage!=='') out.lineVoltage=num(b.lineVoltage,'lineVoltage',50,1000);
  if (b.assumedPf!=null&&b.assumedPf!=='') out.assumedPf=num(b.assumedPf,'assumedPf',0.3,1);
  if (b.annualHours!=null&&b.annualHours!=='') out.annualHours=num(b.annualHours,'annualHours',1,8760);
  if (b.fixedLoadKw!=null&&b.fixedLoadKw!=='') out.fixedLoadKw=num(b.fixedLoadKw,'fixedLoadKw',0,1000);
  if (b.retrofitCost!=null&&b.retrofitCost!=='') out.retrofitCost=num(b.retrofitCost,'retrofitCost',0,1e9);
  if (b.years!=null&&b.years!=='') out.years=num(b.years,'years',1,30);
  if (b.cycleOffsetS!=null&&b.cycleOffsetS!=='') out.cycleOffsetS=num(b.cycleOffsetS,'cycleOffsetS',-60,60);
  if (b.target!=null&&b.target!=='') out.target=choice(b.target,'target',['variable','servo']);
  if (b.driveOverride!=null&&b.driveOverride!=='') out.driveOverride=choice(b.driveOverride,'driveOverride',A.PUMP_TYPES.filter(x=>x!=='unknown'));
  if (b.factors!=null) { const f={}; for (const [k,v2] of Object.entries(b.factors||{})) { if (!A.DEFAULT_FACTORS[k]) bad(`Unknown factor set ${k}`); f[k]=factorSet(v2,k); } out.factors=f; }
  return out;
}
function factorSet(v,key) {
  if (!v||typeof v!=='object') bad(`factors.${key} must be an object`); const out={};
  for (const [cat,t] of Object.entries(v)) { if (!A.CATEGORIES.includes(cat)) bad(`Unknown phase category ${cat}`); if (!A.checkTriple(t)) bad(`factors ${key}.${cat} must be [low, typical, high] from 0 to 0.95, rising`); out[cat]=t; }
  return out;
}
export function phasesBody(v) {
  const list=array(v,'phases'); if (!list.length||list.length>30) bad('A cycle template has 1 to 30 phases');
  const out=list.map((p,i)=>({name:text(p?.name,`Phase ${i+1} name`,60,{required:true}),seconds:num(p?.seconds,`Phase ${i+1} seconds`,0.1,600),category:p?.category?choice(p.category,`Phase ${i+1} category`,A.CATEGORIES):A.guessCategory(p?.name)}));
  if (out.reduce((n,p)=>n+p.seconds,0)>900) bad('The phases add up to more than 900 seconds');
  return out;
}
function benchmarksBody(v) {
  const list=array(v,'benchmarks'); if (list.length>60) bad('At most 60 benchmark rows');
  return list.map((b,i)=>{ const low=num(b?.low,`Row ${i+1} low`,0.01,50), high=num(b?.high,`Row ${i+1} high`,0.01,50); if (low>=high) bad(`Row ${i+1}: low must be below high`);
    return {driveType:choice(b.driveType,`Row ${i+1} driveType`,A.PUMP_TYPES.filter(x=>x!=='unknown')),material:text(b.material,'material',40),low,high,note:text(b.note,'note',200)}; });
}
function materialsBody(v) {
  const list=[...new Set(array(v,'materials').map(x=>text(x,'material',40,{required:true})))]; if (!list.length||list.length>80) bad('1 to 80 materials');
  return list;
}
function uuid(v,name) { if (typeof v!=='string'||!/^([0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(v)) bad(`${name} must be a 16-bit, 32-bit or 128-bit UUID`); return v.toLowerCase(); }
export function bleBody(v) {
  if (v==null) return {}; if (typeof v!=='object') bad('bleConfig must be an object');
  const out={serviceUuid:uuid(v.serviceUuid,'serviceUuid'),characteristicUuid:uuid(v.characteristicUuid,'characteristicUuid'),sampleIntervalMs:num(v.sampleIntervalMs??100,'sampleIntervalMs',10,60000),experimental:true};
  const fields=array(v.decoder?.fields??[],'decoder.fields'); if (!fields.length||fields.length>12) bad('The decoder needs 1 to 12 fields');
  out.decoder={fields:fields.map((f,i)=>({name:choice(f?.name,`decoder field ${i+1} name`,['kw','kva','kvar','pf','volts','amps','thd','kwhTotal','cycle']),offset:num(f.offset,'offset',0,510),type:choice(f.type,'type',['int16','uint16','int32','uint32','float32']),endian:choice(f.endian||'le','endian',['le','be']),scale:num(f.scale??1,'scale',-1e9,1e9)}))};
  return out;
}
async function meterBody(u,body,old) {
  requireWriter(u);
  const eq=old?await byId('equipment',old.equipment_id):await byId('equipment',required(body.equipmentId,'equipmentId',100));
  if (!eq||(!isPlatform(u)&&eq.company_id!==u.company_id)) bad('Unknown machine');
  if (!canWrite(u,eq.company_id)) deny();
  if (eq.machine_type!=='injection') bad('Energy audits are for injection moulding machines');
  const kind=old?old.kind:choice(body.kind??'analyzer','kind',['analyzer','lorawan_ct','generic']);
  const d={analyzer:{measures:'power',interval:100,transport:'http'},lorawan_ct:{measures:'current',interval:600000,transport:'lorawan'},generic:{measures:'power',interval:1000,transport:'http'}}[kind];
  const measures=choice(body.measures??old?.measures??d.measures,'measures',['power','current','energy']);
  const transport=choice(body.transport??old?.transport??d.transport,'transport',['http','mqtt','lorawan','ble']);
  const interval=num(body.nominalIntervalMs??old?.nominal_interval_ms??d.interval,'nominalIntervalMs',10,86400000);
  const volt=body.voltageV!==undefined?num(body.voltageV,'voltageV',50,1000,{nullable:true}):old?.voltage_v??null;
  const pf=body.assumedPf!==undefined?num(body.assumedPf,'assumedPf',0.3,1,{nullable:true}):old?.assumed_pf??(measures==='current'?0.8:null);
  if (measures==='current'&&!volt) bad('A meter that reports current only needs the line voltage (voltageV), to estimate power');
  return {eq,kind,measures,transport,interval,volt,pf,name:body.name!==undefined||!old?required(body.name,'name',80):old.name,deviceId:body.deviceId!==undefined?(text(body.deviceId,'deviceId',64)||null):old?.device_id??null,
    basis:choice(body.voltageBasis??old?.voltage_basis??'ll','voltageBasis',['ll','ln']),mapping:body.mapping!==undefined?I.parseMapping(body.mapping):json(old?.mapping,{}),
    ble:body.bleConfig!==undefined?bleBody(body.bleConfig):json(old?.ble_config,{}),clock:choice(body.clockMode??old?.clock_mode??'device','clockMode',['device','receive'])};
}

// ---------- Intake helpers ----------
async function intakeMeter(req,meterId) {
  const k=await companyKey(req,'energy'); I.limitKey(k.id);
  const m=await one('SELECT * FROM energy_meters WHERE id=? AND company_id=? AND active=1',String(meterId||''),k.company_id);
  if (!m) throw new HttpError(404,'Unknown meter for this key. Register the meter in the app and use its ID.');
  await run('UPDATE integration_keys SET last_used_at=? WHERE id=?',now(),k.id);
  return m;
}
async function ingest(m,body) {
  const parsed=I.parseBatch(body,m); I.limitMeter(m.id,parsed.rows.length);
  return await I.storeBatch(m,parsed);
}
const devEui=s=>String(s||'').toLowerCase().replace(/[^0-9a-f]/g,'');

const auditBody=async (u,body,old)=>{
  requireWriter(u);
  const eq=await byId('equipment',old?old.equipment_id:required(body.equipmentId,'equipmentId',100));
  if (!eq||(!isPlatform(u)&&eq.company_id!==u.company_id)) bad('Unknown machine');
  if (!canWrite(u,eq.company_id)) deny();
  if (eq.machine_type!=='injection') bad('Energy audits are for injection moulding machines');
  const pid=body.productId!==undefined?(body.productId||null):old?.product_id??null;
  if (pid) { const p=await one('SELECT id FROM products WHERE id=? AND company_id=?',pid,eq.company_id); if (!p) bad('Unknown product'); }
  const mid=body.meterId!==undefined?(body.meterId||null):old?.meter_id??null;
  if (mid) { const m=await one('SELECT id FROM energy_meters WHERE id=? AND company_id=? AND equipment_id=?',mid,eq.company_id,eq.id); if (!m) bad('Unknown meter for this machine'); }
  const mass=choice(body.massMode??old?.mass_mode??'counts','massMode',['counts','manual']);
  return {eq,pid,mid,mass,title:body.title!==undefined||!old?text(body.title,'title',120,{required:true}):old.title,material:body.material!==undefined?text(body.material,'material',40):old?.material??'',
    meterNote:body.meterNote!==undefined?text(body.meterNote,'meterNote',160):old?.meter_note??'',notes:body.notes!==undefined?text(body.notes,'notes',4000):old?.notes??'',
    manualKg:body.manualKg!==undefined?num(body.manualKg,'manualKg',0.001,1e7,{nullable:true}):old?.manual_kg??null,manualParts:body.manualParts!==undefined?num(body.manualParts,'manualParts',1,1e9,{nullable:true}):old?.manual_parts??null,
    nameplate:nameplateBody(body.nameplate,json(old?.nameplate,{})),assumptions:assumptionsBody(body.assumptions,json(old?.assumptions,{}))};
};
function periodBody(body,old) {
  const s=body.periodStart!==undefined?(body.periodStart?Date.parse(instant(body.periodStart,'periodStart')):null):old?.period_start_ms??null;
  const e=body.periodEnd!==undefined?(body.periodEnd?Date.parse(instant(body.periodEnd,'periodEnd')):null):old?.period_end_ms??null;
  if (s!=null&&e!=null) { if (e<=s) bad('periodEnd must be after periodStart'); if (e-s>31*DAY) bad('An audit period is at most 31 days'); }
  return {s,e};
}

export function register(r) {
  // ---------- Company tables ----------
  const companyOf=async (u,query)=>{ const c=query.get('companyId')||u.company_id; if (!c) bad('companyId is required'); const co=await byId('companies',c); if (!co) missing(); if (!canRead(u,co.id)) deny(); return co; };
  r.get('/energy-audit/config',async ({u,query})=>{ const c=await companyOf(u,query), s=await settingsOf(c.id);
    return {companyId:c.id,currency:c.currency,materials:s.materials,benchmarks:s.benchmarks,factors:s.factors,defaults:s.defaults,defaultFactors:A.DEFAULT_FACTORS,categories:A.CATEGORIES,pumpTypes:A.PUMP_TYPES,transitions:A.TRANSITIONS,canManage:canManage(u,c.id)}; });
  r.put('/energy-audit/config',async ({u,body,query})=>{
    const c=await companyOf(u,new URLSearchParams(body.companyId?{companyId:body.companyId}:query)); if (!canManage(u,c.id)) deny();
    const cur=await one('SELECT * FROM energy_audit_settings WHERE company_id=?',c.id), pick=(k,f)=>body[k]===undefined?cur?.[k]:body[k]===null?null:JSON.stringify(f(body[k]));
    const factors=body.factors===undefined?cur?.factors:body.factors===null?null:JSON.stringify(Object.fromEntries(Object.entries(body.factors).map(([k,v])=>{ if (!A.DEFAULT_FACTORS[k]) bad(`Unknown factor set ${k}`); return [k,factorSet(v,k)]; })));
    await run(`INSERT INTO energy_audit_settings (company_id,materials,benchmarks,factors,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT (company_id) DO UPDATE SET materials=EXCLUDED.materials,benchmarks=EXCLUDED.benchmarks,factors=EXCLUDED.factors,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
      c.id,pick('materials',materialsBody)??null,pick('benchmarks',benchmarksBody)??null,factors??null,u.id,now());
    await audit(u,'energy_audit.config','company',c.id,c.id,{changed:['materials','benchmarks','factors'].filter(k=>body[k]!==undefined)});
    const s=await settingsOf(c.id); return {companyId:c.id,materials:s.materials,benchmarks:s.benchmarks,factors:s.factors,defaults:s.defaults};
  });

  // ---------- Cycle templates (one per product) ----------
  r.get('/energy-audit/templates/:productId',async ({u,params})=>{ const p=await byId('products',params.productId); if (!p) missing(); if (!canRead(u,p.company_id)) deny();
    const t=await one('SELECT * FROM energy_cycle_templates WHERE product_id=?',p.id); return t?{productId:p.id,name:t.name,phases:json(t.phases,[]),updatedAt:t.updated_at}:{productId:p.id,name:'',phases:[],updatedAt:null}; });
  r.put('/energy-audit/templates/:productId',async ({u,params,body})=>{ const p=await byId('products',params.productId); if (!p) missing(); if (!canWrite(u,p.company_id)) deny();
    const phases=phasesBody(body.phases), name=text(body.name,'name',80)||p.part_number;
    await run('INSERT INTO energy_cycle_templates (id,company_id,product_id,name,phases,updated_by,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (product_id) DO UPDATE SET name=EXCLUDED.name,phases=EXCLUDED.phases,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at',id(),p.company_id,p.id,name,JSON.stringify(phases),u.id,now());
    await audit(u,'energy_audit.template','product',p.id,p.company_id,{phases:phases.length});
    return {productId:p.id,name,phases}; });

  // ---------- Meters ----------
  r.get('/energy-audit/meters',async ({u,query})=>{
    const eq=query.get('equipmentId'), rows=eq?await all('SELECT * FROM energy_meters WHERE equipment_id=? ORDER BY created_at',eq):isPlatform(u)||u.role==='dispatcher'?await all('SELECT * FROM energy_meters ORDER BY created_at'):await all('SELECT * FROM energy_meters WHERE company_id=? ORDER BY created_at',u.company_id);
    return rows.filter(m=>canRead(u,m.company_id)).map(meterOut); });
  r.post('/energy-audit/meters',async ({u,body})=>{
    const b=await meterBody(u,body), key=id();
    await run('INSERT INTO energy_meters (id,company_id,equipment_id,name,kind,transport,device_id,measures,nominal_interval_ms,voltage_v,assumed_pf,voltage_basis,mapping,ble_config,clock_mode,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,b.eq.company_id,b.eq.id,b.name,b.kind,b.transport,b.deviceId,b.measures,b.interval,b.volt,b.pf,b.basis,JSON.stringify(b.mapping),JSON.stringify(b.ble),b.clock,u.id,now());
    await audit(u,'energy_meter.create','energy_meter',key,b.eq.company_id,{kind:b.kind,measures:b.measures}); return created(meterOut(await byId('energy_meters',key))); });
  r.get('/energy-audit/meters/:id',async ({u,params})=>meterOut(await meterFor(u,params.id)));
  r.patch('/energy-audit/meters/:id',async ({u,params,body})=>{ const m=await meterFor(u,params.id,{write:true}), b=await meterBody(u,body,m), active=body.active==null?m.active:body.active===true?1:body.active===false?0:bad('active must be true or false');
    await run('UPDATE energy_meters SET name=?,transport=?,device_id=?,measures=?,nominal_interval_ms=?,voltage_v=?,assumed_pf=?,voltage_basis=?,mapping=?,ble_config=?,clock_mode=?,active=? WHERE id=?',b.name,b.transport,b.deviceId,b.measures,b.interval,b.volt,b.pf,b.basis,JSON.stringify(b.mapping),JSON.stringify(b.ble),b.clock,active,m.id);
    await audit(u,'energy_meter.update','energy_meter',m.id,m.company_id,{active:!!active}); return meterOut(await byId('energy_meters',m.id)); });
  // Dry run: what would this payload become with the meter's mapping (nothing is stored).
  r.post('/energy-audit/meters/:id/test-mapping',async ({u,params,body})=>{ const m=await meterFor(u,params.id,{write:true}); let mapping=json(m.mapping,{}); if (body.mapping!==undefined) mapping=I.parseMapping(body.mapping);
    let payload=body.payload, t=null; if (body.lorawan) { const w=I.unwrapLoRa(payload); payload=w.obj; t=w.time; if (m.device_id&&w.devEui&&devEui(w.devEui)!==devEui(m.device_id)) bad('The payload comes from another device (DevEUI differs)'); }
    const raw=I.applyMapping(payload,{...mapping,objectPath:body.lorawan?undefined:mapping.objectPath}); if (t&&raw.t==null) raw.t=t;
    return {raw,stored:I.sampleValues(raw),note:'Nothing was stored.'}; });
  r.get('/energy-audit/meters/:id/live',async ({u,params})=>{ const m=await meterFor(u,params.id), last=await all('SELECT ts,kw,pf,amps,volts FROM energy_samples WHERE meter_id=? ORDER BY ts DESC LIMIT 20',m.id), n=await one('SELECT count(*) c FROM energy_samples WHERE meter_id=? AND ts>=?',m.id,Date.now()-60000);
    return {meter:meterOut(m),last:last.reverse(),samplesLastMinute:n.c}; });

  // ---------- Intake (integration key, public routes) ----------
  r.post('/integrations/energy-samples',async ({req,body})=>{ const m=await intakeMeter(req,body?.meterId); return created(await ingest(m,body)); },{public:true,bodyLimit:I.LIMITS.bodyBytes});
  r.post('/integrations/lorawan/:meterId',async ({req,body,params})=>{
    const m=await intakeMeter(req,params.meterId), w=I.unwrapLoRa(body);
    if (m.device_id&&w.devEui&&devEui(m.device_id)!==devEui(w.devEui)) throw new HttpError(403,'This uplink is from another device than the one registered for this meter');
    const mapping=json(m.mapping,{}); if (!Object.keys(mapping).some(k=>k!=='objectPath')) bad('This meter has no field mapping yet. Open the meter and map the decoded fields.');
    const raw=I.applyMapping(w.obj,{...mapping,objectPath:undefined}); if (raw.t==null&&w.time) raw.t=w.time;
    return created(await ingest(m,{samples:[raw]})); },{public:true,bodyLimit:64*1024});
  // Any JSON/MQTT-style payload (an object, or an array of objects), read through the meter's field mapping. MQTT: a bridge posts each message here.
  r.post('/integrations/energy-payload/:meterId',async ({req,body,params})=>{
    const m=await intakeMeter(req,params.meterId), mapping=json(m.mapping,{});
    if (!Object.keys(mapping).some(k=>k!=='objectPath')) bad('This meter has no field mapping yet. Open the meter and map the payload fields.');
    const list=Array.isArray(body)?body:[body]; if (list.length>I.LIMITS.maxBatch) bad(`At most ${I.LIMITS.maxBatch} payloads per request`);
    const samples=list.map((p,i)=>{ try { return I.applyMapping(p,mapping); } catch(e) { if (e instanceof HttpError) bad(`Payload ${i}: ${e.message}`); throw e; } });
    if (samples.length>1&&samples.some(s=>s.t==null)) bad('Map a time field (mapping.time) when sending several payloads at once');
    return created(await ingest(m,{samples})); },{public:true,bodyLimit:I.LIMITS.bodyBytes});
  // A signed-in phone relays samples it collected (Bluetooth) or buffered offline.
  r.post('/energy-audit/meters/:id/relay',async ({u,params,body})=>{ const m=await meterFor(u,params.id,{write:true}); if (!m.active) bad('This meter is switched off'); return created(await ingest(m,body)); },{bodyLimit:I.LIMITS.bodyBytes});

  // ---------- Audits ----------
  r.get('/energy-audits',async ({u,query})=>{
    const rows=isPlatform(u)||u.role==='dispatcher'?await all('SELECT * FROM energy_audits ORDER BY created_at DESC LIMIT 200'):await all('SELECT * FROM energy_audits WHERE company_id=? ORDER BY created_at DESC LIMIT 200',u.company_id);
    const plant=query.get('plantId'), list=rows.filter(a=>canRead(u,a.company_id)&&(!plant||a.plant_id===plant));
    return await mapSeq(list,summary); });
  r.post('/energy-audits',async ({u,body})=>{
    const b=await auditBody(u,body), {s,e}=periodBody(body), key=id(), stamp=now();
    await run('INSERT INTO energy_audits (id,company_id,plant_id,equipment_id,product_id,meter_id,meter_note,title,material,status,period_start_ms,period_end_ms,mass_mode,manual_kg,manual_parts,nameplate,assumptions,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,b.eq.company_id,b.eq.plant_id,b.eq.id,b.pid,b.mid,b.meterNote,b.title,b.material,'draft',s,e,b.mass,b.manualKg,b.manualParts,JSON.stringify(b.nameplate),JSON.stringify(b.assumptions),b.notes,u.id,stamp,stamp);
    await audit(u,'energy_audit.create','energy_audit',key,b.eq.company_id,{equipmentId:b.eq.id});
    return created(await present(await byId('energy_audits',key))); });
  r.get('/energy-audits/:id',async ({u,params})=>await present(await auditFor(u,params.id)));
  r.patch('/energy-audits/:id',async ({u,params,body})=>{
    const a=await auditFor(u,params.id,{write:true}); if (a.status==='cancelled') bad('A cancelled audit cannot be changed');
    if (a.status==='running'&&(body.periodStart!==undefined||body.periodEnd!==undefined)) bad('Stop the test run before changing its period');
    const b=await auditBody(u,body,a), {s,e}=periodBody(body,a);
    await run('UPDATE energy_audits SET product_id=?,meter_id=?,meter_note=?,title=?,material=?,period_start_ms=?,period_end_ms=?,mass_mode=?,manual_kg=?,manual_parts=?,nameplate=?,assumptions=?,notes=?,updated_at=? WHERE id=?',
      b.pid,b.mid,b.meterNote,b.title,b.material,s,e,b.mass,b.manualKg,b.manualParts,JSON.stringify(b.nameplate),JSON.stringify(b.assumptions),b.notes,now(),a.id);
    let cur=await byId('energy_audits',a.id);
    if (cur.status==='completed') await run('UPDATE energy_audits SET analysis=? WHERE id=?',await finalize(cur),a.id); // a completed result follows its inputs
    await audit(u,'energy_audit.update','energy_audit',a.id,a.company_id,{fields:Object.keys(body)});
    return await present(await byId('energy_audits',a.id)); });
  r.post('/energy-audits/:id/start',async ({u,params})=>{
    const a=await auditFor(u,params.id,{write:true}); if (!['draft'].includes(a.status)) bad('Only an audit that has not started can be started');
    if (await one("SELECT 1 FROM energy_audits WHERE equipment_id=? AND status='running' AND id<>?",a.equipment_id,a.id)) bad('Another test run is already running on this machine');
    await run("UPDATE energy_audits SET status='running',period_start_ms=?,period_end_ms=NULL,analysis=NULL,updated_at=? WHERE id=?",Date.now(),now(),a.id);
    await audit(u,'energy_audit.start','energy_audit',a.id,a.company_id); return await present(await byId('energy_audits',a.id)); });
  // Stop a running test, or analyse a past period set on a draft: the result is stored with the audit.
  r.post('/energy-audits/:id/stop',async ({u,params})=>{
    const a=await auditFor(u,params.id,{write:true}); if (a.status!=='running') bad('The audit is not running');
    const end=Date.now(); if (end-a.period_start_ms<10000) bad('Let the test run for at least 10 seconds');
    await run("UPDATE energy_audits SET period_end_ms=? WHERE id=?",end,a.id); return await complete(u,await byId('energy_audits',a.id)); });
  r.post('/energy-audits/:id/complete',async ({u,params})=>{
    const a=await auditFor(u,params.id,{write:true}); if (a.status!=='draft'&&a.status!=='completed') bad('Only a draft with a period can be analysed');
    if (a.period_start_ms==null||a.period_end_ms==null) bad('Set the period (start and end) first'); return await complete(u,a); });
  r.post('/energy-audits/:id/cancel',async ({u,params})=>{ const a=await auditFor(u,params.id,{write:true}); await run("UPDATE energy_audits SET status='cancelled',updated_at=? WHERE id=?",now(),a.id); await audit(u,'energy_audit.cancel','energy_audit',a.id,a.company_id); return await present(await byId('energy_audits',a.id)); });
  async function complete(u,a) {
    const keep=Date.now()+I_KEEP_MS; await run("UPDATE energy_audits SET status='completed',completed_at=?,keep_raw_until_ms=?,updated_at=? WHERE id=?",now(),keep,now(),a.id);
    const cur=await byId('energy_audits',a.id); await run('UPDATE energy_audits SET analysis=? WHERE id=?',await finalize(cur),a.id);
    await audit(u,'energy_audit.complete','energy_audit',a.id,a.company_id,{hours:(cur.period_end_ms-cur.period_start_ms)/3600000});
    return await present(await byId('energy_audits',a.id));
  }
  // Raw samples of the audit's window: export as CSV, or delete (the stored result stays).
  r.get('/energy-audits/:id/raw.csv',async ({u,params,res})=>{ const a=await auditFor(u,params.id); if (!a.meter_id||a.period_start_ms==null) bad('This audit has no meter data window');
    const rows=await I.sampleRows(a.meter_id,a.period_start_ms,a.period_end_ms??Date.now(),1000000);
    await audit(u,'energy_audit.export_raw','energy_audit',a.id,a.company_id,{rows:rows.length});
    const csv=['time_utc,kw,kva,kvar,pf,volts,amps,thd,kwh_total,cycle',...rows.map(x=>[iso(x.ts),x.kw,x.kva,x.kvar,x.pf,x.volts,x.amps,x.thd,x.kwh_total,x.cyc].map(v=>v??'').join(','))].join('\n');
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="energy-audit-${a.id.slice(0,8)}-raw.csv"`,'cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(csv); },{writes:true});
  r.delete('/energy-audits/:id/raw',async ({u,params})=>{ const a=await auditFor(u,params.id,{write:true}); if (a.status==='running') bad('Stop the test run first'); if (!a.meter_id||a.period_start_ms==null) return {deleted:0};
    const d=await run('DELETE FROM energy_samples WHERE meter_id=? AND ts>=? AND ts<=?',a.meter_id,a.period_start_ms,a.period_end_ms??Date.now()); await run('UPDATE energy_audits SET keep_raw_until_ms=? WHERE id=?',0,a.id);
    await audit(u,'energy_audit.delete_raw','energy_audit',a.id,a.company_id,{rows:d.changes}); return {deleted:d.changes}; });
  r.get('/energy-audits/:id/report',async ({u,params,query,res})=>{
    const a=await auditFor(u,params.id), p=await present(a), lang=choice(query.get('lang')||'en','lang',['en','de']); if (!p.analysis) bad('There is no result to report yet');
    await audit(u,'energy_audit.report','energy_audit',a.id,a.company_id,{lang});
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-disposition':`attachment; filename="energy-audit-${(p.machine.assetTag||a.id.slice(0,8)).replace(/[^\w-]+/g,'-').toLowerCase()}-${lang}.html"`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"});
    res.end(reportHtml(p,lang,{generatedBy:u.name,generatedAt:now()})); },{writes:true});
}
const I_KEEP_MS=I.RAW_KEEP_DAYS*DAY;
