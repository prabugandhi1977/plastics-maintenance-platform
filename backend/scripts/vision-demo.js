// Vision demo data: an edge node, cameras, licences, zones, counters and incidents with synthetic camera frames, so
// the vision pages can be explored before real cameras are connected. Demo databases only.
import { deflateSync } from 'node:zlib';
import { id, now, one, run } from '../common/db.js';
import { hashKey, storeMedia, syncQualityMinute } from '../services/vision/vision.js';

// The demo node's key, so the edge simulator (edge/simulate.py) can report against a demo copy. Demo only.
export const DEMO_NODE_KEY='vn_demo-chicago-edge-node-key-0001';

// ---------- A tiny PNG painter for synthetic frames ----------
function canvas(w,h,top,bottom) {
  const px=Buffer.alloc(w*h*3);
  for (let y=0;y<h;y++) { const t=y/h, c=top.map((v,i)=>Math.round(v+(bottom[i]-v)*t)); for (let x=0;x<w;x++) px.set(c,(y*w+x)*3); }
  const set=(x,y,c)=>{ if (x>=0&&y>=0&&x<w&&y<h) px.set(c,(y*w+x)*3); };
  return {w,h,
    rect:(x,y,rw,rh,c)=>{ for (let j=Math.max(0,y);j<Math.min(h,y+rh);j++) for (let i=Math.max(0,x);i<Math.min(w,x+rw);i++) px.set(c,(j*w+i)*3); },
    circle:(cx,cy,r,c)=>{ for (let j=-r;j<=r;j++) for (let i=-r;i<=r;i++) if (i*i+j*j<=r*r) set(cx+i,cy+j,c); },
    line:(x0,y0,x1,y1,c,t=1)=>{ const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0)); for (let k=0;k<=n;k++) { const x=Math.round(x0+(x1-x0)*k/n), y=Math.round(y0+(y1-y0)*k/n); for (let a=0;a<t;a++) for (let b=0;b<t;b++) set(x+a,y+b,c); } },
    noise:(amount,seed=7)=>{ let s=seed; for (let i=0;i<px.length;i++) { s=(s*1103515245+12345)&0x7fffffff; px[i]=Math.max(0,Math.min(255,px[i]+((s>>16)%(amount*2+1))-amount)); } },
    png:()=>{ const raw=Buffer.alloc((w*3+1)*h); for (let y=0;y<h;y++) px.copy(raw,y*(w*3+1)+1,y*w*3,(y+1)*w*3);
      const table=[...Array(256)].map((_,n)=>{ let c=n; for (let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; return c>>>0; });
      const crc=b=>{ let c=~0; for (const x of b) c=table[(c^x)&255]^(c>>>8); return (~c)>>>0; };
      const chunk=(type,data)=>{ const len=Buffer.alloc(4); len.writeUInt32BE(data.length); const td=Buffer.concat([Buffer.from(type),data]); const c=Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len,td,c]); };
      const ih=Buffer.alloc(13); ih.writeUInt32BE(w,0); ih.writeUInt32BE(h,4); ih[8]=8; ih[9]=2;
      return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]); }};
}
const W=640, H=360;
// A worker: legs, body (vest colour), head, optional helmet.
function worker(c,x,y,{vest=[250,140,20],helmet=true,scale=1}) {
  const s=v=>Math.round(v*scale);
  c.rect(x+s(6),y+s(70),s(10),s(46),[40,50,70]); c.rect(x+s(22),y+s(70),s(10),s(46),[40,50,70]);
  c.rect(x,y+s(24),s(38),s(50),vest); if (vest[0]>200) c.rect(x,y+s(44),s(38),s(5),[230,230,210]);
  c.circle(x+s(19),y+s(14),s(11),[224,180,150]); if (helmet) c.rect(x+s(7),y,s(25),s(9),[250,215,40]);
}
function scene(kind) {
  if (kind==='gate') { const c=canvas(W,H,[70,78,84],[120,120,112]); c.rect(0,250,W,110,[95,98,92]); c.rect(220,40,200,215,[45,52,58]); c.rect(232,52,176,195,[160,175,180]); c.rect(212,30,216,12,[250,200,0]);
    worker(c,250,120,{helmet:false,scale:1.05}); worker(c,350,128,{scale:1}); c.noise(6); return c; }
  if (kind==='hall') { const c=canvas(W,H,[60,66,72],[110,112,108]); c.rect(0,230,W,130,[90,92,88]); c.rect(70,90,210,160,[60,110,140]); c.rect(80,100,190,40,[200,205,210]); c.rect(420,110,150,130,[230,120,20]);
    c.line(470,240,520,150,[90,90,90],6); c.line(520,150,560,170,[90,90,90],6); c.line(0,300,W,300,[250,200,0],3); worker(c,330,140,{scale:1}); c.noise(6); return c; }
  if (kind==='fire') { const c=canvas(W,H,[58,62,66],[100,100,96]); c.rect(0,240,W,120,[88,90,86]); c.rect(120,120,260,130,[70,120,150]); c.rect(150,90,60,32,[120,120,120]);
    for (let i=0;i<9;i++) c.circle(190+((i*37)%70),150-i*9,26-i*2,[255,120+i*12,20]); for (let i=0;i<10;i++) c.circle(200+i*8,70-i*6,22,[130,130,130]); c.noise(8); return c; }
  if (kind==='panel') { const c=canvas(W,H,[40,44,48],[30,32,36]); c.rect(70,50,500,220,[52,54,58]); c.rect(70,250,500,60,[60,62,66]); for (let i=0;i<6;i++) c.rect(110+i*80,262,26,30,[44,46,50]);
    c.rect(140,90,360,6,[70,72,76]); c.circle(330,170,16,[44,46,50]); c.line(200,140,262,150,[90,92,96],2); c.rect(470,110,40,30,[62,64,68]); c.noise(5); return c; }
  if (kind==='pcb') { const c=canvas(W,H,[20,90,50],[18,80,45]); for (let i=0;i<8;i++) c.rect(60+i*65,80,40,26,[30,30,30]); for (let i=0;i<5;i++) c.rect(90+i*95,190,60,60,[200,200,190]);
    for (let i=0;i<14;i++) c.line(40,140+i*3,600,140+i*3,[210,170,60],1); c.line(300,215,352,236,[240,240,240],2); c.circle(470,110,9,[120,90,40]); c.noise(4); return c; }
  const c=canvas(W,H,[150,165,180],[110,115,118]); c.rect(60,70,520,240,[180,60,40]); for (let i=0;i<13;i++) c.rect(70+i*40,80,6,220,[150,45,30]);
  c.circle(330,170,34,[120,40,25]); c.circle(330,170,22,[160,55,35]); c.rect(450,240,70,30,[120,90,60]); c.noise(6); return c;
}
const png64=kind=>scene(kind).png().toString('base64');

export async function seedVision() {
  if (!await one("SELECT 1 FROM companies WHERE id='c-acme'")||await one('SELECT 1 FROM vision_nodes')) return false;
  const at=now(), T=Date.now(), iso=ms=>new Date(T-ms).toISOString();
  for (const [m,n] of [['ppe',4],['fire_smoke',4],['intrusion',4],['quality',2]]) await run('INSERT INTO vision_licences (company_id,module,cameras,valid_until,updated_at) VALUES (?,?,?,?,?)','c-acme',m,n,'2027-12-31',at);
  for (const [m,n] of [['quality',2],['fire_smoke',2]]) await run('INSERT INTO vision_licences (company_id,module,cameras,valid_until,updated_at) VALUES (?,?,?,?,?)','c-nova',m,n,'2027-06-30',at);
  await run('INSERT INTO vision_nodes (id,company_id,plant_id,name,hardware,max_streams,key_hash,key_hint,last_seen_at,agent_version,metrics,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    'vn-chicago','c-acme','plant-a','Edge PC – Chicago press hall','Industrial PC, NVIDIA RTX A4000 16 GB, 64 GB RAM, 2 TB NVMe',16,hashKey(DEMO_NODE_KEY),`${DEMO_NODE_KEY.slice(0,6)}…${DEMO_NODE_KEY.slice(-4)}`,iso(20000),'1.0.0',
    JSON.stringify({gpuUtil:58,gpuTempC:63,cpuTempC:57,diskPct:41,streams:4,fps:25,inferenceMsP95:13.8}),at);
  const cams=[
    ['vc-gate','Gate 1 – press hall entrance','Door 4, north','rtsp://admin:demo@192.168.10.21:554/Streaming/Channels/101','gate',null,[['ppe',{requiredGear:['helmet','vest'],minConfidence:0.6,cooldownSeconds:30,beaconOutput:{protocol:'modbus_tcp',host:'192.168.10.5',port:502,unitId:1,coil:4,pulseMs:3000}}],['fire_smoke',{sensitivity:'balanced',confirmSeconds:1.5,broadcast:true,sirenOutput:null}]]],
    ['vc-hall','Press hall – robot cell 3','Bay 4, IMM-04','rtsp://admin:demo@192.168.10.22:554/Streaming/Channels/101','hall','eq-a',[['intrusion',{classes:['person','vehicle'],dwellSeconds:0.5,sirenOutput:{protocol:'modbus_tcp',host:'192.168.10.5',port:502,unitId:1,coil:7,pulseMs:5000}}],['fire_smoke',{sensitivity:'conservative',confirmSeconds:1.5,broadcast:true,sirenOutput:null}]]],
    ['vc-line','IMM-05 – door trim panel QA','Cell 5 take-out, IMM-05','admin:demo@192.168.10.23:23','panel','eq-a2',[['quality',{preset:'automotive_plastic',triggerMode:'plc',cycleTimeS:3,resultBudgetMs:500,minDefectMm:0.5,mmPerPixel:0.16,targetFps:60,acceptance:{A:0.5,B:1,C:2},
      triggerInput:{protocol:'ethernet_ip',host:'192.168.10.40',tag:'Cell5_PartPresent'},okOutput:{protocol:'ethernet_ip',host:'192.168.10.40',tag:'Cell5_VisionOK',value:1,pulseMs:200},rejectOutput:{protocol:'ethernet_ip',host:'192.168.10.40',tag:'Cell5_VisionNG',value:1,pulseMs:200}}]]],
    ['vc-dock','Dock 3 – outbound containers','Shipping dock','http://192.168.10.24/ISAPI/Streaming/channels/101/picture','dock',null,[['quality',{preset:'logistics_container',minDefectMm:5,mmPerPixel:2.5,targetFps:10,rejectOutput:null}],['ppe',{requiredGear:['helmet','vest','boots'],minConfidence:0.6,cooldownSeconds:60,beaconOutput:null}]]],
  ];
  const VENDOR={'vc-gate':['Hikvision','rtsp'],'vc-hall':['Hikvision','rtsp'],'vc-line':['Cognex','cognex-native'],'vc-dock':['Hikvision','http-snapshot']};
  for (const [cid,name,location,url,kind,eq,mods] of cams) {
    const frame=await storeMedia('c-acme',{kind:'frame',mime:'image/png',base64:png64(kind)});
    await run('INSERT INTO vision_cameras (id,company_id,plant_id,node_id,name,source_type,source_url,location,equipment_id,fps,snapshot_media_id,status,last_seen_at,metrics,created_at,vendor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      cid,'c-acme','plant-a','vn-chicago',name,VENDOR[cid][1],url,location,eq,cid==='vc-line'?1:25,frame.id,'online',iso(20000),JSON.stringify(cid==='vc-line'?{inspectionMs:182,inferenceMs:38}:{fps:25,inferenceMs:14.5}),at,VENDOR[cid][0]);
    for (const [m,cfg] of mods) await run('INSERT INTO vision_assignments (camera_id,module,enabled,config,updated_by,updated_at) VALUES (?,?,1,?,?,?)',cid,m,JSON.stringify(cfg),'u-acme',at);
  }
  const zone=async (zid,cam,name,kind,points,severity='critical')=>await run('INSERT INTO vision_zones (id,camera_id,name,kind,points,severity,classes,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)',zid,cam,name,kind,JSON.stringify(points),severity,'["person","vehicle"]',at,at);
  await zone('vz-cell','vc-hall','Robot cell 3 – no entry','exclusion',[[0.6,0.28],[0.95,0.28],[0.95,0.72],[0.6,0.72]]);
  await zone('vz-robot','vc-hall','Robot arm path (approved motion)','allowed_motion',[[0.7,0.38],[0.9,0.38],[0.9,0.68],[0.7,0.68]]);
  await zone('vz-line','vc-hall','Floor marking – walkway edge','tripwire',[[0,0.83],[1,0.83]],'warning');
  await run("INSERT INTO vision_zones (id,camera_id,name,kind,points,severity,classes,active,created_at,updated_at,surface_class) VALUES ('vz-face','vc-line','Visible face (class A)','inspection_roi',?,'warning','[]',1,?,?,'A'),('vz-edge','vc-line','Flange and clip area (class B)','inspection_roi',?,'warning','[]',1,?,?,'B')",
    JSON.stringify([[0.12,0.15],[0.88,0.15],[0.88,0.62],[0.12,0.62]]),at,at,JSON.stringify([[0.12,0.62],[0.88,0.62],[0.88,0.85],[0.12,0.85]]),at,at);
  await zone('vz-gate','vc-gate','Entrance – PPE required','ppe_zone',[[0.3,0.1],[0.7,0.1],[0.7,0.72],[0.3,0.72]],'warning');
  // Per-minute counters for the last 6 hours.
  for (let m=0;m<360;m+=1) { const minute=iso(m*60000).slice(0,16), r=k=>(Math.sin(m/7+k)+1)/2;
    await run('INSERT INTO vision_stats (camera_id,minute,module,frames,people,compliant) VALUES (?,?,?,?,?,?)','vc-gate',minute,'ppe',1500,4+Math.round(r(1)*4),4+Math.round(r(1)*4)-(m%23===0?1:0));
    await run('INSERT INTO vision_stats (camera_id,minute,module,frames,people,compliant) VALUES (?,?,?,?,?,?)','vc-dock',minute,'ppe',600,1+Math.round(r(2)*2),1+Math.round(r(2)*2)-(m%41===0?1:0));
    await run('INSERT INTO vision_stats (camera_id,minute,module,frames,ignored) VALUES (?,?,?,?,?)','vc-hall',minute,'intrusion',1500,Math.round(r(3)*30));
    await run('INSERT INTO vision_stats (camera_id,minute,module,frames,inspected,passed) VALUES (?,?,?,?,?,?)','vc-line',minute,'quality',20,20,20-(m%9===0?1:0)-(m%31===0?1:0));
    await run('INSERT INTO vision_stats (camera_id,minute,module,frames,inspected,passed) VALUES (?,?,?,?,?,?)','vc-dock',minute,'quality',600,m%3===0?1:0,m%3===0&&m%18!==0?1:0);
  }
  // Incidents with snapshots: a mix of open, handled and false alarms.
  const ev=async (cam,module,type,severity,ago,{conf=0.9,detail={},boxes=[],zoneId=null,actions={},status='open',note='',kind,locked=1,retrain=0}={})=>{
    const media=kind?(await storeMedia('c-acme',{kind:'snapshot',mime:'image/png',base64:png64(kind)})).id:null, key=id(), occurred=iso(ago*60000);
    await run(`INSERT INTO vision_events (id,company_id,plant_id,camera_id,node_id,module,type,severity,confidence,occurred_at,received_at,latency_ms,zone_id,detail,boxes,edge_actions,snapshot_media_id,status,acknowledged_by,acknowledged_at,resolved_by,resolved_at,resolution_note,locked,retrain,external_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,key,'c-acme','plant-a',cam,'vn-chicago',module,type,severity,conf,occurred,new Date(Date.parse(occurred)+420).toISOString(),420,zoneId,JSON.stringify(detail),JSON.stringify(boxes),JSON.stringify(actions),media,
      status,status==='open'?null:'u-acme',status==='open'?null:occurred,['resolved','false_alarm'].includes(status)?'u-acme':null,['resolved','false_alarm'].includes(status)?occurred:null,note,locked,retrain,`demo-${key.slice(0,8)}`);
    return key;
  };
  const person=(x,y,label,ok=false)=>({x,y,w:0.1,h:0.36,label,confidence:0.92,ok});
  await ev('vc-gate','ppe','ppe_violation','warning',12,{kind:'gate',detail:{missing:['helmet']},boxes:[person(0.39,0.33,'no helmet'),{...person(0.546,0.355,'compliant',true)}],actions:{relayMs:8}});
  await ev('vc-gate','ppe','ppe_violation','warning',190,{kind:'gate',detail:{missing:['helmet','vest']},boxes:[person(0.39,0.33,'no helmet, no vest')],actions:{relayMs:9},status:'resolved',note:'Visitor stopped at the door and given a helmet and vest'});
  await ev('vc-dock','ppe','ppe_violation','warning',400,{kind:'dock',detail:{missing:['boots']},boxes:[person(0.2,0.4,'no safety boots')],status:'acknowledged'});
  await ev('vc-hall','intrusion','intrusion_person','critical',35,{kind:'hall',zoneId:'vz-cell',boxes:[person(0.515,0.39,'person 0.94')],actions:{relayMs:11,broadcastMs:160},status:'acknowledged'});
  await ev('vc-hall','intrusion','intrusion_vehicle','warning',520,{kind:'hall',zoneId:'vz-line',boxes:[{x:0.05,y:0.55,w:0.25,h:0.3,label:'forklift 0.88',confidence:0.88}],status:'resolved',note:'Forklift driver briefed on the walkway marking'});
  await ev('vc-hall','fire_smoke','smoke','critical',260,{kind:'fire',conf:0.86,boxes:[{x:0.28,y:0.1,w:0.25,h:0.3,label:'smoke 0.86',confidence:0.86}],actions:{broadcastMs:180,relayMs:12},status:'false_alarm',note:'Steam from the mould cooling water leak – sent for retraining',retrain:1});
  await ev('vc-gate','fire_smoke','fire','critical',3,{kind:'fire',conf:0.95,boxes:[{x:0.27,y:0.24,w:0.18,h:0.25,label:'fire 0.95',confidence:0.95},{x:0.3,y:0.05,w:0.2,h:0.2,label:'smoke 0.9',confidence:0.9}],actions:{broadcastMs:170,relayMs:10}});
  for (const [ago,defect,size,cls,box] of [[6,'scratch',1.6,'A',[0.31,0.4,0.11,0.06]],[44,'sink_mark',2.4,'A',[0.48,0.42,0.08,0.1]],[95,'short_shot',6,'B',[0.73,0.69,0.08,0.12]],[160,'flash',1.4,'B',[0.15,0.7,0.12,0.06]],[300,'burn_mark',3.1,'A',[0.72,0.28,0.08,0.1]]])
    await ev('vc-line','quality','defect',cls==='A'?'warning':'info',ago,{kind:'panel',conf:0.96,detail:{preset:'automotive_plastic',defect,sizeMm:size,surfaceClass:cls,partId:`DTP-${240000+ago}`,inspectionMs:180+ago%40},
      boxes:[{x:box[0],y:box[1],w:box[2],h:box[3],label:`${defect.replace('_',' ')} ${size} mm`,confidence:0.96}],actions:{plcMs:4},locked:0,status:ago>200?'resolved':'open',note:ago>200?'Part rejected and scrapped':''});
  for (const [ago,defect] of [[20,'dent'],[140,'rust'],[610,'hole']])
    await ev('vc-dock','quality','defect','warning',ago,{kind:'dock',conf:0.93,detail:{preset:'logistics_container',defect,sizeMm:defect==='hole'?40:120,partId:`CONT-MSKU${4410000+ago}`},boxes:[{x:0.47,y:0.37,w:0.12,h:0.21,label:`${defect} 0.93`,confidence:0.93}],locked:0});
  // The Vision quality page (FPY, PPM, Pareto) shows the inspection line's results too.
  const line=await one("SELECT * FROM vision_cameras WHERE id='vc-line'"); for (let m=0;m<360;m+=1) await syncQualityMinute(line,iso(m*60000).slice(0,16));
  await run("UPDATE users SET vision_duties='[\"ehs\",\"security\",\"qa\"]' WHERE id='u-acme'");
  await run("UPDATE users SET vision_duties='[\"ehs\"]' WHERE id='u-acme-maint'");
  return true;
}
