// Vision AI routes.
// - Edge API (/edge/v1/...): GPU edge nodes authenticate with their own key, report health and detections, upload
//   evidence and fetch the configuration they should run.
// - Management API (/vision/...): licences, nodes, cameras, module routing, geofences, incidents, dashboards.
// Viewing follows company access; configuring is for platform admins and the company's customer admin.
import { id, now, one, all, run, transaction, mapSeq } from '../../../common/db.js';
import { canCompany, canManageCompany, isCustomer, isPlatform } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { HttpError, bad, choice, deny, missing, required } from '../../../common/validate.js';
import { created } from '../../../common/http.js';
import { resolveAlertKey } from '../../factory/alerts.js';
import { CAMERA_VENDORS, MODULES, MODULE_KEYS, PPE_GEAR, QUALITY_PRESETS, SOURCE_TYPES, ZONE_KINDS, bumpCamera, bumpNode, heartbeat, ingestBatch, licence, moduleConfig, newNodeKey,
  nodeConfig, nodeFromRequest, nodeStatus, readMedia, storeMedia, visionCatalog, visionSettings } from '../vision.js';
import { falseAlarmReport } from '../analytics.js';
import { REVIEW_MODES, reviewEvent, reviewMode, reviewOf, reviewStats } from '../review.js';
import { aiEnabled } from '../../assistant/assistant.js';

const parse=(v,fallback)=>{ try { return JSON.parse(v); } catch { return fallback; } };
// Camera URLs often carry a password (rtsp://user:pass@host). People see it masked; the edge node gets it in full.
const mask=url=>String(url||'').replace(/(\/\/[^:/@\s]+:)[^@/\s]+@/,'$1****@').replace(/((?:password|pwd|pass)=)[^&\s]+/gi,'$1****');
function companyScope(u) { if (isDispatch(u)) return null; if (isCustomer(u)) return [u.company_id]; deny(); }
const scopeSql=(u,col='company_id')=>{ const ids=companyScope(u); return ids?[`${col} IN (${ids.map(()=>'?').join(',')})`,ids]:['1=1',[]]; };
const view=(u,companyId)=>{ if (!canCompany(u,companyId)) deny(); };
const manage=(u,companyId)=>{ if (!canManageCompany(u,companyId)) deny(); };
const getNode=async (u,key)=>{ const n=await byId('vision_nodes',key); if (!n) missing(); view(u,n.company_id); return n; };
const getCamera=async (u,key)=>{ const c=await byId('vision_cameras',key); if (!c) missing(); view(u,c.company_id); return c; };
const getEvent=async (u,key)=>{ const e=await byId('vision_events',key); if (!e) missing(); view(u,e.company_id); return e; };
const nodeOut=async n=>({id:n.id,companyId:n.company_id,plantId:n.plant_id,name:n.name,hardware:n.hardware,maxStreams:n.max_streams,keyHint:n.key_hint,active:!!n.active,status:nodeStatus(n),
  lastSeenAt:n.last_seen_at,agentVersion:n.agent_version,metrics:parse(n.metrics,{}),configVersion:n.config_version,cameras:(await one('SELECT count(*) n FROM vision_cameras WHERE node_id=? AND active=1',n.id)).n});
const cameraOut=async c=>({id:c.id,companyId:c.company_id,plantId:c.plant_id,nodeId:c.node_id,name:c.name,vendor:c.vendor,sourceType:c.source_type,sourceUrl:mask(c.source_url),location:c.location,zoneId:c.zone_id,
  equipmentId:c.equipment_id,fps:c.fps,snapshotMediaId:c.snapshot_media_id,status:c.status,lastSeenAt:c.last_seen_at,metrics:parse(c.metrics,{}),active:!!c.active,
  modules:(await all('SELECT module,enabled,config,updated_at FROM vision_assignments WHERE camera_id=? ORDER BY module',c.id)).map(a=>({module:a.module,enabled:!!a.enabled,config:parse(a.config,{}),updatedAt:a.updated_at})),
  zones:(await one('SELECT count(*) n FROM vision_zones WHERE camera_id=? AND active=1',c.id)).n});
const zoneOut=z=>({id:z.id,cameraId:z.camera_id,name:z.name,kind:z.kind,surfaceClass:z.surface_class,points:parse(z.points,[]),severity:z.severity,classes:parse(z.classes,[]),active:!!z.active,updatedAt:z.updated_at});
const eventOut=e=>({id:e.id,companyId:e.company_id,plantId:e.plant_id,cameraId:e.camera_id,cameraName:e.camera_name,location:e.location,nodeId:e.node_id,module:e.module,type:e.type,severity:e.severity,confidence:e.confidence,
  occurredAt:e.occurred_at,receivedAt:e.received_at,latencyMs:e.latency_ms,zoneId:e.zone_id,zoneName:e.zone_name,detail:parse(e.detail,{}),boxes:parse(e.boxes,[]),edgeActions:parse(e.edge_actions,{}),
  snapshotMediaId:e.snapshot_media_id,clipMediaId:e.clip_media_id,status:e.status,acknowledgedBy:e.ack_name??null,acknowledgedAt:e.acknowledged_at,resolvedBy:e.res_name??null,resolvedAt:e.resolved_at,
  resolutionNote:e.resolution_note,locked:!!e.locked,retrain:!!e.retrain,alertId:e.alert_id,safetyEventId:e.safety_event_id});
// The AI second opinion (if any) next to each incident in a list: one query for all of them.
async function withReviews(events) {
  if (!events.length) return events;
  const rows=await all(`SELECT event_id,verdict,reason,description FROM vision_reviews WHERE event_id IN (${events.map(()=>'?').join(',')})`,...events.map(e=>e.id)), byEvent=new Map(rows.map(r=>[r.event_id,{verdict:r.verdict,reason:r.reason,description:r.description}]));
  return events.map(e=>({...e,review:byEvent.get(e.id)??null}));
}
const EVENT_SELECT=`SELECT e.*,c.name camera_name,c.location,z.name zone_name,ua.name ack_name,ur.name res_name FROM vision_events e JOIN vision_cameras c ON c.id=e.camera_id
  LEFT JOIN vision_zones z ON z.id=e.zone_id LEFT JOIN users ua ON ua.id=e.acknowledged_by LEFT JOIN users ur ON ur.id=e.resolved_by`;

function points(v,kind) {
  if (!Array.isArray(v)) bad('points must be a list of [x, y] pairs');
  const pts=v.map((p,i)=>{ if (!Array.isArray(p)||p.length!==2) bad(`points[${i}] must be [x, y]`); return p.map(n=>{ const x=Number(n); if (!Number.isFinite(x)||x<0||x>1) bad(`points[${i}] must be within the image (0..1)`); return Math.round(x*10000)/10000; }); });
  if (kind==='tripwire'?pts.length!==2:pts.length<3||pts.length>50) bad(kind==='tripwire'?'A tripwire needs exactly 2 points':'A zone needs 3 to 50 points');
  return JSON.stringify(pts);
}
async function cameraFields(u,body,existing) {
  const plantId=body.plantId??existing?.plant_id, plant=await byId('plants',plantId); if (!plant) bad('Unknown plant'); manage(u,plant.company_id);
  if (existing&&plant.company_id!==existing.company_id) bad('A camera can only move between plants of the same company');
  const nodeId=body.nodeId===undefined?existing?.node_id??null:body.nodeId||null;
  if (nodeId) { const n=await byId('vision_nodes',nodeId); if (!n||n.company_id!==plant.company_id) bad('Unknown edge node for this company');
    const count=(await one('SELECT count(*) n FROM vision_cameras WHERE node_id=? AND active=1 AND id<>?',n.id,existing?.id??'')).n; if (count>=n.max_streams) bad(`${n.name} already runs ${count} of its ${n.max_streams} camera streams`); }
  const zoneId=body.zoneId===undefined?existing?.zone_id??null:body.zoneId||null; if (zoneId&&(await one('SELECT company_id FROM zones WHERE id=?',zoneId))?.company_id!==plant.company_id) bad('Unknown location zone for this company');
  const equipmentId=body.equipmentId===undefined?existing?.equipment_id??null:body.equipmentId||null; if (equipmentId&&(await byId('equipment',equipmentId))?.company_id!==plant.company_id) bad('Unknown equipment for this company');
  const sourceType=body.sourceType==null?existing?.source_type:choice(body.sourceType,'sourceType',SOURCE_TYPES); if (!sourceType) bad('sourceType is required');
  // A masked URL sent back unchanged keeps the stored one (with its password).
  const rawUrl=body.sourceUrl===undefined||String(body.sourceUrl).includes('****')?existing?.source_url??'':String(body.sourceUrl).trim().slice(0,500);
  if (!['csi','visionforge'].includes(sourceType)&&!rawUrl) bad('sourceUrl is required for this camera type (stream URL, snapshot URL, camera address or folder)');
  const fps=body.fps==null?existing?.fps??25:Number(body.fps); if (!Number.isInteger(fps)||fps<1||fps>120) bad('fps must be 1 to 120');
  const vendor=body.vendor===undefined?existing?.vendor??'':body.vendor===''?'':choice(body.vendor,'vendor',CAMERA_VENDORS);
  return {companyId:plant.company_id,plantId:plant.id,nodeId,zoneId,equipmentId,sourceType,sourceUrl:rawUrl,fps,vendor,name:body.name==null?existing?.name:required(body.name,'name',80),location:body.location==null?existing?.location??'':String(body.location).trim().slice(0,120)};
}

export function register(r) {
  // ---------- Edge API ----------
  const edge=async req=>{ const n=await nodeFromRequest(req); if (!n) throw new HttpError(401,'Edge node key missing, wrong or revoked'); return n; };
  r.post('/edge/v1/heartbeat',async ({req,body})=>await heartbeat(await edge(req),body||{}),{public:true});
  r.get('/edge/v1/config',async ({req})=>await nodeConfig(await edge(req)),{public:true});
  r.post('/edge/v1/events',async ({req,body})=>{ const n=await edge(req); const results=await ingestBatch(n,body.events); return {accepted:results.filter(x=>x.status==='accepted').length,duplicates:results.filter(x=>x.status==='duplicate').length,rejected:results.filter(x=>x.status==='rejected').length,results}; },{public:true});
  // Evidence: a snapshot or 10-second clip for an event (by its id or the node's externalId), or a camera's frame
  // used as the background for drawing zones.
  r.post('/edge/v1/media',async ({req,body})=>{
    const n=await edge(req), kind=choice(body.kind,'kind',['snapshot','clip','frame']);
    if (kind==='frame') { const c=await one('SELECT * FROM vision_cameras WHERE id=? AND node_id=?',body.cameraId,n.id); if (!c) bad('cameraId is not a camera of this node');
      const m=await storeMedia(c.company_id,{kind,mime:body.mime,base64:body.base64}); await run('UPDATE vision_cameras SET snapshot_media_id=? WHERE id=?',m.id,c.id); return created({id:m.id}); }
    const e=await one('SELECT * FROM vision_events WHERE node_id=? AND (id=? OR external_id=?)',n.id,String(body.eventId||''),String(body.eventId||'')); if (!e) bad('eventId is not an event of this node');
    const column=kind==='clip'?'clip_media_id':'snapshot_media_id'; if (e[column]) return {id:e[column],status:'duplicate'};
    const m=await storeMedia(e.company_id,{kind,mime:body.mime,base64:body.base64}); await run(`UPDATE vision_events SET ${column}=? WHERE id=?`,m.id,e.id); return created({id:m.id});
  },{public:true});

  // ---------- Catalogue, licences, settings ----------
  r.get('/vision/catalog',({u})=>{ companyScope(u); return visionCatalog(); });
  r.get('/vision/licences',async ({u})=>{ const [where,args]=scopeSql(u,'id');
    return (await mapSeq((await all(`SELECT id,name FROM companies WHERE ${where} ORDER BY name`,...args)), async c=>({companyId:c.id,companyName:c.name,modules:(await mapSeq(MODULE_KEYS, async m=>await licence(c.id,m)))}))); });
  r.put('/vision/licences/:companyId/:module',async ({u,body,params})=>{
    if (!isPlatform(u)) deny(); if (!await byId('companies',params.companyId)) missing(); const module=choice(params.module,'module',MODULE_KEYS);
    const cameras=Number(body.cameras); if (!Number.isInteger(cameras)||cameras<0||cameras>10000) bad('cameras must be a whole number from 0');
    const validUntil=body.validUntil?String(body.validUntil).slice(0,10):null; if (validUntil&&!/^\d{4}-\d\d-\d\d$/.test(validUntil)) bad('validUntil must be a date (YYYY-MM-DD)');
    await run('INSERT INTO vision_licences (company_id,module,cameras,valid_until,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(company_id,module) DO UPDATE SET cameras=excluded.cameras,valid_until=excluded.valid_until,updated_at=excluded.updated_at',params.companyId,module,cameras,validUntil,now());
    for (const n of await all('SELECT id FROM vision_nodes WHERE company_id=?',params.companyId)) await bumpNode(n.id);
    await audit(u,'vision.licence','vision_licence',`${params.companyId}:${module}`,params.companyId,{cameras,validUntil}); return await licence(params.companyId,module);
  });

  // ---------- Edge nodes ----------
  r.get('/vision/nodes',async ({u})=>{ const [where,args]=scopeSql(u); return (await mapSeq((await all(`SELECT * FROM vision_nodes WHERE ${where} ORDER BY name`,...args)), nodeOut)); });
  r.post('/vision/nodes',async ({u,body})=>{
    const plant=await byId('plants',body.plantId); if (!plant) bad('Unknown plant'); manage(u,plant.company_id);
    const maxStreams=body.maxStreams==null?16:Number(body.maxStreams); if (!Number.isInteger(maxStreams)||maxStreams<1||maxStreams>64) bad('maxStreams must be 1 to 64');
    const k=newNodeKey(), key=id();
    await run('INSERT INTO vision_nodes (id,company_id,plant_id,name,hardware,max_streams,key_hash,key_hint,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,plant.company_id,plant.id,required(body.name,'name',80),String(body.hardware||'').slice(0,160),maxStreams,k.hash,k.hint,now());
    await audit(u,'vision.node.create','vision_node',key,plant.company_id);
    // The key is shown once; only its hash is stored.
    return created({node:await nodeOut(await byId('vision_nodes',key)),key:k.key});
  });
  r.patch('/vision/nodes/:id',async ({u,body,params})=>{
    const n=await getNode(u,params.id); manage(u,n.company_id);
    const maxStreams=body.maxStreams==null?n.max_streams:Number(body.maxStreams); if (!Number.isInteger(maxStreams)||maxStreams<1||maxStreams>64) bad('maxStreams must be 1 to 64');
    await run('UPDATE vision_nodes SET name=?,hardware=?,max_streams=?,active=?,config_version=config_version+1 WHERE id=?',body.name==null?n.name:required(body.name,'name',80),body.hardware==null?n.hardware:String(body.hardware).slice(0,160),maxStreams,body.active==null?n.active:body.active?1:0,n.id);
    await audit(u,'vision.node.update','vision_node',n.id,n.company_id,{fields:Object.keys(body)}); return await nodeOut(await byId('vision_nodes',n.id));
  });
  r.post('/vision/nodes/:id/key',async ({u,params})=>{ const n=await getNode(u,params.id); manage(u,n.company_id); const k=newNodeKey();
    await run('UPDATE vision_nodes SET key_hash=?,key_hint=? WHERE id=?',k.hash,k.hint,n.id); await audit(u,'vision.node.key','vision_node',n.id,n.company_id); return {node:await nodeOut(await byId('vision_nodes',n.id)),key:k.key}; });
  // The configuration a node runs, as the node will receive it (passwords in camera URLs masked).
  r.get('/vision/nodes/:id/config',async ({u,params})=>{ const n=await getNode(u,params.id); const c=await nodeConfig(n); return {...c,cameras:c.cameras.map(x=>({...x,sourceUrl:mask(x.sourceUrl)}))}; });

  // ---------- Cameras and module routing ----------
  r.get('/vision/cameras',async ({u})=>{ const [where,args]=scopeSql(u); return (await mapSeq((await all(`SELECT * FROM vision_cameras WHERE ${where} ORDER BY name`,...args)), cameraOut)); });
  r.post('/vision/cameras',async ({u,body})=>{
    const f=await cameraFields(u,body), key=id();
    await run('INSERT INTO vision_cameras (id,company_id,plant_id,node_id,name,source_type,source_url,location,zone_id,equipment_id,fps,vendor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',key,f.companyId,f.plantId,f.nodeId,f.name,f.sourceType,f.sourceUrl,f.location,f.zoneId,f.equipmentId,f.fps,f.vendor,now());
    await bumpNode(f.nodeId); await audit(u,'vision.camera.create','vision_camera',key,f.companyId); return created(await cameraOut(await byId('vision_cameras',key)));
  });
  r.patch('/vision/cameras/:id',async ({u,body,params})=>{
    const c=await getCamera(u,params.id), f=await cameraFields(u,body,c), active=body.active==null?c.active:body.active?1:0;
    await run('UPDATE vision_cameras SET plant_id=?,node_id=?,name=?,source_type=?,source_url=?,location=?,zone_id=?,equipment_id=?,fps=?,vendor=?,active=? WHERE id=?',f.plantId,f.nodeId,f.name,f.sourceType,f.sourceUrl,f.location,f.zoneId,f.equipmentId,f.fps,f.vendor,active,c.id);
    await bumpNode(c.node_id); await bumpNode(f.nodeId); await audit(u,'vision.camera.update','vision_camera',c.id,c.company_id,{fields:Object.keys(body)}); return await cameraOut(await byId('vision_cameras',c.id));
  });
  // Assign (or update) a module on a camera. Enabling takes a licence seat.
  r.put('/vision/cameras/:id/modules/:module',async ({u,body,params})=>{
    const c=await getCamera(u,params.id); manage(u,c.company_id); const module=choice(params.module,'module',MODULE_KEYS), enabled=body.enabled!==false;
    const current=await one('SELECT * FROM vision_assignments WHERE camera_id=? AND module=?',c.id,module);
    if (enabled&&!current?.enabled) { const l=await licence(c.company_id,module);
      if (!l.valid) bad(`No valid ${MODULES[module].label} licence for this company. Ask the platform administrator to add one.`);
      if (!l.available) bad(`All ${l.cameras} ${MODULES[module].label} licences are in use. Free one on another camera or extend the licence.`); }
    const config=JSON.stringify(moduleConfig(module,body.config??(current?parse(current.config,{}):{})));
    await run('INSERT INTO vision_assignments (camera_id,module,enabled,config,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(camera_id,module) DO UPDATE SET enabled=excluded.enabled,config=excluded.config,updated_by=excluded.updated_by,updated_at=excluded.updated_at',c.id,module,enabled?1:0,config,u.id,now());
    await bumpNode(c.node_id); await audit(u,'vision.module.assign','vision_camera',c.id,c.company_id,{module,enabled}); return await cameraOut(await byId('vision_cameras',c.id));
  });
  r.delete('/vision/cameras/:id/modules/:module',async ({u,params})=>{ const c=await getCamera(u,params.id); manage(u,c.company_id); const module=choice(params.module,'module',MODULE_KEYS);
    await run('DELETE FROM vision_assignments WHERE camera_id=? AND module=?',c.id,module); await bumpNode(c.node_id); await audit(u,'vision.module.remove','vision_camera',c.id,c.company_id,{module}); return await cameraOut(await byId('vision_cameras',c.id)); });

  // ---------- Geofences ----------
  r.get('/vision/cameras/:id/zones',async ({u,params})=>{ const c=await getCamera(u,params.id); return (await all('SELECT * FROM vision_zones WHERE camera_id=? ORDER BY created_at',c.id)).map(zoneOut); });
  const zoneBody=(body,existing)=>{ const kind=body.kind==null?existing?.kind:choice(body.kind,'kind',Object.keys(ZONE_KINDS));
    const classes=body.classes==null?existing?.classes??'["person","vehicle"]':JSON.stringify([...new Set(Array.isArray(body.classes)?body.classes:[])].filter(x=>['person','vehicle'].includes(x)));
    if (classes==='[]') bad('classes must include person and/or vehicle');
    return {kind,name:body.name==null?existing?.name:required(body.name,'name',80),points:body.points==null?existing?.points:points(body.points,kind),
      severity:body.severity==null?existing?.severity??'critical':choice(body.severity,'severity',['warning','critical']),classes,active:body.active==null?existing?.active??1:body.active?1:0,
      // Surface class A/B/C (VDA 16) applies to inspection areas: it picks the acceptance limit for defects inside.
      surfaceClass:kind==='inspection_roi'?(body.surfaceClass==null?existing?.surface_class??'A':choice(body.surfaceClass,'surfaceClass',['A','B','C'])):null}; };
  r.post('/vision/cameras/:id/zones',async ({u,body,params})=>{ const c=await getCamera(u,params.id); manage(u,c.company_id); const z=zoneBody(body); if (!z.points) bad('points are required'); const key=id(), at=now();
    await run('INSERT INTO vision_zones (id,camera_id,name,kind,points,severity,classes,active,created_at,updated_at,surface_class) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,c.id,z.name,z.kind,z.points,z.severity,z.classes,z.active,at,at,z.surfaceClass);
    await bumpNode(c.node_id); await audit(u,'vision.zone.create','vision_camera',c.id,c.company_id,{zoneId:key,kind:z.kind}); return created(zoneOut(await byId('vision_zones',key))); });
  r.patch('/vision/zones/:id',async ({u,body,params})=>{ const z0=await byId('vision_zones',params.id); if (!z0) missing(); const c=await getCamera(u,z0.camera_id); manage(u,c.company_id);
    if (body.kind&&body.kind!==z0.kind&&body.points==null) bad('Send the points again when changing the kind of a zone');
    const z=zoneBody(body,z0); await run('UPDATE vision_zones SET name=?,kind=?,points=?,severity=?,classes=?,active=?,updated_at=?,surface_class=? WHERE id=?',z.name,z.kind,z.points,z.severity,z.classes,z.active,now(),z.surfaceClass,z0.id);
    await bumpNode(c.node_id); await audit(u,'vision.zone.update','vision_camera',c.id,c.company_id,{zoneId:z0.id}); return zoneOut(await byId('vision_zones',z0.id)); });
  r.delete('/vision/zones/:id',async ({u,params})=>{ const z=await byId('vision_zones',params.id); if (!z) missing(); const c=await getCamera(u,z.camera_id); manage(u,c.company_id);
    // Zones referenced by incidents are deactivated rather than deleted, so the incident record stays complete.
    if (await one('SELECT 1 FROM vision_events WHERE zone_id=?',z.id)) await run('UPDATE vision_zones SET active=0,updated_at=? WHERE id=?',now(),z.id); else await run('DELETE FROM vision_zones WHERE id=?',z.id);
    await bumpNode(c.node_id); await audit(u,'vision.zone.delete','vision_camera',c.id,c.company_id,{zoneId:z.id}); return {deleted:true}; });

  // ---------- Incidents ----------
  const eventQuery=(u,query)=>{ const [where,args]=scopeSql(u,'e.company_id'), cond=[where], a=[...args];
    for (const [k,col,opts] of [['module','e.module',[...MODULE_KEYS,'system']],['severity','e.severity',['info','warning','critical']],['status','e.status',['open','acknowledged','resolved','false_alarm']]]) { const v=query.get(k); if (v) { cond.push(`${col}=?`); a.push(choice(v,k,opts)); } }
    if (query.get('cameraId')) { cond.push('e.camera_id=?'); a.push(query.get('cameraId')); }
    if (query.get('plantId')) { cond.push('e.plant_id=?'); a.push(query.get('plantId')); }
    if (query.get('retrain')==='1') cond.push('e.retrain=1');
    const hours=Number(query.get('hours')||0); if (hours>0) { cond.push('e.occurred_at>=?'); a.push(new Date(Date.now()-Math.min(hours,24*400)*3600000).toISOString()); }
    return [cond.join(' AND '),a]; };
  r.get('/vision/events',async ({u,query})=>{ const [where,args]=eventQuery(u,query), limit=Math.min(500,Math.max(1,Number(query.get('limit'))||200));
    return await withReviews((await all(`${EVENT_SELECT} WHERE ${where} ORDER BY e.occurred_at DESC LIMIT ?`,...args,limit)).map(eventOut)); });
  // Proof-of-violation log: every matching incident with who handled it and how, as CSV for audits.
  r.get('/vision/events.csv',async ({u,query,res})=>{ const [where,args]=eventQuery(u,query); const rows=(await all(`${EVENT_SELECT} WHERE ${where} ORDER BY e.occurred_at DESC LIMIT 20000`,...args)).map(eventOut);
    const cell=v=>{ const s=String(v??''); return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; };
    const head=['Occurred (UTC)','Camera','Location','Module','Type','Severity','Confidence','Zone','Detail','Status','Acknowledged by','Acknowledged at','Resolved by','Resolved at','Note','Evidence locked','Snapshot','Clip','Incident ID'];
    const lines=rows.map(e=>[e.occurredAt,e.cameraName,e.location,MODULES[e.module]?.label||e.module,e.type,e.severity,e.confidence,e.zoneName,e.module==='ppe'?`missing: ${(e.detail.missing||[]).map(g=>PPE_GEAR[g]||g).join(', ')}`:e.module==='quality'?`${e.detail.preset} ${e.detail.defect}${e.detail.sizeMm?` ${e.detail.sizeMm} mm`:''}`:'',
      e.status,e.acknowledgedBy,e.acknowledgedAt,e.resolvedBy,e.resolvedAt,e.resolutionNote,e.locked?'yes':'no',e.snapshotMediaId?'yes':'no',e.clipMediaId?'yes':'no',e.id].map(cell).join(','));
    await audit(u,'vision.export','vision_event','csv',isCustomer(u)?u.company_id:null,{rows:rows.length});
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="vision-incidents-${now().slice(0,10)}.csv"`,'cache-control':'no-store'});
    res.end('﻿'+[head.join(','),...lines].join('\r\n')); });
  r.get('/vision/events/:id',async ({u,params})=>{ const e=await getEvent(u,params.id); return {...eventOut(await one(`${EVENT_SELECT} WHERE e.id=?`,params.id)),review:await reviewOf(e.id),aiReviewMode:await reviewMode(e.company_id),aiEnabled:aiEnabled()}; });
  const close=async (e,status,u,note)=>{ await run('UPDATE vision_events SET status=?,resolved_by=?,resolved_at=?,resolution_note=?,acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?',status,u.id,now(),note,u.id,now(),e.id);
    // The last open incident of a kind on a camera closes its alert too.
    if (e.alert_id&&!await one("SELECT 1 FROM vision_events WHERE alert_id=? AND status IN ('open','acknowledged')",e.alert_id)) { const a=await byId('alerts',e.alert_id); if (a) await resolveAlertKey(a.dedupe_key); } };
  r.post('/vision/events/:id/acknowledge',async ({u,params})=>{ const e=await getEvent(u,params.id); if (e.status!=='open') bad(`This incident is already ${e.status.replace('_',' ')}`);
    await run("UPDATE vision_events SET status='acknowledged',acknowledged_by=?,acknowledged_at=? WHERE id=?",u.id,now(),e.id); await audit(u,'vision.event.ack','vision_event',e.id,e.company_id); return eventOut(await one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  r.post('/vision/events/:id/resolve',async ({u,body,params})=>{ const e=await getEvent(u,params.id); if (['resolved','false_alarm'].includes(e.status)) bad('This incident is already closed');
    await close(e,'resolved',u,required(body.note,'note',1000)); await audit(u,'vision.event.resolve','vision_event',e.id,e.company_id); return eventOut(await one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  // A false alarm can be sent for retraining: it is kept (with its media) for the model training set.
  r.post('/vision/events/:id/false-alarm',async ({u,body,params})=>{ const e=await getEvent(u,params.id); if (['resolved','false_alarm'].includes(e.status)) bad('This incident is already closed');
    await close(e,'false_alarm',u,required(body.note,'note',1000)); await run('UPDATE vision_events SET retrain=? WHERE id=?',body.retrain===false?0:1,e.id);
    await audit(u,'vision.event.false_alarm','vision_event',e.id,e.company_id,{retrain:body.retrain!==false}); return eventOut(await one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  r.post('/vision/events/:id/lock',async ({u,body,params})=>{ const e=await getEvent(u,params.id), locked=body.locked!==false;
    if (!locked) manage(u,e.company_id); // Releasing evidence for automatic deletion needs an administrator.
    await run('UPDATE vision_events SET locked=? WHERE id=?',locked?1:0,e.id); await audit(u,locked?'vision.event.lock':'vision.event.unlock','vision_event',e.id,e.company_id); return eventOut(await one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  r.get('/vision/media/:id',async ({u,params,res})=>{ const m=await byId('vision_media',params.id); if (!m) missing(); view(u,m.company_id);
    res.writeHead(200,{'content-type':m.mime,'content-disposition':'inline','x-content-type-options':'nosniff','cache-control':'private, max-age=600'}); res.end(readMedia(m)); });
  // Training set for the cloud retraining pipeline (FEAT-07): false alarms marked for retraining, with their evidence.
  r.get('/vision/retraining',async ({u})=>{ const [where,args]=scopeSql(u,'e.company_id'); if (!isPlatform(u)&&u.role!=='customer_admin') deny();
    return (await all(`${EVENT_SELECT} WHERE ${where} AND e.retrain=1 ORDER BY e.occurred_at DESC LIMIT 5000`,...args)).map(eventOut).map(e=>({id:e.id,module:e.module,type:e.type,label:'false_positive',
      occurredAt:e.occurredAt,camera:e.cameraName,note:e.resolutionNote,boxes:e.boxes,detail:e.detail,snapshot:e.snapshotMediaId?`/api/vision/media/${e.snapshotMediaId}`:null,clip:e.clipMediaId?`/api/vision/media/${e.clipMediaId}`:null})); });

  // ---------- AI: false-alarm analytics and second opinions ----------
  // How often each kind of incident was a false alarm, by confidence, camera and hour, with a threshold that would bring
  // false alarms under the target (default from settings; 10 % of incidents).
  r.get('/vision/analytics/false-alarms',async ({u,query})=>{
    const ids=companyScope(u), days=[7,30,90,365].includes(Number(query.get('days')))?Number(query.get('days')):30;
    const t=query.get('targetPct')==null?(await visionSettings()).falseAlarmTargetPct:Number(query.get('targetPct')); if (!Number.isFinite(t)||t<0.1||t>50) bad('targetPct must be from 0.1 to 50');
    return await falseAlarmReport(ids,{days,targetPct:t});
  });
  // Per company: whether snapshots may be sent to the AI for a second opinion (off, manual or auto), plus how well it agrees with people.
  r.get('/vision/ai-review',async ({u,query})=>{
    const ids=companyScope(u), days=[7,30,90,365].includes(Number(query.get('days')))?Number(query.get('days')):30;
    const companies=await all(`SELECT id,name,vision_ai_review mode FROM companies ${ids?`WHERE id IN (${ids.map(()=>'?').join(',')})`:''} ORDER BY name`,...(ids||[]));
    return {aiEnabled:aiEnabled(),modes:REVIEW_MODES,companies:companies.map(c=>({id:c.id,name:c.name,mode:c.mode,canManage:canManageCompany(u,c.id)})),stats:await reviewStats(ids,{days})};
  });
  r.patch('/vision/ai-review/:companyId',async ({u,body,params})=>{
    const c=await byId('companies',params.companyId); if (!c) missing(); manage(u,c.id);
    const mode=choice(body.mode,'mode',REVIEW_MODES); await run('UPDATE companies SET vision_ai_review=? WHERE id=?',mode,c.id);
    await audit(u,'vision.ai_review.mode','company',c.id,c.id,{mode}); return {id:c.id,mode};
  });
  // One review per incident: asking again returns the stored one unless a refresh is requested.
  r.post('/vision/events/:id/ai-review',async({u,body,params})=>{
    const e=await getEvent(u,params.id), mode=await reviewMode(e.company_id);
    if (mode==='off') throw new HttpError(403,'AI review is off for this company. A company administrator can turn it on (snapshots are sent to the AI service).');
    const review=await reviewEvent(e,{source:'manual',userId:u.id,refresh:body?.refresh===true});
    if (!review.cached) await audit(u,'vision.event.ai_review','vision_event',e.id,e.company_id,{verdict:review.verdict});
    return review;
  });

  // ---------- Dashboards and alarms ----------
  r.get('/vision/overview',async ({u,query})=>{
    const [where,args]=scopeSql(u,'c.company_id'), plantId=query.get('plantId'), hours=Math.min(24*90,Math.max(1,Number(query.get('hours'))||24)), since=new Date(Date.now()-hours*3600000).toISOString();
    const camWhere=`${where}${plantId?' AND c.plant_id=?':''} AND c.active=1`, camArgs=[...args,...(plantId?[plantId]:[])];
    const cameras=await all(`SELECT c.* FROM vision_cameras c WHERE ${camWhere} ORDER BY c.name`,...camArgs);
    const ids=cameras.map(c=>c.id), inIds=ids.length?`IN (${ids.map(()=>'?').join(',')})`:'IN (NULL)';
    const stats=async m=>await one(`SELECT coalesce(sum(frames),0) frames,coalesce(sum(people),0) people,coalesce(sum(compliant),0) compliant,coalesce(sum(inspected),0) inspected,coalesce(sum(passed),0) passed,coalesce(sum(ignored),0) ignored FROM vision_stats WHERE camera_id ${inIds} AND module=? AND minute>=?`,...ids,m,since.slice(0,16));
    const ev=`FROM vision_events WHERE camera_id ${inIds} AND occurred_at>=?`, evArgs=[...ids,since];
    const count=async (cond,...a)=>(await one(`SELECT count(*) n ${ev} AND ${cond}`,...evArgs,...a)).n;
    const group=async (expr,cond,...a)=>await all(`SELECT ${expr} key,count(*) n ${ev} AND ${cond} GROUP BY 1 ORDER BY n DESC`,...evArgs,...a);
    const ppe=await stats('ppe'), q=await stats('quality'), intr=await stats('intrusion');
    const latest=async c=>await one('SELECT id,type,severity,occurred_at,snapshot_media_id,boxes,status FROM vision_events WHERE camera_id=? ORDER BY occurred_at DESC LIMIT 1',c.id);
    const nodes=await all(`SELECT DISTINCT n.* FROM vision_nodes n JOIN vision_cameras c ON c.node_id=n.id WHERE ${camWhere} UNION SELECT n.* FROM vision_nodes n WHERE ${where.replaceAll('c.company_id','n.company_id')}${plantId?' AND n.plant_id=?':''}`,...camArgs,...args,...(plantId?[plantId]:[]));
    const crit=await all(`SELECT latency_ms,edge_actions ${ev} AND severity='critical'`,...evArgs), p95=xs=>{ const s=xs.filter(x=>x!=null).sort((a,b)=>a-b); return s.length?s[Math.min(s.length-1,Math.floor(s.length*0.95))]:null; };
    return {hours,since,
      cameras:(await mapSeq(cameras, async c=>({...await cameraOut(c),latest:(e=>e&&{...e,boxes:parse(e.boxes,[])})(await latest(c)),
        today:{events:(await one('SELECT count(*) n FROM vision_events WHERE camera_id=? AND occurred_at>=?',c.id,since)).n,...(async ()=>{ const s=await one('SELECT coalesce(sum(inspected),0) i,coalesce(sum(passed),0) p,coalesce(sum(people),0) pe,coalesce(sum(compliant),0) co FROM vision_stats WHERE camera_id=? AND minute>=?',c.id,since.slice(0,16)); return {inspected:s.i,passed:s.p,people:s.pe,compliant:s.co}; })()}}))),
      nodes:[...new Map((await mapSeq(nodes, async n=>[n.id,await nodeOut(n)]))).values()],
      ppe:{people:ppe.people,compliant:ppe.compliant,complianceRate:ppe.people?Math.round(1000*ppe.compliant/ppe.people)/10:null,violations:await count("module='ppe'"),
        byGear:await all(`SELECT j.value AS key,count(*) n ${ev.replace('FROM vision_events',"FROM vision_events, jsonb_array_elements_text(vision_events.detail::jsonb->'missing') AS j(value)")} AND module='ppe' GROUP BY 1 ORDER BY n DESC`,...evArgs),
        byCamera:await group('camera_id',"module='ppe'")},
      fire:{events:await count("module='fire_smoke'"),fire:await count("type='fire'"),smoke:await count("type='smoke'"),falseAlarms:await count("module='fire_smoke' AND status='false_alarm'"),open:await count("module='fire_smoke' AND status IN ('open','acknowledged')")},
      intrusion:{events:await count("module='intrusion'"),people:await count("type='intrusion_person'"),vehicles:await count("type='intrusion_vehicle'"),ignoredMachineMotion:intr.ignored,byZone:await group("coalesce((SELECT name FROM vision_zones z WHERE z.id=zone_id),'—')","module='intrusion'")},
      quality:{inspected:q.inspected,passed:q.passed,defectRate:q.inspected?Math.round(10000*(q.inspected-q.passed)/q.inspected)/100:null,defects:await count("module='quality'"),
        byPreset:await group("json_extract(detail,'$.preset')","module='quality'"),byDefect:await group("json_extract(detail,'$.defect')","module='quality'"),
        logistics:await group("json_extract(detail,'$.defect')","module='quality' AND json_extract(detail,'$.preset')='logistics_container'"),byCamera:await group('camera_id',"module='quality'")},
      latency:{criticalEvents:crit.length,uplinkP95Ms:p95(crit.map(x=>x.latency_ms)),broadcastP95Ms:p95(crit.map(x=>parse(x.edge_actions,{}).broadcastMs??null)),actuatorP95Ms:p95(crit.map(x=>{ const a=parse(x.edge_actions,{}); return a.relayMs??a.plcMs??null; }))},
      open:(await all(`${EVENT_SELECT} WHERE e.camera_id ${inIds} AND e.status IN ('open','acknowledged') AND e.severity IN ('warning','critical') ORDER BY e.severity='critical' DESC,e.occurred_at DESC LIMIT 30`,...ids)).map(eventOut),
      hourly:await all(`SELECT substr(occurred_at,1,13) hour,module,count(*) n ${ev} GROUP BY 1,2 ORDER BY 1`,...evArgs)};
  });
  // Live alarms for the banner: open warning/critical incidents of the last day that match the person's vision
  // duties (fire always). Without duties, critical incidents only.
  r.get('/vision/alarms',async ({u})=>{
    if (!isDispatch(u)&&!isCustomer(u)) return [];
    const [where,args]=scopeSql(u,'e.company_id'), mine=parse((await byId('users',u.id))?.vision_duties,[]);
    const modules=MODULE_KEYS.filter(m=>mine.includes(MODULES[m].duty)||m==='fire_smoke');
    const cond=mine.length?`(e.module IN (${modules.map(()=>'?').join(',')}) AND e.severity IN ('warning','critical'))`:"e.severity='critical'";
    return (await all(`${EVENT_SELECT} WHERE ${where} AND e.status='open' AND ${cond} AND e.occurred_at>=? ORDER BY e.severity='critical' DESC,e.occurred_at DESC LIMIT 20`,...args,...(mine.length?modules:[]),new Date(Date.now()-86400000).toISOString())).map(eventOut);
  });
}
