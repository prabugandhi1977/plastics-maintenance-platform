import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'mouldcare-test-'));
process.env.MOULDCARE_DATA_DIR=dir;
process.env.MOULDCARE_DB_SCHEMA='t_'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
process.env.MOULDCARE_SECRET='test-only-very-long-random-secret-123456';
process.env.MOULDCARE_INTEGRATION_KEY='test-integration-key';
await import('../scripts/seed.js');
const { createServer }=await import('../server.js');
const { db, one, all, run, execSql }=await import('../common/db.js');
const { pruneMedia, checkNodes }=await import('../services/vision/vision.js');
const server=createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close({dropSchema:true});rmSync(dir,{recursive:true,force:true});});
async function call(path,method='GET',body,token,headers={}) {const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...headers},body:body==null?undefined:JSON.stringify(body)});const type=r.headers.get('content-type')||'';return {status:r.status,type,data:type.startsWith('application/json')?await r.json():Buffer.from(await r.arrayBuffer())};}
const error=r=>r.data.error, tokens={}, ctx={};
const JPEG=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0,0xff,0xd9]).toString('base64');
const MP4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(12)]).toString('base64');
const ago=s=>new Date(Date.now()-s*1000).toISOString();
const edge=(path,body,key=ctx.key)=>call(path,body?'POST':'GET',body,null,key?{authorization:`Bearer ${key}`}:{});

test('setup',async()=>{
  // Start from no vision data (the demo seed adds some).
  await execSql("DELETE FROM vision_events; DELETE FROM vision_media; DELETE FROM vision_stats; DELETE FROM vision_zones; DELETE FROM vision_assignments; DELETE FROM vision_cameras; DELETE FROM vision_nodes; DELETE FROM vision_licences; UPDATE users SET vision_duties='[]'");
  for (const [k,email] of Object.entries({admin:'admin@demo.test',dispatch:'dispatch@demo.test',acme:'acme@demo.test',maint:'maint@demo.test',nova:'nova@demo.test',engineer:'engineer@demo.test'})) tokens[k]=(await call('/auth/login','POST',{email,password:'DemoPass123!'})).data.token; });

test('licences are set by the platform admin per company and module',async()=>{
  assert.equal((await call('/vision/licences/c-acme/ppe','PUT',{cameras:2},tokens.acme)).status,403);
  for (const [m,n] of [['ppe',2],['fire_smoke',2],['intrusion',2],['quality',1]]) assert.equal((await call(`/vision/licences/c-acme/${m}`,'PUT',{cameras:n,validUntil:'2099-12-31'},tokens.admin)).data.cameras,n);
  const mine=(await call('/vision/licences','GET',null,tokens.acme)).data; assert.equal(mine.length,1); assert.equal(mine[0].modules.find(x=>x.module==='quality').available,1);
  assert.equal((await call('/vision/licences','GET',null,tokens.engineer)).status,403);
});

test('edge nodes and cameras: keys shown once, passwords masked, stream limits',async()=>{
  assert.equal((await call('/vision/nodes','POST',{plantId:'plant-a',name:'Edge A'},tokens.maint)).status,403);
  const made=await call('/vision/nodes','POST',{plantId:'plant-a',name:'Edge PC hall A',hardware:'IPC + RTX A4000',maxStreams:2},tokens.acme);
  assert.equal(made.status,201); assert.match(made.data.key,/^vn_/); assert.equal(made.data.node.status,'never_seen'); ctx.node=made.data.node.id; ctx.key=made.data.key;
  assert.equal((await call('/vision/nodes','GET',null,tokens.nova)).data.length,0);
  const cam=n=>({plantId:'plant-a',nodeId:ctx.node,name:`Cam ${n}`,sourceType:'rtsp',sourceUrl:`rtsp://admin:s3cret@10.0.0.${n}:554/Streaming/Channels/101`,location:`Door ${n}`,equipmentId:'eq-a'});
  const c1=await call('/vision/cameras','POST',cam(1),tokens.acme); assert.equal(c1.status,201); assert.equal(c1.data.sourceUrl,'rtsp://admin:****@10.0.0.1:554/Streaming/Channels/101'); ctx.c1=c1.data.id;
  ctx.c2=(await call('/vision/cameras','POST',cam(2),tokens.acme)).data.id;
  assert.match(error(await call('/vision/cameras','POST',cam(3),tokens.acme)),/already runs 2 of its 2/);
  // Saving the masked URL back keeps the real one.
  await call(`/vision/cameras/${ctx.c1}`,'PATCH',{sourceUrl:'rtsp://admin:****@10.0.0.1:554/Streaming/Channels/101',name:'Gate 1'},tokens.acme);
  assert.match((await one('SELECT source_url FROM vision_cameras WHERE id=?', ctx.c1)).source_url,/s3cret/);
  assert.match(error(await call('/vision/cameras','POST',{plantId:'plant-a',name:'X',sourceType:'rtsp'},tokens.acme)),/sourceUrl is required/);
});

test('module routing checks licences and validates settings',async()=>{
  const put=(cam,m,body)=>call(`/vision/cameras/${cam}/modules/${m}`,'PUT',body,tokens.acme);
  assert.equal((await put(ctx.c1,'ppe',{config:{requiredGear:['helmet','vest','goggles'],beaconOutput:{protocol:'modbus_tcp',host:'10.0.0.50',coil:3}}})).status,200);
  assert.match(error(await put(ctx.c1,'ppe',{config:{requiredGear:['cape']}})),/requiredGear/);
  assert.match(error(await put(ctx.c1,'fire_smoke',{config:{confirmSeconds:5}})),/confirmSeconds must be from 0.2 to 1.8/);
  await put(ctx.c1,'fire_smoke',{}); await put(ctx.c2,'intrusion',{}); await put(ctx.c2,'fire_smoke',{});
  assert.equal((await put(ctx.c1,'quality',{config:{preset:'logistics_container',rejectOutput:{protocol:'ethernet_ip',host:'10.0.0.60',tag:'Reject_Cmd'}}})).status,200);
  assert.match(error(await put(ctx.c2,'quality',{})),/All 1 Quality inspection licences are in use/);
  assert.equal((await call(`/vision/cameras/${ctx.c1}/modules/ppe`,'PUT',{},tokens.maint)).status,403);
  const c=(await call('/vision/cameras','GET',null,tokens.acme)).data.find(x=>x.id===ctx.c1);
  assert.deepEqual(c.modules.map(m=>m.module),['fire_smoke','ppe','quality']); assert.equal(c.modules.find(m=>m.module==='ppe').config.beaconOutput.port,502);
});

test('geofences: polygons and tripwires on the camera image',async()=>{
  assert.match(error(await call(`/vision/cameras/${ctx.c2}/zones`,'POST',{name:'Line',kind:'tripwire',points:[[0,0],[1,1],[0.5,0.5]]},tokens.acme)),/exactly 2 points/);
  assert.match(error(await call(`/vision/cameras/${ctx.c2}/zones`,'POST',{name:'Bad',kind:'exclusion',points:[[0,0],[1.2,1],[0.5,0.5]]},tokens.acme)),/within the image/);
  const z=await call(`/vision/cameras/${ctx.c2}/zones`,'POST',{name:'Press cell',kind:'exclusion',points:[[0.1,0.1],[0.6,0.1],[0.6,0.8],[0.1,0.8]],severity:'critical'},tokens.acme);
  assert.equal(z.status,201); ctx.zone=z.data.id;
  await call(`/vision/cameras/${ctx.c2}/zones`,'POST',{name:'Robot arm',kind:'allowed_motion',points:[[0.3,0.2],[0.5,0.2],[0.5,0.5]]},tokens.acme);
  assert.equal((await call(`/vision/cameras/${ctx.c2}/zones`,'GET',null,tokens.maint)).data.length,2);
});

test('edge: heartbeat syncs configuration (full URLs), only to the right key',async()=>{
  assert.equal((await edge('/edge/v1/heartbeat',{},'vn_wrongwrongwrongwrongwrong')).status,401);
  const hb=(await edge('/edge/v1/heartbeat',{agentVersion:'1.0.0',configVersion:0,metrics:{gpuTempC:61,diskPct:42,streams:2,inferenceMsP95:14}})).data;
  assert.ok(hb.config); ctx.version=hb.configVersion;
  const c1=hb.config.cameras.find(c=>c.id===ctx.c1); assert.match(c1.sourceUrl,/s3cret/); assert.deepEqual(c1.modules.map(m=>m.module).sort(),['fire_smoke','ppe','quality']);
  assert.equal(hb.config.cameras.find(c=>c.id===ctx.c2).zones.length,2); assert.equal(hb.config.settings.broadcast.port,5005);
  assert.equal((await edge('/edge/v1/heartbeat',{configVersion:ctx.version})).data.config,undefined);
  // A licence cut leaves the extra assignment out of the node's configuration.
  await call('/vision/licences/c-acme/fire_smoke','PUT',{cameras:1,validUntil:'2099-12-31'},tokens.admin);
  const cut=(await edge('/edge/v1/heartbeat',{configVersion:ctx.version})).data; assert.ok(cut.config);
  assert.equal(cut.config.cameras.flatMap(c=>c.modules).filter(m=>m.module==='fire_smoke').length,1);
  await call('/vision/licences/c-acme/fire_smoke','PUT',{cameras:2,validUntil:'2099-12-31'},tokens.admin);
  const node=(await call('/vision/nodes','GET',null,tokens.acme)).data[0]; assert.equal(node.status,'online'); assert.equal(node.metrics.gpuTempC,61);
});

test('edge: detections are prioritised, alert people, log safety and lock proof',async()=>{
  const events=[
    {externalId:'q-1',cameraId:ctx.c1,module:'quality',type:'defect',occurredAt:ago(3),confidence:0.97,detail:{preset:'logistics_container',defect:'dent',sizeMm:3.2},boxes:[{x:0.4,y:0.4,w:0.1,h:0.1,label:'dent'}]},
    {externalId:'p-1',cameraId:ctx.c1,module:'ppe',type:'ppe_violation',occurredAt:ago(2),confidence:0.91,detail:{missing:['helmet']},boxes:[{x:0.2,y:0.1,w:0.15,h:0.6,label:'person'}],edgeActions:{relayMs:9}},
    {externalId:'f-1',cameraId:ctx.c2,module:'fire_smoke',type:'fire',occurredAt:ago(1),confidence:0.95,edgeActions:{broadcastMs:180,relayMs:12}},
    {externalId:'i-1',cameraId:ctx.c2,module:'intrusion',type:'intrusion_person',zoneId:ctx.zone,occurredAt:ago(1),confidence:0.88},
    {externalId:'x-1',cameraId:ctx.c2,module:'ppe',type:'ppe_violation',occurredAt:ago(1),detail:{missing:['vest']}},
  ];
  const r=(await edge('/edge/v1/events',{events})).data;
  assert.deepEqual([r.accepted,r.rejected],[4,1]); assert.match(r.results[4].error,/not assigned to this camera/);
  // Critical first: the fire and intrusion were recorded before the quality defect.
  const order=(await all("SELECT type FROM vision_events ORDER BY seq")).map(x=>x.type); assert.ok(order.indexOf('fire')<order.indexOf('defect'));
  assert.equal((await edge('/edge/v1/events',{events:[events[0]]})).data.duplicates,1);
  const alerts=(await call('/alerts','GET',null,tokens.acme)).data.filter(a=>a.module==='vision');
  assert.ok(alerts.some(a=>/Fire detected/.test(a.title)&&a.severity==='critical')); assert.ok(alerts.some(a=>/Person in Press cell/.test(a.title))); assert.ok(alerts.some(a=>/PPE missing/.test(a.title)));
  const safety=(await all("SELECT event_type FROM safety_events WHERE source='camera' AND description ILIKE '%Cam%' OR description ILIKE '%Gate 1%'")).map(x=>x.event_type);
  assert.ok(safety.includes('fire_smoke')&&safety.includes('ppe_missing'));
  const list=(await call('/vision/events','GET',null,tokens.acme)).data; ctx.fire=list.find(e=>e.type==='fire').id; ctx.defect=list.find(e=>e.type==='defect').id; ctx.ppe=list.find(e=>e.type==='ppe_violation').id;
  assert.equal(list.find(e=>e.type==='fire').locked,true); assert.equal(list.find(e=>e.type==='defect').locked,false);
  assert.equal(list.find(e=>e.type==='intrusion_person').zoneName,'Press cell');
  assert.equal((await call('/vision/events','GET',null,tokens.nova)).data.length,0);
  // Another node's key cannot report for these cameras.
  const other=(await call('/vision/nodes','POST',{plantId:'plant-a',name:'Edge B'},tokens.acme)).data.key;
  assert.match((await edge('/edge/v1/events',{events:[events[2]]},other)).data.results[0].error,/not a camera of this node/);
});

test('edge: evidence uploads; media served only within the company',async()=>{
  assert.equal((await edge('/edge/v1/media',{eventId:'f-1',kind:'snapshot',mime:'image/jpeg',base64:JPEG})).status,201);
  assert.equal((await edge('/edge/v1/media',{eventId:'f-1',kind:'clip',mime:'video/mp4',base64:MP4})).status,201);
  assert.match(error(await edge('/edge/v1/media',{eventId:'p-1',kind:'clip',mime:'image/jpeg',base64:JPEG})),/clip must be video\/mp4/);
  assert.match(error(await edge('/edge/v1/media',{eventId:'p-1',kind:'snapshot',mime:'image/jpeg',base64:MP4})),/does not match/);
  assert.equal((await edge('/edge/v1/media',{cameraId:ctx.c2,kind:'frame',mime:'image/jpeg',base64:JPEG})).status,201);
  const fire=(await call(`/vision/events/${ctx.fire}`,'GET',null,tokens.acme)).data; assert.ok(fire.snapshotMediaId&&fire.clipMediaId);
  const clip=await call(`/vision/media/${fire.clipMediaId}`,'GET',null,tokens.maint); assert.equal(clip.status,200); assert.equal(clip.type,'video/mp4');
  assert.equal((await call(`/vision/media/${fire.clipMediaId}`,'GET',null,tokens.nova)).status,403);
  assert.ok((await call('/vision/cameras','GET',null,tokens.acme)).data.find(c=>c.id===ctx.c2).snapshotMediaId);
});

test('incidents: acknowledge, resolve (closing the alert), false alarm for retraining, proof log',async()=>{
  assert.equal((await call(`/vision/events/${ctx.fire}/acknowledge`,'POST',{},tokens.maint)).data.status,'acknowledged');
  assert.match(error(await call(`/vision/events/${ctx.fire}/resolve`,'POST',{},tokens.maint)),/note must be/);
  assert.equal((await call(`/vision/events/${ctx.fire}/resolve`,'POST',{note:'Small fire at the hopper heater, extinguished'},tokens.maint)).data.status,'resolved');
  assert.ok(!(await call('/alerts','GET',null,tokens.acme)).data.some(a=>a.module==='vision'&&/Fire detected/.test(a.title)));
  const fa=(await call(`/vision/events/${ctx.defect}/false-alarm`,'POST',{note:'Reflection on wet container, not a dent'},tokens.acme)).data;
  assert.equal(fa.status,'false_alarm'); assert.equal(fa.retrain,true);
  assert.equal((await call('/vision/retraining','GET',null,tokens.maint)).status,403);
  const set=(await call('/vision/retraining','GET',null,tokens.acme)).data; assert.equal(set.length,1); assert.equal(set[0].label,'false_positive');
  assert.equal((await call(`/vision/events/${ctx.ppe}/lock`,'POST',{locked:false},tokens.maint)).status,403);
  const csv=await call('/vision/events.csv?module=ppe','GET',null,tokens.acme); assert.equal(csv.status,200); assert.match(csv.type,/text\/csv/);
  const text=csv.data.toString('utf8'); assert.match(text,/Occurred \(UTC\),Camera/); assert.match(text,/missing: Safety helmet/);
});

test('dashboard: PPE compliance and quality rates from edge counters; alarms by duty',async()=>{
  const minute=new Date().toISOString().slice(0,16);
  await edge('/edge/v1/heartbeat',{configVersion:ctx.version,cameras:[{id:ctx.c1,status:'online',fps:25,inferenceMs:12,stats:[{minute,module:'ppe',frames:1500,people:40,compliant:38},{minute,module:'quality',frames:3600,inspected:400,passed:396}]}]});
  const o=(await call('/vision/overview?hours=24','GET',null,tokens.acme)).data;
  assert.equal(o.ppe.complianceRate,95); assert.equal(o.quality.defectRate,1); assert.equal(o.fire.fire,1); assert.equal(o.intrusion.people,1);
  assert.deepEqual(o.ppe.byGear,[{key:'helmet',n:1}]); assert.deepEqual(o.quality.logistics,[{key:'dent',n:1}]);
  assert.equal(o.latency.broadcastP95Ms,180); assert.equal(o.cameras.length,2); assert.ok(o.nodes.length>=1);
  // The maintenance user has no vision duties: critical alarms only. As security they also see warnings in their area.
  const crit=(await call('/vision/alarms','GET',null,tokens.maint)).data; assert.ok(crit.every(e=>e.severity==='critical'));
  const maintId=(await one("SELECT id FROM users WHERE email='maint@demo.test'")).id;
  assert.equal((await call(`/users/${maintId}`,'PATCH',{visionDuties:['security','guard']},tokens.acme)).status,400);
  assert.deepEqual(JSON.parse((await call(`/users/${maintId}`,'PATCH',{visionDuties:['ehs']},tokens.acme)).data.vision_duties),['ehs']);
  const ehs=(await call('/vision/alarms','GET',null,tokens.maint)).data; assert.ok(ehs.some(e=>e.module==='ppe')); assert.ok(!ehs.some(e=>e.module==='intrusion'));
  assert.deepEqual((await call('/me','GET',null,tokens.maint)).data.visionDuties??(await call('/auth/me','GET',null,tokens.maint)).data?.visionDuties,['ehs']);
});

test('housekeeping: silent nodes alert; closed unlocked evidence is pruned, locked evidence never',async()=>{
  await run("UPDATE vision_nodes SET last_seen_at=? WHERE id=?", ago(600),ctx.node); await checkNodes();
  assert.ok((await call('/alerts','GET',null,tokens.acme)).data.some(a=>/edge node offline/.test(a.title)));
  await edge('/edge/v1/heartbeat',{configVersion:ctx.version});
  assert.ok(!(await call('/alerts','GET',null,tokens.acme)).data.some(a=>/edge node offline/.test(a.title)));
  // An old, closed quality defect with a snapshot (not for retraining) is pruned; the old resolved fire (locked) is not.
  await edge('/edge/v1/events',{events:[{externalId:'q-old',cameraId:ctx.c1,module:'quality',type:'defect',occurredAt:ago(5),detail:{preset:'logistics_container',defect:'rust'}}]});
  await edge('/edge/v1/media',{eventId:'q-old',kind:'snapshot',mime:'image/jpeg',base64:JPEG});
  const old=(await one("SELECT id FROM vision_events WHERE external_id='q-old'")).id;
  await call(`/vision/events/${old}/resolve`,'POST',{note:'Container sent back'},tokens.acme);
  await run("UPDATE vision_events SET occurred_at=? WHERE id IN (?,?)", ago(40*86400),old,ctx.fire);
  assert.equal(await pruneMedia(),1);
  assert.equal((await one('SELECT snapshot_media_id s FROM vision_events WHERE id=?', old)).s,null);
  assert.ok((await one('SELECT clip_media_id c FROM vision_events WHERE id=?', ctx.fire)).c);
});

test('automotive plastic parts: preset, PLC trigger within the cycle, A/B/C acceptance, vendor and surface classes',async()=>{
  await call('/vision/licences/c-acme/quality','PUT',{cameras:3,validUntil:'2099-12-31'},tokens.admin);
  const cam=(await call('/vision/cameras','POST',{plantId:'plant-a',nodeId:null,name:'Door panel QA',vendor:'Cognex',sourceType:'cognex-native',sourceUrl:'192.168.10.30:23',equipmentId:'eq-a2'},tokens.acme)).data;
  assert.equal(cam.vendor,'Cognex');
  assert.match(error(await call('/vision/cameras','POST',{plantId:'plant-a',name:'X',vendor:'Acme Cams',sourceType:'rtsp',sourceUrl:'rtsp://x'},tokens.acme)),/vendor must be one of/);
  const put=config=>call(`/vision/cameras/${cam.id}/modules/quality`,'PUT',{config},tokens.acme);
  const defaults=(await put({})).data.modules.find(m=>m.module==='quality').config;
  assert.deepEqual([defaults.preset,defaults.triggerMode,defaults.cycleTimeS,defaults.resultBudgetMs],['automotive_plastic','plc',3,500]);
  assert.match(error(await put({cycleTimeS:3,resultBudgetMs:1800})),/at most half the cycle time/);
  assert.match(error(await put({acceptance:{A:2,B:1,C:3}})),/A ≤ B ≤ C/);
  assert.match(error(await put({triggerInput:{protocol:'profinet',host:'x'}})),/modbus_tcp or ethernet_ip/);
  const plc=(await put({triggerInput:{protocol:'ethernet_ip',host:'192.168.10.40',tag:'Cell3_PartPresent'},okOutput:{protocol:'ethernet_ip',host:'192.168.10.40',tag:'Cell3_OK'},rejectOutput:{protocol:'modbus_tcp',host:'192.168.10.41',coil:2}})).data.modules.find(m=>m.module==='quality').config;
  assert.equal(plc.triggerInput.tag,'Cell3_PartPresent'); assert.equal(plc.rejectOutput.port,502);
  const roi=await call(`/vision/cameras/${cam.id}/zones`,'POST',{name:'Visible face',kind:'inspection_roi',surfaceClass:'A',points:[[0.1,0.1],[0.9,0.1],[0.9,0.6],[0.1,0.6]]},tokens.acme);
  assert.equal(roi.data.surfaceClass,'A');
  assert.equal((await call(`/vision/cameras/${cam.id}/zones`,'POST',{name:'Wall',kind:'exclusion',surfaceClass:'B',points:[[0,0],[1,0],[1,1]]},tokens.acme)).data.surfaceClass,null);
  assert.ok((await call('/vision/catalog','GET',null,tokens.acme)).data.defectInfo.sink_mark[2].includes('Holding pressure'));
  // Defects from the edge feed the Vision quality page (FPY and Pareto per machine).
  await call(`/vision/nodes/${ctx.node}`,'PATCH',{maxStreams:4},tokens.acme);
  assert.equal((await call(`/vision/cameras/${cam.id}`,'PATCH',{nodeId:ctx.node},tokens.acme)).data.nodeId,ctx.node);
  const conf=(await edge('/edge/v1/config')).data.cameras.find(c=>c.id===cam.id);
  const q=conf.modules.find(m=>m.module==='quality').config;
  assert.ok(q.defects.includes('short_shot')&&q.defects.includes('sink_mark'),'the node gets the preset defect classes to grade against');
  assert.equal(conf.zones.find(z=>z.kind==='inspection_roi').surfaceClass,'A');
  const minute=new Date().toISOString().slice(0,16);
  await edge('/edge/v1/heartbeat',{configVersion:0,cameras:[{id:cam.id,status:'online',inspectionMs:212,stats:[{minute,module:'quality',frames:20,inspected:20,passed:18}]}]});
  assert.equal(JSON.parse((await one('SELECT metrics FROM vision_cameras WHERE id=?', cam.id)).metrics).inspectionMs,212);
  const r=await edge('/edge/v1/events',{events:['sink_mark','short_shot'].map((defect,i)=>({externalId:`auto-${i}`,cameraId:cam.id,module:'quality',type:'defect',occurredAt:new Date().toISOString(),detail:{preset:'automotive_plastic',defect,surfaceClass:'A',sizeMm:1.2}}))});
  assert.equal(r.data.accepted,2,JSON.stringify(r.data.results));
  const row=await one("SELECT inspected,rejected,defects,source FROM vision_results WHERE equipment_id='eq-a2' AND station='Door panel QA'");
  assert.deepEqual([row.inspected,row.rejected,row.source],[20,2,'edge']); assert.deepEqual(JSON.parse(row.defects),{short_shot:1,sink_mark:1});
});
