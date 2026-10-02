// Vision AI core: the module catalogue, evidence storage, intake of edge detections, and the configuration each edge
// node runs. Real-time work (inference, beacons, PLC rejects, the fire broadcast on the factory subnet) happens on the
// edge node; this side records, alerts people, and keeps the proof.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, id, now, one, all, run, transaction } from './db.js';
import { raiseAlert, resolveAlertKey } from './factory/alerts.js';
import { recordSafety } from './factory/safety.js';
import { bad } from './validate.js';

// ---------- Catalogue ----------
export const MODULES={
  ppe:{label:'PPE detection',duty:'ehs',events:['ppe_violation'],
    defaults:{requiredGear:['helmet','vest'],minConfidence:0.6,cooldownSeconds:30,beaconOutput:null}},
  fire_smoke:{label:'Fire & smoke detection',duty:'ehs',events:['fire','smoke'],
    defaults:{sensitivity:'balanced',confirmSeconds:1.5,broadcast:true,sirenOutput:null}},
  intrusion:{label:'Restricted area intrusion',duty:'security',events:['intrusion_person','intrusion_vehicle'],
    defaults:{classes:['person','vehicle'],dwellSeconds:0.5,sirenOutput:null}},
  quality:{label:'Quality inspection',duty:'qa',events:['defect'],
    defaults:{preset:'automotive_plastic',triggerMode:'plc',cycleTimeS:3,resultBudgetMs:500,minDefectMm:0.5,mmPerPixel:null,targetFps:60,
      acceptance:{A:0.5,B:1.0,C:2.0},triggerInput:null,okOutput:null,rejectOutput:null}},
};
export const MODULE_KEYS=Object.keys(MODULES);
export const PPE_GEAR={helmet:'Safety helmet',vest:'High-visibility vest',goggles:'Safety goggles',boots:'Steel-toe footwear'};
export const QUALITY_PRESETS={
  automotive_plastic:{label:'Automotive plastic parts (injection moulded)',defects:['short_shot','flash','sink_mark','warpage','burn_mark','black_spot','splay','weld_line','flow_lines','jetting','scratch','crack','contamination','colour_variation','gloss_variation','missing_feature','dimensional']},
  vehicle_body:{label:'Vehicle body',defects:['scratch','dent','crack','stain','paint_run','orange_peel']},
  electronics:{label:'Electronics assembly',defects:['scratch','crack','stain','missing_component','solder_bridge','misalignment']},
  logistics_container:{label:'Logistics / shipping container damage',defects:['dent','hole','crack','rust','stain','deformation','torn_label']},
};
// The standard visual defects of injection-moulded automotive parts, what they look like and their usual causes,
// so a QA lead (or the maintenance team) knows where to look. Names match the Vision quality defect Pareto.
export const DEFECT_INFO={
  short_shot:['Short shot','The part is incomplete: the melt did not fill the cavity.','Too little shot volume or injection pressure, cold melt or mould, blocked gate or vent, worn check ring.'],
  flash:['Flash','Thin excess plastic at the parting line, ejector pins or slides.','Too much injection or holding pressure, too little clamp force, worn or damaged parting line, mould not closing fully.'],
  sink_mark:['Sink mark','A shallow depression over thick sections, ribs or bosses.','Holding pressure or time too low, melt or mould too hot, thick wall design, gate freezing too early.'],
  warpage:['Warpage','The part is bent or twisted after ejection.','Uneven cooling, too short cooling time, residual stress, uneven ejection, fibre orientation.'],
  burn_mark:['Burn mark','Brown or black burnt areas, often at the end of flow or in corners.','Trapped air (blocked vents), injection too fast, melt too hot or too long in the barrel.'],
  black_spot:['Black specks','Small dark particles in the surface.','Degraded material in the barrel or hot runner, contamination, dirty hopper or dryer.'],
  splay:['Splay / silver streaks','Silvery streaks in the flow direction.','Moisture in the material (dryer), overheated material, air entrapment.'],
  weld_line:['Weld line','A visible line where two melt fronts meet.','Low melt or mould temperature, slow injection, poor venting, gate position.'],
  flow_lines:['Flow lines','Wavy lines or rings near the gate.','Slow injection, low melt or mould temperature, varying wall thickness.'],
  jetting:['Jetting','A snake-like flow pattern from the gate.','Injection too fast through a small gate into an open cavity, gate design.'],
  scratch:['Scratch','A line-shaped surface damage.','Handling, conveyors or robot gripper, ejection drag, damaged mould polish.'],
  crack:['Crack','A fracture in the part, often near bosses or ejector pins.','Stress from ejection or overpacking, too short cooling, chemical attack, cold mould.'],
  contamination:['Contamination','Foreign particles or a different material in the part.','Regrind or masterbatch quality, open hopper, wrong material, dirty dryer.'],
  colour_variation:['Colour variation','Colour differs from the master sample.','Masterbatch dosing, material lot change, overheating, mixing.'],
  gloss_variation:['Gloss variation','Gloss differs from the master sample or across the surface.','Mould temperature, mould surface wear, holding pressure, venting.'],
  missing_feature:['Missing feature','A clip, boss, insert or label is missing.','Short shot in a feature, broken core pin, insert not loaded, automation fault.'],
  dimensional:['Out of tolerance','A measured dimension is outside the drawing tolerance.','Shrinkage from process changes, warpage, worn mould, material change.'],
};
export const CAMERA_VENDORS=['Hikvision','Hikrobot','Keyence','Cognex','Basler','Axis','Other'];
export const SYSTEM_EVENTS=['camera_offline','camera_tamper','node_overheat','disk_full','model_error'];
export const SOURCE_TYPES=['rtsp','http-snapshot','cognex-native','folder','csi','visionforge'];
export const DUTIES={ehs:'EHS officer',security:'Security & facility admin',qa:'QA lead'};
export const ZONE_KINDS={exclusion:'Exclusion zone (no entry)',tripwire:'Tripwire line',allowed_motion:'Approved machine motion (ignored)',ppe_zone:'PPE-required zone',inspection_roi:'Inspection area'};
const SENSITIVITY=['conservative','balanced','sensitive'];
const OUTPUT_PROTOCOLS=['modbus_tcp','ethernet_ip','gpio','http'];
const RANK={info:0,warning:1,critical:2};
const DEFAULT_SEVERITY={fire:'critical',smoke:'critical',intrusion_person:'critical',intrusion_vehicle:'warning',ppe_violation:'warning',defect:'info',
  camera_offline:'warning',camera_tamper:'warning',node_overheat:'warning',disk_full:'warning',model_error:'warning'};
export const visionCatalog=()=>({modules:Object.fromEntries(Object.entries(MODULES).map(([k,m])=>[k,{label:m.label,duty:m.duty,events:m.events,defaults:m.defaults}])),
  ppeGear:PPE_GEAR,qualityPresets:QUALITY_PRESETS,defectInfo:DEFECT_INFO,cameraVendors:CAMERA_VENDORS,sourceTypes:SOURCE_TYPES,duties:DUTIES,zoneKinds:ZONE_KINDS,sensitivity:SENSITIVITY,outputProtocols:OUTPUT_PROTOCOLS,systemEvents:SYSTEM_EVENTS});

export function visionSettings() {
  const base={mediaRetentionDays:30,qualityAlertRatePct:2,clipSeconds:10,preEventSeconds:5,diskPrunePct:90,broadcastGroup:'239.10.10.10',broadcastPort:5005};
  try { return {...base,...JSON.parse(one("SELECT value FROM settings WHERE key='vision_settings'")?.value||'{}')}; } catch { return base; }
}

// ---------- Module settings ----------
// A physical output on the edge: a Modbus TCP coil/register, an EtherNet/IP tag, a GPIO pin or an HTTP relay.
function output(v,name) {
  if (v==null||v==='') return null;
  if (typeof v!=='object'||Array.isArray(v)) bad(`${name} must be an object`);
  const protocol=OUTPUT_PROTOCOLS.includes(v.protocol)?v.protocol:bad(`${name}.protocol must be one of: ${OUTPUT_PROTOCOLS.join(', ')}`);
  const text=(k,max=120,req=false)=>{ const s=String(v[k]??'').trim(); if (req&&!s) bad(`${name}.${k} is required`); if (s.length>max) bad(`${name}.${k} is too long`); return s; };
  const int=(k,min,max,fallback)=>{ const n=v[k]==null||v[k]===''?fallback:Number(v[k]); if (!Number.isInteger(n)||n<min||n>max) bad(`${name}.${k} must be a whole number from ${min} to ${max}`); return n; };
  if (protocol==='modbus_tcp') return {protocol,host:text('host',120,true),port:int('port',1,65535,502),unitId:int('unitId',0,255,1),coil:int('coil',0,65535,0),pulseMs:int('pulseMs',10,60000,500)};
  if (protocol==='ethernet_ip') return {protocol,host:text('host',120,true),tag:text('tag',80,true),value:int('value',-32768,65535,1),pulseMs:int('pulseMs',10,60000,500)};
  if (protocol==='gpio') return {protocol,pin:int('pin',0,512,0),activeHigh:v.activeHigh!==false,pulseMs:int('pulseMs',10,60000,2000)};
  return {protocol,url:/^https?:\/\/\S+$/.test(String(v.url||''))?String(v.url).slice(0,300):bad(`${name}.url must be an http(s) URL`),pulseMs:int('pulseMs',10,60000,1000)};
}
// A PLC signal the edge reads: the part-present trigger (Modbus TCP discrete input or coil, EtherNet/IP tag).
function plcInput(v,name) {
  if (v==null||v==='') return null;
  if (typeof v!=='object'||Array.isArray(v)) bad(`${name} must be an object`);
  const host=String(v.host??'').trim(); if (!host||host.length>120) bad(`${name}.host is required`);
  const int=(k,min,max,fallback)=>{ const n=v[k]==null||v[k]===''?fallback:Number(v[k]); if (!Number.isInteger(n)||n<min||n>max) bad(`${name}.${k} must be a whole number from ${min} to ${max}`); return n; };
  if (v.protocol==='modbus_tcp') return {protocol:'modbus_tcp',host,port:int('port',1,65535,502),unitId:int('unitId',0,255,1),kind:v.kind==='coil'?'coil':'discrete_input',address:int('address',0,65535,0)};
  if (v.protocol==='ethernet_ip') { const tag=String(v.tag??'').trim(); if (!tag||tag.length>80) bad(`${name}.tag is required`); return {protocol:'ethernet_ip',host,tag}; }
  bad(`${name}.protocol must be modbus_tcp or ethernet_ip`);
}
const num=(v,name,min,max,fallback)=>{ const n=v==null||v===''?fallback:Number(v); if (n==null) return null; if (!Number.isFinite(n)||n<min||n>max) bad(`${name} must be from ${min} to ${max}`); return n; };
// Validates a module's settings against its catalogue entry; unknown keys are dropped.
export function moduleConfig(module,input={}) {
  const c=input&&typeof input==='object'?input:{}, d=MODULES[module].defaults;
  if (module==='ppe') {
    const gear=Array.isArray(c.requiredGear)?[...new Set(c.requiredGear)]:d.requiredGear;
    if (!gear.length||gear.some(g=>!PPE_GEAR[g])) bad(`requiredGear must list one or more of: ${Object.keys(PPE_GEAR).join(', ')}`);
    return {requiredGear:gear,minConfidence:num(c.minConfidence,'minConfidence',0.3,0.99,d.minConfidence),cooldownSeconds:num(c.cooldownSeconds,'cooldownSeconds',0,3600,d.cooldownSeconds),beaconOutput:output(c.beaconOutput,'beaconOutput')};
  }
  if (module==='fire_smoke') return {sensitivity:SENSITIVITY.includes(c.sensitivity)?c.sensitivity:c.sensitivity==null?d.sensitivity:bad(`sensitivity must be one of: ${SENSITIVITY.join(', ')}`),
    confirmSeconds:num(c.confirmSeconds,'confirmSeconds',0.2,1.8,d.confirmSeconds),broadcast:c.broadcast!==false,sirenOutput:output(c.sirenOutput,'sirenOutput')};
  if (module==='intrusion') {
    const classes=Array.isArray(c.classes)?[...new Set(c.classes)]:d.classes; if (!classes.length||classes.some(x=>!['person','vehicle'].includes(x))) bad('classes must be person and/or vehicle');
    return {classes,dwellSeconds:num(c.dwellSeconds,'dwellSeconds',0,30,d.dwellSeconds),sirenOutput:output(c.sirenOutput,'sirenOutput')};
  }
  const preset=c.preset==null?d.preset:QUALITY_PRESETS[c.preset]?c.preset:bad(`preset must be one of: ${Object.keys(QUALITY_PRESETS).join(', ')}`);
  const triggerMode=c.triggerMode==null?d.triggerMode:['plc','camera','continuous'].includes(c.triggerMode)?c.triggerMode:bad('triggerMode must be plc, camera or continuous');
  const cycleTimeS=num(c.cycleTimeS,'cycleTimeS',0.2,600,d.cycleTimeS), resultBudgetMs=num(c.resultBudgetMs,'resultBudgetMs',20,10000,d.resultBudgetMs);
  // The OK/NG result must reach the PLC well inside the machine cycle: at most half of it.
  if (resultBudgetMs>cycleTimeS*500) bad(`The result time (${resultBudgetMs} ms) must be at most half the cycle time (${cycleTimeS} s)`);
  const a=c.acceptance&&typeof c.acceptance==='object'?c.acceptance:{}, acceptance=Object.fromEntries(['A','B','C'].map(k=>[k,num(a[k],`acceptance.${k}`,0.05,100,d.acceptance[k])]));
  if (!(acceptance.A<=acceptance.B&&acceptance.B<=acceptance.C)) bad('Acceptance limits must not get stricter from class A to C (A ≤ B ≤ C)');
  const triggerInput=plcInput(c.triggerInput,'triggerInput'); if (triggerMode==='plc'&&!triggerInput&&c.triggerInput!==undefined&&c.triggerInput!==null) bad('triggerInput is required for PLC triggering');
  return {preset,triggerMode,cycleTimeS,resultBudgetMs,minDefectMm:num(c.minDefectMm,'minDefectMm',0.05,50,d.minDefectMm),mmPerPixel:num(c.mmPerPixel,'mmPerPixel',0.001,10,null),
    targetFps:num(c.targetFps,'targetFps',1,120,d.targetFps),acceptance,triggerInput,okOutput:output(c.okOutput,'okOutput'),rejectOutput:output(c.rejectOutput,'rejectOutput')};
}

// ---------- Licences ----------
export function licence(companyId,module) {
  const l=one('SELECT * FROM vision_licences WHERE company_id=? AND module=?',companyId,module);
  const valid=!!l&&l.cameras>0&&(!l.valid_until||l.valid_until>=now().slice(0,10));
  const used=one("SELECT count(*) n FROM vision_assignments a JOIN vision_cameras c ON c.id=a.camera_id WHERE c.company_id=? AND a.module=? AND a.enabled=1 AND c.active=1",companyId,module).n;
  return {module,cameras:l?.cameras??0,validUntil:l?.valid_until??null,valid,used,available:valid?Math.max(0,l.cameras-used):0};
}

// ---------- Evidence (snapshots, clips, camera frames) ----------
export const MAX_MEDIA_BYTES=6*1024*1024;
const SIGNATURE={'image/jpeg':b=>b[0]===0xff&&b[1]===0xd8,'image/png':b=>b.subarray(0,4).toString('hex')==='89504e47','image/webp':b=>b.subarray(8,12).toString('latin1')==='WEBP','video/mp4':b=>b.subarray(4,8).toString('latin1')==='ftyp'};
export function storeMedia(companyId,{kind,mime,base64}) {
  if (!['snapshot','clip','frame'].includes(kind)) bad('kind must be snapshot, clip or frame');
  if (!SIGNATURE[mime]) bad('mime must be image/jpeg, image/png, image/webp or video/mp4');
  if ((kind==='clip')!==(mime==='video/mp4')) bad(kind==='clip'?'A clip must be video/mp4':'A snapshot or frame must be an image');
  if (typeof base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) bad('base64 content required');
  const bytes=Buffer.from(base64,'base64'); if (!bytes.length||bytes.length>MAX_MEDIA_BYTES) bad('Media must be 1 byte to 6 MB');
  if (!SIGNATURE[mime](bytes)) bad('File content does not match its type');
  const key=id(), storage=`vision-${randomBytes(16).toString('hex')}`;
  mkdirSync(join(DATA_DIR,'uploads'),{recursive:true}); writeFileSync(join(DATA_DIR,'uploads',storage),bytes,{flag:'wx'});
  run('INSERT INTO vision_media (id,company_id,kind,mime,size_bytes,storage_name,created_at) VALUES (?,?,?,?,?,?,?)',key,companyId,kind,mime,bytes.length,storage,now());
  return one('SELECT * FROM vision_media WHERE id=?',key);
}
export const readMedia=m=>readFileSync(join(DATA_DIR,'uploads',m.storage_name));
function deleteMedia(mediaId) { const m=one('SELECT * FROM vision_media WHERE id=?',mediaId); if (!m) return; rmSync(join(DATA_DIR,'uploads',m.storage_name),{force:true}); run('DELETE FROM vision_media WHERE id=?',m.id); }

// ---------- Edge nodes ----------
export const hashKey=key=>createHash('sha256').update(String(key)).digest('hex');
export function newNodeKey() { const key=`vn_${randomBytes(24).toString('base64url')}`; return {key,hash:hashKey(key),hint:`${key.slice(0,6)}…${key.slice(-4)}`}; }
export function nodeFromRequest(req) {
  const m=/^Bearer\s+(vn_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization||''); if (!m) return null;
  return one('SELECT * FROM vision_nodes WHERE key_hash=? AND active=1',hashKey(m[1]))||null;
}
// Anything a node runs changed: it fetches its configuration on the next heartbeat.
export const bumpNode=nodeId=>{ if (nodeId) run('UPDATE vision_nodes SET config_version=config_version+1 WHERE id=?',nodeId); };
export const bumpCamera=cameraId=>bumpNode(one('SELECT node_id FROM vision_cameras WHERE id=?',cameraId)?.node_id);
export const nodeStatus=n=>!n.active?'disabled':!n.last_seen_at?'never_seen':Date.now()-Date.parse(n.last_seen_at)>3*60000?'offline':'online';

// What a node runs: its cameras, the licensed modules on each with their settings, and the drawn zones. Modules
// beyond a company's licensed camera count (e.g. after a licence was reduced) are left out, oldest assignments first.
export function nodeConfig(node) {
  const s=visionSettings(), seats={};
  const cameras=all('SELECT * FROM vision_cameras WHERE node_id=? AND active=1 ORDER BY created_at',node.id).map(c=>{
    const modules=all('SELECT * FROM vision_assignments WHERE camera_id=? AND enabled=1 ORDER BY updated_at',c.id).filter(a=>{
      const key=`${c.company_id}:${a.module}`; seats[key]??=(()=>{ const l=licence(c.company_id,a.module); return l.valid?l.cameras:0; })();
      if (seats[key]<=0) return false; seats[key]--; return true;
    }).map(a=>{ const config=JSON.parse(a.config);
      // The node grades against the preset's defect classes, so it needs no copy of the preset list.
      if (a.module==='quality') config.defects=QUALITY_PRESETS[config.preset]?.defects||[];
      return {module:a.module,config}; });
    const zones=all('SELECT * FROM vision_zones WHERE camera_id=? AND active=1 ORDER BY created_at',c.id).map(z=>({id:z.id,name:z.name,kind:z.kind,severity:z.severity,classes:JSON.parse(z.classes),points:JSON.parse(z.points),...(z.surface_class?{surfaceClass:z.surface_class}:{})}));
    return {id:c.id,name:c.name,vendor:c.vendor,sourceType:c.source_type,sourceUrl:c.source_url,fps:c.fps,location:c.location,modules,zones};
  });
  return {nodeId:node.id,name:node.name,configVersion:node.config_version,maxStreams:node.max_streams,cameras,
    settings:{clipSeconds:s.clipSeconds,preEventSeconds:s.preEventSeconds,diskPrunePct:s.diskPrunePct,broadcast:{group:s.broadcastGroup,port:s.broadcastPort}}};
}

// ---------- Intake ----------
const iso=(v,name)=>{ const t=Date.parse(v); if (typeof v!=='string'||Number.isNaN(t)) bad(`${name} must be an ISO date-time`); if (t>Date.now()+120000) bad(`${name} is in the future`); return new Date(t).toISOString(); };
const json=(v,name,max)=>{ if (v==null) return null; const s=JSON.stringify(v); if (s.length>max) bad(`${name} is too large`); return s; };
function boxes(v) {
  if (v==null) return '[]'; if (!Array.isArray(v)||v.length>50) bad('boxes must be a list of up to 50 boxes');
  return JSON.stringify(v.map((b,i)=>{ const n=k=>{ const x=Number(b?.[k]); if (!Number.isFinite(x)||x<0||x>1) bad(`boxes[${i}].${k} must be 0..1 (fraction of the image)`); return Math.round(x*10000)/10000; };
    return {x:n('x'),y:n('y'),w:n('w'),h:n('h'),label:String(b.label??'').slice(0,40),...(b.confidence!=null?{confidence:Math.round(Number(b.confidence)*1000)/1000}:{}),...(b.ok!=null?{ok:!!b.ok}:{})}; }));
}

// Records one detection from a node and does what it calls for: alerts, the safety log, evidence locking.
export function recordDetection(node,ev,receivedAt=now()) {
  const cam=typeof ev?.cameraId==='string'&&one('SELECT * FROM vision_cameras WHERE id=?',ev.cameraId);
  if (!cam||cam.node_id!==node.id) bad('cameraId is not a camera of this node');
  const module=ev.module==='system'?'system':MODULES[ev.module]?ev.module:bad(`module must be one of: ${[...MODULE_KEYS,'system'].join(', ')}`);
  const types=module==='system'?SYSTEM_EVENTS:MODULES[module].events; if (!types.includes(ev.type)) bad(`type for ${module} must be one of: ${types.join(', ')}`);
  if (module!=='system'&&!one('SELECT 1 FROM vision_assignments WHERE camera_id=? AND module=?',cam.id,module)) bad(`${MODULES[module].label} is not assigned to this camera`);
  const externalId=ev.externalId==null?null:String(ev.externalId).slice(0,80);
  if (externalId) { const dup=one('SELECT id FROM vision_events WHERE node_id=? AND external_id=?',node.id,externalId); if (dup) return {id:dup.id,status:'duplicate'}; }
  const zone=ev.zoneId?one('SELECT * FROM vision_zones WHERE id=? AND camera_id=?',ev.zoneId,cam.id)||bad('zoneId is not a zone of this camera'):null;
  const severity=ev.severity==null?(zone&&ev.type.startsWith('intrusion')?zone.severity:DEFAULT_SEVERITY[ev.type]):['info','warning','critical'].includes(ev.severity)?ev.severity:bad('severity must be info, warning or critical');
  const occurredAt=iso(ev.occurredAt,'occurredAt'), detail=ev.detail&&typeof ev.detail==='object'?ev.detail:{};
  if (module==='ppe'&&(!Array.isArray(detail.missing)||!detail.missing.length||detail.missing.some(g=>!PPE_GEAR[g]))) bad('detail.missing must list the missing gear');
  if (module==='quality'&&!(QUALITY_PRESETS[detail.preset]?.defects.includes(detail.defect))) bad('detail.preset and detail.defect must name a quality preset and one of its defects');
  const key=id(), latency=Math.max(0,Date.parse(receivedAt)-Date.parse(occurredAt));
  const confidence=ev.confidence==null?null:Number(ev.confidence); if (confidence!=null&&!(confidence>=0&&confidence<=1)) bad('confidence must be 0..1');
  // Life-safety evidence and PPE violations are kept as proof: their media is never pruned automatically.
  const locked=['fire','smoke','intrusion_person','intrusion_vehicle','ppe_violation'].includes(ev.type)?1:0;
  run(`INSERT INTO vision_events (id,company_id,plant_id,camera_id,node_id,module,type,severity,confidence,occurred_at,received_at,latency_ms,zone_id,detail,boxes,edge_actions,locked,external_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,cam.company_id,cam.plant_id,cam.id,node.id,module,ev.type,severity,confidence,occurredAt,receivedAt,latency,zone?.id??null,
    json(detail,'detail',8000)??'{}',boxes(ev.boxes),json(ev.edgeActions,'edgeActions',2000)??'{}',locked,externalId);
  effects(one('SELECT * FROM vision_events WHERE id=?',key),cam,zone);
  return {id:key,status:'accepted'};
}

const label=t=>t.replaceAll('_',' ');
function effects(e,cam,zone) {
  const where=`${cam.name}${cam.location?` (${cam.location})`:''}`, d=JSON.parse(e.detail);
  const alert=(severity,kind,title,detail)=>{ const a=raiseAlert({companyId:e.company_id,plantId:e.plant_id,module:'vision',severity,equipmentId:cam.equipment_id,title,detail,dedupeKey:`vision:${kind}:${cam.id}${zone?`:${zone.id}`:''}`,at:e.occurred_at}); if (a) run('UPDATE vision_events SET alert_id=? WHERE id=?',a,e.id); };
  const safety=(eventType,description)=>{ const s=recordSafety({companyId:e.company_id,plantId:e.plant_id,zoneId:cam.zone_id,equipmentId:cam.equipment_id,eventType,severity:e.severity,source:'camera',description,occurredAt:e.occurred_at},{alert:false}); run('UPDATE vision_events SET safety_event_id=? WHERE id=?',s,e.id); };
  if (e.type==='fire'||e.type==='smoke') { alert('critical','fire',`${e.type==='fire'?'Fire':'Smoke'} detected – ${where}`,`Camera ${cam.name} detected ${e.type} at ${e.occurred_at}. Confidence ${e.confidence??'—'}. Follow the emergency procedure.`); safety('fire_smoke',`${e.type==='fire'?'Fire':'Smoke'} detected by camera ${cam.name}`); }
  else if (e.module==='intrusion') alert(e.severity,'intrusion',`${e.type==='intrusion_vehicle'?'Vehicle':'Person'} in ${zone?.name||'restricted area'} – ${where}`,`Camera ${cam.name} detected a ${e.type==='intrusion_vehicle'?'vehicle':'person'} inside ${zone?.name||'a restricted area'} at ${e.occurred_at}.`);
  else if (e.module==='ppe') { const missing=(d.missing||[]).map(g=>PPE_GEAR[g]||g).join(', '); safety('ppe_missing',`Missing PPE (${missing}) at ${where}`); alert(e.severity,'ppe',`PPE missing – ${where}`,`Missing: ${missing}. Detected at ${e.occurred_at}.`); }
  else if (e.module==='quality') { qualityRateAlert(cam); syncQualityMinute(cam,e.occurred_at.slice(0,16)); }
  else if (e.module==='system') alert(e.severity,`system:${e.type}`,`${label(e.type)[0].toUpperCase()}${label(e.type).slice(1)} – ${where}`,d.message?String(d.message).slice(0,500):`Reported by the edge node at ${e.occurred_at}.`);
}
// Edge quality results also feed the Vision quality page (first-pass yield, PPM, defect Pareto per machine): one
// row per camera and minute, rebuilt from the counters and the defects recorded in that minute.
export function syncQualityMinute(cam,minute) {
  if (!cam.equipment_id) return;
  const s=one("SELECT inspected,passed FROM vision_stats WHERE camera_id=? AND module='quality' AND minute=?",cam.id,minute);
  const defects=Object.fromEntries(all("SELECT json_extract(detail,'$.defect') d,count(*) n FROM vision_events WHERE camera_id=? AND module='quality' AND substr(occurred_at,1,16)=? GROUP BY 1",cam.id,minute).map(r=>[r.d,r.n]));
  const found=Object.values(defects).reduce((a,b)=>a+b,0), inspected=Math.max(s?.inspected??0,found), rejected=Math.max(inspected-(s?.passed??inspected),Math.min(found,inspected));
  if (!inspected) return;
  run(`INSERT INTO vision_results (id,company_id,equipment_id,station,period_start,period_minutes,inspected,rejected,defects,source) VALUES (?,?,?,?,?,1,?,?,?,'edge')
    ON CONFLICT(equipment_id,station,period_start) DO UPDATE SET inspected=excluded.inspected,rejected=excluded.rejected,defects=excluded.defects`,id(),cam.company_id,cam.equipment_id,cam.name,`${minute}:00.000Z`,inspected,rejected,JSON.stringify(defects));
}

// A rising defect rate (last 15 minutes against the threshold in vision settings) raises one alert per camera.
function qualityRateAlert(cam) {
  const since=new Date(Date.now()-15*60000).toISOString().slice(0,16), s=one("SELECT sum(inspected) i,sum(passed) p FROM vision_stats WHERE camera_id=? AND module='quality' AND minute>=?",cam.id,since);
  const defects=one("SELECT count(*) n FROM vision_events WHERE camera_id=? AND module='quality' AND occurred_at>=?",cam.id,new Date(Date.now()-15*60000).toISOString()).n;
  const inspected=s.i||0, rate=inspected?100*(inspected-(s.p||0))/inspected:null, limit=visionSettings().qualityAlertRatePct;
  if (rate!=null&&inspected>=50&&rate>limit) raiseAlert({companyId:cam.company_id,plantId:cam.plant_id,module:'vision',severity:'warning',equipmentId:cam.equipment_id,title:`Defect rate ${rate.toFixed(1)} % – ${cam.name}`,detail:`${inspected-(s.p||0)} of ${inspected} parts failed in the last 15 minutes (limit ${limit} %); ${defects} defects recorded.`,dedupeKey:`vision:quality:${cam.id}`});
}

// Heartbeat: node and camera health plus per-minute counters. Replies with the config version (and the config when
// the node's copy is out of date). A camera back online resolves its offline alert.
export function heartbeat(node,body) {
  // Metrics and version are kept from the last heartbeat that sent them.
  const at=now(), metrics=body.metrics&&typeof body.metrics==='object'?json(body.metrics,'metrics',4000):node.metrics;
  run('UPDATE vision_nodes SET last_seen_at=?,agent_version=?,metrics=? WHERE id=?',at,String(body.agentVersion||'').slice(0,40)||node.agent_version,metrics,node.id);
  resolveAlertKey(`vision:node-offline:${node.id}`,at);
  const cams=Array.isArray(body.cameras)?body.cameras.slice(0,64):[];
  transaction(()=>{ for (const c of cams) {
    const cam=one('SELECT * FROM vision_cameras WHERE id=? AND node_id=?',c?.id,node.id); if (!cam) continue;
    const status=['online','offline','tampered','starting'].includes(c.status)?c.status:'online';
    run('UPDATE vision_cameras SET status=?,last_seen_at=?,metrics=? WHERE id=?',status,status==='online'?at:cam.last_seen_at,json({fps:c.fps??null,inferenceMs:c.inferenceMs??null,decodeMs:c.decodeMs??null,inspectionMs:c.inspectionMs??null},'camera metrics',500),cam.id);
    if (status==='online') resolveAlertKey(`vision:system:camera_offline:${cam.id}`,at);
    for (const s of Array.isArray(c.stats)?c.stats.slice(0,120):[]) {
      if (!MODULES[s?.module]||typeof s.minute!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s.minute)) continue;
      const n=k=>Math.max(0,Math.min(1e7,Math.round(Number(s[k])||0)));
      run(`INSERT INTO vision_stats (camera_id,minute,module,frames,people,compliant,inspected,passed,ignored) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(camera_id,minute,module) DO UPDATE SET frames=excluded.frames,people=excluded.people,compliant=excluded.compliant,inspected=excluded.inspected,passed=excluded.passed,ignored=excluded.ignored`,
        cam.id,s.minute.slice(0,16),s.module,n('frames'),n('people'),n('compliant'),n('inspected'),n('passed'),n('ignored'));
      if (s.module==='quality') syncQualityMinute(cam,s.minute.slice(0,16));
    }
  } });
  const fresh=one('SELECT * FROM vision_nodes WHERE id=?',node.id);
  return {serverTime:at,configVersion:fresh.config_version,...(Number(body.configVersion)!==fresh.config_version?{config:nodeConfig(fresh)}:{})};
}

// Edge-side events are prioritised: critical first, so a fire in a batch of quality defects is alerted first.
export function ingestBatch(node,events) {
  if (!Array.isArray(events)||!events.length||events.length>500) bad('Send 1-500 events per request');
  const at=now(), order=events.map((ev,index)=>({ev,index})).sort((a,b)=>(RANK[b.ev?.severity]??RANK[DEFAULT_SEVERITY[b.ev?.type]]??0)-(RANK[a.ev?.severity]??RANK[DEFAULT_SEVERITY[a.ev?.type]]??0));
  const results=[];
  for (const {ev,index} of order) { try { results.push({index,...transaction(()=>recordDetection(node,ev,at))}); } catch (e) { results.push({index,status:'rejected',error:e.message}); } }
  return results.sort((a,b)=>a.index-b.index);
}

// ---------- Housekeeping ----------
// Nodes silent for 3 minutes raise an alert; it resolves on the next heartbeat.
export function checkNodes() {
  for (const n of all('SELECT * FROM vision_nodes WHERE active=1 AND last_seen_at IS NOT NULL')) if (nodeStatus(n)==='offline')
    raiseAlert({companyId:n.company_id,plantId:n.plant_id,module:'vision',severity:'warning',title:`Vision edge node offline – ${n.name}`,detail:`No heartbeat since ${n.last_seen_at}. Its cameras keep acting locally if the node runs, but nothing reaches the platform.`,dedupeKey:`vision:node-offline:${n.id}`});
}
// Media of closed, unlocked events older than the retention period is deleted; locked evidence never is.
export function pruneMedia(at=Date.now()) {
  const cutoff=new Date(at-visionSettings().mediaRetentionDays*86400000).toISOString(); let removed=0;
  for (const e of all("SELECT id,snapshot_media_id,clip_media_id FROM vision_events WHERE locked=0 AND retrain=0 AND status IN ('resolved','false_alarm') AND occurred_at<? AND (snapshot_media_id IS NOT NULL OR clip_media_id IS NOT NULL)",cutoff)) {
    run('UPDATE vision_events SET snapshot_media_id=NULL,clip_media_id=NULL WHERE id=?',e.id);
    for (const m of [e.snapshot_media_id,e.clip_media_id]) if (m) { deleteMedia(m); removed++; }
  }
  run('DELETE FROM vision_stats WHERE minute<?',new Date(at-400*86400000).toISOString().slice(0,16));
  return removed;
}
