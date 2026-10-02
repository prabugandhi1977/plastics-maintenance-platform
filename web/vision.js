// Vision AI pages: the overview (EHS, security and QA views), cameras with drag-and-drop module routing and the
// geofence editor, incidents with their evidence, and edge nodes with licences. Plus the live alarm banner shown on
// every page for fire, intrusion and (for people with those duties) PPE and quality alarms.
import { esc, btn, humanise, dataTable, simpleTable, field, select, checkboxes, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber } from './shared/i18n.js';
import { columnChart, barChart, statTile } from './charts.js';
import { authImageUrl, machineIcon } from './shared/media.js';

export function createVision(ctx) {
  const { state, api, render, fail, when, header, is, customer, admin, raiseTicket } = ctx;
  const vc=()=>state.visionCat||{};
  const mod=m=>vc().modules?.[m]?.label||humanise(m);
  const canManage=companyId=>admin()||(is('customer_admin')&&state.user.companyId===companyId);
  const anyManage=()=>admin()||is('customer_admin');
  const camById=id=>(state.vcams||[]).find(c=>c.id===id)||(state.vo?.cameras||[]).find(c=>c.id===id);
  const plantName=id=>(state.data.plants||[]).find(p=>p.id===id)?.name||'';
  const sevPill=s=>`<span class="pill ${s==='critical'?'critical':s==='warning'?'warning':''}">${s==='critical'?'⚠ ':s==='warning'?'● ':''}${esc(humanise(s))}</span>`;
  const statusPill=s=>`<span class="pill ${({open:'critical',acknowledged:'pending',resolved:'approved',false_alarm:'inactive'})[s]||''}">${esc(humanise(s))}</span>`;
  const camStatus=s=>`<span class="pill ${({online:'approved',offline:'critical',tampered:'critical',never_seen:'inactive',unknown:'inactive',starting:'pending',disabled:'inactive'})[s]||''}">${esc(humanise(s))}</span>`;
  const tabs=(key,list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-vtab="${key}:${k}">${esc(l)}</button>`).join('')}</div>`;
  // Compact filter selects, styled like the other smart-factory pages.
  const tool=(attr,key,label,opts,value,all='All')=>`<select ${attr}="${key}" class="tt-filter" aria-label="${esc(label)}">${all?`<option value="">${esc(all)}</option>`:''}${opts.map(([v,l])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(l)}</option>`).join('')}</select>`;
  const pct=v=>v==null?'—':`${formatNumber(v,1)} %`;
  const ms=v=>v==null?'—':`${formatNumber(v,0)} ms`;
  const typeLabel=t=>({ppe_violation:'PPE violation',fire:'Fire',smoke:'Smoke',intrusion_person:'Person intrusion',intrusion_vehicle:'Vehicle intrusion',defect:'Defect'})[t]||humanise(t);
  const eventDetail=e=>e.module==='ppe'?`Missing ${(e.detail.missing||[]).map(g=>vc().ppeGear?.[g]||g).join(', ')}`:e.module==='quality'?`${humanise(e.detail.defect||'')}${e.detail.sizeMm?` · ${formatNumber(e.detail.sizeMm,1)} mm`:''} · ${vc().qualityPresets?.[e.detail.preset]?.label||e.detail.preset||''}`:e.zoneName?`Zone: ${e.zoneName}`:'';
  async function loadCat(){ if (!state.visionCat) state.visionCat=await api('/vision/catalog'); }

  // A camera image (snapshot or frame) with detection boxes and zones drawn over it. Media is fetched with the
  // sign-in token, so the <img> gets its src after rendering (see bind).
  const frame=({mediaId,boxes=[],zones=[],cls='',alt='Camera image'})=>`<div class="vframe ${cls}">${mediaId?`<img data-vmedia="${esc(mediaId)}" alt="${esc(alt)}">`:`<div class="vframe-empty">${machineIcon('auxiliary',40,'camera')}<span>No image yet</span></div>`}
    ${zones.length?`<svg class="vzones" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${zones.map(z=>z.kind==='tripwire'?`<line class="z-${z.kind}" x1="${z.points[0][0]*100}" y1="${z.points[0][1]*100}" x2="${z.points[1][0]*100}" y2="${z.points[1][1]*100}"/>`:`<polygon class="z-${z.kind}" points="${z.points.map(p=>`${p[0]*100},${p[1]*100}`).join(' ')}"/>`).join('')}</svg>`:''}
    ${boxes.map(b=>`<span class="bbox ${b.ok?'ok':''}" style="left:${b.x*100}%;top:${b.y*100}%;width:${b.w*100}%;height:${b.h*100}%"><em>${esc(b.label||'')}${b.confidence!=null&&!/\d/.test(b.label||'')?` ${Math.round(b.confidence*100)}%`:''}</em></span>`).join('')}</div>`;

  // ---------- Overview ----------
  async function loadOverview(){ await loadCat(); const f=state.visionFilter||(state.visionFilter={hours:'24',plantId:''});
    state.vo=await api(`/vision/overview?hours=${f.hours}${f.plantId?`&plantId=${encodeURIComponent(f.plantId)}`:''}`); }
  function overviewView(){
    if (!state.vo) { loadOverview().then(render).catch(fail); return '<div class="panel empty">Loading vision overview…</div>'; }
    const o=state.vo, duties=state.user.visionDuties||[], tab=state.visionTab||(duties.length===1?duties[0]:'all'), f=state.visionFilter;
    const filters=`<div class="table-tools">${tool('data-vfilter','hours','Period',[['1','Last hour'],['24','Last 24 hours'],['168','Last 7 days'],['720','Last 30 days']],f.hours,'')}${tool('data-vfilter','plantId','Plant',(state.data.plants||[]).map(p=>[p.id,p.name]),f.plantId,'All plants')}</div>`;
    const online=o.nodes.filter(n=>n.status==='online').length, camsOnline=o.cameras.filter(c=>c.status==='online').length;
    const kpi={
      all:[statTile('PPE compliance',pct(o.ppe.complianceRate),{status:o.ppe.complianceRate==null?'':o.ppe.complianceRate>=98?'good':o.ppe.complianceRate>=90?'warning':'critical',note:`${formatNumber(o.ppe.people)} people checked`}),
        statTile('Fire & smoke',formatNumber(o.fire.events),{status:o.fire.open?'critical':'',note:o.fire.open?`${o.fire.open} open`:`${o.fire.falseAlarms} false alarms`}),
        statTile('Intrusions',formatNumber(o.intrusion.events),{note:`${o.intrusion.people} people · ${o.intrusion.vehicles} vehicles`}),
        statTile('Defect rate',pct(o.quality.defectRate),{note:`${formatNumber(o.quality.inspected)} inspected`}),
        statTile('Cameras online',`${camsOnline} / ${o.cameras.length}`,{status:o.cameras.length&&camsOnline<o.cameras.length?'warning':'',note:`${online} of ${o.nodes.length} edge nodes online`}),
        statTile('Alarm broadcast (p95)',ms(o.latency.broadcastP95Ms),{status:o.latency.broadcastP95Ms==null?'':o.latency.broadcastP95Ms<=2000?'good':'critical',note:'target under 2,000 ms'})],
      ehs:[statTile('PPE compliance',pct(o.ppe.complianceRate),{status:o.ppe.complianceRate==null?'':o.ppe.complianceRate>=98?'good':'warning',note:`${formatNumber(o.ppe.compliant)} of ${formatNumber(o.ppe.people)} people`}),
        statTile('PPE violations',formatNumber(o.ppe.violations),{note:'with photo proof'}),statTile('Fire',formatNumber(o.fire.fire),{status:o.fire.fire?'critical':''}),statTile('Smoke',formatNumber(o.fire.smoke),{status:o.fire.smoke?'warning':''}),
        statTile('False fire alarms',formatNumber(o.fire.falseAlarms),{note:'sent for retraining'}),statTile('Alarm broadcast (p95)',ms(o.latency.broadcastP95Ms),{note:'detection to factory broadcast'})],
      security:[statTile('Intrusions',formatNumber(o.intrusion.events),{status:o.intrusion.events?'warning':''}),statTile('People',formatNumber(o.intrusion.people)),statTile('Vehicles',formatNumber(o.intrusion.vehicles)),
        statTile('Machine motion ignored',formatNumber(o.intrusion.ignoredMachineMotion),{note:'approved conveyor and robot paths'}),statTile('Alert to platform (p95)',ms(o.latency.uplinkP95Ms)),statTile('Relay / siren (p95)',ms(o.latency.actuatorP95Ms))],
      qa:[statTile('Inspected',formatNumber(o.quality.inspected)),statTile('Defect rate',pct(o.quality.defectRate),{status:o.quality.defectRate==null?'':o.quality.defectRate<=0.5?'good':o.quality.defectRate<=2?'warning':'critical',note:'failed ÷ inspected'}),
        statTile('Defects recorded',formatNumber(o.quality.defects)),statTile('Logistics damage',formatNumber(o.quality.logistics.reduce((n,r)=>n+r.n,0)),{note:'shipping containers'})]
    }[tab]||[];
    const camName=id=>o.cameras.find(c=>c.id===id)?.name||'—';
    const rows=(list,labelFn=x=>x)=>list.map(r=>({label:labelFn(r.key)||'—',value:r.n}));
    const charts={
      all:columnChart('v-hourly',{title:'Detections by hour',subtitle:'All modules',points:Object.entries(o.hourly.reduce((m,h)=>(m[h.hour]=(m[h.hour]||0)+h.n,m),{})).map(([h,v])=>({label:new Intl.DateTimeFormat(state.user.preferences.locale,{hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone}).format(new Date(`${h}:00:00Z`)),value:v})),valueLabel:'Detections'}),
      ehs:`<div class="chart-grid">${barChart('v-gear',{title:'Missing PPE',subtitle:'Violations by item',rows:rows(o.ppe.byGear,g=>vc().ppeGear?.[g]||g),valueLabel:'Violations'})}${barChart('v-ppecam',{title:'PPE violations by camera',rows:rows(o.ppe.byCamera,camName),valueLabel:'Violations'})}</div>`,
      security:barChart('v-zones',{title:'Intrusions by zone',rows:rows(o.intrusion.byZone),valueLabel:'Intrusions'}),
      qa:`<div class="chart-grid">${barChart('v-defects',{title:'Defects by type',subtitle:'All presets',rows:rows(o.quality.byDefect,humanise),valueLabel:'Defects'})}${barChart('v-presets',{title:'Defects by inspection preset',rows:rows(o.quality.byPreset,p=>vc().qualityPresets?.[p]?.label||p),valueLabel:'Defects'})}${barChart('v-logistics',{title:'Logistics damage profile',subtitle:'Shipping container inspection',rows:rows(o.quality.logistics,humanise),valueLabel:'Damage findings'})}${barChart('v-qcam',{title:'Defects by camera',rows:rows(o.quality.byCamera,camName),valueLabel:'Defects'})}</div>`
    }[tab]||'';
    const want={ehs:['ppe','fire_smoke'],security:['intrusion','fire_smoke'],qa:['quality']}[tab];
    const cams=o.cameras.filter(c=>!want||c.modules.some(m=>want.includes(m.module)));
    const tiles=cams.length?`<div class="vtiles">${cams.map(c=>`<article class="vtile ${c.latest?.status==='open'&&c.latest.severity==='critical'?'alarm':''}">${frame({mediaId:c.latest?.snapshot_media_id||c.snapshotMediaId,boxes:c.latest?.snapshot_media_id?c.latest.boxes:[],alt:c.name})}
      <div class="vtile-body"><div class="spread"><b>${esc(c.name)}</b>${camStatus(c.status)}</div><div class="muted mini">${esc(c.location||plantName(c.plantId))}${c.metrics?.fps?` · ${formatNumber(c.metrics.fps,0)} fps`:''}${c.metrics?.inferenceMs?` · ${formatNumber(c.metrics.inferenceMs,0)} ms`:''}</div>
      <div class="chips">${c.modules.filter(m=>m.enabled).map(m=>`<span class="chip mod-${m.module}">${esc(mod(m.module))}</span>`).join('')||'<span class="muted mini">No modules assigned</span>'}</div>
      <div class="mini">${c.today.people?`PPE ${pct(Math.round(1000*c.today.compliant/c.today.people)/10)} · `:''}${c.today.inspected?`Pass ${formatNumber(c.today.passed)} / Fail ${formatNumber(c.today.inspected-c.today.passed)} · `:''}${c.today.events} detections</div>
      ${c.latest?`<div class="mini"><a data-action="vEvent" data-id="${esc(c.latest.id)}">${esc(typeLabel(c.latest.type))}</a> · ${when(c.latest.occurred_at)}</div>`:''}</div></article>`).join('')}</div>`
      :`<div class="panel empty">No cameras ${want?'with these modules ':''}yet. ${anyManage()?'Add cameras and assign modules under <b>Cameras & AI modules</b>.':''}</div>`;
    const open=o.open.filter(e=>!want||want.includes(e.module));
    const openPanel=`<div class="panel"><div class="spread"><h2>Open alarms</h2><span class="row">${btn('All incidents','vGoIncidents','secondary small')}${tab==='ehs'?`<a class="btn-link" data-vcsv="ppe">⬇ PPE proof log (CSV)</a>`:''}</span></div>${open.length?simpleTable(['When','Camera','Incident','Severity',''],open.map(e=>`<tr><td>${when(e.occurredAt)}</td><td>${esc(e.cameraName)}</td><td><a data-action="vEvent" data-id="${esc(e.id)}">${esc(typeLabel(e.type))}</a><div class="muted mini">${esc(eventDetail(e))}</div></td><td>${sevPill(e.severity)}</td><td class="row">${e.status==='open'?btn('Acknowledge','vAck','secondary small',e.id):statusPill(e.status)}</td></tr>`)):'<p class="muted">No open alarms. ✓</p>'}</div>`;
    const tabList=[['all','All modules'],['ehs','EHS – PPE & fire'],['security','Security – restricted areas'],['qa','Quality inspection']];
    return header('Vision overview','Live PPE compliance, fire and smoke, restricted-area intrusions and quality inspection from your camera network',anyManage()?btn('Cameras & AI modules','vGoCameras','secondary'):'')
      +filters+tabs('vision',tabList,tab)+`<section class="kpis small" aria-label="Vision figures">${kpi.join('')}</section>`+openPanel+`<h2 class="section-title">Cameras</h2>`+tiles+(charts?`<div class="panel">${charts}</div>`:'');
  }

  // ---------- Cameras and module routing ----------
  async function loadCameras(){ await loadCat(); const [cams,nodes,lic]=await Promise.all([api('/vision/cameras'),api('/vision/nodes'),api('/vision/licences')]); state.vcams=cams; state.vnodes=nodes; state.vlic=lic; }
  const licFor=(companyId,m)=>(state.vlic||[]).find(l=>l.companyId===companyId)?.modules.find(x=>x.module===m);
  function camerasView(){
    if (!state.vcams) { loadCameras().then(render).catch(fail); return '<div class="panel empty">Loading cameras…</div>'; }
    const companies=(state.vlic||[]).filter(l=>canManage(l.companyId));
    const palette=companies.length?`<div class="panel"><h2>AI modules</h2><p class="muted">Drag a module onto a camera to run it there, or use <b>Add module</b> on the camera. Each camera running a module uses one licence.</p>${companies.map(l=>`${companies.length>1?`<h3>${esc(l.companyName)}</h3>`:''}<div class="module-palette">${l.modules.map(x=>`<div class="module-card mod-${x.module} ${x.valid?'':'off'}" ${x.valid&&x.available?`draggable="true"`:''} data-module="${x.module}" data-company="${esc(l.companyId)}" title="${x.valid?`${x.used} of ${x.cameras} licences in use`:'No valid licence'}">
      <b>${esc(mod(x.module))}</b><span>${x.valid?`${x.used} / ${x.cameras} cameras${x.validUntil?` · until ${esc(x.validUntil)}`:''}`:'Not licensed'}</span></div>`).join('')}</div>`).join('')}</div>`:'';
    const nodeName=id=>(state.vnodes||[]).find(n=>n.id===id)?.name||'— no edge node —';
    const table=dataTable('vcams',{rows:state.vcams,search:c=>`${c.name} ${c.location} ${c.sourceType} ${nodeName(c.nodeId)} ${c.modules.map(m=>mod(m.module)).join(' ')}`,
      filters:[{key:'status',label:'Status',options:['online','offline','tampered','unknown'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:'No cameras yet.',
      columns:[{title:'Camera',cell:c=>`<b>${esc(c.name)}</b> ${c.active?'':'<span class="pill inactive">Inactive</span>'}<div class="muted">${esc(c.location||'')}${c.location?' · ':''}${esc(plantName(c.plantId))}</div>`},
        {title:'Source',cell:c=>`${esc(humanise(c.sourceType))}<div class="muted mini code">${esc(c.sourceUrl||'—')}</div>`},{title:'Edge node',cell:c=>esc(nodeName(c.nodeId))},{title:'Status',cell:c=>camStatus(c.status)},
        {title:'AI modules',cell:c=>`<div class="drop-zone" data-drop-camera="${esc(c.id)}"><div class="chips">${c.modules.map(m=>`<button type="button" class="chip mod-${m.module} ${m.enabled?'':'off'}" data-action="vModule" data-id="${esc(c.id)}|${m.module}" title="Settings">${esc(mod(m.module))}${m.enabled?'':' (off)'}</button>`).join('')}${canManage(c.companyId)?btn('+ Add module','vAddModule','chip chip-add',c.id):''}</div></div>`},
        {title:'',cls:'row',cell:c=>canManage(c.companyId)?`${btn('Draw zones','vZones','secondary small',c.id)}${btn('Edit','vEditCamera','secondary small',c.id)}`:btn(`Zones (${c.zones})`,'vZones','secondary small',c.id)}]});
    return header('Cameras & AI modules','Every IP or CSI camera, the edge node that processes it, and the AI modules it runs',anyManage()?btn('Add camera','vNewCamera','primary'):'')+palette+`<div class="panel">${table}</div>`;
  }
  function cameraForm(c){
    const plants=(state.data.plants||[]).filter(p=>canManage(p.company_id)), nodes=state.vnodes||[];
    const body=section('Camera',`${select('plantId','Plant',plants.map(p=>[p.id,p.name]),{value:c?.plantId||plants[0]?.id,required:true})}${field('name','Name',{value:c?.name,required:true,maxlength:80,help:'e.g. Gate 1 – press hall entrance'})}${field('location','Location',{value:c?.location,maxlength:120,help:'Door, line or area the camera watches'})}
      ${select('nodeId','Edge node',nodes.map(n=>[n.id,`${n.name} (${n.cameras}/${n.maxStreams} streams)`]),{value:c?.nodeId||'',placeholder:'— not yet —',help:'The GPU PC that analyses this camera (up to 16 streams each)'})}
      ${select('equipmentId','Machine watched',(state.data.equipment||[]).map(e=>[e.id,`${e.asset_tag||''} ${e.make} ${e.model}`]),{value:c?.equipmentId||'',placeholder:'— none —',help:'Links alerts and quality results to the machine'})}`)
      +section('Video source',`${select('vendor','Camera make',(vc().cameraVendors||[]).map(v=>[v,v]),{value:c?.vendor||'',placeholder:'— choose —',help:'Picks the right connection on the edge node'})}${select('sourceType','Connection',(vc().sourceTypes||[]).map(s=>[s,({rtsp:'RTSP video stream (Hikvision, Axis…)','http-snapshot':'HTTP snapshot (Hikvision ISAPI, Axis, Dahua)','cognex-native':'Cognex In-Sight Native Mode (trigger + image)',folder:'FTP / folder image output (Keyence CV-X, Hikrobot, Cognex FTP)',csi:'CSI camera on the edge node',visionforge:'VisionForge inspection station'})[s]]),{value:c?.sourceType||'rtsp',required:true})}<p class="muted wide mini" id="src-help"></p>
      ${field('sourceUrl','Address',{value:c?.sourceUrl,wide:true,maxlength:500,help:'e.g. rtsp://user:password@192.168.0.64:554/Streaming/Channels/101. Passwords are stored for the edge node only and shown masked.'})}${field('fps','Frame rate',{type:'number',value:c?.fps||25,min:1,max:120,unit:'fps',help:'Quality inspection on fast lines: 60'})}`);
    const HELP={rtsp:'Hikvision: rtsp://user:password@192.168.0.64:554/Streaming/Channels/101 (main stream) or …/102 (sub stream).','http-snapshot':'Hikvision: http://192.168.0.64/ISAPI/Streaming/channels/101/picture (digest login: put user:password@ in the address).',
      'cognex-native':'Cognex In-Sight: camera IP and port, e.g. admin:password@192.168.0.50:23. The job must accept software triggers and the camera be Online.',folder:'Keyence CV-X/XG or Hikrobot: the folder their FTP image output writes to on the edge PC, e.g. /data/ftp/keyence-line3. Results can also come over EtherNet/IP.',
      csi:'No address needed.',visionforge:'No address needed: the station reports its results to the platform.'};
    openDialog(c?`Edit ${c.name}`:'Add camera',body,{onOpen:d=>{ const t=d.querySelector('[name=sourceType]'), h=d.querySelector('#src-help'), v=d.querySelector('[name=vendor]'); const sync=()=>{ h.textContent=HELP[t.value]||''; }; t.onchange=sync; sync();
      v.onchange=()=>{ const pick={Cognex:'cognex-native',Keyence:'folder',Hikrobot:'folder',Hikvision:'rtsp'}[v.value]; if (pick&&!c) { t.value=pick; sync(); } }; },onSubmit:async fd=>{ const v=Object.fromEntries(fd); v.fps=Number(v.fps);
      if (c) await api(`/vision/cameras/${c.id}`,'PATCH',v); else await api('/vision/cameras','POST',v); toast(c?'Camera saved':'Camera added'); state.vcams=undefined; render(); }});
  }
  // Settings of one module on one camera; also how a module is first added (from the drag-and-drop or the button).
  function outputFields(prefix,label,o){
    const p=o?.protocol||''; const f=(k,t,opts={})=>field(`${prefix}.${k}`,t,{value:o?.[k]??'',...opts});
    return `<fieldset class="fld wide output-set" data-output="${prefix}"><legend>${esc(label)}</legend><div class="form-grid">${select(`${prefix}.protocol`,'Interface',[['modbus_tcp','Modbus TCP coil'],['ethernet_ip','EtherNet/IP tag'],['gpio','Edge GPIO / relay pin'],['http','HTTP relay']],{value:p,placeholder:'— none —'})}
      ${f('host','PLC / relay IP',{help:'Modbus TCP and EtherNet/IP'})}${f('port','Port',{type:'number',help:'Modbus 502'})}${f('unitId','Unit ID',{type:'number'})}${f('coil','Coil',{type:'number'})}${f('tag','Tag',{help:'EtherNet/IP tag, e.g. Reject_Cmd'})}${f('value','Value',{type:'number'})}${f('pin','GPIO pin',{type:'number'})}${f('url','Relay URL',{wide:true})}${f('pulseMs','Pulse',{type:'number',unit:'ms'})}</div></fieldset>`;
  }
  function inputFields(prefix,label,i){
    const f=(k,t,opts={})=>field(`${prefix}.${k}`,t,{value:i?.[k]??'',...opts});
    return `<fieldset class="fld wide output-set"><legend>${esc(label)}</legend><div class="form-grid">${select(`${prefix}.protocol`,'Interface',[['ethernet_ip','EtherNet/IP tag'],['modbus_tcp','Modbus TCP input']],{value:i?.protocol||'',placeholder:'— none —'})}
      ${f('host','PLC IP')}${f('tag','Tag',{help:'EtherNet/IP, e.g. Cell3_PartPresent'})}${select(`${prefix}.kind`,'Modbus type',[['discrete_input','Discrete input'],['coil','Coil']],{value:i?.kind||'discrete_input'})}${f('address','Modbus address',{type:'number'})}${f('port','Port',{type:'number',help:'Modbus 502'})}${f('unitId','Unit ID',{type:'number'})}</div></fieldset>`;
  }
  const readInput=(fd,prefix)=>{ const p=fd.get(`${prefix}.protocol`); if (!p) return null; const o={protocol:p}; for (const k of ['host','tag','kind','address','port','unitId']) { const v=fd.get(`${prefix}.${k}`); if (v!==null&&v!=='') o[k]=['host','tag','kind'].includes(k)?v:Number(v); } return o; };
  const readOutput=(fd,prefix)=>{ const p=fd.get(`${prefix}.protocol`); if (!p) return null; const o={protocol:p}; for (const k of ['host','port','unitId','coil','tag','value','pin','url','pulseMs']) { const v=fd.get(`${prefix}.${k}`); if (v!==null&&v!=='') o[k]=['host','tag','url'].includes(k)?v:Number(v); } return o; };
  function moduleForm(cam,module){
    const a=cam.modules.find(m=>m.module===module), c=a?.config||vc().modules[module].defaults, manageable=canManage(cam.companyId);
    let body='';
    if (module==='ppe') body=section('Required protective equipment',`${checkboxes('requiredGear','Required in this zone',Object.entries(vc().ppeGear).map(([k,v])=>[k,v]),{values:c.requiredGear,required:true})}${field('minConfidence','Minimum confidence',{type:'number',value:c.minConfidence,min:0.3,max:0.99,step:0.01,help:'Below this, the person is checked again rather than flagged'})}${field('cooldownSeconds','Repeat alarm after',{type:'number',value:c.cooldownSeconds,min:0,max:3600,unit:'s',help:'Same person, same violation'})}${outputFields('beaconOutput','Entrance beacon (blinks at this doorway)',c.beaconOutput)}`);
    if (module==='fire_smoke') body=section('Fire and smoke',`${select('sensitivity','Sensitivity',(vc().sensitivity||[]).map(s=>[s,humanise(s)]),{value:c.sensitivity,required:true,help:'Conservative suits areas with steam, dust or welding'})}${field('confirmSeconds','Confirm over',{type:'number',value:c.confirmSeconds,min:0.2,max:1.8,step:0.1,unit:'s',help:'Temporal check that separates flames and smoke plumes from steam, dust and welding arcs; keeps the broadcast under 2 s'})}
      ${checkboxes('broadcast','Factory network',[['yes','Broadcast the alarm on the factory subnet (all screens, PA and fire panels listening)']],{values:c.broadcast?['yes']:[]})}${outputFields('sirenOutput','Siren / strobe',c.sirenOutput)}`);
    if (module==='intrusion') body=section('Restricted area',`${checkboxes('classes','Raise an intrusion for',[['person','People'],['vehicle','Vehicles (forklifts, trucks)']],{values:c.classes,required:true})}${field('dwellSeconds','Inside the zone for at least',{type:'number',value:c.dwellSeconds,min:0,max:30,step:0.1,unit:'s'})}${outputFields('sirenOutput','Siren / security light',c.sirenOutput)}<p class="muted wide">Draw the exclusion zones, tripwires and approved machine-motion areas with <b>Draw zones</b>. Movement inside approved machine-motion areas (conveyors, robot arms) is ignored.</p>`);
    if (module==='quality') { const acc=c.acceptance||{A:0.5,B:1,C:2};
      body=section('Product',`${select('preset','Inspection preset',Object.entries(vc().qualityPresets).map(([k,p])=>[k,p.label]),{value:c.preset,required:true,wide:true,help:'Model and defect classes for the product'})}<p class="muted wide mini" id="preset-defects"></p>${field('minDefectMm','Smallest defect to find',{type:'number',value:c.minDefectMm,min:0.05,max:50,step:0.05,unit:'mm'})}${field('mmPerPixel','Calibration',{type:'number',value:c.mmPerPixel??'',min:0.001,max:10,step:0.001,unit:'mm/pixel',help:'From the calibration target; needed for defect sizes'})}`)
        +section('Acceptance by surface class (VDA 16)',`${field('acceptance.A','Class A – visible surfaces',{type:'number',value:acc.A,min:0.05,max:100,step:0.05,unit:'mm',help:'Reject defects at or above this size'})}${field('acceptance.B','Class B – partly visible',{type:'number',value:acc.B,min:0.05,max:100,step:0.05,unit:'mm'})}${field('acceptance.C','Class C – hidden surfaces',{type:'number',value:acc.C,min:0.05,max:100,step:0.05,unit:'mm'})}<p class="muted wide mini">Draw the class A/B/C areas as inspection areas with <b>Draw zones</b>. Defaults are a starting point: use the limits agreed with your customer (drawing or VDA 16 agreement).</p>`)
        +section('Line timing and PLC',`${select('triggerMode','Trigger',[['plc','PLC part-present signal (one inspection per part)'],['camera','Camera hardware trigger'],['continuous','Continuous video']],{value:c.triggerMode,required:true})}${field('cycleTimeS','Machine cycle time',{type:'number',value:c.cycleTimeS,min:0.2,max:600,step:0.1,unit:'s',help:'Shortest cycle on this line'})}${field('resultBudgetMs','OK/NG result within',{type:'number',value:c.resultBudgetMs,min:20,max:10000,unit:'ms',help:'At most half the cycle time'})}${field('targetFps','Frame rate (continuous)',{type:'number',value:c.targetFps,min:1,max:120,unit:'fps'})}
          ${inputFields('triggerInput','Part-present trigger (PLC → edge)',c.triggerInput)}${outputFields('okOutput','OK result (edge → PLC)',c.okOutput)}${outputFields('rejectOutput','NG / reject result (edge → PLC, fired first)',c.rejectOutput)}`); }
    const enabled=checkboxes('enabled','Status',[['yes','Running on this camera']],{values:a?.enabled===false?[]:['yes']});
    const d=openDialog(`${mod(module)} – ${cam.name}`,`${body}<div class="form-grid">${enabled}</div>${a&&manageable?`<p>${btn('Remove module from this camera','vRemoveModule','danger small',`${cam.id}|${module}`)}</p>`:''}`,{submitLabel:a?'Save':'Add module',onSubmit:manageable?async fd=>{
      const v=Object.fromEntries([...fd.entries()].filter(([k])=>!k.includes('.')&&!['requiredGear','classes','broadcast','enabled'].includes(k)));
      const config={...v};
      for (const k of ['minConfidence','cooldownSeconds','confirmSeconds','dwellSeconds','minDefectMm','mmPerPixel','targetFps','cycleTimeS','resultBudgetMs']) if (k in config) config[k]=config[k]===''?null:Number(config[k]);
      if (module==='ppe') { config.requiredGear=fd.getAll('requiredGear'); config.beaconOutput=readOutput(fd,'beaconOutput'); }
      if (module==='fire_smoke') { config.broadcast=fd.getAll('broadcast').includes('yes'); config.sirenOutput=readOutput(fd,'sirenOutput'); }
      if (module==='intrusion') { config.classes=fd.getAll('classes'); config.sirenOutput=readOutput(fd,'sirenOutput'); }
      if (module==='quality') { config.rejectOutput=readOutput(fd,'rejectOutput'); config.okOutput=readOutput(fd,'okOutput'); config.triggerInput=readInput(fd,'triggerInput'); config.acceptance={A:Number(fd.get('acceptance.A')),B:Number(fd.get('acceptance.B')),C:Number(fd.get('acceptance.C'))}; }
      await api(`/vision/cameras/${cam.id}/modules/${module}`,'PUT',{enabled:fd.getAll('enabled').includes('yes'),config}); toast(`${mod(module)} saved`); state.vcams=undefined; render(); }:undefined});
    d.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>vAction(b.dataset.action,b.dataset.id));
    const presetSel=d.querySelector('[name=preset]'), list=d.querySelector('#preset-defects');
    if (presetSel&&list) { const show=()=>{ list.textContent=`Defects found: ${(vc().qualityPresets[presetSel.value]?.defects||[]).map(x=>vc().defectInfo?.[x]?.[0]||humanise(x)).join(', ')}`; }; presetSel.onchange=show; show(); }
  }

  // ---------- Geofence editor ----------
  async function zonesDialog(camId){
    const cam=camById(camId)||(await api('/vision/cameras')).find(c=>c.id===camId), manageable=canManage(cam.companyId);
    let zones=await api(`/vision/cameras/${camId}/zones`), draft=null;
    const KIND=vc().zoneKinds, onlyQuality=cam.modules.length&&cam.modules.every(m=>m.module==='quality'), defKind=onlyQuality?'inspection_roi':'exclusion';
    const d=openDialog(`Zones – ${cam.name}`,`<div class="geo">
      <div class="geo-stage" id="geo-stage">${frame({mediaId:cam.snapshotMediaId,cls:'geo-frame',alt:`${cam.name} view`})}<svg id="geo-svg" viewBox="0 0 1000 562" preserveAspectRatio="none" role="application" aria-label="Zone drawing area"></svg></div>
      <div class="geo-side">${manageable?`<div class="form-grid">${field('gname','Zone name',{wide:true,maxlength:80,placeholder:'e.g. Press 3 safety cell'})}${select('gkind','Kind',Object.entries(KIND),{value:defKind,required:true,wide:true})}${select('gsev','Severity',[['critical','Critical – security / life safety'],['warning','Warning']],{value:'critical',wide:true})}${select('gclassAB','Surface class (inspection areas)',[['A','A – visible surface'],['B','B – partly visible'],['C','C – hidden surface']],{value:'A',wide:true})}${checkboxes('gclass','Detect',[['person','People'],['vehicle','Vehicles']],{values:['person','vehicle']})}</div>
        <p class="muted mini" id="geo-help">Click on the image to place points; drag a point to move it. A tripwire takes two points.</p>
        <div class="row">${btn('Save zone','gSave','primary small')}${btn('Undo point','gUndo','secondary small')}${btn('Cancel','gCancel','secondary small')}</div>`:'<p class="muted">View only. A company administrator draws zones.</p>'}
        <h3>Zones</h3><div id="geo-list"></div>${cam.snapshotMediaId?'':'<p class="muted mini">No camera image yet: the edge node uploads one when it connects. You can still draw on the blank frame.</p>'}</div></div>`,{wide:true});
    d.classList.add('xwide');
    const svg=d.querySelector('#geo-svg'), W=1000, H=562;
    const pt=e=>{ const r=svg.getBoundingClientRect(); return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))].map(x=>Math.round(x*10000)/10000); };
    const shape=(z,cls)=>z.kind==='tripwire'&&z.points.length>=2?`<line class="${cls} z-${z.kind}" x1="${z.points[0][0]*W}" y1="${z.points[0][1]*H}" x2="${z.points[1][0]*W}" y2="${z.points[1][1]*H}"/>`
      :z.points.length>=3?`<polygon class="${cls} z-${z.kind}" points="${z.points.map(p=>`${p[0]*W},${p[1]*H}`).join(' ')}"/>`:z.points.length===2?`<polyline class="${cls} z-${z.kind}" points="${z.points.map(p=>`${p[0]*W},${p[1]*H}`).join(' ')}"/>`:'';
    const draw=()=>{
      svg.innerHTML=zones.filter(z=>z.active&&(!draft||z.id!==draft.id)).map(z=>`${shape(z,'saved')}<text x="${z.points[0][0]*W+6}" y="${z.points[0][1]*H-6}" class="geo-label">${esc(z.name)}</text>`).join('')
        +(draft?`${shape(draft,'draft')}${draft.points.map((p,i)=>`<circle class="handle" data-i="${i}" cx="${p[0]*W}" cy="${p[1]*H}" r="9"/>`).join('')}`:'');
      d.querySelector('#geo-list').innerHTML=zones.length?zones.map(z=>`<div class="geo-item ${z.active?'':'off'}"><span class="swatch z-${z.kind}"></span><div><b>${esc(z.name)}</b><div class="muted mini">${esc(KIND[z.kind])}${z.surfaceClass?` · class ${esc(z.surfaceClass)}`:''}${z.kind==='exclusion'||z.kind==='tripwire'?` · ${esc(z.severity)} · ${z.classes.join(', ')}`:''}${z.active?'':' · inactive'}</div></div>${manageable&&z.active?`<span class="row">${btn('Edit','gEdit','secondary small',z.id)}${btn('Delete','gDelete','danger small',z.id)}</span>`:''}</div>`).join(''):'<p class="muted">No zones yet.</p>';
      d.querySelectorAll('#geo-list [data-action]').forEach(b=>b.onclick=()=>geoAction(b.dataset.action,b.dataset.id));
    };
    const form=()=>{ const kind=d.querySelector('[name=gkind]').value; return {name:d.querySelector('[name=gname]').value.trim(),kind,severity:d.querySelector('[name=gsev]').value,classes:[...d.querySelectorAll('[name=gclass]:checked')].map(x=>x.value),...(kind==='inspection_roi'?{surfaceClass:d.querySelector('[name=gclassAB]').value}:{})}; };
    let dragging=null;
    // Severity and people/vehicle classes apply to safety zones; the surface class only to inspection areas.
    function fit(){ const k=d.querySelector('[name=gkind]')?.value, roi=k==='inspection_roi';
      const show=(n,on)=>{ const el=d.querySelector(`[name=${n}]`)?.closest('.fld'); if (el) el.hidden=!on; };
      show('gsev',!roi&&k!=='allowed_motion'); show('gclass',!roi&&k!=='ppe_zone'); show('gclassAB',roi); }
    if (manageable) {
      fit();
      svg.addEventListener('pointerdown',e=>{ const h=e.target.closest('.handle'); if (h) { dragging=Number(h.dataset.i); svg.setPointerCapture(e.pointerId); e.preventDefault(); return; }
        const f=form(); draft??={kind:f.kind,points:[]}; draft.kind=f.kind;
        if (draft.kind==='tripwire'&&draft.points.length>=2) return toast('A tripwire has two points. Drag them, or Undo.','error');
        draft.points.push(pt(e)); draw(); });
      svg.addEventListener('pointermove',e=>{ if (dragging==null||!draft) return; draft.points[dragging]=pt(e); draw(); });
      svg.addEventListener('pointerup',()=>{ dragging=null; });
      d.querySelector('[name=gkind]').addEventListener('change',fit);
      d.querySelector('[name=gkind]').onchange=e=>{ if (draft) { draft.kind=e.target.value; if (draft.kind==='tripwire') draft.points=draft.points.slice(0,2); draw(); } };
    }
    async function geoAction(name,id){
      try {
        if (name==='gUndo') { draft?.points.pop(); draw(); }
        if (name==='gCancel') { draft=null; draw(); }
        if (name==='gEdit') { const z=zones.find(x=>x.id===id); draft={id:z.id,kind:z.kind,points:z.points.map(p=>[...p])}; d.querySelector('[name=gname]').value=z.name; d.querySelector('[name=gkind]').value=z.kind; d.querySelector('[name=gsev]').value=z.severity; if (z.surfaceClass) d.querySelector('[name=gclassAB]').value=z.surfaceClass; d.querySelectorAll('[name=gclass]').forEach(x=>x.checked=z.classes.includes(x.value)); fit(); draw(); }
        if (name==='gDelete') { if (!await confirmAction('Delete this zone?','The edge node stops using it within a minute. Zones that recorded incidents are kept as inactive.',{confirmLabel:'Delete'})) return; await api(`/vision/zones/${id}`,'DELETE'); zones=await api(`/vision/cameras/${camId}/zones`); toast('Zone deleted'); draw(); }
        if (name==='gSave') { const f=form(); if (!draft?.points.length) return toast('Click on the image to place the zone’s points first','error'); if (!f.name) return toast('Give the zone a name','error');
          const body={...f,points:draft.points}; if (draft.id) await api(`/vision/zones/${draft.id}`,'PATCH',body); else await api(`/vision/cameras/${camId}/zones`,'POST',body);
          zones=await api(`/vision/cameras/${camId}/zones`); draft=null; d.querySelector('[name=gname]').value=''; toast('Zone saved – the edge node picks it up within a minute'); draw(); }
      } catch (e) { toast(e.message,'error'); }
    }
    d.querySelectorAll('.geo-side > .row [data-action]').forEach(b=>b.onclick=()=>geoAction(b.dataset.action));
    loadMedia(d); draw();
  }

  // ---------- Incidents ----------
  async function loadEvents(){ await loadCat(); const f=state.vEventFilter||(state.vEventFilter={module:'',severity:'',status:'',hours:'168'});
    const q=new URLSearchParams(Object.entries(f).filter(([,v])=>v)); state.vevents=await api(`/vision/events?${q}`); }
  function incidentsView(){
    if (!state.vevents) { loadEvents().then(render).catch(fail); return '<div class="panel empty">Loading incidents…</div>'; }
    const f=state.vEventFilter, sel=(key,label,opts,all=`All ${label.toLowerCase()}s`)=>tool('data-vevent',key,label,opts,f[key],all);
    const filters=`<div class="table-tools">${sel('hours','Period',[['24','Last 24 hours'],['168','Last 7 days'],['720','Last 30 days'],['8760','Last year']],'')}${sel('module','Module',[...Object.keys(vc().modules||{}).map(m=>[m,mod(m)]),['system','System']])}${sel('severity','Severity',[['critical','Critical'],['warning','Warning'],['info','Info']],'All severities')}${sel('status','Status',[['open','Open'],['acknowledged','Acknowledged'],['resolved','Resolved'],['false_alarm','False alarm']],'All statuses')}</div>`;
    const table=dataTable('vevents',{rows:state.vevents,search:e=>`${e.cameraName} ${e.type} ${e.zoneName||''} ${eventDetail(e)} ${e.resolutionNote}`,empty:'No incidents in this period.',
      columns:[{title:'When',cell:e=>when(e.occurredAt)},{title:'Incident',cell:e=>`<a data-action="vEvent" data-id="${esc(e.id)}"><b>${esc(typeLabel(e.type))}</b></a><div class="muted mini">${esc(mod(e.module))} · ${esc(eventDetail(e))}</div>`},
        {title:'Camera',cell:e=>`${esc(e.cameraName)}<div class="muted mini">${esc(e.location||'')}</div>`},{title:'Severity',cell:e=>sevPill(e.severity)},{title:'Evidence',cell:e=>`${e.snapshotMediaId?'📷':''}${e.clipMediaId?' 🎞':''}${e.locked?' 🔒':''}`},
        {title:'Status',cell:e=>`${statusPill(e.status)}${e.retrain?' <span class="pill pending">Retraining</span>':''}`},{title:'',cls:'row',cell:e=>e.status==='open'?btn('Acknowledge','vAck','secondary small',e.id):''}]});
    const q=new URLSearchParams(Object.entries(f).filter(([,v])=>v));
    return header('Vision incidents','Every detection with its photo and 10-second clip: proof-of-violation and audit log',`<a class="btn-link" data-vcsv="${esc(q.toString())}">⬇ Export CSV</a>`)+filters+`<div class="panel">${table}</div>`;
  }
  async function eventDialog(eventId){
    const e=await api(`/vision/events/${eventId}`), cam=camById(e.cameraId), zones=cam?await api(`/vision/cameras/${e.cameraId}/zones`).catch(()=>[]):[];
    const actions=e.edgeActions||{}, rows=[['Camera',`${esc(e.cameraName)} <span class="muted">${esc(e.location||'')}</span>`],['Occurred',`${when(e.occurredAt)} <span class="muted">received after ${ms(e.latencyMs)}</span>`],['Module',esc(mod(e.module))],['Severity',sevPill(e.severity)],['Confidence',e.confidence==null?'—':`${Math.round(e.confidence*100)} %`],
      ...(eventDetail(e)?[['Detail',esc(eventDetail(e))+(e.detail?.surfaceClass?` · surface class ${esc(e.detail.surfaceClass)}`:'')]]:[]),
      ...(e.module==='quality'&&vc().defectInfo?.[e.detail?.defect]?[['What it is',esc(vc().defectInfo[e.detail.defect][1])],['Typical causes',esc(vc().defectInfo[e.detail.defect][2])]]:[]),...(Object.keys(actions).length?[['At the edge',esc(Object.entries(actions).map(([k,v])=>`${humanise(k.replace(/Ms$/,''))}: ${typeof v==='number'?`${v} ms`:v}`).join(' · '))]]:[]),
      ['Status',`${statusPill(e.status)}${e.acknowledgedBy?` <span class="muted">acknowledged by ${esc(e.acknowledgedBy)}</span>`:''}${e.resolvedBy?` <span class="muted">· closed by ${esc(e.resolvedBy)}: ${esc(e.resolutionNote)}</span>`:''}`],['Evidence',e.locked?'🔒 Locked – kept permanently':'Deleted automatically after the retention period once closed']];
    const open=!['resolved','false_alarm'].includes(e.status);
    const d=openDialog(`${typeLabel(e.type)} – ${e.cameraName}`,`<div class="vevent">${frame({mediaId:e.snapshotMediaId,boxes:e.boxes,zones:zones.filter(z=>z.id===e.zoneId),cls:'large',alt:'Snapshot at detection'})}
      ${e.clipMediaId?`<video controls playsinline preload="metadata" data-vclip="${esc(e.clipMediaId)}" aria-label="10-second clip around the detection"></video>`:''}
      <table class="kv">${rows.map(([k,v])=>`<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>
      <div class="row">${e.status==='open'?btn('Acknowledge','vAck','secondary',e.id):''}${open?btn('Resolve','vResolve','primary',e.id)+btn('False alarm','vFalse','secondary',e.id):''}${e.locked?(canManage(e.companyId)?btn('Unlock evidence','vUnlock','secondary small',e.id):''):btn('Lock evidence','vLock','secondary small',e.id)}${e.module==='quality'&&cam?.equipmentId&&raiseTicket?btn('Report breakdown on this machine','vTicket','secondary small',e.id):''}</div></div>`,{wide:true});
    d.querySelectorAll('.vevent [data-action]').forEach(b=>b.onclick=()=>vAction(b.dataset.action,b.dataset.id));
    loadMedia(d);
  }
  const refreshAll=()=>{ state.vo=undefined; state.vevents=undefined; };
  async function closeForm(id,kind){
    openDialog(kind==='resolve'?'Resolve incident':'Mark as false alarm',`<div class="form-grid">${field('note',kind==='resolve'?'What was done':'Why it is a false alarm',{type:'textarea',required:true,wide:true,maxlength:1000,help:kind==='resolve'?'e.g. Worker given a helmet and reminded at the toolbox talk':'e.g. Steam from the cooling tower'})}${kind==='false'?checkboxes('retrain','Model improvement',[['yes','Send this clip for retraining (it is kept until the model is updated)']],{values:['yes']}):''}</div>`,
      {submitLabel:kind==='resolve'?'Resolve':'Mark false alarm',onSubmit:async fd=>{ await api(`/vision/events/${id}/${kind==='resolve'?'resolve':'false-alarm'}`,'POST',{note:fd.get('note'),...(kind==='false'?{retrain:fd.getAll('retrain').includes('yes')}:{})}); toast(kind==='resolve'?'Incident resolved':'Marked as false alarm'); refreshAll(); render(); }});
  }

  // ---------- Edge nodes and licences ----------
  async function loadNodes(){ await loadCat(); const [nodes,lic]=await Promise.all([api('/vision/nodes'),api('/vision/licences')]); state.vnodes=nodes; state.vlic=lic; state.vnodesLoaded=true; }
  function nodesView(){
    if (!state.vnodesLoaded) { loadNodes().then(render).catch(fail); return '<div class="panel empty">Loading edge nodes…</div>'; }
    const m=n=>n.metrics||{};
    const nodes=dataTable('vnodes',{rows:state.vnodes,search:n=>`${n.name} ${n.hardware} ${plantName(n.plantId)}`,empty:'No edge nodes yet. Add one for each GPU PC that analyses cameras.',
      columns:[{title:'Edge node',cell:n=>`<b>${esc(n.name)}</b><div class="muted">${esc(plantName(n.plantId))}${n.hardware?` · ${esc(n.hardware)}`:''}</div>`},{title:'Status',cell:n=>`${camStatus(n.status)}${n.lastSeenAt?`<div class="muted mini">${when(n.lastSeenAt)}</div>`:''}`},
        {title:'Streams',cell:n=>`${n.cameras} / ${n.maxStreams}`},{title:'GPU',cell:n=>m(n).gpuUtil!=null||m(n).gpuTempC!=null?`${m(n).gpuUtil!=null?`${formatNumber(m(n).gpuUtil,0)} %`:''}${m(n).gpuTempC!=null?` · ${formatNumber(m(n).gpuTempC,0)} °C`:''}`:'—'},
        {title:'Inference (p95)',cell:n=>m(n).inferenceMsP95!=null?`<span class="${m(n).inferenceMsP95>25?'pill warning':''}">${formatNumber(m(n).inferenceMsP95,1)} ms</span>`:'—'},{title:'Disk',cell:n=>m(n).diskPct!=null?`<span class="${m(n).diskPct>=90?'pill critical':''}">${formatNumber(m(n).diskPct,0)} %</span>`:'—'},
        {title:'Agent',cell:n=>`${esc(n.agentVersion||'—')}<div class="muted mini">key ${esc(n.keyHint)} · config v${n.configVersion}</div>`},
        {title:'',cls:'row',cell:n=>`${btn('View config','vNodeConfig','secondary small',n.id)}${canManage(n.companyId)?btn('Edit','vEditNode','secondary small',n.id)+btn('New key','vNodeKey','secondary small',n.id):''}`}]});
    const lic=simpleTable(['Company',...Object.keys(vc().modules||{}).map(mod),''],(state.vlic||[]).map(l=>`<tr><td><b>${esc(l.companyName)}</b></td>${l.modules.map(x=>`<td>${x.valid?`${x.used} / ${x.cameras}${x.validUntil?`<div class="muted mini">until ${esc(x.validUntil)}</div>`:''}`:x.cameras&&!x.valid?'<span class="pill critical">Expired</span>':'<span class="muted">—</span>'}</td>`).join('')}<td>${admin()?btn('Edit','vLicence','secondary small',l.companyId):''}</td></tr>`));
    return header('Edge nodes & licences','The GPU PCs that analyse your cameras on site, and the AI modules your company is licensed for',anyManage()?btn('Add edge node','vNewNode','primary'):'')
      +`<div class="panel">${nodes}</div><div class="panel"><h2>Module licences</h2><p class="muted">Each camera running a module uses one licence. ${admin()?'':'Contact the platform administrator to change licences.'}</p>${lic}</div>`
      +`<details class="panel explainer"><summary><b>How the edge works</b> <span class="muted">– a quick guide</span></summary><p>An <b>edge node</b> is an industrial PC with an NVIDIA GPU next to the cameras. It decodes up to 16 streams, runs the AI models (TensorRT/DeepStream) and acts on the spot: it blinks the beacon at a doorway when PPE is missing, sends the PLC reject signal within 15 ms, sounds sirens, and broadcasts fire alarms on the factory network in under 2 seconds — even if the internet is down. It then reports each incident here with a photo and a 10-second clip.</p><p>Every minute the node checks in, sends its health and counters, and fetches any change you make here: modules, zones and settings reach it within a minute. Install the agent from <code>edge/</code> in the repository and give it the node key shown when you add the node.</p></details>`;
  }
  function nodeForm(n){
    const plants=(state.data.plants||[]).filter(p=>canManage(p.company_id));
    openDialog(n?`Edit ${n.name}`:'Add edge node',`<div class="form-grid">${n?'':select('plantId','Plant',plants.map(p=>[p.id,p.name]),{value:plants[0]?.id,required:true})}${field('name','Name',{value:n?.name,required:true,maxlength:80,help:'e.g. Edge PC – press hall'})}${field('hardware','Hardware',{value:n?.hardware,maxlength:160,help:'e.g. Industrial PC, RTX A4000 16 GB, 64 GB RAM, 2 TB NVMe'})}${field('maxStreams','Camera streams',{type:'number',value:n?.maxStreams||16,min:1,max:64,help:'16 per node at 1080p/25 fps on an RTX A4000-class GPU'})}${n?checkboxes('active','Status',[['yes','Active (its key is accepted)']],{values:n.active?['yes']:[]}):''}</div>`,
      {onSubmit:async fd=>{ const v=Object.fromEntries(fd); v.maxStreams=Number(v.maxStreams);
        if (n) { v.active=fd.getAll('active').includes('yes'); await api(`/vision/nodes/${n.id}`,'PATCH',v); toast('Edge node saved'); state.vnodesLoaded=false; render(); }
        else { const r=await api('/vision/nodes','POST',v); state.vnodesLoaded=false; render(); setTimeout(()=>showKey(r.node,r.key),50); } }});
  }
  function showKey(node,key){
    const url=location.origin;
    openDialog(`Key for ${node.name}`,`<div class="notice warn">Copy this key now: it is shown only once. Anyone with it can report incidents for this node.</div>
      <p><b>Node key</b></p><pre class="code-block" id="node-key">${esc(key)}</pre>
      <p><b>Start the agent on the edge PC</b></p><pre class="code-block">PLATFORM_URL=${esc(url)} \\\nNODE_KEY=${esc(key)} \\\npython3 -m edge_agent</pre><p class="muted">See <code>edge/README.md</code> for the full installation (NVIDIA driver, DeepStream, camera access and outputs).</p>
      <p>${btn('Copy key','vCopyKey','primary small')}</p>`,{onOpen:d=>{ d.querySelector('[data-action=vCopyKey]').onclick=()=>navigator.clipboard?.writeText(key).then(()=>toast('Key copied')).catch(()=>toast('Select the key and copy it','error')); }});
  }
  function licenceForm(companyId){
    const l=state.vlic.find(x=>x.companyId===companyId);
    openDialog(`Vision licences – ${l.companyName}`,`<div class="form-grid">${l.modules.map(x=>`${field(`cams.${x.module}`,`${mod(x.module)} cameras`,{type:'number',value:x.cameras,min:0,max:10000,help:`${x.used} in use`})}${field(`until.${x.module}`,'Valid until',{type:'date',value:x.validUntil||''})}`).join('')}</div>`,
      {onSubmit:async fd=>{ for (const x of l.modules) await api(`/vision/licences/${companyId}/${x.module}`,'PUT',{cameras:Number(fd.get(`cams.${x.module}`)||0),validUntil:fd.get(`until.${x.module}`)||null}); toast('Licences saved'); state.vnodesLoaded=false; state.vcams=undefined; render(); }});
  }

  // ---------- Media, CSV, alarms ----------
  function loadMedia(root=document){
    root.querySelectorAll('img[data-vmedia]:not([src])').forEach(async img=>{ const url=await authImageUrl(`/api/vision/media/${img.dataset.vmedia}`,state.token); if (url) img.src=url; });
    root.querySelectorAll('video[data-vclip]:not([src])').forEach(async v=>{ const url=await authImageUrl(`/api/vision/media/${v.dataset.vclip}`,state.token); if (url) v.src=url; });
  }
  async function downloadCsv(query){
    try { const r=await fetch(`/api/vision/events.csv${query?`?${query}`:''}`,{headers:{authorization:`Bearer ${state.token}`}}); if (!r.ok) throw Error('Export failed');
      const url=URL.createObjectURL(await r.blob()), a=document.createElement('a'); a.href=url; a.download=`vision-incidents-${new Date().toISOString().slice(0,10)}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
    catch (e) { toast(e.message,'error'); }
  }
  // Live alarm banner: polled every 5 s; a new critical alarm sounds a short tone. Shown above every page.
  let alarmTimer=null, seen=new Set(), audio=null;
  const canSeeVision=()=>!!state.user&&(customer()||is('platform_admin','dispatcher'));
  function beep(){ try { audio??=new AudioContext(); const o=audio.createOscillator(), g=audio.createGain(); o.frequency.value=880; g.gain.value=0.15; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime+0.6); } catch {} }
  async function pollAlarms(){
    if (!canSeeVision()) return;
    try { const list=await api('/vision/alarms'); state.valarms=list;
      if (list.some(a=>a.severity==='critical'&&!seen.has(a.id))) beep(); list.forEach(a=>seen.add(a.id)); drawBanner(); } catch {}
  }
  function drawBanner(){
    let el=document.getElementById('vision-alarm'); const list=(state.valarms||[]).filter(a=>!state.vMuted?.has(a.id));
    if (!list.length) { el?.remove(); return; }
    if (!el) { el=document.createElement('div'); el.id='vision-alarm'; el.setAttribute('role','alert'); document.body.prepend(el); }
    const top=list[0];
    el.className=`vision-alarm ${top.severity}`;
    el.innerHTML=`<span class="va-icon" aria-hidden="true">${top.type==='fire'||top.type==='smoke'?'🔥':top.module==='intrusion'?'🚫':top.module==='ppe'?'⛑':'⚠'}</span><div class="va-text"><b>${esc(typeLabel(top.type))} – ${esc(top.cameraName)}</b><span>${esc(top.location||'')}${eventDetail(top)?` · ${esc(eventDetail(top))}`:''} · ${when(top.occurredAt)}${list.length>1?` · +${list.length-1} more`:''}</span></div>
      <button type="button" data-va="open">View</button><button type="button" data-va="ack">Acknowledge</button><button type="button" class="va-x" data-va="hide" aria-label="Hide this alarm">✕</button>`;
    el.querySelector('[data-va=open]').onclick=()=>eventDialog(top.id).catch(fail);
    el.querySelector('[data-va=ack]').onclick=()=>api(`/vision/events/${top.id}/acknowledge`,'POST',{}).then(()=>{ toast('Alarm acknowledged'); refreshAll(); pollAlarms(); if (String(state.page).startsWith('vision')) render(); }).catch(fail);
    el.querySelector('[data-va=hide]').onclick=()=>{ (state.vMuted??=new Set()).add(top.id); drawBanner(); };
  }
  function startAlarms(){ if (alarmTimer||!canSeeVision()) return; pollAlarms(); alarmTimer=setInterval(pollAlarms,5000); }
  function stopAlarms(){ clearInterval(alarmTimer); alarmTimer=null; document.getElementById('vision-alarm')?.remove(); seen=new Set(); }
  // The overview refreshes itself every 15 s while it is open.
  let liveTimer=setInterval(()=>{ if (state.user&&state.page==='vision'&&!state.detail&&!document.querySelector('dialog[open]')) loadOverview().then(render).catch(()=>{}); },15000);

  // ---------- Actions and bindings ----------
  async function vAction(name,id){
    if (name==='vGoCameras') { state.page='visionCameras'; return render(); }
    if (name==='vGoIncidents') { state.page='visionIncidents'; return render(); }
    if (name==='vEvent') return eventDialog(id).catch(fail);
    if (name==='vAck') return api(`/vision/events/${id}/acknowledge`,'POST',{}).then(()=>{ closeDialog(); toast('Acknowledged'); refreshAll(); pollAlarms(); render(); }).catch(fail);
    if (name==='vResolve') { closeDialog(); return closeForm(id,'resolve'); }
    if (name==='vFalse') { closeDialog(); return closeForm(id,'false'); }
    if (name==='vLock'||name==='vUnlock') return api(`/vision/events/${id}/lock`,'POST',{locked:name==='vLock'}).then(()=>{ closeDialog(); toast(name==='vLock'?'Evidence locked':'Evidence unlocked'); refreshAll(); render(); }).catch(fail);
    if (name==='vTicket') { const e=await api(`/vision/events/${id}`), cam=camById(e.cameraId), info=vc().defectInfo?.[e.detail?.defect];
      closeDialog(); return raiseTicket(cam.equipmentId,{title:`${info?.[0]||humanise(e.detail?.defect||'Defect')} found by ${e.cameraName}`.slice(0,160),
        symptoms:`Vision quality inspection: ${info?.[0]||e.detail?.defect}${e.detail?.sizeMm?` (${e.detail.sizeMm} mm)`:''}${e.detail?.surfaceClass?`, surface class ${e.detail.surfaceClass}`:''} at ${new Intl.DateTimeFormat(state.user.preferences.locale,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone,timeZoneName:'short'}).format(new Date(e.occurredAt))}.${info?` Typical causes: ${info[2]}`:''}`,failureCategory:'tooling'}); }
    if (name==='vNewCamera') return cameraForm();
    if (name==='vEditCamera') return cameraForm(state.vcams.find(c=>c.id===id));
    if (name==='vZones') return zonesDialog(id).catch(fail);
    if (name==='vModule') { const [cid,m]=id.split('|'); return moduleForm(state.vcams.find(c=>c.id===cid),m); }
    if (name==='vAddModule') { const cam=state.vcams.find(c=>c.id===id), free=Object.keys(vc().modules).filter(m=>!cam.modules.some(x=>x.module===m));
      if (!free.length) return toast('All modules are already assigned to this camera');
      return openDialog(`Add module – ${cam.name}`,`<div class="form-grid">${select('module','Module',free.map(m=>{ const l=licFor(cam.companyId,m); return [m,`${mod(m)} – ${l?.valid?`${l.available} licence${l.available===1?'':'s'} free`:'not licensed'}`]; }),{required:true,wide:true})}</div>`,{submitLabel:'Next',onSubmit:async fd=>{ setTimeout(()=>moduleForm(cam,fd.get('module')),30); }}); }
    if (name==='vRemoveModule') { const [cid,m]=id.split('|'); if (!await confirmAction(`Remove ${mod(m)}?`,'The camera stops running this module within a minute and its licence becomes free.',{confirmLabel:'Remove'})) return;
      return api(`/vision/cameras/${cid}/modules/${m}`,'DELETE').then(()=>{ closeDialog(); toast('Module removed'); state.vcams=undefined; render(); }).catch(fail); }
    if (name==='vNewNode') return nodeForm();
    if (name==='vEditNode') return nodeForm(state.vnodes.find(n=>n.id===id));
    if (name==='vNodeKey') { const n=state.vnodes.find(x=>x.id===id); if (!await confirmAction(`New key for ${n.name}?`,'The current key stops working at once. Enter the new key on the edge PC to reconnect it.',{confirmLabel:'Create new key'})) return;
      return api(`/vision/nodes/${id}/key`,'POST',{}).then(r=>{ state.vnodesLoaded=false; render(); setTimeout(()=>showKey(r.node,r.key),50); }).catch(fail); }
    if (name==='vNodeConfig') return api(`/vision/nodes/${id}/config`).then(c=>openDialog(`Configuration – ${c.name}`,`<p class="muted">What the node runs now (version ${c.configVersion}). Camera passwords are masked here.</p><pre class="code-block">${esc(JSON.stringify(c,null,2))}</pre>`,{wide:true})).catch(fail);
    if (name==='vLicence') return licenceForm(id);
    return false;
  }
  function bind(){
    document.querySelectorAll('[data-vtab]').forEach(el=>el.onclick=()=>{ const [k,t]=el.dataset.vtab.split(':'); state[k+'Tab']=t; render(); });
    document.querySelectorAll('[data-vfilter]').forEach(el=>el.onchange=()=>{ state.visionFilter[el.dataset.vfilter]=el.value; state.vo=undefined; render(); });
    document.querySelectorAll('[data-vevent]').forEach(el=>el.onchange=()=>{ state.vEventFilter[el.dataset.vevent]=el.value; state.vevents=undefined; render(); });
    document.querySelectorAll('[data-vcsv]').forEach(el=>el.onclick=()=>downloadCsv(el.dataset.vcsv==='ppe'?'module=ppe&hours=8760':el.dataset.vcsv));
    // Drag a module card onto a camera's module cell to assign it.
    document.querySelectorAll('.module-card[draggable]').forEach(c=>c.ondragstart=e=>{ e.dataTransfer.setData('text/plain',`${c.dataset.module}|${c.dataset.company}`); e.dataTransfer.effectAllowed='copy'; });
    document.querySelectorAll('[data-drop-camera]').forEach(z=>{
      z.ondragover=e=>{ e.preventDefault(); z.classList.add('over'); }; z.ondragleave=()=>z.classList.remove('over');
      z.ondrop=e=>{ e.preventDefault(); z.classList.remove('over'); const [m,company]=(e.dataTransfer.getData('text/plain')||'').split('|'), cam=state.vcams.find(c=>c.id===z.dataset.dropCamera);
        if (!m||!cam) return; if (cam.companyId!==company) return toast('That licence belongs to another company','error');
        if (cam.modules.some(x=>x.module===m)) return moduleForm(cam,m);
        api(`/vision/cameras/${cam.id}/modules/${m}`,'PUT',{}).then(updated=>{ toast(`${mod(m)} added to ${cam.name}`); state.vcams=state.vcams.map(c=>c.id===cam.id?updated:c); state.vlic=undefined; loadCameras().then(()=>{ render(); moduleForm(state.vcams.find(c=>c.id===cam.id),m); }); }).catch(fail); };
    });
    loadMedia(); drawBanner();
  }
  const views={vision:overviewView,visionCameras:camerasView,visionIncidents:incidentsView,visionNodes:nodesView};
  const reset=()=>{ state.vo=undefined; state.vcams=undefined; state.vevents=undefined; state.vnodesLoaded=false; };
  return {views,action:vAction,bind,reset,startAlarms,stopAlarms,canSeeVision,ACTIONS:['vTicket','vGoCameras','vGoIncidents','vEvent','vAck','vResolve','vFalse','vLock','vUnlock','vNewCamera','vEditCamera','vZones','vModule','vAddModule','vRemoveModule','vNewNode','vEditNode','vNodeKey','vNodeConfig','vLicence']};
}
