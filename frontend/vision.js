// Vision AI pages: the overview (EHS, security and QA views), cameras with drag-and-drop module routing and the
// geofence editor, incidents with their evidence, and edge nodes with licences. Plus the live alarm banner shown on
// every page for fire, intrusion and (for people with those duties) PPE and quality alarms.
import { esc, btn, humanise, dataTable, simpleTable, field, select, checkboxes, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber, t as _t } from './shared/i18n.js';
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
  const typeLabel=t=>({ppe_violation:_t('vis.ppeViolation'),fire:_t('vis.fire'),smoke:_t('vis.smoke'),intrusion_person:_t('vis.personIntrusion'),intrusion_vehicle:_t('vis.vehicleIntrusion'),defect:_t('vis.defect')})[t]||humanise(t);
  const eventDetail=e=>e.module==='ppe'?`${_t('vis.missing',{value:(e.detail.missing||[]).map(g=>vc().ppeGear?.[g]||g).join(', ')})}`:e.module==='quality'?`${humanise(e.detail.defect||'')}${e.detail.sizeMm?` · ${formatNumber(e.detail.sizeMm,1)} mm`:''} · ${vc().qualityPresets?.[e.detail.preset]?.label||e.detail.preset||''}`:e.zoneName?`${_t('vis.zone',{zoneName:e.zoneName})}`:'';
  async function loadCat(){ if (!state.visionCat) state.visionCat=await api('/vision/catalog'); }

  // A camera image (snapshot or frame) with detection boxes and zones drawn over it. Media is fetched with the
  // sign-in token, so the <img> gets its src after rendering (see bind).
  const frame=({mediaId,boxes=[],zones=[],cls='',alt=_t('vis.cameraImage')})=>`<div class="vframe ${cls}">${mediaId?`<img data-vmedia="${esc(mediaId)}" alt="${esc(alt)}">`:`<div class="vframe-empty">${machineIcon('auxiliary',40,'camera')}<span>${_t('vis.noImageYet')}</span></div>`}
    ${zones.length?`<svg class="vzones" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${zones.map(z=>z.kind==='tripwire'?`<line class="z-${z.kind}" x1="${z.points[0][0]*100}" y1="${z.points[0][1]*100}" x2="${z.points[1][0]*100}" y2="${z.points[1][1]*100}"/>`:`<polygon class="z-${z.kind}" points="${z.points.map(p=>`${p[0]*100},${p[1]*100}`).join(' ')}"/>`).join('')}</svg>`:''}
    ${boxes.map(b=>`<span class="bbox ${b.ok?'ok':''}" style="left:${b.x*100}%;top:${b.y*100}%;width:${b.w*100}%;height:${b.h*100}%"><em>${esc(b.label||'')}${b.confidence!=null&&!/\d/.test(b.label||'')?` ${Math.round(b.confidence*100)}%`:''}</em></span>`).join('')}</div>`;

  // ---------- Overview ----------
  async function loadOverview(){ await loadCat(); const f=state.visionFilter||(state.visionFilter={hours:'24',plantId:''});
    state.vo=await api(`/vision/overview?hours=${f.hours}${f.plantId?`&plantId=${encodeURIComponent(f.plantId)}`:''}`); }
  function overviewView(){
    if (!state.vo) { loadOverview().then(render).catch(fail); return '<div class="panel empty">Loading vision overview…</div>'; }
    const o=state.vo, duties=state.user.visionDuties||[], tab=state.visionTab||(duties.length===1?duties[0]:'all'), f=state.visionFilter;
    const filters=`<div class="table-tools">${tool('data-vfilter','hours',_t('vis.period'),[['1',_t('vis.lastHour')],['24',_t('vis.last24Hours')],['168',_t('vis.last7Days')],['720',_t('vis.last30Days')]],f.hours,'')}${tool('data-vfilter','plantId',_t('vis.plant'),(state.data.plants||[]).map(p=>[p.id,p.name]),f.plantId,_t('vis.allPlants'))}</div>`;
    const online=o.nodes.filter(n=>n.status==='online').length, camsOnline=o.cameras.filter(c=>c.status==='online').length;
    const kpi={
      all:[statTile(_t('vis.ppeCompliance'),pct(o.ppe.complianceRate),{status:o.ppe.complianceRate==null?'':o.ppe.complianceRate>=98?'good':o.ppe.complianceRate>=90?'warning':'critical',note:`${_t('vis.peopleChecked',{people:formatNumber(o.ppe.people)})}`}),
        statTile(_t('vis.fireSmoke'),formatNumber(o.fire.events),{status:o.fire.open?'critical':'',note:o.fire.open?`${_t('vis.open',{open:o.fire.open})}`:`${_t('vis.falseAlarms2',{falseAlarms:o.fire.falseAlarms})}`}),
        statTile(_t('vis.intrusions'),formatNumber(o.intrusion.events),{note:`${_t('vis.peopleVehicles',{people:o.intrusion.people,vehicles:o.intrusion.vehicles})}`}),
        statTile(_t('vis.defectRate'),pct(o.quality.defectRate),{note:`${_t('vis.inspected',{inspected:formatNumber(o.quality.inspected)})}`}),
        statTile(_t('vis.camerasOnline'),`${camsOnline} / ${o.cameras.length}`,{status:o.cameras.length&&camsOnline<o.cameras.length?'warning':'',note:`${_t('vis.ofEdgeNodesOnline',{online:online,length:o.nodes.length})}`}),
        statTile(_t('vis.alarmBroadcastP95'),ms(o.latency.broadcastP95Ms),{status:o.latency.broadcastP95Ms==null?'':o.latency.broadcastP95Ms<=2000?'good':'critical',note:_t('vis.targetUnder2000Ms')})],
      ehs:[statTile(_t('vis.ppeCompliance'),pct(o.ppe.complianceRate),{status:o.ppe.complianceRate==null?'':o.ppe.complianceRate>=98?'good':'warning',note:`${_t('vis.ofPeople',{compliant:formatNumber(o.ppe.compliant),people:formatNumber(o.ppe.people)})}`}),
        statTile(_t('vis.ppeViolations'),formatNumber(o.ppe.violations),{note:_t('vis.withPhotoProof')}),statTile(_t('vis.fire'),formatNumber(o.fire.fire),{status:o.fire.fire?'critical':''}),statTile(_t('vis.smoke'),formatNumber(o.fire.smoke),{status:o.fire.smoke?'warning':''}),
        statTile(_t('vis.falseFireAlarms'),formatNumber(o.fire.falseAlarms),{note:_t('vis.sentForRetraining')}),statTile(_t('vis.alarmBroadcastP95'),ms(o.latency.broadcastP95Ms),{note:_t('vis.detectionToFactoryBroadcast')})],
      security:[statTile(_t('vis.intrusions'),formatNumber(o.intrusion.events),{status:o.intrusion.events?'warning':''}),statTile(_t('vis.people'),formatNumber(o.intrusion.people)),statTile(_t('vis.vehicles'),formatNumber(o.intrusion.vehicles)),
        statTile(_t('vis.machineMotionIgnored'),formatNumber(o.intrusion.ignoredMachineMotion),{note:_t('vis.approvedConveyorAndRobotPaths')}),statTile(_t('vis.alertToPlatformP95'),ms(o.latency.uplinkP95Ms)),statTile(_t('vis.relaySirenP95'),ms(o.latency.actuatorP95Ms))],
      qa:[statTile(_t('vis.inspected2'),formatNumber(o.quality.inspected)),statTile(_t('vis.defectRate'),pct(o.quality.defectRate),{status:o.quality.defectRate==null?'':o.quality.defectRate<=0.5?'good':o.quality.defectRate<=2?'warning':'critical',note:_t('vis.failedInspected')}),
        statTile(_t('vis.defectsRecorded'),formatNumber(o.quality.defects)),statTile(_t('vis.logisticsDamage'),formatNumber(o.quality.logistics.reduce((n,r)=>n+r.n,0)),{note:_t('vis.shippingContainers')})]
    }[tab]||[];
    const camName=id=>o.cameras.find(c=>c.id===id)?.name||'—';
    const rows=(list,labelFn=x=>x)=>list.map(r=>({label:labelFn(r.key)||'—',value:r.n}));
    const charts={
      all:columnChart('v-hourly',{title:_t('vis.detectionsByHour'),subtitle:_t('vis.allModules'),points:Object.entries(o.hourly.reduce((m,h)=>(m[h.hour]=(m[h.hour]||0)+h.n,m),{})).map(([h,v])=>({label:new Intl.DateTimeFormat(state.user.preferences.locale,{hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone}).format(new Date(`${h}:00:00Z`)),value:v})),valueLabel:_t('vis.detections2')}),
      ehs:`<div class="chart-grid">${barChart('v-gear',{title:_t('vis.missingPpe'),subtitle:_t('vis.violationsByItem'),rows:rows(o.ppe.byGear,g=>vc().ppeGear?.[g]||g),valueLabel:_t('vis.violations')})}${barChart('v-ppecam',{title:_t('vis.ppeViolationsByCamera'),rows:rows(o.ppe.byCamera,camName),valueLabel:_t('vis.violations')})}</div>`,
      security:barChart('v-zones',{title:_t('vis.intrusionsByZone'),rows:rows(o.intrusion.byZone),valueLabel:_t('vis.intrusions')}),
      qa:`<div class="chart-grid">${barChart('v-defects',{title:_t('vis.defectsByType'),subtitle:_t('vis.allPresets'),rows:rows(o.quality.byDefect,humanise),valueLabel:_t('vis.defects')})}${barChart('v-presets',{title:_t('vis.defectsByInspectionPreset'),rows:rows(o.quality.byPreset,p=>vc().qualityPresets?.[p]?.label||p),valueLabel:_t('vis.defects')})}${barChart('v-logistics',{title:_t('vis.logisticsDamageProfile'),subtitle:_t('vis.shippingContainerInspection'),rows:rows(o.quality.logistics,humanise),valueLabel:_t('vis.damageFindings')})}${barChart('v-qcam',{title:_t('vis.defectsByCamera'),rows:rows(o.quality.byCamera,camName),valueLabel:_t('vis.defects')})}</div>`
    }[tab]||'';
    const want={ehs:['ppe','fire_smoke'],security:['intrusion','fire_smoke'],qa:['quality']}[tab];
    const cams=o.cameras.filter(c=>!want||c.modules.some(m=>want.includes(m.module)));
    const tiles=cams.length?`<div class="vtiles">${cams.map(c=>`<article class="vtile ${c.latest?.status==='open'&&c.latest.severity==='critical'?'alarm':''}">${frame({mediaId:c.latest?.snapshot_media_id||c.snapshotMediaId,boxes:c.latest?.snapshot_media_id?c.latest.boxes:[],alt:c.name})}
      <div class="vtile-body"><div class="spread"><b>${esc(c.name)}</b>${camStatus(c.status)}</div><div class="muted mini">${esc(c.location||plantName(c.plantId))}${c.metrics?.fps?` ${_t('vis.fps',{fps:formatNumber(c.metrics.fps,0)})}`:''}${c.metrics?.inspectionMs?` · OK/NG in ${formatNumber(c.metrics.inspectionMs,0)} ms`:c.metrics?.inferenceMs?` · ${formatNumber(c.metrics.inferenceMs,0)} ms`:''}</div>
      <div class="chips">${c.modules.filter(m=>m.enabled).map(m=>`<span class="chip mod-${m.module}">${esc(mod(m.module))}</span>`).join('')||_t('vis.noModulesAssigned')}</div>
      <div class="mini">${_t('vis.detections',{value:c.today.people?`${_t('vis.ppe',{value:pct(Math.round(1000*c.today.compliant/c.today.people)/10)})} `:'',value2:c.today.inspected?`${_t('vis.passFail',{passed:formatNumber(c.today.passed),value:formatNumber(c.today.inspected-c.today.passed)})} `:'',events:c.today.events})}</div>
      ${c.latest?`<div class="mini"><a data-action="vEvent" data-id="${esc(c.latest.id)}">${esc(typeLabel(c.latest.type))}</a> · ${when(c.latest.occurred_at)}</div>`:''}</div></article>`).join('')}</div>`
      :`<div class="panel empty">${_t('vis.noCamerasYet2',{value:want?_t('vis.withTheseModules'):'',value2:anyManage()?_t('vis.addCamerasAndAssignModules'):''})}</div>`;
    const open=o.open.filter(e=>!want||want.includes(e.module));
    const openPanel=`<div class="panel"><div class="spread"><h2>${_t('vis.openAlarms')}</h2><span class="row">${btn(_t('vis.allIncidents'),'vGoIncidents','secondary small')}${tab==='ehs'?`<a class="btn-link" data-vcsv="ppe">${_t('vis.ppeProofLogCsv')}</a>`:''}</span></div>${open.length?simpleTable([_t('vis.when'),_t('vis.camera'),_t('vis.incident'),_t('vis.severity'),''],open.map(e=>`<tr><td>${when(e.occurredAt)}</td><td>${esc(e.cameraName)}</td><td><a data-action="vEvent" data-id="${esc(e.id)}">${esc(typeLabel(e.type))}</a><div class="muted mini">${esc(eventDetail(e))}</div></td><td>${sevPill(e.severity)}</td><td class="row">${e.status==='open'?btn(_t('vis.acknowledge'),'vAck','secondary small',e.id):statusPill(e.status)}</td></tr>`)):_t('vis.noOpenAlarms')}</div>`;
    const tabList=[['all',_t('vis.allModules')],['ehs',_t('vis.ehsPpeFire')],['security',_t('vis.securityRestrictedAreas')],['qa',_t('vis.qualityInspection')]];
    return header(_t('vis.visionOverview'),_t('vis.livePpeComplianceFireAnd'),anyManage()?btn(_t('vis.camerasAiModules'),'vGoCameras','secondary'):'')
      +filters+tabs('vision',tabList,tab)+`<section class="kpis small" aria-label="${_t('vis.visionFigures')}">${kpi.join('')}</section>`+openPanel+`<h2 class="section-title">${_t('vis.cameras')}</h2>`+tiles+(charts?`<div class="panel">${charts}</div>`:'');
  }

  // ---------- Cameras and module routing ----------
  async function loadCameras(){ await loadCat(); const [cams,nodes,lic]=await Promise.all([api('/vision/cameras'),api('/vision/nodes'),api('/vision/licences')]); state.vcams=cams; state.vnodes=nodes; state.vlic=lic; }
  const licFor=(companyId,m)=>(state.vlic||[]).find(l=>l.companyId===companyId)?.modules.find(x=>x.module===m);
  function camerasView(){
    if (!state.vcams) { loadCameras().then(render).catch(fail); return '<div class="panel empty">Loading cameras…</div>'; }
    const companies=(state.vlic||[]).filter(l=>canManage(l.companyId));
    const palette=companies.length?`<div class="panel"><h2>${_t('vis.aiModules')}</h2><p class="muted">${_t('vis.dragAModuleOntoA')} <b>${_t('vis.addModule2')}</b> ${_t('vis.onTheCameraEachCamera')}</p>${companies.map(l=>`${companies.length>1?`<h3>${esc(l.companyName)}</h3>`:''}<div class="module-palette">${l.modules.map(x=>`<div class="module-card mod-${x.module} ${x.valid?'':'off'}" ${x.valid&&x.available?`draggable="true"`:''} data-module="${x.module}" data-company="${esc(l.companyId)}" title="${x.valid?`${_t('vis.ofLicencesInUse',{used:x.used,cameras:x.cameras})}`:_t('vis.noValidLicence')}">
      <b>${esc(mod(x.module))}</b><span>${x.valid?`${x.used} / ${x.cameras} cameras${x.validUntil?` ${_t('vis.until2',{validUntil:esc(x.validUntil)})}`:''}`:_t('vis.notLicensed')}</span></div>`).join('')}</div>`).join('')}</div>`:'';
    const nodeName=id=>(state.vnodes||[]).find(n=>n.id===id)?.name||'— no edge node —';
    const table=dataTable('vcams',{rows:state.vcams,search:c=>`${c.name} ${c.location} ${c.sourceType} ${nodeName(c.nodeId)} ${c.modules.map(m=>mod(m.module)).join(' ')}`,
      filters:[{key:'status',label:_t('vis.status'),options:['online','offline','tampered','unknown'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:_t('vis.noCamerasYet'),
      columns:[{title:_t('vis.camera'),cell:c=>`<b>${esc(c.name)}</b> ${c.active?'':_t('vis.inactive')}<div class="muted">${esc(c.location||'')}${c.location?' · ':''}${esc(plantName(c.plantId))}</div>`},
        {title:_t('vis.source'),cell:c=>`${esc(humanise(c.sourceType))}<div class="muted mini code">${esc(c.sourceUrl||'—')}</div>`},{title:_t('vis.edgeNode'),cell:c=>esc(nodeName(c.nodeId))},{title:_t('vis.status'),cell:c=>camStatus(c.status)},
        {title:_t('vis.aiModules'),cell:c=>`<div class="drop-zone" data-drop-camera="${esc(c.id)}"><div class="chips">${c.modules.map(m=>`<button type="button" class="chip mod-${m.module} ${m.enabled?'':'off'}" data-action="vModule" data-id="${esc(c.id)}|${m.module}" title="${_t('vis.settings')}">${esc(mod(m.module))}${m.enabled?'':_t('vis.off')}</button>`).join('')}${canManage(c.companyId)?btn(_t('vis.addModule'),'vAddModule','chip chip-add',c.id):''}</div></div>`},
        {title:'',cls:'row',cell:c=>canManage(c.companyId)?`${btn(_t('vis.drawZones'),'vZones','secondary small',c.id)}${btn(_t('vis.edit'),'vEditCamera','secondary small',c.id)}`:btn(`${_t('vis.zones',{zones:c.zones})}`,'vZones','secondary small',c.id)}]});
    return header(_t('vis.camerasAiModules'),_t('vis.everyIpOrCsiCamera'),anyManage()?btn(_t('vis.addCamera'),'vNewCamera','primary'):'')+palette+`<div class="panel">${table}</div>`;
  }
  function cameraForm(c){
    const plants=(state.data.plants||[]).filter(p=>canManage(p.company_id)), nodes=state.vnodes||[];
    const body=section(_t('vis.camera'),`${select('plantId',_t('vis.plant'),plants.map(p=>[p.id,p.name]),{value:c?.plantId||plants[0]?.id,required:true})}${field('name',_t('vis.name'),{value:c?.name,required:true,maxlength:80,help:_t('vis.eGGate1Press')})}${field('location',_t('vis.location'),{value:c?.location,maxlength:120,help:_t('vis.doorLineOrAreaThe')})}
      ${select('nodeId',_t('vis.edgeNode'),nodes.map(n=>[n.id,`${_t('vis.streams2',{name:n.name,cameras:n.cameras,maxStreams:n.maxStreams})}`]),{value:c?.nodeId||'',placeholder:_t('vis.notYet'),help:_t('vis.theGpuPcThatAnalyses')})}
      ${select('equipmentId',_t('vis.machineWatched'),(state.data.equipment||[]).map(e=>[e.id,`${e.asset_tag||''} ${e.make} ${e.model}`]),{value:c?.equipmentId||'',placeholder:_t('vis.none'),help:_t('vis.linksAlertsAndQualityResults')})}`)
      +section(_t('vis.videoSource'),`${select('vendor',_t('vis.cameraMake'),(vc().cameraVendors||[]).map(v=>[v,v]),{value:c?.vendor||'',placeholder:_t('vis.choose'),help:_t('vis.picksTheRightConnectionOn')})}${select('sourceType',_t('vis.connection'),(vc().sourceTypes||[]).map(s=>[s,({rtsp:_t('vis.rtspVideoStreamHikvisionAxis'),'http-snapshot':_t('vis.httpSnapshotHikvisionIsapiAxis'),'cognex-native':_t('vis.cognexInSightNativeMode'),folder:_t('vis.ftpFolderImageOutputKeyence'),csi:_t('vis.csiCameraOnTheEdge'),visionforge:_t('vis.visionforgeInspectionStation')})[s]]),{value:c?.sourceType||'rtsp',required:true})}<p class="muted wide mini" id="src-help"></p>
      ${field('sourceUrl',_t('vis.address'),{value:c?.sourceUrl,wide:true,maxlength:500,help:_t('vis.eGRtspUserPassword')})}${field('fps',_t('vis.frameRate'),{type:'number',value:c?.fps||25,min:1,max:120,unit:'fps',help:_t('vis.qualityInspectionOnFastLines')})}`);
    const HELP={rtsp:_t('vis.hikvisionRtspUserPassword192'),'http-snapshot':_t('vis.hikvisionHttp1921680'),
      'cognex-native':_t('vis.cognexInSightCameraIp'),folder:_t('vis.keyenceCvXXgOr'),
      csi:_t('vis.noAddressNeeded'),visionforge:_t('vis.noAddressNeededTheStation')};
    openDialog(c?`${_t('vis.edit2',{name:c.name})}`:_t('vis.addCamera'),body,{onOpen:d=>{ const t=d.querySelector('[name=sourceType]'), h=d.querySelector('#src-help'), v=d.querySelector('[name=vendor]'); const sync=()=>{ h.textContent=HELP[t.value]||''; }; t.onchange=sync; sync();
      v.onchange=()=>{ const pick={Cognex:'cognex-native',Keyence:'folder',Hikrobot:'folder',Hikvision:'rtsp'}[v.value]; if (pick&&!c) { t.value=pick; sync(); } }; },onSubmit:async fd=>{ const v=Object.fromEntries(fd); v.fps=Number(v.fps);
      if (c) await api(`/vision/cameras/${c.id}`,'PATCH',v); else await api('/vision/cameras','POST',v); toast(c?_t('vis.cameraSaved'):_t('vis.cameraAdded')); state.vcams=undefined; render(); }});
  }
  // Settings of one module on one camera; also how a module is first added (from the drag-and-drop or the button).
  function outputFields(prefix,label,o){
    const p=o?.protocol||''; const f=(k,t,opts={})=>field(`${prefix}.${k}`,t,{value:o?.[k]??'',...opts});
    return `<fieldset class="fld wide output-set" data-output="${prefix}"><legend>${esc(label)}</legend><div class="form-grid">${select(`${prefix}.protocol`,_t('vis.interface'),[['modbus_tcp',_t('vis.modbusTcpCoil')],['ethernet_ip',_t('vis.ethernetIpTag')],['gpio',_t('vis.edgeGpioRelayPin')],['http',_t('vis.httpRelay')]],{value:p,placeholder:_t('vis.none')})}
      ${f('host',_t('vis.plcRelayIp'),{help:_t('vis.modbusTcpAndEthernetIp')})}${f('port',_t('vis.port'),{type:'number',help:_t('vis.modbus502')})}${f('unitId',_t('vis.unitId'),{type:'number'})}${f('coil',_t('vis.coil'),{type:'number'})}${f('tag','Tag',{help:_t('vis.ethernetIpTagEG')})}${f('value',_t('vis.value'),{type:'number'})}${f('pin',_t('vis.gpioPin'),{type:'number'})}${f('url',_t('vis.relayUrl'),{wide:true})}${f('pulseMs',_t('vis.pulse'),{type:'number',unit:'ms'})}</div></fieldset>`;
  }
  function inputFields(prefix,label,i){
    const f=(k,t,opts={})=>field(`${prefix}.${k}`,t,{value:i?.[k]??'',...opts});
    return `<fieldset class="fld wide output-set"><legend>${esc(label)}</legend><div class="form-grid">${select(`${prefix}.protocol`,_t('vis.interface'),[['ethernet_ip',_t('vis.ethernetIpTag')],['modbus_tcp',_t('vis.modbusTcpInput')]],{value:i?.protocol||'',placeholder:_t('vis.none')})}
      ${f('host','PLC IP')}${f('tag','Tag',{help:_t('vis.ethernetIpEGCell3')})}${select(`${prefix}.kind`,_t('vis.modbusType'),[['discrete_input',_t('vis.discreteInput')],['coil',_t('vis.coil')]],{value:i?.kind||'discrete_input'})}${f('address',_t('vis.modbusAddress'),{type:'number'})}${f('port',_t('vis.port'),{type:'number',help:_t('vis.modbus502')})}${f('unitId',_t('vis.unitId'),{type:'number'})}</div></fieldset>`;
  }
  const readInput=(fd,prefix)=>{ const p=fd.get(`${prefix}.protocol`); if (!p) return null; const o={protocol:p}; for (const k of ['host','tag','kind','address','port','unitId']) { const v=fd.get(`${prefix}.${k}`); if (v!==null&&v!=='') o[k]=['host','tag','kind'].includes(k)?v:Number(v); } return o; };
  const readOutput=(fd,prefix)=>{ const p=fd.get(`${prefix}.protocol`); if (!p) return null; const o={protocol:p}; for (const k of ['host','port','unitId','coil','tag','value','pin','url','pulseMs']) { const v=fd.get(`${prefix}.${k}`); if (v!==null&&v!=='') o[k]=['host','tag','url'].includes(k)?v:Number(v); } return o; };
  function moduleForm(cam,module){
    const a=cam.modules.find(m=>m.module===module), c=a?.config||vc().modules[module].defaults, manageable=canManage(cam.companyId);
    let body='';
    if (module==='ppe') body=section(_t('vis.requiredProtectiveEquipment'),`${checkboxes('requiredGear',_t('vis.requiredInThisZone'),Object.entries(vc().ppeGear).map(([k,v])=>[k,v]),{values:c.requiredGear,required:true})}${field('minConfidence',_t('vis.minimumConfidence'),{type:'number',value:c.minConfidence,min:0.3,max:0.99,step:0.01,help:_t('vis.belowThisThePersonIs')})}${field('cooldownSeconds',_t('vis.repeatAlarmAfter'),{type:'number',value:c.cooldownSeconds,min:0,max:3600,unit:'s',help:_t('vis.samePersonSameViolation')})}${outputFields('beaconOutput',_t('vis.entranceBeaconBlinksAtThis'),c.beaconOutput)}`);
    if (module==='fire_smoke') body=section(_t('vis.fireAndSmoke'),`${select('sensitivity',_t('vis.sensitivity'),(vc().sensitivity||[]).map(s=>[s,humanise(s)]),{value:c.sensitivity,required:true,help:_t('vis.conservativeSuitsAreasWithSteam')})}${field('confirmSeconds',_t('vis.confirmOver'),{type:'number',value:c.confirmSeconds,min:0.2,max:1.8,step:0.1,unit:'s',help:_t('vis.temporalCheckThatSeparatesFlames')})}
      ${checkboxes('broadcast',_t('vis.factoryNetwork'),[['yes',_t('vis.broadcastTheAlarmOnThe')]],{values:c.broadcast?['yes']:[]})}${outputFields('sirenOutput',_t('vis.sirenStrobe'),c.sirenOutput)}`);
    if (module==='intrusion') body=section(_t('vis.restrictedArea'),`${checkboxes('classes',_t('vis.raiseAnIntrusionFor'),[['person',_t('vis.people')],['vehicle',_t('vis.vehiclesForkliftsTrucks')]],{values:c.classes,required:true})}${field('dwellSeconds',_t('vis.insideTheZoneForAt'),{type:'number',value:c.dwellSeconds,min:0,max:30,step:0.1,unit:'s'})}${outputFields('sirenOutput',_t('vis.sirenSecurityLight'),c.sirenOutput)}<p class="muted wide">${_t('vis.drawTheExclusionZonesTripwires')} <b>${_t('vis.drawZones')}</b>${_t('vis.movementInsideApprovedMachineMotion')}</p>`);
    if (module==='quality') { const acc=c.acceptance||{A:0.5,B:1,C:2};
      body=section(_t('vis.product'),`${select('preset',_t('vis.inspectionPreset'),Object.entries(vc().qualityPresets).map(([k,p])=>[k,p.label]),{value:c.preset,required:true,wide:true,help:_t('vis.modelAndDefectClassesFor')})}<p class="muted wide mini" id="preset-defects"></p>${field('minDefectMm',_t('vis.smallestDefectToFind'),{type:'number',value:c.minDefectMm,min:0.05,max:50,step:0.05,unit:'mm'})}${field('mmPerPixel',_t('vis.calibration'),{type:'number',value:c.mmPerPixel??'',min:0.001,max:10,step:0.001,unit:'mm/pixel',help:_t('vis.fromTheCalibrationTargetNeeded')})}`)
        +section(_t('vis.acceptanceBySurfaceClassVda'),`${field('acceptance.A',_t('vis.classAVisibleSurfaces'),{type:'number',value:acc.A,min:0.05,max:100,step:0.05,unit:'mm',help:_t('vis.rejectDefectsAtOrAbove')})}${field('acceptance.B',_t('vis.classBPartlyVisible'),{type:'number',value:acc.B,min:0.05,max:100,step:0.05,unit:'mm'})}${field('acceptance.C',_t('vis.classCHiddenSurfaces'),{type:'number',value:acc.C,min:0.05,max:100,step:0.05,unit:'mm'})}<p class="muted wide mini">${_t('vis.drawTheClassAB')} <b>${_t('vis.drawZones')}</b>${_t('vis.defaultsAreAStartingPoint')}</p>`)
        +section(_t('vis.lineTimingAndPlc'),`${select('triggerMode',_t('vis.trigger'),[['plc',_t('vis.plcPartPresentSignalOne')],['camera',_t('vis.cameraHardwareTrigger')],['continuous',_t('vis.continuousVideo')]],{value:c.triggerMode,required:true})}${field('cycleTimeS',_t('vis.machineCycleTime'),{type:'number',value:c.cycleTimeS,min:0.2,max:600,step:0.1,unit:'s',help:_t('vis.shortestCycleOnThisLine')})}${field('resultBudgetMs',_t('vis.okNgResultWithin'),{type:'number',value:c.resultBudgetMs,min:20,max:10000,unit:'ms',help:_t('vis.atMostHalfTheCycle')})}${field('targetFps',_t('vis.frameRateContinuous'),{type:'number',value:c.targetFps,min:1,max:120,unit:'fps'})}
          ${inputFields('triggerInput',_t('vis.partPresentTriggerPlcEdge'),c.triggerInput)}${outputFields('okOutput',_t('vis.okResultEdgePlc'),c.okOutput)}${outputFields('rejectOutput',_t('vis.ngRejectResultEdgePlc'),c.rejectOutput)}`); }
    const enabled=checkboxes('enabled',_t('vis.status'),[['yes',_t('vis.runningOnThisCamera')]],{values:a?.enabled===false?[]:['yes']});
    const d=openDialog(`${mod(module)} – ${cam.name}`,`${body}<div class="form-grid">${enabled}</div>${a&&manageable?`<p>${btn(_t('vis.removeModuleFromThisCamera'),'vRemoveModule','danger small',`${cam.id}|${module}`)}</p>`:''}`,{submitLabel:a?_t('vis.save'):_t('vis.addModule2'),onSubmit:manageable?async fd=>{
      const v=Object.fromEntries([...fd.entries()].filter(([k])=>!k.includes('.')&&!['requiredGear','classes','broadcast','enabled'].includes(k)));
      const config={...v};
      for (const k of ['minConfidence','cooldownSeconds','confirmSeconds','dwellSeconds','minDefectMm','mmPerPixel','targetFps','cycleTimeS','resultBudgetMs']) if (k in config) config[k]=config[k]===''?null:Number(config[k]);
      if (module==='ppe') { config.requiredGear=fd.getAll('requiredGear'); config.beaconOutput=readOutput(fd,'beaconOutput'); }
      if (module==='fire_smoke') { config.broadcast=fd.getAll('broadcast').includes('yes'); config.sirenOutput=readOutput(fd,'sirenOutput'); }
      if (module==='intrusion') { config.classes=fd.getAll('classes'); config.sirenOutput=readOutput(fd,'sirenOutput'); }
      if (module==='quality') { config.rejectOutput=readOutput(fd,'rejectOutput'); config.okOutput=readOutput(fd,'okOutput'); config.triggerInput=readInput(fd,'triggerInput'); config.acceptance={A:Number(fd.get('acceptance.A')),B:Number(fd.get('acceptance.B')),C:Number(fd.get('acceptance.C'))}; }
      await api(`/vision/cameras/${cam.id}/modules/${module}`,'PUT',{enabled:fd.getAll('enabled').includes('yes'),config}); toast(`${_t('vis.saved',{module:mod(module)})}`); state.vcams=undefined; render(); }:undefined});
    d.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>vAction(b.dataset.action,b.dataset.id));
    const presetSel=d.querySelector('[name=preset]'), list=d.querySelector('#preset-defects');
    if (presetSel&&list) { const show=()=>{ list.textContent=`${_t('vis.defectsFound',{value:(vc().qualityPresets[presetSel.value]?.defects||[]).map(x=>vc().defectInfo?.[x]?.[0]||humanise(x)).join(', ')})}`; }; presetSel.onchange=show; show(); }
  }

  // ---------- Geofence editor ----------
  async function zonesDialog(camId){
    const cam=camById(camId)||(await api('/vision/cameras')).find(c=>c.id===camId), manageable=canManage(cam.companyId);
    let zones=await api(`/vision/cameras/${camId}/zones`), draft=null;
    const KIND=vc().zoneKinds, onlyQuality=cam.modules.length&&cam.modules.every(m=>m.module==='quality'), defKind=onlyQuality?'inspection_roi':'exclusion';
    const d=openDialog(`${_t('vis.zones2',{name:cam.name})}`,`<div class="geo">
      <div class="geo-stage" id="geo-stage">${frame({mediaId:cam.snapshotMediaId,cls:'geo-frame',alt:`${_t('vis.view2',{name:cam.name})}`})}<svg id="geo-svg" viewBox="0 0 1000 562" preserveAspectRatio="none" role="application" aria-label="${_t('vis.zoneDrawingArea')}"></svg></div>
      <div class="geo-side">${manageable?`<div class="form-grid">${field('gname',_t('vis.zoneName'),{wide:true,maxlength:80,placeholder:_t('vis.eGPress3Safety')})}${select('gkind',_t('vis.kind'),Object.entries(KIND),{value:defKind,required:true,wide:true})}${select('gsev',_t('vis.severity'),[['critical',_t('vis.criticalSecurityLifeSafety')],['warning',_t('vis.warning')]],{value:'critical',wide:true})}${select('gclassAB',_t('vis.surfaceClassInspectionAreas'),[['A',_t('vis.aVisibleSurface')],['B',_t('vis.bPartlyVisible')],['C',_t('vis.cHiddenSurface')]],{value:'A',wide:true})}${checkboxes('gclass',_t('vis.detect'),[['person',_t('vis.people')],['vehicle',_t('vis.vehicles')]],{values:['person','vehicle']})}</div>
        <p class="muted mini" id="geo-help">${_t('vis.clickOnTheImageTo2')}</p>
        <div class="row">${btn(_t('vis.saveZone'),'gSave','primary small')}${btn(_t('vis.undoPoint'),'gUndo','secondary small')}${btn(_t('vis.cancel'),'gCancel','secondary small')}</div>`:_t('vis.viewOnlyACompanyAdministrator')}
        <h3>${_t('vis.zones3')}</h3><div id="geo-list"></div>${cam.snapshotMediaId?'':_t('vis.noCameraImageYetThe')}</div></div>`,{wide:true});
    d.classList.add('xwide');
    const svg=d.querySelector('#geo-svg'), W=1000, H=562;
    const pt=e=>{ const r=svg.getBoundingClientRect(); return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))].map(x=>Math.round(x*10000)/10000); };
    const shape=(z,cls)=>z.kind==='tripwire'&&z.points.length>=2?`<line class="${cls} z-${z.kind}" x1="${z.points[0][0]*W}" y1="${z.points[0][1]*H}" x2="${z.points[1][0]*W}" y2="${z.points[1][1]*H}"/>`
      :z.points.length>=3?`<polygon class="${cls} z-${z.kind}" points="${z.points.map(p=>`${p[0]*W},${p[1]*H}`).join(' ')}"/>`:z.points.length===2?`<polyline class="${cls} z-${z.kind}" points="${z.points.map(p=>`${p[0]*W},${p[1]*H}`).join(' ')}"/>`:'';
    const draw=()=>{
      svg.innerHTML=zones.filter(z=>z.active&&(!draft||z.id!==draft.id)).map(z=>`${shape(z,'saved')}<text x="${z.points[0][0]*W+6}" y="${z.points[0][1]*H-6}" class="geo-label">${esc(z.name)}</text>`).join('')
        +(draft?`${shape(draft,'draft')}${draft.points.map((p,i)=>`<circle class="handle" data-i="${i}" cx="${p[0]*W}" cy="${p[1]*H}" r="9"/>`).join('')}`:'');
      d.querySelector('#geo-list').innerHTML=zones.length?zones.map(z=>`<div class="geo-item ${z.active?'':'off'}"><span class="swatch z-${z.kind}"></span><div><b>${esc(z.name)}</b><div class="muted mini">${esc(KIND[z.kind])}${z.surfaceClass?` ${_t('vis.class',{surfaceClass:esc(z.surfaceClass)})}`:''}${z.kind==='exclusion'||z.kind==='tripwire'?` · ${esc(z.severity)} · ${z.classes.join(', ')}`:''}${z.active?'':_t('vis.inactive2')}</div></div>${manageable&&z.active?`<span class="row">${btn(_t('vis.edit'),'gEdit','secondary small',z.id)}${btn(_t('vis.delete'),'gDelete','danger small',z.id)}</span>`:''}</div>`).join(''):'<p class="muted">No zones yet.</p>';
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
        if (draft.kind==='tripwire'&&draft.points.length>=2) return toast(_t('vis.aTripwireHasTwoPoints'),'error');
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
        if (name==='gDelete') { if (!await confirmAction(_t('vis.deleteThisZone'),_t('vis.theEdgeNodeStopsUsing'),{confirmLabel:_t('vis.delete')})) return; await api(`/vision/zones/${id}`,'DELETE'); zones=await api(`/vision/cameras/${camId}/zones`); toast(_t('vis.zoneDeleted')); draw(); }
        if (name==='gSave') { const f=form(); if (!draft?.points.length) return toast(_t('vis.clickOnTheImageTo'),'error'); if (!f.name) return toast(_t('vis.giveTheZoneAName'),'error');
          const body={...f,points:draft.points}; if (draft.id) await api(`/vision/zones/${draft.id}`,'PATCH',body); else await api(`/vision/cameras/${camId}/zones`,'POST',body);
          zones=await api(`/vision/cameras/${camId}/zones`); draft=null; d.querySelector('[name=gname]').value=''; toast(_t('vis.zoneSavedTheEdgeNode')); draw(); }
      } catch (e) { toast(e.message,'error'); }
    }
    d.querySelectorAll('.geo-side > .row [data-action]').forEach(b=>b.onclick=()=>geoAction(b.dataset.action));
    loadMedia(d); draw();
  }

  // ---------- Incidents ----------
  async function loadEvents(){ await loadCat(); const f=state.vEventFilter||(state.vEventFilter={module:'',severity:'',status:'',hours:'168'});
    const q=new URLSearchParams(Object.entries(f).filter(([,v])=>v)); state.vevents=await api(`/vision/events?${q}`); }
  const VERDICT={confirmed:['✓',_t('vis.aiConfirmed'),'approved',_t('vis.thePictureSupportsTheDetection')],doubtful:['?',_t('vis.aiDoubtful'),'pending',_t('vis.thePictureDoesNotClearly')],unclear:['○',_t('vis.aiUnclear'),'inactive',_t('vis.thePictureCannotSettleIt')]};
  const aiVerdict=r=>{ if (!r) return '<span class="muted">—</span>'; const [i,l,tone,tip]=VERDICT[r.verdict]||VERDICT.unclear; return `<span class="pill ${tone}" title="${esc(r.reason||tip)}"><span aria-hidden="true">${i}</span> ${l}</span>`; };
  async function loadVai(){ const d=state.vaiDays||30; [state.vfa,state.vai]=await Promise.all([api(`/vision/analytics/false-alarms?days=${d}`),api(`/vision/ai-review?days=${d}`)]); }
  const MODE_LABEL={off:_t('vis.offNothingIsSentTo'),manual:_t('vis.manualAButtonOnEach'),auto:_t('vis.automaticAlsoNewNonCritical')};
  function aiPanel(){
    if (state.vfa===undefined) { loadVai().then(render).catch(e=>{ state.vfa=null; fail(e); }); return '<div class="panel empty">Analysing closed incidents…</div>'; }
    if (!state.vfa||!state.vai) return '';
    const fa=state.vfa, cfg=state.vai, st=cfg.stats, rows=fa.modules.filter(m=>m.decided>0);
    const advice=m=>{ const r=m.recommendation; if (m.status==='not_enough_data') return `<span class="muted">${esc(m.note)}</span>`; if (!r) return ''; const hint=r.status==='raise'&&m.module==='ppe'?' Set it under Cameras & AI modules → PPE → minimum confidence.':'';
      return `<span class="${r.status==='ok'?'muted':''}">${esc(r.note)}${esc(hint)}</span>`; };
    const noisy=fa.modules.flatMap(m=>(m.byCamera||[]).filter(c=>c.falsePct>=fa.targetPct).map(c=>({...c,module:m.label}))).sort((a,b)=>b.falsePct-a.falsePct).slice(0,5);
    const days=`<select data-vai-days class="tt-filter" aria-label="${_t('vis.period')}">${[[7,_t('vis.last7Days')],[30,_t('vis.last30Days')],[90,_t('vis.last90Days')],[365,_t('vis.lastYear')]].map(([v,l])=>`<option value="${v}" ${(state.vaiDays||30)===v?'selected':''}>${l}</option>`).join('')}</select>`;
    const falsePart=rows.length?simpleTable([_t('vis.module'),_t('vis.closed'),_t('vis.falseAlarms'),_t('vis.advice')],rows.map(m=>`<tr><td>${esc(m.label)}</td><td>${formatNumber(m.decided,0)}</td><td>${m.falsePct==null?'—':`<b>${pct(m.falsePct)}</b> <span class="muted">(${m.falseAlarms})</span>`}</td><td>${advice(m)}</td></tr>`)):'<p class="muted">No closed incidents in this period yet. Resolve incidents or mark false alarms, and advice appears here.</p>';
    const noisyPart=noisy.length?`<h3>${_t('vis.noisiestCameras')}</h3>${simpleTable([_t('vis.camera'),_t('vis.module'),_t('vis.falseAlarms')],noisy.map(c=>`<tr><td>${esc(c.camera)}</td><td>${esc(c.module)}</td><td><b>${pct(c.falsePct)}</b> <span class="muted">${_t('vis.ofClosed',{decided:c.decided})}</span></td></tr>`))}`:'';
    const settingRows=cfg.companies.map(c=>`<tr><td>${esc(c.name)}</td><td>${c.canManage?`<select data-vai-mode="${esc(c.id)}" class="tt-filter" aria-label="${_t('vis.aiSecondOpinionFor',{name:esc(c.name)})}">${cfg.modes.map(m=>`<option value="${m}" ${c.mode===m?'selected':''}>${esc(MODE_LABEL[m])}</option>`).join('')}</select>`:esc(MODE_LABEL[c.mode])}</td></tr>`);
    const agree=st.closedReviewed?`<p>${_t('vis.ofClosedIncidentsTheAi',{closedReviewed:formatNumber(st.closedReviewed,0)})} <b>${st.agreementPct==null?'—':pct(st.agreementPct)}</b> ${_t('vis.ofTheDecisiveOnesConfirmed',{confirmedReal:st.confirmedReal,doubtfulFalse:st.doubtfulFalse})} <b>${st.realIncidentsCalledDoubtful}</b> ${_t('vis.realIncidentCalledDoubtful',{value:st.realIncidentsCalledDoubtful===1?_t('vis.was'):_t('vis.sWere'),value2:st.enoughData?'':_t('vis.tooFewSoFarTo')})}</p>`:'<p class="muted">No AI-reviewed incident has been closed yet, so there is nothing to compare.</p>';
    return `<div class="panel"><div class="spread"><h2>${_t('vis.aiInsightFalseAlarms')}</h2>${days}</div><p class="muted">${_t('vis.basedOnIncidentsPeopleClosed',{targetPct:fa.targetPct})}</p>${falsePart}${noisyPart}</div>
      <div class="panel"><h2>${_t('vis.aiSecondOpinionOnSnapshots')}</h2><p class="muted">${_t('vis.claudeLooksAtAnIncident',{value:cfg.aiEnabled?'':_t('vis.theAiServiceIsNot')})}</p>${simpleTable([_t('vis.company'),_t('vis.mode')],settingRows)}${agree}</div>`;
  }
  function incidentsView(){
    if (!state.vevents) { loadEvents().then(render).catch(fail); return '<div class="panel empty">Loading incidents…</div>'; }
    const f=state.vEventFilter, sel=(key,label,opts,all=`${_t('vis.allS',{value:label.toLowerCase()})}`)=>tool('data-vevent',key,label,opts,f[key],all);
    const filters=`<div class="table-tools">${sel('hours',_t('vis.period'),[['24',_t('vis.last24Hours')],['168',_t('vis.last7Days')],['720',_t('vis.last30Days')],['8760',_t('vis.lastYear')]],'')}${sel('module',_t('vis.module'),[...Object.keys(vc().modules||{}).map(m=>[m,mod(m)]),['system',_t('vis.system')]])}${sel('severity',_t('vis.severity'),[['critical',_t('vis.critical')],['warning',_t('vis.warning')],['info',_t('vis.info')]],_t('vis.allSeverities'))}${sel('status',_t('vis.status'),[['open',_t('vis.open2')],['acknowledged',_t('vis.acknowledged')],['resolved',_t('vis.resolved')],['false_alarm',_t('vis.falseAlarm')]],_t('vis.allStatuses'))}</div>`;
    const table=dataTable('vevents',{rows:state.vevents,search:e=>`${e.cameraName} ${e.type} ${e.zoneName||''} ${eventDetail(e)} ${e.resolutionNote}`,empty:_t('vis.noIncidentsInThisPeriod'),
      columns:[{title:_t('vis.when'),cell:e=>when(e.occurredAt)},{title:_t('vis.incident'),cell:e=>`<a data-action="vEvent" data-id="${esc(e.id)}"><b>${esc(typeLabel(e.type))}</b></a><div class="muted mini">${esc(mod(e.module))} · ${esc(eventDetail(e))}</div>`},
        {title:_t('vis.camera'),cell:e=>`${esc(e.cameraName)}<div class="muted mini">${esc(e.location||'')}</div>`},{title:_t('vis.severity'),cell:e=>sevPill(e.severity)},{title:_t('vis.evidence'),cell:e=>`${e.snapshotMediaId?'📷':''}${e.clipMediaId?' 🎞':''}${e.locked?' 🔒':''}`},
        {title:_t('vis.aiCheck'),cell:e=>aiVerdict(e.review)},{title:_t('vis.status'),cell:e=>`${statusPill(e.status)}${e.retrain?' <span class="pill pending">Retraining</span>':''}`},{title:'',cls:'row',cell:e=>e.status==='open'?btn(_t('vis.acknowledge'),'vAck','secondary small',e.id):''}]});
    const q=new URLSearchParams(Object.entries(f).filter(([,v])=>v));
    return header(_t('vis.visionIncidents'),_t('vis.everyDetectionWithItsPhoto'),`<a class="btn-link" data-vcsv="${esc(q.toString())}">${_t('vis.exportCsv')}</a>`)+filters+`<div class="panel">${table}</div>`+aiPanel();
  }
  function aiBlock(e) {
    const r=e.review, can=e.aiReviewMode!=='off'&&e.snapshotMediaId;
    if (r) return `<div class="notice"><p>${aiVerdict(r)} <span class="muted">${_t('vis.secondOpinionByAdviceOnly',{value:esc(r.model||'AI')})}</span></p><p>${esc(r.reason)}</p>${r.description?`<p class="muted">${_t('vis.scene',{description:esc(r.description)})}</p>`:''}${can?btn(_t('vis.askAgain'),'vAiReview','secondary small',e.id+'|refresh'):''}</div>`;
    if (can) return `<div class="notice"><p>${_t('vis.notReviewedByTheAi')}</p>${btn(_t('vis.aiSecondOpinion'),'vAiReview','secondary small',e.id)}</div>`;
    return e.aiReviewMode==='off'?'<p class="muted">AI second opinion is off for this company (see Vision incidents → AI second opinion on snapshots).</p>':'';
  }
  async function eventDialog(eventId){
    const e=await api(`/vision/events/${eventId}`), cam=camById(e.cameraId), zones=cam?await api(`/vision/cameras/${e.cameraId}/zones`).catch(()=>[]):[];
    const actions=e.edgeActions||{}, rows=[[_t('vis.camera'),`${esc(e.cameraName)} <span class="muted">${esc(e.location||'')}</span>`],[_t('vis.occurred'),`${when(e.occurredAt)} <span class="muted">${_t('vis.receivedAfter',{latencyMs:ms(e.latencyMs)})}</span>`],[_t('vis.module'),esc(mod(e.module))],[_t('vis.severity'),sevPill(e.severity)],[_t('vis.confidence'),e.confidence==null?'—':`${Math.round(e.confidence*100)} %`],
      ...(eventDetail(e)?[[_t('vis.detail'),esc(eventDetail(e))+(e.detail?.surfaceClass?` ${_t('vis.surfaceClass',{surfaceClass:esc(e.detail.surfaceClass)})}`:'')]]:[]),
      ...(e.module==='quality'&&vc().defectInfo?.[e.detail?.defect]?[[_t('vis.whatItIs'),esc(vc().defectInfo[e.detail.defect][1])],[_t('vis.typicalCauses'),esc(vc().defectInfo[e.detail.defect][2])]]:[]),...(Object.keys(actions).length?[[_t('vis.atTheEdge'),esc(Object.entries(actions).map(([k,v])=>`${humanise(k.replace(/Ms$/,''))}: ${typeof v==='number'?`${v} ms`:v}`).join(' · '))]]:[]),
      [_t('vis.status'),`${statusPill(e.status)}${e.acknowledgedBy?` <span class="muted">${_t('vis.acknowledgedBy',{acknowledgedBy:esc(e.acknowledgedBy)})}</span>`:''}${e.resolvedBy?` <span class="muted">${_t('vis.closedBy',{resolvedBy:esc(e.resolvedBy),resolutionNote:esc(e.resolutionNote)})}</span>`:''}`],[_t('vis.evidence'),e.locked?'🔒 Locked – kept permanently':_t('vis.deletedAutomaticallyAfterTheRetention')]];
    const open=!['resolved','false_alarm'].includes(e.status);
    const d=openDialog(`${typeLabel(e.type)} – ${e.cameraName}`,`<div class="vevent">${frame({mediaId:e.snapshotMediaId,boxes:e.boxes,zones:zones.filter(z=>z.id===e.zoneId),cls:'large',alt:_t('vis.snapshotAtDetection')})}
      ${e.clipMediaId?`<video controls playsinline preload="metadata" data-vclip="${esc(e.clipMediaId)}" aria-label="${_t('vis.10SecondClipAroundThe')}"></video>`:''}
      <table class="kv">${rows.map(([k,v])=>`<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>${aiBlock(e)}
      <div class="row">${e.status==='open'?btn(_t('vis.acknowledge'),'vAck','secondary',e.id):''}${open?btn(_t('vis.resolve'),'vResolve','primary',e.id)+btn(_t('vis.falseAlarm'),'vFalse','secondary',e.id):''}${e.locked?(canManage(e.companyId)?btn(_t('vis.unlockEvidence'),'vUnlock','secondary small',e.id):''):btn(_t('vis.lockEvidence'),'vLock','secondary small',e.id)}${e.module==='quality'&&cam?.equipmentId&&raiseTicket?btn(_t('vis.reportBreakdownOnThisMachine'),'vTicket','secondary small',e.id):''}</div></div>`,{wide:true});
    d.querySelectorAll('.vevent [data-action]').forEach(b=>b.onclick=()=>vAction(b.dataset.action,b.dataset.id));
    loadMedia(d);
  }
  const refreshAll=()=>{ state.vo=undefined; state.vevents=undefined; };
  async function closeForm(id,kind){
    openDialog(kind==='resolve'?_t('vis.resolveIncident'):_t('vis.markAsFalseAlarm'),`<div class="form-grid">${field('note',kind==='resolve'?_t('vis.whatWasDone'):_t('vis.whyItIsAFalse'),{type:'textarea',required:true,wide:true,maxlength:1000,help:kind==='resolve'?_t('vis.eGWorkerGivenA'):_t('vis.eGSteamFromThe')})}${kind==='false'?checkboxes('retrain',_t('vis.modelImprovement'),[['yes',_t('vis.sendThisClipForRetraining')]],{values:['yes']}):''}</div>`,
      {submitLabel:kind==='resolve'?_t('vis.resolve'):_t('vis.markFalseAlarm'),onSubmit:async fd=>{ await api(`/vision/events/${id}/${kind==='resolve'?'resolve':'false-alarm'}`,'POST',{note:fd.get('note'),...(kind==='false'?{retrain:fd.getAll('retrain').includes('yes')}:{})}); toast(kind==='resolve'?_t('vis.incidentResolved'):_t('vis.markedAsFalseAlarm')); refreshAll(); render(); }});
  }

  // ---------- Edge nodes and licences ----------
  async function loadNodes(){ await loadCat(); const [nodes,lic]=await Promise.all([api('/vision/nodes'),api('/vision/licences')]); state.vnodes=nodes; state.vlic=lic; state.vnodesLoaded=true; }
  function nodesView(){
    if (!state.vnodesLoaded) { loadNodes().then(render).catch(fail); return '<div class="panel empty">Loading edge nodes…</div>'; }
    const m=n=>n.metrics||{};
    const nodes=dataTable('vnodes',{rows:state.vnodes,search:n=>`${n.name} ${n.hardware} ${plantName(n.plantId)}`,empty:_t('vis.noEdgeNodesYetAdd'),
      columns:[{title:_t('vis.edgeNode'),cell:n=>`<b>${esc(n.name)}</b><div class="muted">${esc(plantName(n.plantId))}${n.hardware?` · ${esc(n.hardware)}`:''}</div>`},{title:_t('vis.status'),cell:n=>`${camStatus(n.status)}${n.lastSeenAt?`<div class="muted mini">${when(n.lastSeenAt)}</div>`:''}`},
        {title:_t('vis.streams'),cell:n=>`${n.cameras} / ${n.maxStreams}`},{title:_t('vis.gpu'),cell:n=>m(n).gpuUtil!=null||m(n).gpuTempC!=null?`${m(n).gpuUtil!=null?`${formatNumber(m(n).gpuUtil,0)} %`:''}${m(n).gpuTempC!=null?` · ${formatNumber(m(n).gpuTempC,0)} °C`:''}`:'—'},
        {title:_t('vis.inferenceP95'),cell:n=>m(n).inferenceMsP95!=null?`<span class="${m(n).inferenceMsP95>25?'pill warning':''}">${_t('vis.ms',{inferenceMsP95:formatNumber(m(n).inferenceMsP95,1)})}</span>`:'—'},{title:_t('vis.disk'),cell:n=>m(n).diskPct!=null?`<span class="${m(n).diskPct>=90?'pill critical':''}">${formatNumber(m(n).diskPct,0)} %</span>`:'—'},
        {title:_t('vis.agent'),cell:n=>`${esc(n.agentVersion||'—')}<div class="muted mini">${_t('vis.keyConfigV',{keyHint:esc(n.keyHint),configVersion:n.configVersion})}</div>`},
        {title:'',cls:'row',cell:n=>`${btn(_t('vis.viewConfig'),'vNodeConfig','secondary small',n.id)}${canManage(n.companyId)?btn(_t('vis.edit'),'vEditNode','secondary small',n.id)+btn(_t('vis.newKey'),'vNodeKey','secondary small',n.id):''}`}]});
    const lic=simpleTable([_t('vis.company'),...Object.keys(vc().modules||{}).map(mod),''],(state.vlic||[]).map(l=>`<tr><td><b>${esc(l.companyName)}</b></td>${l.modules.map(x=>`<td>${x.valid?`${x.used} / ${x.cameras}${x.validUntil?`<div class="muted mini">${_t('vis.until',{validUntil:esc(x.validUntil)})}</div>`:''}`:x.cameras&&!x.valid?_t('vis.expired'):_t('vis.text')}</td>`).join('')}<td>${admin()?btn(_t('vis.edit'),'vLicence','secondary small',l.companyId):''}</td></tr>`));
    return header(_t('vis.edgeNodesLicences'),_t('vis.theGpuPcsThatAnalyse'),anyManage()?btn(_t('vis.addEdgeNode'),'vNewNode','primary'):'')
      +`<div class="panel">${nodes}</div><div class="panel"><h2>${_t('vis.moduleLicences')}</h2><p class="muted">${_t('vis.eachCameraRunningAModule',{value:admin()?'':_t('vis.contactThePlatformAdministratorTo')})}</p>${lic}</div>`
      +`<details class="panel explainer"><summary><b>${_t('vis.howTheEdgeWorks')}</b> <span class="muted">${_t('vis.aQuickGuide')}</span></summary><p>${_t('vis.an')} <b>${_t('vis.edgeNode2')}</b> ${_t('vis.isAnIndustrialPcWith')}</p><p>${_t('vis.everyMinuteTheNodeChecks')} <code>${_t('vis.edge')}</code> ${_t('vis.inTheRepositoryAndGive')}</p></details>`;
  }
  function nodeForm(n){
    const plants=(state.data.plants||[]).filter(p=>canManage(p.company_id));
    openDialog(n?`${_t('vis.edit2',{name:n.name})}`:_t('vis.addEdgeNode'),`<div class="form-grid">${n?'':select('plantId',_t('vis.plant'),plants.map(p=>[p.id,p.name]),{value:plants[0]?.id,required:true})}${field('name',_t('vis.name'),{value:n?.name,required:true,maxlength:80,help:_t('vis.eGEdgePcPress')})}${field('hardware',_t('vis.hardware'),{value:n?.hardware,maxlength:160,help:_t('vis.eGIndustrialPcRtx')})}${field('maxStreams',_t('vis.cameraStreams'),{type:'number',value:n?.maxStreams||16,min:1,max:64,help:_t('vis.16PerNodeAt1080p')})}${n?checkboxes('active',_t('vis.status'),[['yes',_t('vis.activeItsKeyIsAccepted')]],{values:n.active?['yes']:[]}):''}</div>`,
      {onSubmit:async fd=>{ const v=Object.fromEntries(fd); v.maxStreams=Number(v.maxStreams);
        if (n) { v.active=fd.getAll('active').includes('yes'); await api(`/vision/nodes/${n.id}`,'PATCH',v); toast(_t('vis.edgeNodeSaved')); state.vnodesLoaded=false; render(); }
        else { const r=await api('/vision/nodes','POST',v); state.vnodesLoaded=false; render(); setTimeout(()=>showKey(r.node,r.key),50); } }});
  }
  function showKey(node,key){
    const url=location.origin;
    openDialog(`${_t('vis.keyFor',{name:node.name})}`,`<div class="notice warn">${_t('vis.copyThisKeyNowIt')}</div>
      <p><b>${_t('vis.nodeKey')}</b></p><pre class="code-block" id="node-key">${esc(key)}</pre>
      <p><b>${_t('vis.startTheAgentOnThe')}</b></p><pre class="code-block">${_t('vis.platformUrlNodeKeyPython3',{url:esc(url),key:esc(key)})}</pre><p class="muted">${_t('vis.see')} <code>${_t('vis.edgeReadmeMd')}</code> ${_t('vis.forTheFullInstallationNvidia')}</p>
      <p>${btn(_t('vis.copyKey'),'vCopyKey','primary small')}</p>`,{onOpen:d=>{ d.querySelector('[data-action=vCopyKey]').onclick=()=>navigator.clipboard?.writeText(key).then(()=>toast(_t('vis.keyCopied'))).catch(()=>toast(_t('vis.selectTheKeyAndCopy'),'error')); }});
  }
  function licenceForm(companyId){
    const l=state.vlic.find(x=>x.companyId===companyId);
    openDialog(`${_t('vis.visionLicences',{companyName:l.companyName})}`,`<div class="form-grid">${l.modules.map(x=>`${field(`cams.${x.module}`,`${_t('vis.cameras2',{module:mod(x.module)})}`,{type:'number',value:x.cameras,min:0,max:10000,help:`${_t('vis.inUse',{used:x.used})}`})}${field(`until.${x.module}`,_t('vis.validUntil'),{type:'date',value:x.validUntil||''})}`).join('')}</div>`,
      {onSubmit:async fd=>{ for (const x of l.modules) await api(`/vision/licences/${companyId}/${x.module}`,'PUT',{cameras:Number(fd.get(`cams.${x.module}`)||0),validUntil:fd.get(`until.${x.module}`)||null}); toast(_t('vis.licencesSaved')); state.vnodesLoaded=false; state.vcams=undefined; render(); }});
  }

  // ---------- Media, CSV, alarms ----------
  function loadMedia(root=document){
    root.querySelectorAll('img[data-vmedia]:not([src])').forEach(async img=>{ const url=await authImageUrl(`/api/vision/media/${img.dataset.vmedia}`,state.token); if (url) img.src=url; });
    root.querySelectorAll('video[data-vclip]:not([src])').forEach(async v=>{ const url=await authImageUrl(`/api/vision/media/${v.dataset.vclip}`,state.token); if (url) v.src=url; });
  }
  async function downloadCsv(query){
    try { const r=await fetch(`/api/vision/events.csv${query?`?${query}`:''}`,{headers:{authorization:`Bearer ${state.token}`}}); if (!r.ok) throw Error(_t('vis.exportFailed'));
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
    el.className=`${`vision-alarm ${top.severity}`}`;
    el.innerHTML=`<span class="va-icon" aria-hidden="true">${top.type==='fire'||top.type==='smoke'?'🔥':top.module==='intrusion'?'🚫':top.module==='ppe'?'⛑':'⚠'}</span><div class="va-text"><b>${esc(typeLabel(top.type))} – ${esc(top.cameraName)}</b><span>${esc(top.location||'')}${eventDetail(top)?` · ${esc(eventDetail(top))}`:''} · ${when(top.occurredAt)}${list.length>1?` ${_t('vis.more',{value:list.length-1})}`:''}</span></div>
      <button type="button" data-va="open">${_t('vis.view')}</button><button type="button" data-va="ack">${_t('vis.acknowledge')}</button><button type="button" class="va-x" data-va="hide" aria-label="${_t('vis.hideThisAlarm')}">✕</button>`;
    el.querySelector('[data-va=open]').onclick=()=>eventDialog(top.id).catch(fail);
    el.querySelector('[data-va=ack]').onclick=()=>api(`/vision/events/${top.id}/acknowledge`,'POST',{}).then(()=>{ toast(_t('vis.alarmAcknowledged')); refreshAll(); pollAlarms(); if (String(state.page).startsWith('vision')) render(); }).catch(fail);
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
    if (name==='vAiReview') { const [eid,flag]=id.split('|'); toast(_t('vis.askingTheAi')); return api(`/vision/events/${eid}/ai-review`,'POST',flag==='refresh'?{refresh:true}:{}).then(()=>{ state.vevents=undefined; state.vfa=undefined; return eventDialog(eid); }).catch(fail); }
    if (name==='vAck') return api(`/vision/events/${id}/acknowledge`,'POST',{}).then(()=>{ closeDialog(); toast(_t('vis.acknowledged')); refreshAll(); pollAlarms(); render(); }).catch(fail);
    if (name==='vResolve') { closeDialog(); return closeForm(id,'resolve'); }
    if (name==='vFalse') { closeDialog(); return closeForm(id,'false'); }
    if (name==='vLock'||name==='vUnlock') return api(`/vision/events/${id}/lock`,'POST',{locked:name==='vLock'}).then(()=>{ closeDialog(); toast(name==='vLock'?_t('vis.evidenceLocked'):_t('vis.evidenceUnlocked')); refreshAll(); render(); }).catch(fail);
    if (name==='vTicket') { const e=await api(`/vision/events/${id}`), cam=camById(e.cameraId), info=vc().defectInfo?.[e.detail?.defect];
      closeDialog(); return raiseTicket(cam.equipmentId,{title:`${_t('vis.foundBy',{value:info?.[0]||humanise(e.detail?.defect||_t('vis.defect')),cameraName:e.cameraName})}`.slice(0,160),
        symptoms:`${_t('vis.visionQualityInspectionAt',{value:info?.[0]||e.detail?.defect,value2:e.detail?.sizeMm?` (${e.detail.sizeMm} mm)`:'',value3:e.detail?.surfaceClass?`${_t('vis.surfaceClass2',{surfaceClass:e.detail.surfaceClass})}`:'',value4:new Intl.DateTimeFormat(state.user.preferences.locale,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone,timeZoneName:'short'}).format(new Date(e.occurredAt)),value5:info?` ${_t('vis.typicalCauses2',{value:info[2]})}`:''})}`,failureCategory:'tooling'}); }
    if (name==='vNewCamera') return cameraForm();
    if (name==='vEditCamera') return cameraForm(state.vcams.find(c=>c.id===id));
    if (name==='vZones') return zonesDialog(id).catch(fail);
    if (name==='vModule') { const [cid,m]=id.split('|'); return moduleForm(state.vcams.find(c=>c.id===cid),m); }
    if (name==='vAddModule') { const cam=state.vcams.find(c=>c.id===id), free=Object.keys(vc().modules).filter(m=>!cam.modules.some(x=>x.module===m));
      if (!free.length) return toast(_t('vis.allModulesAreAlreadyAssigned'));
      return openDialog(`${_t('vis.addModule3',{name:cam.name})}`,`<div class="form-grid">${select('module',_t('vis.module'),free.map(m=>{ const l=licFor(cam.companyId,m); return [m,`${mod(m)} – ${l?.valid?`${_t('vis.licenceFree',{available:l.available,value:l.available===1?'':'s'})}`:'not licensed'}`]; }),{required:true,wide:true})}</div>`,{submitLabel:_t('vis.next'),onSubmit:async fd=>{ setTimeout(()=>moduleForm(cam,fd.get('module')),30); }}); }
    if (name==='vRemoveModule') { const [cid,m]=id.split('|'); if (!await confirmAction(`${_t('vis.remove2',{m:mod(m)})}`,_t('vis.theCameraStopsRunningThis'),{confirmLabel:_t('vis.remove')})) return;
      return api(`/vision/cameras/${cid}/modules/${m}`,'DELETE').then(()=>{ closeDialog(); toast(_t('vis.moduleRemoved')); state.vcams=undefined; render(); }).catch(fail); }
    if (name==='vNewNode') return nodeForm();
    if (name==='vEditNode') return nodeForm(state.vnodes.find(n=>n.id===id));
    if (name==='vNodeKey') { const n=state.vnodes.find(x=>x.id===id); if (!await confirmAction(`${_t('vis.newKeyFor',{name:n.name})}`,_t('vis.theCurrentKeyStopsWorking'),{confirmLabel:_t('vis.createNewKey')})) return;
      return api(`/vision/nodes/${id}/key`,'POST',{}).then(r=>{ state.vnodesLoaded=false; render(); setTimeout(()=>showKey(r.node,r.key),50); }).catch(fail); }
    if (name==='vNodeConfig') return api(`/vision/nodes/${id}/config`).then(c=>openDialog(`${_t('vis.configuration',{name:c.name})}`,`<p class="muted">${_t('vis.whatTheNodeRunsNow',{configVersion:c.configVersion})}</p><pre class="code-block">${esc(JSON.stringify(c,null,2))}</pre>`,{wide:true})).catch(fail);
    if (name==='vLicence') return licenceForm(id);
    return false;
  }
  function bind(){
    document.querySelectorAll('[data-vtab]').forEach(el=>el.onclick=()=>{ const [k,t]=el.dataset.vtab.split(':'); state[k+'Tab']=t; render(); });
    document.querySelectorAll('[data-vfilter]').forEach(el=>el.onchange=()=>{ state.visionFilter[el.dataset.vfilter]=el.value; state.vo=undefined; render(); });
    document.querySelectorAll('[data-vevent]').forEach(el=>el.onchange=()=>{ state.vEventFilter[el.dataset.vevent]=el.value; state.vevents=undefined; render(); });
    document.querySelectorAll('[data-vai-days]').forEach(el=>el.onchange=()=>{ state.vaiDays=Number(el.value); state.vfa=undefined; render(); });
    document.querySelectorAll('[data-vai-mode]').forEach(el=>el.onchange=()=>api(`/vision/ai-review/${el.dataset.vaiMode}`,'PATCH',{mode:el.value}).then(()=>{ toast(_t('vis.aiSecondOpinionSettingSaved')); state.vfa=undefined; render(); }).catch(fail));
    document.querySelectorAll('[data-vcsv]').forEach(el=>el.onclick=()=>downloadCsv(el.dataset.vcsv==='ppe'?'module=ppe&hours=8760':el.dataset.vcsv));
    // Drag a module card onto a camera's module cell to assign it.
    document.querySelectorAll('.module-card[draggable]').forEach(c=>c.ondragstart=e=>{ e.dataTransfer.setData('text/plain',`${c.dataset.module}|${c.dataset.company}`); e.dataTransfer.effectAllowed='copy'; });
    document.querySelectorAll('[data-drop-camera]').forEach(z=>{
      z.ondragover=e=>{ e.preventDefault(); z.classList.add('over'); }; z.ondragleave=()=>z.classList.remove('over');
      z.ondrop=e=>{ e.preventDefault(); z.classList.remove('over'); const [m,company]=(e.dataTransfer.getData('text/plain')||'').split('|'), cam=state.vcams.find(c=>c.id===z.dataset.dropCamera);
        if (!m||!cam) return; if (cam.companyId!==company) return toast(_t('vis.thatLicenceBelongsToAnother'),'error');
        if (cam.modules.some(x=>x.module===m)) return moduleForm(cam,m);
        api(`/vision/cameras/${cam.id}/modules/${m}`,'PUT',{}).then(updated=>{ toast(`${_t('vis.addedTo',{m:mod(m),name:cam.name})}`); state.vcams=state.vcams.map(c=>c.id===cam.id?updated:c); state.vlic=undefined; loadCameras().then(()=>{ render(); moduleForm(state.vcams.find(c=>c.id===cam.id),m); }); }).catch(fail); };
    });
    loadMedia(); drawBanner();
  }
  const views={vision:overviewView,visionCameras:camerasView,visionIncidents:incidentsView,visionNodes:nodesView};
  const reset=()=>{ state.vfa=undefined; state.vo=undefined; state.vcams=undefined; state.vevents=undefined; state.vnodesLoaded=false; };
  return {views,action:vAction,bind,reset,startAlarms,stopAlarms,canSeeVision,ACTIONS:['vTicket','vGoCameras','vGoIncidents','vEvent','vAck','vResolve','vFalse','vLock','vUnlock','vNewCamera','vEditCamera','vZones','vModule','vAddModule','vRemoveModule','vNewNode','vEditNode','vNodeKey','vNodeConfig','vLicence','vAiReview']};
}
