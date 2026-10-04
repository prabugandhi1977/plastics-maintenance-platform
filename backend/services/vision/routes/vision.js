// Vision AI routes.
// - Edge API (/edge/v1/...): GPU edge nodes authenticate with their own key, report health and detections, upload
//   evidence and fetch the configuration they should run.
// - Management API (/vision/...): licences, nodes, cameras, module routing, geofences, incidents, dashboards.
// Viewing follows company access; configuring is for platform admins and the company's customer admin.
import { id, now, one, all, run, transaction } from '../../../common/db.js';
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
const getNode=(u,key)=>{ const n=byId('vision_nodes',key); if (!n) missing(); view(u,n.company_id); return n; };
const getCamera=(u,key)=>{ const c=byId('vision_cameras',key); if (!c) missing(); view(u,c.company_id); return c; };
const getEvent=(u,key)=>{ const e=byId('vision_events',key); if (!e) missing(); view(u,e.company_id); return e; };
const nodeOut=n=>({id:n.id,companyId:n.company_id,plantId:n.plant_id,name:n.name,hardware:n.hardware,maxStreams:n.max_streams,keyHint:n.key_hint,active:!!n.active,status:nodeStatus(n),
  lastSeenAt:n.last_seen_at,agentVersion:n.agent_version,metrics:parse(n.metrics,{}),configVersion:n.config_version,cameras:one('SELECT count(*) n FROM vision_cameras WHERE node_id=? AND active=1',n.id).n});
const cameraOut=c=>({id:c.id,companyId:c.company_id,plantId:c.plant_id,nodeId:c.node_id,name:c.name,vendor:c.vendor,sourceType:c.source_type,sourceUrl:mask(c.source_url),location:c.location,zoneId:c.zone_id,
  equipmentId:c.equipment_id,fps:c.fps,snapshotMediaId:c.snapshot_media_id,status:c.status,lastSeenAt:c.last_seen_at,metrics:parse(c.metrics,{}),active:!!c.active,
  modules:all('SELECT module,enabled,config,updated_at FROM vision_assignments WHERE camera_id=? ORDER BY module',c.id).map(a=>({module:a.module,enabled:!!a.enabled,config:parse(a.config,{}),updatedAt:a.updated_at})),
  zones:one('SELECT count(*) n FROM vision_zones WHERE camera_id=? AND active=1',c.id).n});
const zoneOut=z=>({id:z.id,cameraId:z.camera_id,name:z.name,kind:z.kind,surfaceClass:z.surface_class,points:parse(z.points,[]),severity:z.severity,classes:parse(z.classes,[]),active:!!z.active,updatedAt:z.updated_at});
const eventOut=e=>({id:e.id,companyId:e.company_id,plantId:e.plant_id,cameraId:e.camera_id,cameraName:e.camera_name,location:e.location,nodeId:e.node_id,module:e.module,type:e.type,severity:e.severity,confidence:e.confidence,
  occurredAt:e.occurred_at,receivedAt:e.received_at,latencyMs:e.latency_ms,zoneId:e.zone_id,zoneName:e.zone_name,detail:parse(e.detail,{}),boxes:parse(e.boxes,[]),edgeActions:parse(e.edge_actions,{}),
  snapshotMediaId:e.snapshot_media_id,clipMediaId:e.clip_media_id,status:e.status,acknowledgedBy:e.ack_name??null,acknowledgedAt:e.acknowledged_at,resolvedBy:e.res_name??null,resolvedAt:e.resolved_at,
  resolutionNote:e.resolution_note,locked:!!e.locked,retrain:!!e.retrain,alertId:e.alert_id,safetyEventId:e.safety_event_id});
// The AI second opinion (if any) next to each incident in a list: one query for all of them.
function withReviews(events) {
  if (!events.length) return events;
  const rows=all(`SELECT event_id,verdict,reason,description FROM vision_reviews WHERE event_id IN (${events.map(()=>'?').join(',')})`,...events.map(e=>e.id)), byEvent=new Map(rows.map(r=>[r.event_id,{verdict:r.verdict,reason:r.reason,description:r.description}]));
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
function cameraFields(u,body,existing) {
  const plantId=body.plantId??existing?.plant_id, plant=byId('plants',plantId); if (!plant) bad('Unknown plant'); manage(u,plant.company_id);
  if (existing&&plant.company_id!==existing.company_id) bad('A camera can only move between plants of the same company');
  const nodeId=body.nodeId===undefined?existing?.node_id??null:body.nodeId||null;
  if (nodeId) { const n=byId('vision_nodes',nodeId); if (!n||n.company_id!==plant.company_id) bad('Unknown edge node for this company');
    const count=one('SELECT count(*) n FROM vision_cameras WHERE node_id=? AND active=1 AND id<>?',n.id,existing?.id??'').n; if (count>=n.max_streams) bad(`${n.name} already runs ${count} of its ${n.max_streams} camera streams`); }
  const zoneId=body.zoneId===undefined?existing?.zone_id??null:body.zoneId||null; if (zoneId&&one('SELECT company_id FROM zones WHERE id=?',zoneId)?.company_id!==plant.company_id) bad('Unknown location zone for this company');
  const equipmentId=body.equipmentId===undefined?existing?.equipment_id??null:body.equipmentId||null; if (equipmentId&&byId('equipment',equipmentId)?.company_id!==plant.company_id) bad('Unknown equipment for this company');
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
  const edge=req=>{ const n=nodeFromRequest(req); if (!n) throw new HttpError(401,'Edge node key missing, wrong or revoked'); return n; };
  r.post('/edge/v1/heartbeat',({req,body})=>heartbeat(edge(req),body||{}),{public:true});
  r.get('/edge/v1/config',({req})=>nodeConfig(edge(req)),{public:true});
  r.post('/edge/v1/events',({req,body})=>{ const n=edge(req); const results=ingestBatch(n,body.events); return {accepted:results.filter(x=>x.status==='accepted').length,duplicates:results.filter(x=>x.status==='duplicate').length,rejected:results.filter(x=>x.status==='rejected').length,results}; },{public:true});
  // Evidence: a snapshot or 10-second clip for an event (by its id or the node's externalId), or a camera's frame
  // used as the background for drawing zones.
  r.post('/edge/v1/media',({req,body})=>{
    const n=edge(req), kind=choice(body.kind,'kind',['snapshot','clip','frame']);
    if (kind==='frame') { const c=one('SELECT * FROM vision_cameras WHERE id=? AND node_id=?',body.cameraId,n.id); if (!c) bad('cameraId is not a camera of this node');
      const m=storeMedia(c.company_id,{kind,mime:body.mime,base64:body.base64}); run('UPDATE vision_cameras SET snapshot_media_id=? WHERE id=?',m.id,c.id); return created({id:m.id}); }
    const e=one('SELECT * FROM vision_events WHERE node_id=? AND (id=? OR external_id=?)',n.id,String(body.eventId||''),String(body.eventId||'')); if (!e) bad('eventId is not an event of this node');
    const column=kind==='clip'?'clip_media_id':'snapshot_media_id'; if (e[column]) return {id:e[column],status:'duplicate'};
    const m=storeMedia(e.company_id,{kind,mime:body.mime,base64:body.base64}); run(`UPDATE vision_events SET ${column}=? WHERE id=?`,m.id,e.id); return created({id:m.id});
  },{public:true});

  // ---------- Catalogue, licences, settings ----------
  r.get('/vision/catalog',({u})=>{ companyScope(u); return visionCatalog(); });
  r.get('/vision/licences',({u})=>{ const [where,args]=scopeSql(u,'id');
    return all(`SELECT id,name FROM companies WHERE ${where} ORDER BY name`,...args).map(c=>({companyId:c.id,companyName:c.name,modules:MODULE_KEYS.map(m=>licence(c.id,m))})); });
  r.put('/vision/licences/:companyId/:module',({u,body,params})=>{
    if (!isPlatform(u)) deny(); if (!byId('companies',params.companyId)) missing(); const module=choice(params.module,'module',MODULE_KEYS);
    const cameras=Number(body.cameras); if (!Number.isInteger(cameras)||cameras<0||cameras>10000) bad('cameras must be a whole number from 0');
    const validUntil=body.validUntil?String(body.validUntil).slice(0,10):null; if (validUntil&&!/^\d{4}-\d\d-\d\d$/.test(validUntil)) bad('validUntil must be a date (YYYY-MM-DD)');
    run('INSERT INTO vision_licences (company_id,module,cameras,valid_until,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(company_id,module) DO UPDATE SET cameras=excluded.cameras,valid_until=excluded.valid_until,updated_at=excluded.updated_at',params.companyId,module,cameras,validUntil,now());
    for (const n of all('SELECT id FROM vision_nodes WHERE company_id=?',params.companyId)) bumpNode(n.id);
    audit(u,'vision.licence','vision_licence',`${params.companyId}:${module}`,params.companyId,{cameras,validUntil}); return licence(params.companyId,module);
  });

  // ---------- Edge nodes ----------
  r.get('/vision/nodes',({u})=>{ const [where,args]=scopeSql(u); return all(`SELECT * FROM vision_nodes WHERE ${where} ORDER BY name`,...args).map(nodeOut); });
  r.post('/vision/nodes',({u,body})=>{
    const plant=byId('plants',body.plantId); if (!plant) bad('Unknown plant'); manage(u,plant.company_id);
    const maxStreams=body.maxStreams==null?16:Number(body.maxStreams); if (!Number.isInteger(maxStreams)||maxStreams<1||maxStreams>64) bad('maxStreams must be 1 to 64');
    const k=newNodeKey(), key=id();
    run('INSERT INTO vision_nodes (id,company_id,plant_id,name,hardware,max_streams,key_hash,key_hint,created_at) VALUES (?,?,?,?,?,?,?,?,?)',key,plant.company_id,plant.id,required(body.name,'name',80),String(body.hardware||'').slice(0,160),maxStreams,k.hash,k.hint,now());
    audit(u,'vision.node.create','vision_node',key,plant.company_id);
    // The key is shown once; only its hash is stored.
    return created({node:nodeOut(byId('vision_nodes',key)),key:k.key});
  });
  r.patch('/vision/nodes/:id',({u,body,params})=>{
    const n=getNode(u,params.id); manage(u,n.company_id);
    const maxStreams=body.maxStreams==null?n.max_streams:Number(body.maxStreams); if (!Number.isInteger(maxStreams)||maxStreams<1||maxStreams>64) bad('maxStreams must be 1 to 64');
    run('UPDATE vision_nodes SET name=?,hardware=?,max_streams=?,active=?,config_version=config_version+1 WHERE id=?',body.name==null?n.name:required(body.name,'name',80),body.hardware==null?n.hardware:String(body.hardware).slice(0,160),maxStreams,body.active==null?n.active:body.active?1:0,n.id);
    audit(u,'vision.node.update','vision_node',n.id,n.company_id,{fields:Object.keys(body)}); return nodeOut(byId('vision_nodes',n.id));
  });
  r.post('/vision/nodes/:id/key',({u,params})=>{ const n=getNode(u,params.id); manage(u,n.company_id); const k=newNodeKey();
    run('UPDATE vision_nodes SET key_hash=?,key_hint=? WHERE id=?',k.hash,k.hint,n.id); audit(u,'vision.node.key','vision_node',n.id,n.company_id); return {node:nodeOut(byId('vision_nodes',n.id)),key:k.key}; });
  // The configuration a node runs, as the node will receive it (passwords in camera URLs masked).
  r.get('/vision/nodes/:id/config',({u,params})=>{ const n=getNode(u,params.id); const c=nodeConfig(n); return {...c,cameras:c.cameras.map(x=>({...x,sourceUrl:mask(x.sourceUrl)}))}; });

  // ---------- Cameras and module routing ----------
  r.get('/vision/cameras',({u})=>{ const [where,args]=scopeSql(u); return all(`SELECT * FROM vision_cameras WHERE ${where} ORDER BY name`,...args).map(cameraOut); });
  r.post('/vision/cameras',({u,body})=>{
    const f=cameraFields(u,body), key=id();
    run('INSERT INTO vision_cameras (id,company_id,plant_id,node_id,name,source_type,source_url,location,zone_id,equipment_id,fps,vendor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',key,f.companyId,f.plantId,f.nodeId,f.name,f.sourceType,f.sourceUrl,f.location,f.zoneId,f.equipmentId,f.fps,f.vendor,now());
    bumpNode(f.nodeId); audit(u,'vision.camera.create','vision_camera',key,f.companyId); return created(cameraOut(byId('vision_cameras',key)));
  });
  r.patch('/vision/cameras/:id',({u,body,params})=>{
    const c=getCamera(u,params.id), f=cameraFields(u,body,c), active=body.active==null?c.active:body.active?1:0;
    run('UPDATE vision_cameras SET plant_id=?,node_id=?,name=?,source_type=?,source_url=?,location=?,zone_id=?,equipment_id=?,fps=?,vendor=?,active=? WHERE id=?',f.plantId,f.nodeId,f.name,f.sourceType,f.sourceUrl,f.location,f.zoneId,f.equipmentId,f.fps,f.vendor,active,c.id);
    bumpNode(c.node_id); bumpNode(f.nodeId); audit(u,'vision.camera.update','vision_camera',c.id,c.company_id,{fields:Object.keys(body)}); return cameraOut(byId('vision_cameras',c.id));
  });
  // Assign (or update) a module on a camera. Enabling takes a licence seat.
  r.put('/vision/cameras/:id/modules/:module',({u,body,params})=>{
    const c=getCamera(u,params.id); manage(u,c.company_id); const module=choice(params.module,'module',MODULE_KEYS), enabled=body.enabled!==false;
    const current=one('SELECT * FROM vision_assignments WHERE camera_id=? AND module=?',c.id,module);
    if (enabled&&!current?.enabled) { const l=licence(c.company_id,module);
      if (!l.valid) bad(`No valid ${MODULES[module].label} licence for this company. Ask the platform administrator to add one.`);
      if (!l.available) bad(`All ${l.cameras} ${MODULES[module].label} licences are in use. Free one on another camera or extend the licence.`); }
    const config=JSON.stringify(moduleConfig(module,body.config??(current?parse(current.config,{}):{})));
    run('INSERT INTO vision_assignments (camera_id,module,enabled,config,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(camera_id,module) DO UPDATE SET enabled=excluded.enabled,config=excluded.config,updated_by=excluded.updated_by,updated_at=excluded.updated_at',c.id,module,enabled?1:0,config,u.id,now());
    bumpNode(c.node_id); audit(u,'vision.module.assign','vision_camera',c.id,c.company_id,{module,enabled}); return cameraOut(byId('vision_cameras',c.id));
  });
  r.delete('/vision/cameras/:id/modules/:module',({u,params})=>{ const c=getCamera(u,params.id); manage(u,c.company_id); const module=choice(params.module,'module',MODULE_KEYS);
    run('DELETE FROM vision_assignments WHERE camera_id=? AND module=?',c.id,module); bumpNode(c.node_id); audit(u,'vision.module.remove','vision_camera',c.id,c.company_id,{module}); return cameraOut(byId('vision_cameras',c.id)); });

  // ---------- Geofences ----------
  r.get('/vision/cameras/:id/zones',({u,params})=>{ const c=getCamera(u,params.id); return all('SELECT * FROM vision_zones WHERE camera_id=? ORDER BY created_at',c.id).map(zoneOut); });
  const zoneBody=(body,existing)=>{ const kind=body.kind==null?existing?.kind:choice(body.kind,'kind',Object.keys(ZONE_KINDS));
    const classes=body.classes==null?existing?.classes??'["person","vehicle"]':JSON.stringify([...new Set(Array.isArray(body.classes)?body.classes:[])].filter(x=>['person','vehicle'].includes(x)));
    if (classes==='[]') bad('classes must include person and/or vehicle');
    return {kind,name:body.name==null?existing?.name:required(body.name,'name',80),points:body.points==null?existing?.points:points(body.points,kind),
      severity:body.severity==null?existing?.severity??'critical':choice(body.severity,'severity',['warning','critical']),classes,active:body.active==null?existing?.active??1:body.active?1:0,
      // Surface class A/B/C (VDA 16) applies to inspection areas: it picks the acceptance limit for defects inside.
      surfaceClass:kind==='inspection_roi'?(body.surfaceClass==null?existing?.surface_class??'A':choice(body.surfaceClass,'surfaceClass',['A','B','C'])):null}; };
  r.post('/vision/cameras/:id/zones',({u,body,params})=>{ const c=getCamera(u,params.id); manage(u,c.company_id); const z=zoneBody(body); if (!z.points) bad('points are required'); const key=id(), at=now();
    run('INSERT INTO vision_zones (id,camera_id,name,kind,points,severity,classes,active,created_at,updated_at,surface_class) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,c.id,z.name,z.kind,z.points,z.severity,z.classes,z.active,at,at,z.surfaceClass);
    bumpNode(c.node_id); audit(u,'vision.zone.create','vision_camera',c.id,c.company_id,{zoneId:key,kind:z.kind}); return created(zoneOut(byId('vision_zones',key))); });
  r.patch('/vision/zones/:id',({u,body,params})=>{ const z0=byId('vision_zones',params.id); if (!z0) missing(); const c=getCamera(u,z0.camera_id); manage(u,c.company_id);
    if (body.kind&&body.kind!==z0.kind&&body.points==null) bad('Send the points again when changing the kind of a zone');
    const z=zoneBody(body,z0); run('UPDATE vision_zones SET name=?,kind=?,points=?,severity=?,classes=?,active=?,updated_at=?,surface_class=? WHERE id=?',z.name,z.kind,z.points,z.severity,z.classes,z.active,now(),z.surfaceClass,z0.id);
    bumpNode(c.node_id); audit(u,'vision.zone.update','vision_camera',c.id,c.company_id,{zoneId:z0.id}); return zoneOut(byId('vision_zones',z0.id)); });
  r.delete('/vision/zones/:id',({u,params})=>{ const z=byId('vision_zones',params.id); if (!z) missing(); const c=getCamera(u,z.camera_id); manage(u,c.company_id);
    // Zones referenced by incidents are deactivated rather than deleted, so the incident record stays complete.
    if (one('SELECT 1 FROM vision_events WHERE zone_id=?',z.id)) run('UPDATE vision_zones SET active=0,updated_at=? WHERE id=?',now(),z.id); else run('DELETE FROM vision_zones WHERE id=?',z.id);
    bumpNode(c.node_id); audit(u,'vision.zone.delete','vision_camera',c.id,c.company_id,{zoneId:z.id}); return {deleted:true}; });

  // ---------- Incidents ----------
  const eventQuery=(u,query)=>{ const [where,args]=scopeSql(u,'e.company_id'), cond=[where], a=[...args];
    for (const [k,col,opts] of [['module','e.module',[...MODULE_KEYS,'system']],['severity','e.severity',['info','warning','critical']],['status','e.status',['open','acknowledged','resolved','false_alarm']]]) { const v=query.get(k); if (v) { cond.push(`${col}=?`); a.push(choice(v,k,opts)); } }
    if (query.get('cameraId')) { cond.push('e.camera_id=?'); a.push(query.get('cameraId')); }
    if (query.get('plantId')) { cond.push('e.plant_id=?'); a.push(query.get('plantId')); }
    if (query.get('retrain')==='1') cond.push('e.retrain=1');
    const hours=Number(query.get('hours')||0); if (hours>0) { cond.push('e.occurred_at>=?'); a.push(new Date(Date.now()-Math.min(hours,24*400)*3600000).toISOString()); }
    return [cond.join(' AND '),a]; };
  r.get('/vision/events',({u,query})=>{ const [where,args]=eventQuery(u,query), limit=Math.min(500,Math.max(1,Number(query.get('limit'))||200));
    return withReviews(all(`${EVENT_SELECT} WHERE ${where} ORDER BY e.occurred_at DESC LIMIT ?`,...args,limit).map(eventOut)); });
  // Proof-of-violation log: every matching incident with who handled it and how, as CSV for audits.
  r.get('/vision/events.csv',({u,query,res})=>{ const [where,args]=eventQuery(u,query); const rows=all(`${EVENT_SELECT} WHERE ${where} ORDER BY e.occurred_at DESC LIMIT 20000`,...args).map(eventOut);
    const cell=v=>{ const s=String(v??''); return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; };
    const head=['Occurred (UTC)','Camera','Location','Module','Type','Severity','Confidence','Zone','Detail','Status','Acknowledged by','Acknowledged at','Resolved by','Resolved at','Note','Evidence locked','Snapshot','Clip','Incident ID'];
    const lines=rows.map(e=>[e.occurredAt,e.cameraName,e.location,MODULES[e.module]?.label||e.module,e.type,e.severity,e.confidence,e.zoneName,e.module==='ppe'?`missing: ${(e.detail.missing||[]).map(g=>PPE_GEAR[g]||g).join(', ')}`:e.module==='quality'?`${e.detail.preset} ${e.detail.defect}${e.detail.sizeMm?` ${e.detail.sizeMm} mm`:''}`:'',
      e.status,e.acknowledgedBy,e.acknowledgedAt,e.resolvedBy,e.resolvedAt,e.resolutionNote,e.locked?'yes':'no',e.snapshotMediaId?'yes':'no',e.clipMediaId?'yes':'no',e.id].map(cell).join(','));
    audit(u,'vision.export','vision_event','csv',isCustomer(u)?u.company_id:null,{rows:rows.length});
    res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="vision-incidents-${now().slice(0,10)}.csv"`,'cache-control':'no-store'});
    res.end('﻿'+[head.join(','),...lines].join('\r\n')); });
  r.get('/vision/events/:id',({u,params})=>{ const e=getEvent(u,params.id); return {...eventOut(one(`${EVENT_SELECT} WHERE e.id=?`,params.id)),review:reviewOf(e.id),aiReviewMode:reviewMode(e.company_id),aiEnabled:aiEnabled()}; });
  const close=(e,status,u,note)=>{ run('UPDATE vision_events SET status=?,resolved_by=?,resolved_at=?,resolution_note=?,acknowledged_by=COALESCE(acknowledged_by,?),acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?',status,u.id,now(),note,u.id,now(),e.id);
    // The last open incident of a kind on a camera closes its alert too.
    if (e.alert_id&&!one("SELECT 1 FROM vision_events WHERE alert_id=? AND status IN ('open','acknowledged')",e.alert_id)) { const a=byId('alerts',e.alert_id); if (a) resolveAlertKey(a.dedupe_key); } };
  r.post('/vision/events/:id/acknowledge',({u,params})=>{ const e=getEvent(u,params.id); if (e.status!=='open') bad(`This incident is already ${e.status.replace('_',' ')}`);
    run("UPDATE vision_events SET status='acknowledged',acknowledged_by=?,acknowledged_at=? WHERE id=?",u.id,now(),e.id); audit(u,'vision.event.ack','vision_event',e.id,e.company_id); return eventOut(one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  r.post('/vision/events/:id/resolve',({u,body,params})=>{ const e=getEvent(u,params.id); if (['resolved','false_alarm'].includes(e.status)) bad('This incident is already closed');
    close(e,'resolved',u,required(body.note,'note',1000)); audit(u,'vision.event.resolve','vision_event',e.id,e.company_id); return eventOut(one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  // A false alarm can be sent for retraining: it is kept (with its media) for the model training set.
  r.post('/vision/events/:id/false-alarm',({u,body,params})=>{ const e=getEvent(u,params.id); if (['resolved','false_alarm'].includes(e.status)) bad('This incident is already closed');
    close(e,'false_alarm',u,required(body.note,'note',1000)); run('UPDATE vision_events SET retrain=? WHERE id=?',body.retrain===false?0:1,e.id);
    audit(u,'vision.event.false_alarm','vision_event',e.id,e.company_id,{retrain:body.retrain!==false}); return eventOut(one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  r.post('/vision/events/:id/lock',({u,body,params})=>{ const e=getEvent(u,params.id), locked=body.locked!==false;
    if (!locked) manage(u,e.company_id); // Releasing evidence for automatic deletion needs an administrator.
    run('UPDATE vision_events SET locked=? WHERE id=?',locked?1:0,e.id); audit(u,locked?'vision.event.lock':'vision.event.unlock','vision_event',e.id,e.company_id); return eventOut(one(`${EVENT_SELECT} WHERE e.id=?`,e.id)); });
  r.get('/vision/media/:id',({u,params,res})=>{ const m=byId('vision_media',params.id); if (!m) missing(); view(u,m.company_id);
    res.writeHead(200,{'content-type':m.mime,'content-disposition':'inline','x-content-type-options':'nosniff','cache-control':'private, max-age=600'}); res.end(readMedia(m)); });
  // Training set for the cloud retraining pipeline (FEAT-07): false alarms marked for retraining, with their evidence.
  r.get('/vision/retraining',({u})=>{ const [where,args]=scopeSql(u,'e.company_id'); if (!isPlatform(u)&&u.role!=='customer_admin') deny();
    return all(`${EVENT_SELECT} WHERE ${where} AND e.retrain=1 ORDER BY e.occurred_at DESC LIMIT 5000`,...args).map(eventOut).map(e=>({id:e.id,module:e.module,type:e.type,label:'false_positive',
      occurredAt:e.occurredAt,camera:e.cameraName,note:e.resolutionNote,boxes:e.boxes,detail:e.detail,snapshot:e.snapshotMediaId?`/api/vision/media/${e.snapshotMediaId}`:null,clip:e.clipMediaId?`/api/vision/media/${e.clipMediaId}`:null})); });

  // ---------- AI: false-alarm analytics and second opinions ----------
  // How often each kind of incident was a false alarm, by confidence, camera and hour, with a threshold that would bring
  // false alarms under the target (default from settings; 10 % of incidents).
  r.get('/vision/analytics/false-alarms',({u,query})=>{
    const ids=companyScope(u), days=[7,30,90,365].includes(Number(query.get('days')))?Number(query.get('days')):30;
    const t=query.get('targetPct')==null?visionSettings().falseAlarmTargetPct:Number(query.get('targetPct')); if (!Number.isFinite(t)||t<0.1||t>50) bad('targetPct must be from 0.1 to 50');
    return falseAlarmReport(ids,{days,targetPct:t});
  });
  // Per company: whether snapshots may be sent to the AI for a second opinion (off, manual or auto), plus how well it agrees with people.
  r.get('/vision/ai-review',({u,query})=>{
    const ids=companyScope(u), days=[7,30,90,365].includes(Number(query.get('days')))?Number(query.get('days')):30;
    const companies=all(`SELECT id,name,vision_ai_review mode FROM companies ${ids?`WHERE id IN (${ids.map(()=>'?').join(',')})`:''} ORDER BY name`,...(ids||[]));
    return {aiEnabled:aiEnabled(),modes:REVIEW_MODES,companies:companies.map(c=>({id:c.id,name:c.name,mode:c.mode,canManage:canManageCompany(u,c.id)})),stats:reviewStats(ids,{days})};
  });
  r.patch('/vision/ai-review/:companyId',({u,body,params})=>{
    const c=byId('companies',params.companyId); if (!c) missing(); manage(u,c.id);
    const mode=choice(body.mode,'mode',REVIEW_MODES); run('UPDATE companies SET vision_ai_review=? WHERE id=?',mode,c.id);
    audit(u,'vision.ai_review.mode','company',c.id,c.id,{mode}); return {id:c.id,mode};
  });
  // One review per incident: asking again returns the stored one unless a refresh is requested.
  r.post('/vision/events/:id/ai-review',async({u,body,params})=>{
    const e=getEvent(u,params.id), mode=reviewMode(e.company_id);
    if (mode==='off') throw new HttpError(403,'AI review is off for this company. A company administrator can turn it on (snapshots are sent to the AI service).');
    const review=await reviewEvent(e,{source:'manual',userId:u.id,refresh:body?.refresh===true});
    if (!review.cached) audit(u,'vision.event.ai_review','vision_event',e.id,e.company_id,{verdict:review.verdict});
    return review;
  });

  // ---------- Dashboards and alarms ----------
  r.get('/vision/overview',({u,query})=>{
    const [where,args]=scopeSql(u,'c.company_id'), plantId=query.get('plantId'), hours=Math.min(24*90,Math.max(1,Number(query.get('hours'))||24)), since=new Date(Date.now()-hours*3600000).toISOString();
    const camWhere=`${where}${plantId?' AND c.plant_id=?':''} AND c.active=1`, camArgs=[...args,...(plantId?[plantId]:[])];
    const cameras=all(`SELECT c.* FROM vision_cameras c WHERE ${camWhere} ORDER BY c.name`,...camArgs);
    const ids=cameras.map(c=>c.id), inIds=ids.length?`IN (${ids.map(()=>'?').join(',')})`:'IN (NULL)';
    const stats=m=>one(`SELECT coalesce(sum(frames),0) frames,coalesce(sum(people),0) people,coalesce(sum(compliant),0) compliant,coalesce(sum(inspected),0) inspected,coalesce(sum(passed),0) passed,coalesce(sum(ignored),0) ignored FROM vision_stats WHERE camera_id ${inIds} AND module=? AND minute>=?`,...ids,m,since.slice(0,16));
    const ev=`FROM vision_events WHERE camera_id ${inIds} AND occurred_at>=?`, evArgs=[...ids,since];
    const count=(cond,...a)=>one(`SELECT count(*) n ${ev} AND ${cond}`,...evArgs,...a).n;
    const group=(expr,cond,...a)=>all(`SELECT ${expr} key,count(*) n ${ev} AND ${cond} GROUP BY 1 ORDER BY n DESC`,...evArgs,...a);
    const ppe=stats('ppe'), q=stats('quality'), intr=stats('intrusion');
    const latest=c=>one('SELECT id,type,severity,occurred_at,snapshot_media_id,boxes,status FROM vision_events WHERE camera_id=? ORDER BY occurred_at DESC LIMIT 1',c.id);
    const nodes=all(`SELECT DISTINCT n.* FROM vision_nodes n JOIN vision_cameras c ON c.node_id=n.id WHERE ${camWhere} UNION SELECT n.* FROM vision_nodes n WHERE ${where.replaceAll('c.company_id','n.company_id')}${plantId?' AND n.plant_id=?':''}`,...camArgs,...args,...(plantId?[plantId]:[]));
    const crit=all(`SELECT latency_ms,edge_actions ${ev} AND severity='critical'`,...evArgs), p95=xs=>{ const s=xs.filter(x=>x!=null).sort((a,b)=>a-b); return s.length?s[Math.min(s.length-1,Math.floor(s.length*0.95))]:null; };
    return {hours,since,
      cameras:cameras.map(c=>({...cameraOut(c),latest:(e=>e&&{...e,boxes:parse(e.boxes,[])})(latest(c)),
        today:{events:one('SELECT count(*) n FROM vision_events WHERE camera_id=? AND occurred_at>=?',c.id,since).n,...(()=>{ const s=one('SELECT coalesce(sum(inspected),0) i,coalesce(sum(passed),0) p,coalesce(sum(people),0) pe,coalesce(sum(compliant),0) co FROM vision_stats WHERE camera_id=? AND minute>=?',c.id,since.slice(0,16)); return {inspected:s.i,passed:s.p,people:s.pe,compliant:s.co}; })()}})),
      nodes:[...new Map(nodes.map(n=>[n.id,nodeOut(n)])).values()],
      ppe:{people:ppe.people,compliant:ppe.compliant,complianceRate:ppe.people?Math.round(1000*ppe.compliant/ppe.people)/10:null,violations:count("module='ppe'"),
        byGear:all(`SELECT j.value key,count(*) n ${ev.replace('FROM vision_events','FROM vision_events, json_each(json_extract(vision_events.detail,\'$.missing\')) j')} AND module='ppe' GROUP BY 1 ORDER BY n DESC`,...evArgs),
        byCamera:group('camera_id',"module='ppe'")},
      fire:{events:count("module='fire_smoke'"),fire:count("type='fire'"),smoke:count("type='smoke'"),falseAlarms:count("module='fire_smoke' AND status='false_alarm'"),open:count("module='fire_smoke' AND status IN ('open','acknowledged')")},
      intrusion:{events:count("module='intrusion'"),people:count("type='intrusion_person'"),vehicles:count("type='intrusion_vehicle'"),ignoredMachineMotion:intr.ignored,byZone:group("coalesce((SELECT name FROM vision_zones z WHERE z.id=zone_id),'—')","module='intrusion'")},
      quality:{inspected:q.inspected,passed:q.passed,defectRate:q.inspected?Math.round(10000*(q.inspected-q.passed)/q.inspected)/100:null,defects:count("module='quality'"),
        byPreset:group("json_extract(detail,'$.preset')","module='quality'"),byDefect:group("json_extract(detail,'$.defect')","module='quality'"),
        logistics:group("json_extract(detail,'$.defect')","module='quality' AND json_extract(detail,'$.preset')='logistics_container'"),byCamera:group('camera_id',"module='quality'")},
      latency:{criticalEvents:crit.length,uplinkP95Ms:p95(crit.map(x=>x.latency_ms)),broadcastP95Ms:p95(crit.map(x=>parse(x.edge_actions,{}).broadcastMs??null)),actuatorP95Ms:p95(crit.map(x=>{ const a=parse(x.edge_actions,{}); return a.relayMs??a.plcMs??null; }))},
      open:all(`${EVENT_SELECT} WHERE e.camera_id ${inIds} AND e.status IN ('open','acknowledged') AND e.severity IN ('warning','critical') ORDER BY e.severity='critical' DESC,e.occurred_at DESC LIMIT 30`,...ids).map(eventOut),
      hourly:all(`SELECT substr(occurred_at,1,13) hour,module,count(*) n ${ev} GROUP BY 1,2 ORDER BY 1`,...evArgs)};
  });
  // Live alarms for the banner: open warning/critical incidents of the last day that match the person's vision
  // duties (fire always). Without duties, critical incidents only.
  r.get('/vision/alarms',({u})=>{
    if (!isDispatch(u)&&!isCustomer(u)) return [];
    const [where,args]=scopeSql(u,'e.company_id'), mine=parse(byId('users',u.id)?.vision_duties,[]);
    const modules=MODULE_KEYS.filter(m=>mine.includes(MODULES[m].duty)||m==='fire_smoke');
    const cond=mine.length?`(e.module IN (${modules.map(()=>'?').join(',')}) AND e.severity IN ('warning','critical'))`:"e.severity='critical'";
    return all(`${EVENT_SELECT} WHERE ${where} AND e.status='open' AND ${cond} AND e.occurred_at>=? ORDER BY e.severity='critical' DESC,e.occurred_at DESC LIMIT 20`,...args,...(mine.length?modules:[]),new Date(Date.now()-86400000).toISOString()).map(eventOut);
  });
}
