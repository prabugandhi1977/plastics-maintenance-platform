// Operator tablet, andon calls, the andon board and their reports (logic in ../andon.js).
// Routes marked {station:true} accept a station token (POST /operator/login) as well as a person's sign-in; a station
// reaches only its own machines and plant. Everything else is for signed-in people, scoped to their company.
import { id, now, one, all, run, mapSeq } from '../../../common/db.js';
import { verifyPassword, hashPassword, isCustomer } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { created, reply } from '../../../common/http.js';
import { HttpError, array, bad, choice, deny, instant, missing, required } from '../../../common/validate.js';
import { PRODUCTION_MACHINES } from '../../../common/catalog.js';
import { plantOf } from '../production.js';
import * as A from '../andon.js';

const DAY=86400000;
// Wrong codes from one address (guessing station codes) are limited in memory as well; the PIN lockout itself is
// stored on the station, so it holds across restarts and instances.
const ipFailures=new Map(), IP_WINDOW=15*60000, IP_MAX=30;
const DUMMY_PIN=hashPassword('000000-timing');
function ipBlocked(ip) { const f=ipFailures.get(ip); if (f&&Date.now()-f.first>IP_WINDOW) { ipFailures.delete(ip); return false; } return !!f&&f.count>=IP_MAX; }
function ipFail(ip) { if (ipFailures.size>10000) ipFailures.clear(); const f=ipFailures.get(ip); ipFailures.set(ip,f?{...f,count:f.count+1}:{first:Date.now(),count:1}); }
const range=query=>{ const to=query.get('to')?Date.parse(instant(query.get('to'),'to')):Date.now(), from=query.get('from')?Date.parse(instant(query.get('from'),'from')):to-7*DAY;
  if (!(from<to)) bad('from must be before to'); if (to-from>92*DAY) bad('Choose a range of at most 92 days'); return {from,to}; };
const requireUser=ctx=>{ if (!ctx.u) deny(); return ctx.u; };
const requireTablet=ctx=>{ if (ctx.station&&ctx.station.kind!=='tablet') deny(); };

async function stationBody(u,body,existing) {
  const plant=existing?await byId('plants',existing.plant_id):await byId('plants',required(body.plantId,'plantId',100)); if (!plant) bad('Unknown plant');
  if (!A.canManageFloor(u,plant.company_id)) deny();
  const kind=existing?existing.kind:choice(body.kind??'tablet','kind',['tablet','board']);
  let machines=null;
  if (kind==='tablet'&&(body.equipmentIds!==undefined||!existing)) {
    const ids=[...new Set(array(body.equipmentIds,'equipmentIds'))]; if (!ids.length||ids.length>20) bad('A tablet needs 1 to 20 machines');
    machines=await mapSeq(ids,async k=>{ const e=await byId('equipment',String(k)); if (!e||e.company_id!==plant.company_id||e.plant_id!==plant.id||!PRODUCTION_MACHINES.includes(e.machine_type)) bad('equipmentIds must be production machines of the station\'s plant'); return e.id; });
  }
  return {plant,kind,name:body.name!==undefined||!existing?required(body.name,'name',80):existing.name,machines,pin:body.pin!==undefined||!existing?A.validPin(body.pin):null};
}
async function setMachines(stationId,ids) { await run('DELETE FROM operator_station_machines WHERE station_id=?',stationId); for (const e of ids) await run('INSERT INTO operator_station_machines (station_id,equipment_id) VALUES (?,?)',stationId,e); }
const stationFor=async (u,key)=>{ const s=await byId('operator_stations',key); if (!s) missing(); if (!A.canFloor(u,s.company_id)) deny(); return s; };

export function register(r) {
  // ---------- Station sign-in ----------
  // Body {code, pin}. Five wrong PINs in a row lock the station for 15 minutes (a supervisor can unlock it).
  r.post('/operator/login',async ({body,req})=>{
    const ip=req.socket.remoteAddress||'?';
    if (ipBlocked(ip)) throw new HttpError(429,'Too many failed station sign-ins from this device. Wait 15 minutes and try again.');
    const code=A.normCode(body.code), pin=typeof body.pin==='number'?String(body.pin):body.pin;
    const wrong=()=>reply(401,{error:'Station code or PIN is incorrect.'});
    if (!code||typeof pin!=='string'||!/^\d{4,8}$/.test(pin)) { ipFail(ip); return wrong(); }
    const s=await one('SELECT * FROM operator_stations WHERE code=?',code);
    if (!s||!s.active) { verifyPassword(pin,DUMMY_PIN); ipFail(ip); return wrong(); }
    if (s.locked_until&&s.locked_until>now()) { const left=Math.max(1,Math.ceil((Date.parse(s.locked_until)-Date.now())/60000)); throw Object.assign(new HttpError(429,`This station is locked after too many wrong PINs. Try again in ${left} minute${left===1?'':'s'}, or ask a supervisor to unlock it.`),{headers:{'retry-after':String(left*60)}}); }
    if (!verifyPassword(pin,s.pin_hash)) {
      // Not thrown: the failed attempt must be committed, so it is returned as a reply.
      const attempts=s.failed_attempts+1, lock=attempts>=A.MAX_PIN_FAILURES, until=lock?new Date(Date.now()+A.LOCK_MS).toISOString():null;
      await run('UPDATE operator_stations SET failed_attempts=?,locked_until=? WHERE id=?',lock?0:attempts,until,s.id);
      await audit(A.SYSTEM,lock?'station.locked':'station.login_failed','operator_station',s.id,s.company_id,{attempts,ip});
      ipFail(ip);
      return lock?reply(429,{error:'Wrong PIN. This station is now locked for 15 minutes.'}):reply(401,{error:`Station code or PIN is incorrect. ${A.MAX_PIN_FAILURES-attempts} attempt${A.MAX_PIN_FAILURES-attempts===1?'':'s'} left before the station locks.`,attemptsLeft:A.MAX_PIN_FAILURES-attempts});
    }
    await run('UPDATE operator_stations SET failed_attempts=0,locked_until=NULL,last_login_at=? WHERE id=?',now(),s.id);
    await audit(A.SYSTEM,'station.login','operator_station',s.id,s.company_id,{ip});
    return {token:A.stationToken(s),station:await A.stationOut(s)};
  },{public:true});
  // Who is at the tablet and which machines it can work on (a person: their company's machines).
  r.get('/operator/me',async (ctx)=>{
    const machines=(await A.machinesOf(ctx,ctx.query.get('plantId')||null)).map(e=>({id:e.id,assetTag:e.asset_tag,make:e.make,model:e.model,plantId:e.plant_id,location:e.location}));
    if (ctx.station) { const {pin_hash,...s}=ctx.station; return {station:await A.stationOut(s),machines}; }
    const plants=isDispatch(ctx.u)?await all('SELECT id,name,company_id FROM plants ORDER BY name'):isCustomer(ctx.u)?await all('SELECT id,name,company_id FROM plants WHERE company_id=? ORDER BY name',ctx.u.company_id):[];
    return {user:{id:ctx.u.id,name:ctx.u.name,role:ctx.u.role,companyId:ctx.u.company_id},plants,machines};
  },{station:true});

  // ---------- At the machine ----------
  r.get('/operator/machines/:id',async (ctx)=>await A.machineView(await A.machineFor(ctx,ctx.params.id)),{station:true});
  r.post('/operator/machines/:id/downtime',async (ctx)=>{ requireTablet(ctx); const e=await A.machineFor(ctx,ctx.params.id,{write:true}); const stateId=await A.recordDowntime(e,ctx.body,A.actorOf(ctx)); return {stateId,machine:await A.machineView(e)}; },{station:true});
  r.post('/operator/machines/:id/resume',async (ctx)=>{ requireTablet(ctx); const e=await A.machineFor(ctx,ctx.params.id,{write:true}); await A.resumeMachine(e,A.actorOf(ctx)); return {machine:await A.machineView(e)}; },{station:true});
  r.post('/operator/machines/:id/scrap',async (ctx)=>{ requireTablet(ctx); const e=await A.machineFor(ctx,ctx.params.id,{write:true}); const key=await A.recordScrap(e,ctx.body,A.actorOf(ctx)); return created({id:key,machine:await A.machineView(e)}); },{station:true});
  r.post('/operator/machines/:id/job',async (ctx)=>{ requireTablet(ctx); const e=await A.machineFor(ctx,ctx.params.id,{write:true}); await A.jobAction(e,ctx.body,A.actorOf(ctx)); return {machine:await A.machineView(e)}; },{station:true});
  r.post('/operator/machines/:id/andon',async (ctx)=>{ requireTablet(ctx); const e=await A.machineFor(ctx,ctx.params.id,{write:true}); const {call,created:isNew}=await A.raiseAndon(e,ctx.body,A.actorOf(ctx)); return reply(isNew?201:200,{created:isNew,call:await A.callView(call)}); },{station:true});

  // ---------- Andon calls ----------
  // ?status=active (default) or all, ?plantId, ?from/&to (with all). A tablet sees its machines' calls.
  r.get('/andon/calls',async (ctx)=>{
    const status=choice(ctx.query.get('status')||'active','status',['active','all']), machines=await A.machinesOf(ctx,ctx.query.get('plantId')||null);
    if (!machines.length) return [];
    const ids=machines.map(e=>e.id), args=[...ids]; let where=`equipment_id IN (${ids.map(()=>'?').join(',')})`;
    if (status==='active') where+=" AND status<>'resolved'"; else { const {from,to}=range(ctx.query); where+=' AND raised_at>=? AND raised_at<?'; args.push(new Date(from).toISOString(),new Date(to).toISOString()); }
    return await mapSeq(await all(`SELECT * FROM andon_calls WHERE ${where} ORDER BY raised_at DESC LIMIT 300`,...args),A.callView);
  },{station:true});
  r.post('/andon/calls/:id/acknowledge',async (ctx)=>{ const c=await A.callFor(ctx,ctx.params.id); await A.acknowledgeCall(c,A.actorOf({...ctx,body:{operator:ctx.body.name??ctx.body.operator}})); return await A.callView(await byId('andon_calls',c.id)); },{station:true});
  r.post('/andon/calls/:id/resolve',async (ctx)=>{ const c=await A.callFor(ctx,ctx.params.id); await A.resolveCall(c,ctx.body,A.actorOf(ctx)); return await A.callView(await byId('andon_calls',c.id)); },{station:true});
  r.post('/andon/calls/:id/ticket',async (ctx)=>{
    const c=await A.callFor(ctx,ctx.params.id);
    if (ctx.u&&!(isCustomer(ctx.u)||isDispatch(ctx.u))) deny();
    const out=await A.ticketFromCall(c,ctx.body,A.actorOf(ctx));
    return reply(out.created?201:200,{...out,call:await A.callView(await byId('andon_calls',c.id))});
  },{station:true});

  // ---------- Board (TV) ----------
  // A board or tablet station shows its own plant; a person picks one of their plants (?plantId).
  r.get('/andon/board',async (ctx)=>{
    let plant;
    if (ctx.station) plant=await byId('plants',ctx.station.plant_id);
    else { const key=ctx.query.get('plantId'); plant=key?await byId('plants',key):isCustomer(ctx.u)?await one('SELECT * FROM plants WHERE company_id=? ORDER BY name LIMIT 1',ctx.u.company_id):await one('SELECT * FROM plants ORDER BY name LIMIT 1'); if (!plant) missing(); if (!A.canFloor(ctx.u,plant.company_id)) deny(); }
    return await A.boardFor(await A.machinesOf(ctx,plant.id),plant);
  },{station:true});

  // ---------- Settings, stations and reports (people only) ----------
  const companyParam=(u,v)=>{ const companyId=v||u.company_id; if (!companyId) bad('companyId is required'); if (!A.canFloor(u,companyId)) deny(); return companyId; };
  r.get('/andon/settings',async (ctx)=>{ const u=requireUser(ctx), companyId=companyParam(u,ctx.query.get('companyId')); return {companyId,types:await A.andonSettings(companyId),defaults:A.DEFAULT_ANDON,roles:A.NOTIFY_ROLES}; });
  r.put('/andon/settings',async (ctx)=>{
    const u=requireUser(ctx), companyId=companyParam(u,ctx.body.companyId); if (!A.canManageFloor(u,companyId)) deny();
    const merged={...await A.andonSettings(companyId),...A.settingsBody(ctx.body.types)};
    await run('INSERT INTO andon_settings (company_id,config,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT (company_id) DO UPDATE SET config=excluded.config,updated_by=excluded.updated_by,updated_at=excluded.updated_at',companyId,JSON.stringify(merged),u.id,now());
    await audit(u,'andon.settings','company',companyId,companyId,{types:Object.keys(ctx.body.types||{})});
    return {companyId,types:await A.andonSettings(companyId),defaults:A.DEFAULT_ANDON,roles:A.NOTIFY_ROLES};
  });
  r.get('/andon/report',async (ctx)=>{
    const u=requireUser(ctx); if (!(isCustomer(u)||isDispatch(u))) deny();
    const {from,to}=range(ctx.query), plantId=ctx.query.get('plantId')||null;
    if (plantId) { const p=await byId('plants',plantId); if (!p) missing(); if (!A.canFloor(u,p.company_id)) deny(); }
    const companies=isDispatch(u)?(await all('SELECT id FROM companies')).map(c=>c.id):[u.company_id];
    return await A.andonReport(companies,{plantId,from,to});
  });
  r.get('/operator/stations',async (ctx)=>{ const u=requireUser(ctx); if (!(isCustomer(u)||isDispatch(u))) deny();
    const rows=isDispatch(u)?await all('SELECT * FROM operator_stations ORDER BY name'):await all('SELECT * FROM operator_stations WHERE company_id=? ORDER BY name',u.company_id); return await mapSeq(rows,A.stationOut); });
  // Body {plantId, name, kind:'tablet'|'board', equipmentIds (tablet), pin}. The station code is shown here and in the list.
  r.post('/operator/stations',async (ctx)=>{
    const u=requireUser(ctx), s=await stationBody(u,ctx.body), key=id(), code=await A.newStationCode();
    await run('INSERT INTO operator_stations (id,company_id,plant_id,name,kind,code,pin_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,s.plant.company_id,s.plant.id,s.name,s.kind,code,A.hashPin(s.pin),u.id,now());
    if (s.machines) await setMachines(key,s.machines);
    await audit(u,'station.create','operator_station',key,s.plant.company_id,{kind:s.kind,plantId:s.plant.id,equipmentIds:s.machines||[]});
    return created(await A.stationOut(await byId('operator_stations',key)));
  });
  // Body: any of {name, equipmentIds, pin, active, unlock:true, signOut:true}. A new PIN, deactivating or signOut
  // signs every tablet using the station out.
  r.patch('/operator/stations/:id',async (ctx)=>{
    const u=requireUser(ctx), existing=await stationFor(u,ctx.params.id); if (!A.canManageFloor(u,existing.company_id)) deny();
    const s=await stationBody(u,ctx.body,existing), body=ctx.body;
    const active=body.active===undefined?existing.active:body.active===true?1:body.active===false?0:bad('active must be true or false');
    const revoke=!!s.pin||body.signOut===true||(active===0&&existing.active===1);
    await run('UPDATE operator_stations SET name=?,active=?,pin_hash=?,session_version=session_version+?,failed_attempts=CASE WHEN ?=1 THEN 0 ELSE failed_attempts END,locked_until=CASE WHEN ?=1 THEN NULL ELSE locked_until END WHERE id=?',
      s.name,active,s.pin?A.hashPin(s.pin):existing.pin_hash,revoke?1:0,body.unlock===true||!!s.pin,body.unlock===true||!!s.pin,existing.id);
    if (s.machines) await setMachines(existing.id,s.machines);
    await audit(u,'station.update','operator_station',existing.id,existing.company_id,{fields:Object.keys(body).filter(k=>k!=='pin'),pinChanged:!!s.pin,signedOut:revoke});
    return await A.stationOut(await byId('operator_stations',existing.id));
  });
}
