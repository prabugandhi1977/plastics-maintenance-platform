// Production › Andon in the web workspace: open andon calls (acknowledge, resolve, breakdown ticket), the andon and
// operator-downtime reports, operator stations (tablets and boards) and who each call type notifies and escalates to.
import { esc, btn, simpleTable, field, select, checkboxes, openDialog, confirmAction, toast } from './ui.js';
import { formatNumber, formatDuration, t as _t } from './shared/i18n.js';
import { barChart, statTile, bindCharts } from './charts.js';
import { ANDON_TYPES, ANDON_ICONS, stateLabel, reasonLabel, typeLabel, callStatusLabel, tickTimers, elapsed, minutes } from './shared/andon.js';

export function createAndon(ctx) {
  const { state, api, render, fail, when, header, RANGES, factoryManager, admin } = ctx;
  const companies=()=>state.data.companies||[], plants=()=>state.data.plants||[];
  const plantName=id=>plants().find(p=>p.id===id)?.name||'';
  const machineName=id=>{ const e=(state.data.equipment||[]).find(x=>x.id===id); return e?`${e.asset_tag||''} ${e.make} ${e.model}`.trim():id; };
  const canManageAny=()=>companies().some(c=>factoryManager(c.id));
  const tabs=(list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="andon:${k}">${esc(l)}</button>`).join('')}</div>`;
  const statusPill=c=>`<span class="pill ${c.status==='open'?'critical':c.status==='acknowledged'?'pending':'approved'}">${esc(callStatusLabel(c.status))}</span>${c.level?` <span class="pill warning" title="${esc(_t('andon.escalatedTip'))}">▲ ${c.level}</span>`:''}`;
  const typeCell=x=>`<span class="andon-type ${esc(x)}">${ANDON_ICONS[x]} ${esc(typeLabel(x))}</span>`;

  async function loadCalls(){ state.andonCalls=await api('/andon/calls').catch(e=>{ fail(e); return []; }); }
  async function loadReport(){ const f=state.andonReportFilter||(state.andonReportFilter={range:'7d',plantId:''}); const q=new URLSearchParams({from:new Date(RANGES[f.range][1]()).toISOString(),to:new Date().toISOString(),...(f.plantId?{plantId:f.plantId}:{})}); state.andonReport=await api('/andon/report?'+q).catch(e=>{ fail(e); return null; }); }
  async function loadStations(){ state.andonStations=await api('/operator/stations').catch(e=>{ fail(e); return []; }); }
  async function loadSettings(companyId){ state.andonSettings=await api('/andon/settings'+(companyId?`?companyId=${encodeURIComponent(companyId)}`:'')).catch(e=>{ fail(e); return null; }); }

  function callsTab() {
    if (state.andonCalls===undefined) { loadCalls().then(render); return `<div class="panel empty">${_t('andon.loading')}</div>`; }
    const list=state.andonCalls, open=list.filter(c=>c.status==='open');
    const rows=list.map(c=>`<tr class="${c.status==='open'?'row-alert':''}"><td>${typeCell(c.type)}</td><td><a data-action="equipment" data-id="${esc(c.equipmentId)}"><b>${esc(c.assetTag)}</b></a> <span class="muted">${esc(c.machine)}</span><div class="muted">${esc(plantName(c.plantId))}</div></td>
      <td>${esc(c.note||'—')}${c.operator?`<div class="muted">${esc(_t('andon.byOperator',{name:c.operator}))}</div>`:''}</td><td><b class="timer" data-since="${esc(c.raisedAt)}">${elapsed(c.raisedAt)}</b><div class="muted">${when(c.raisedAt)}</div></td>
      <td>${statusPill(c)}${c.acknowledgedBy?`<div class="muted">${esc(c.acknowledgedBy)} · ${minutes(c.responseMinutes)}</div>`:''}</td>
      <td class="row">${c.status==='open'?btn(_t('andon.acknowledge'),'andonAck','small',c.id):''}${c.type==='maintenance'?(c.ticketId?`<a data-action="ticket" data-id="${esc(c.ticketId)}">${_t('andon.openTicket')}</a>`:btn(_t('andon.toTicket'),'andonTicket','secondary small',c.id)):''}${btn(_t('andon.resolve'),'andonResolve','secondary small',c.id)}</td></tr>`);
    return `<section class="kpis small">${statTile(_t('andon.openCalls'),formatNumber(list.length),{status:list.length?'warning':'good'})}${statTile(_t('andon.waitingForResponse'),formatNumber(open.length),{status:open.length?'critical':'good'})}${statTile(_t('andon.escalated'),formatNumber(list.filter(c=>c.level>0).length),{status:list.some(c=>c.level>0)?'critical':''})}</section>
      <div class="panel"><h2>${_t('andon.activeCalls')}</h2><p class="muted">${_t('andon.activeCallsNote')}</p>${simpleTable([_t('andon.type'),_t('andon.machine'),_t('andon.problem'),_t('andon.waitingFor'),_t('andon.statusCol'),''],rows,_t('andon.noOpenCalls'))}</div>`;
  }

  function reportTab() {
    if (state.andonReport===undefined) { loadReport().then(render); return `<div class="panel empty">${_t('andon.loading')}</div>`; }
    const f=state.andonReportFilter, r=state.andonReport||{total:{},byType:[],byMachine:[],byShift:[],downtime:[],scrap:[]}, tot=r.total;
    const filters=`<div class="table-tools"><select data-filter="andonReport:range" class="tt-filter" aria-label="${_t('andon.period')}">${Object.entries(RANGES).map(([k,[l]])=>`<option value="${k}" ${f.range===k?'selected':''}>${l}</option>`).join('')}</select><select data-filter="andonReport:plantId" class="tt-filter" aria-label="${_t('andon.plant')}"><option value="">${_t('andon.allPlants')}</option>${plants().map(p=>`<option value="${esc(p.id)}" ${f.plantId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>`;
    const tiles=`<section class="kpis">${statTile(_t('andon.calls'),formatNumber(tot.count??0),{note:_t('andon.openNow',{n:tot.open??0})})}${statTile(_t('andon.meanResponse'),minutes(tot.meanResponseMinutes),{note:_t('andon.toAcknowledge')})}${statTile(_t('andon.meanResolve'),minutes(tot.meanResolveMinutes),{note:_t('andon.toResolve')})}${statTile(_t('andon.escalated'),formatNumber(tot.escalated??0),{status:tot.escalated?'warning':'',note:_t('andon.notAnsweredInTime')})}</section>`;
    const stat=(first,rows,label)=>simpleTable([label,_t('andon.calls'),_t('andon.open'),_t('andon.escalated'),_t('andon.meanResponse'),_t('andon.meanResolve')],rows.map(x=>`<tr><td>${first(x)}</td><td>${formatNumber(x.count)}</td><td>${formatNumber(x.open)}</td><td>${formatNumber(x.escalated)}</td><td>${minutes(x.meanResponseMinutes)}</td><td>${minutes(x.meanResolveMinutes)}</td></tr>`),_t('andon.noCallsInPeriod'));
    const charts=`<div class="chart-row">${barChart('chart-andon-type',{title:_t('andon.callsByType'),subtitle:_t('andon.callsByTypeSub'),valueLabel:_t('andon.calls'),rows:r.byType.map(x=>({label:typeLabel(x.type),value:x.count})),formatValue:v=>formatNumber(v),empty:_t('andon.noCallsInPeriod')})}${barChart('chart-andon-downtime',{title:_t('andon.downtimePareto'),subtitle:_t('andon.downtimeParetoSub'),valueLabel:_t('andon.lostTime'),rows:r.downtime.slice(0,10).map(d=>({label:`${stateLabel(d.state)} – ${reasonLabel(d.reason)}`,value:d.minutes})),formatValue:formatDuration,empty:_t('andon.noOperatorReasons')})}</div>`;
    const pareto=simpleTable([_t('andon.reason'),_t('andon.stops'),_t('andon.lostTime'),_t('andon.cumulative')],r.downtime.map(d=>`<tr><td>${esc(stateLabel(d.state))} – ${esc(reasonLabel(d.reason))}</td><td>${formatNumber(d.stops)}</td><td>${formatDuration(d.minutes)}</td><td>${d.cumulativePct==null?'—':formatNumber(d.cumulativePct,1)+' %'}</td></tr>`),_t('andon.noOperatorReasons'));
    const scrap=simpleTable([_t('andon.scrapReason'),_t('andon.entries'),_t('andon.quantity')],r.scrap.map(s=>`<tr><td>${esc(reasonLabel(s.reason))}</td><td>${formatNumber(s.entries)}</td><td>${formatNumber(s.quantity,1)}</td></tr>`),_t('andon.noScrap'));
    return filters+tiles+charts+`<div class="panel"><h2>${_t('andon.byType')}</h2>${stat(x=>typeCell(x.type),r.byType,_t('andon.type'))}</div><div class="panel"><h2>${_t('andon.byMachine')}</h2>${stat(x=>`<a data-action="equipment" data-id="${esc(x.equipmentId)}">${esc(x.assetTag||machineName(x.equipmentId))}</a>`,r.byMachine,_t('andon.machine'))}</div>
      <div class="panel"><h2>${_t('andon.byShift')}</h2>${stat(x=>esc(x.shift),r.byShift,_t('andon.shift'))}</div><div class="panel"><h2>${_t('andon.downtimeReasons')}</h2><p class="muted">${_t('andon.downtimeReasonsNote')}</p>${pareto}</div><div class="panel"><h2>${_t('andon.scrapByReason')}</h2>${scrap}</div>`;
  }

  function stationsTab() {
    if (state.andonStations===undefined) { loadStations().then(render); return `<div class="panel empty">${_t('andon.loading')}</div>`; }
    const rows=state.andonStations.map(s=>`<tr><td><b>${esc(s.name)}</b><div class="muted">${esc(s.kind==='board'?_t('andon.board'):_t('andon.tablet'))} · ${esc(s.plantName)}</div></td><td><code class="station-code">${esc(s.code)}</code></td>
      <td>${s.kind==='board'?esc(_t('andon.wholePlant')):s.equipmentIds.map(id=>esc(machineName(id))).join('<br>')}</td><td>${!s.active?`<span class="pill inactive">${_t('andon.inactive')}</span>`:s.locked?`<span class="pill critical">${_t('andon.locked')}</span>`:`<span class="pill approved">${_t('andon.active')}</span>`}${s.lastLoginAt?`<div class="muted">${_t('andon.lastSignIn',{time:when(s.lastLoginAt)})}</div>`:''}</td>
      <td class="row">${factoryManager(s.companyId)?`${btn(_t('andon.edit'),'stationEdit','secondary small',s.id)}${s.locked?btn(_t('andon.unlock'),'stationUnlock','small',s.id):''}${s.active?btn(_t('andon.signOutTablets'),'stationSignOut','secondary small',s.id):''}`:''}</td></tr>`);
    return `<div class="panel"><h2>${_t('andon.stations')}</h2><p class="muted">${_t('andon.stationsNote')}</p>${simpleTable([_t('andon.station'),_t('andon.code'),_t('andon.machines'),_t('andon.statusCol'),''],rows,_t('andon.noStations'))}</div>`;
  }

  function settingsTab() {
    const own=companies().filter(c=>factoryManager(c.id)||admin()), companyId=state.andonSettingsCompany||own[0]?.id||state.user.companyId;
    if (!companyId) return `<div class="panel empty">${_t('andon.noCompany')}</div>`;
    if (state.andonSettings===undefined||state.andonSettings?.companyId!==companyId) { loadSettings(companyId).then(render); return `<div class="panel empty">${_t('andon.loading')}</div>`; }
    const s=state.andonSettings, edit=factoryManager(companyId), roleName=r=>_t(`andon.role.${r}`);
    const pickCompany=companies().length>1?`<div class="table-tools"><select id="andon-company" class="tt-filter" aria-label="${_t('andon.company')}">${companies().map(c=>`<option value="${esc(c.id)}" ${c.id===companyId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>`:'';
    const rows=ANDON_TYPES.map(type=>{ const c=s.types[type]; return `<tr><td>${typeCell(type)}</td><td>${c.severity==='critical'?`<span class="pill critical">${_t('andon.critical')}</span>`:`<span class="pill warning">${_t('andon.warning')}</span>`}</td><td>${c.notify.map(roleName).join(', ')}</td><td>${c.escalation.length?c.escalation.map((l,i)=>`<div>${_t('andon.levelAfter',{n:i+1,min:l.afterMinutes})}: ${l.roles.map(roleName).join(', ')}</div>`).join(''):'—'}</td><td>${edit?btn(_t('andon.edit'),'andonType','secondary small',type):''}</td></tr>`; });
    return pickCompany+`<div class="panel"><h2>${_t('andon.escalation')}</h2><p class="muted">${_t('andon.escalationNote')}</p>${simpleTable([_t('andon.type'),_t('andon.severity'),_t('andon.notifyFirst'),_t('andon.thenEscalate'),''],rows)}</div>`;
  }

  function andonView() {
    const tab=state.andonTab||'calls', plant=state.andonReportFilter?.plantId||plants()[0]?.id||'';
    const links=`<a class="btn-link" href="/andon/${plant?`?plantId=${encodeURIComponent(plant)}`:''}" target="_blank" rel="noopener">${_t('andon.openBoard')}</a><a class="btn-link secondary" href="/operator/" target="_blank" rel="noopener">${_t('andon.openTablet')}</a>${canManageAny()?btn(_t('andon.newStation'),'stationNew','primary'):''}`;
    header(_t('nav.andon'),_t('andon.pageSub'),links);
    const body={calls:callsTab,report:reportTab,stations:stationsTab,settings:settingsTab}[tab]||callsTab;
    return tabs([['calls',_t('andon.tabCalls')],['report',_t('andon.tabReport')],['stations',_t('andon.tabStations')],['settings',_t('andon.tabSettings')]],tab)+body();
  }

  // ---------- Dialogs ----------
  function stationForm(s) {
    const own=plants().filter(p=>factoryManager(p.company_id)), plantId=s?.plantId||own[0]?.id||'';
    const machinesOf=pid=>(state.data.equipment||[]).filter(e=>e.plant_id===pid&&(state.cat?.productionMachines||['injection','blow','extrusion']).includes(e.machine_type)&&e.status!=='decommissioned').map(e=>[e.id,`${e.asset_tag||''} ${e.make} ${e.model}`.trim()]);
    const body=pid=>`<div class="form-grid">${field('name',_t('andon.stationName'),{value:s?.name||'',required:true,maxlength:80,help:_t('andon.stationNameHelp')})}
      ${s?'':select('plantId',_t('andon.plant'),own.map(p=>[p.id,p.name]),{value:pid,required:true})}${s?'':select('kind',_t('andon.stationKind'),[['tablet',_t('andon.tablet')],['board',_t('andon.board')]],{value:'tablet',required:true})}
      <div class="wide" id="station-machines">${!s||s.kind==='tablet'?checkboxes('equipmentIds',_t('andon.stationMachines'),machinesOf(pid),{values:s?.equipmentIds||[],help:_t('andon.stationMachinesHelp')}):''}</div>
      ${field('pin',s?_t('andon.newPin'):_t('andon.pin'),{type:'password',required:!s,inputmode:'numeric',pattern:'[0-9]{4,8}',autocomplete:'new-password',help:_t('andon.pinHelp')})}</div>`;
    openDialog(s?`${_t('andon.edit')}: ${s.name}`:_t('andon.newStation'),body(plantId),{onSubmit:async fd=>{
      const kind=s?.kind||fd.get('kind'), v={name:fd.get('name'),...(kind==='tablet'?{equipmentIds:fd.getAll('equipmentIds')}:{}),...(fd.get('pin')?{pin:fd.get('pin')}:{})};
      if (kind==='tablet'&&!v.equipmentIds.length) throw Error(_t('andon.pickMachine'));
      const out=s?await api(`/operator/stations/${s.id}`,'PATCH',v):await api('/operator/stations','POST',{...v,plantId:fd.get('plantId'),kind});
      toast(s?_t('andon.stationSaved'):_t('andon.stationCreated',{code:out.code})); state.andonStations=undefined; state.andonTab='stations'; render();
    },onOpen:d=>{ const p=d.querySelector('[name=plantId]'), k=d.querySelector('[name=kind]'); const redo=()=>{ d.querySelector('#station-machines').innerHTML=k?.value==='board'?`<p class="muted">${_t('andon.boardShowsPlant')}</p>`:checkboxes('equipmentIds',_t('andon.stationMachines'),machinesOf(p?.value||plantId),{help:_t('andon.stationMachinesHelp')}); }; if (p) p.onchange=redo; if (k) k.onchange=redo; }});
  }
  function typeForm(type) {
    const s=state.andonSettings, c=s.types[type], roles=s.roles.map(r=>[r,_t(`andon.role.${r}`)]), level=i=>c.escalation[i]||{afterMinutes:'',roles:[]};
    const levels=[0,1,2].map(i=>`<fieldset class="section"><legend>${_t('andon.levelN',{n:i+1})}</legend><div class="form-grid">${field(`after${i}`,_t('andon.afterMinutes'),{type:'number',min:1,max:1440,value:level(i).afterMinutes,unit:'min',help:i?'':_t('andon.afterMinutesHelp')})}${checkboxes(`roles${i}`,_t('andon.alsoNotify'),roles,{values:level(i).roles})}</div></fieldset>`).join('');
    openDialog(`${typeLabel(type)}: ${_t('andon.escalation')}`,`<div class="form-grid">${type==='safety'?`<p class="muted wide">${_t('andon.safetyAlwaysCritical')}</p>`:select('severity',_t('andon.severity'),[['warning',_t('andon.warning')],['critical',_t('andon.critical')]],{value:c.severity,required:true})}${checkboxes('notify',_t('andon.notifyFirst'),roles,{values:c.notify,required:true})}</div>${levels}`,{onSubmit:async fd=>{
      const escalation=[0,1,2].map(i=>({afterMinutes:Number(fd.get(`after${i}`)),roles:fd.getAll(`roles${i}`)})).filter(l=>l.afterMinutes&&l.roles.length);
      state.andonSettings=await api('/andon/settings','PUT',{companyId:s.companyId,types:{[type]:{severity:fd.get('severity')||c.severity,notify:fd.getAll('notify'),escalation}}}); toast(_t('andon.settingsSaved')); render();
    }});
  }
  async function action(name,id) {
    const reload=()=>{ state.andonCalls=undefined; render(); };
    if (name==='andonAck') return api(`/andon/calls/${id}/acknowledge`,'POST',{}).then(()=>{ toast(_t('andon.acknowledged')); reload(); }).catch(fail);
    if (name==='andonResolve') return openDialog(_t('andon.resolveCall'),`<div class="form-grid">${field('resolution',_t('andon.whatWasDone'),{type:'textarea',wide:true,maxlength:500})}</div>`,{submitLabel:_t('andon.resolve'),onSubmit:async fd=>{ await api(`/andon/calls/${id}/resolve`,'POST',{resolution:fd.get('resolution')}); toast(_t('andon.resolvedMsg')); reload(); }});
    if (name==='andonTicket') { if (!await confirmAction(_t('andon.toTicket'),_t('andon.toTicketConfirm'),{confirmLabel:_t('andon.toTicket'),danger:false})) return; return api(`/andon/calls/${id}/ticket`,'POST',{}).then(r=>{ toast(_t('andon.ticketRaised')); state.andonCalls=undefined; return ctx.action('ticket',r.ticketId); }).catch(fail); }
    if (name==='stationNew') return stationForm(null);
    if (name==='stationEdit') return stationForm(state.andonStations.find(s=>s.id===id));
    if (name==='stationUnlock') return api(`/operator/stations/${id}`,'PATCH',{unlock:true}).then(()=>{ toast(_t('andon.unlocked')); state.andonStations=undefined; render(); }).catch(fail);
    if (name==='stationSignOut') { if (!await confirmAction(_t('andon.signOutTablets'),_t('andon.signOutConfirm'),{confirmLabel:_t('andon.signOutTablets')})) return; return api(`/operator/stations/${id}`,'PATCH',{signOut:true}).then(()=>{ toast(_t('andon.signedOut')); state.andonStations=undefined; render(); }).catch(fail); }
    if (name==='andonType') return typeForm(id);
    return false;
  }
  // Live while the calls tab is on screen: timers every second, the list every 20 seconds (paused while a dialog is open).
  let ticker=null, poll=null;
  function bind() {
    clearInterval(ticker); clearInterval(poll);
    const sel=document.getElementById('andon-company'); if (sel) sel.onchange=()=>{ state.andonSettingsCompany=sel.value; state.andonSettings=undefined; render(); };
    if (state.page!=='andon'||state.detail) return;
    bindCharts(); tickTimers();
    ticker=setInterval(()=>tickTimers(),1000);
    if ((state.andonTab||'calls')==='calls') poll=setInterval(async ()=>{ if (state.page!=='andon'||document.getElementById('modal')) return; await loadCalls(); render(); },20000);
  }
  const reset=()=>{ state.andonCalls=undefined; state.andonReport=undefined; state.andonStations=undefined; state.andonSettings=undefined; };
  return {views:{andon:andonView},action,bind,reset,ACTIONS:['andonAck','andonResolve','andonTicket','stationNew','stationEdit','stationUnlock','stationSignOut','andonType']};
}
