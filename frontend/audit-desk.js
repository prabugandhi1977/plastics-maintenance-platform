// Energy (EMS) › Energy audits in the web workspace: the list of audits with SEC, status and savings, the same result blocks as the
// phone app for one audit, the meters that send data, and the company's benchmark / saving-factor / material tables.
import { esc, btn, simpleTable, field, select, openDialog, confirmAction, toast } from './ui.js';
import { formatNumber, formatDateTime, t as _t } from './shared/i18n.js';
import { statTile } from './charts.js';
import { qrSvg } from './qr.js';
import { adviceBox, confidenceBlock, secBlock, cycleBlock, driveBlock, proposalBlock, fmtMs, pumpLabel, clsLabel, statusLabel, money, PUMP_TYPES } from './shared/audit-view.js';

export function createAuditDesk(ctx) {
  const { state, api, render, fail, header, is } = ctx;
  const write=companyId=>is('platform_admin')||(is('customer_admin','plant_manager','maintenance')&&state.user.companyId===companyId);
  const manage=companyId=>is('platform_admin')||(is('customer_admin','plant_manager')&&state.user.companyId===companyId);
  const machineName=id=>{ const e=(state.data.equipment||[]).find(x=>x.id===id); return e?`${e.asset_tag||''} ${e.make} ${e.model}`.trim():id; };
  const tabs=(list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="energyAudits:${k}">${esc(l)}</button>`).join('')}</div>`;
  const nf=formatNumber;

  async function loadList() { state.auditList=await api('/energy-audits').catch(e=>{ fail(e); return []; }); }
  async function loadAudit(id) { state.auditCur=await api('/energy-audits/'+encodeURIComponent(id)).catch(e=>{ fail(e); state.auditId=null; return null; }); }
  async function loadMeters() { state.auditMeters=await api('/energy-audit/meters').catch(e=>{ fail(e); return []; }); }
  async function loadConfig() { const c=state.data.companies||[], id=state.auditCompany||c[0]?.id; state.auditCfg=await api('/energy-audit/config'+(id?`?companyId=${encodeURIComponent(id)}`:'')).catch(e=>{ fail(e); return null; }); }

  // ---------- List ----------
  function listTab() {
    if (state.auditList===undefined) { loadList().then(render); return `<div class="panel empty">${_t('au.loading')}</div>`; }
    const list=state.auditList, done=list.filter(a=>a.secKwhPerKg!=null);
    const tiles=`<section class="kpis small">${statTile(_t('au.audits'),nf(list.length))}${statTile(_t('au.running'),nf(list.filter(a=>a.status==='running').length))}${statTile(_t('au.avgSec'),done.length?`${nf(done.reduce((s,a)=>s+a.secKwhPerKg,0)/done.length,2)} kWh/kg`:'—')}${statTile(_t('au.typicalSavingTotal'),list.some(a=>a.annualMoneyTypical)?list.filter(a=>a.annualMoneyTypical).map(a=>money(a.annualMoneyTypical,a.currency)).slice(0,3).join(' · '):'—')}</section>`;
    const rows=list.map(a=>`<tr class="clickable" data-audit="${esc(a.id)}"><td><a data-audit-open="${esc(a.id)}"><b>${esc(a.title)}</b></a></td><td>${esc(a.machine)}<div class="muted">${esc(a.plantName)}</div></td><td><span class="pill ${a.status==='completed'?'approved':a.status==='running'?'pending':''}">${esc(statusLabel(a.status))}</span></td>
      <td>${a.secKwhPerKg!=null?`<b>${nf(a.secKwhPerKg,2)}</b>${a.secEstimated?` <span class="pill warning">${esc(_t('au.estimated'))}</span>`:''}`:'—'}</td><td>${a.benchmarkPosition?esc(_t('au.pos_'+a.benchmarkPosition)):'—'}</td>
      <td>${a.drive?esc(clsLabel(a.drive)):'—'}</td><td>${a.annualMoneyTypical!=null?`${money(a.annualMoneyTypical,a.currency)} / ${esc(_t('au.yearShort'))}<div class="muted">${nf(a.annualKwhTypical,0)} kWh</div>`:a.proposalStatus==='efficient'?esc(_t('au.noUpgradeCase')):'—'}</td>
      <td>${a.paybackYears!=null?`${nf(a.paybackYears,1)} ${esc(_t('au.yearsShort'))}`:'—'}</td><td>${a.confidence?esc(_t('au.conf_'+a.confidence)):'—'}</td></tr>`);
    return tiles+`<div class="panel">${simpleTable([_t('au.title'),_t('au.machine'),_t('label.status'),_t('au.sec')+' (kWh/kg)',_t('au.benchmark'),_t('au.driveShort'),_t('au.typicalSavingTotal'),_t('au.payback'),_t('au.confidence')],rows,_t('au.noAudits'))}</div>
      ${phoneApp()}`;
  }
  // The phone app lives on this site at /audit/: a link, a QR code to scan with the phone, and how to put it on the home screen.
  const appUrl=()=>location.origin+'/audit/';
  const phoneApp=()=>`<div class="panel phone-app"><div class="phone-app-qr">${qrSvg(appUrl(),150)}</div>
      <div><h2>${esc(_t('au.phoneApp'))}</h2><p>${esc(_t('au.phoneAppText'))}</p><p><code>${esc(appUrl())}</code></p>
      <p><a class="btn-link" href="/audit/" target="_blank" rel="noopener">${esc(_t('au.openPhoneApp'))}</a> ${btn(_t('au.copyLink'),'auditCopyLink','secondary')}</p></div></div>`;

  // ---------- Detail ----------
  function detail() {
    const p=state.auditCur;
    if (!p||p.id!==state.auditId) { loadAudit(state.auditId).then(render); return `<div class="panel empty">${_t('au.loading')}</div>`; }
    const w=write(p.companyId), an=p.analysis;
    header(p.title,`${machineName(p.machine.id)} · ${p.plant.name} · ${statusLabel(p.status)}`,
      `${btn(_t('au.back'),'auditBack','secondary')}${an?btn(_t('au.reportEn'),'auditReportEn','secondary')+btn(_t('au.reportDe'),'auditReportDe','secondary'):''}${w&&p.status!=='cancelled'?btn(_t('au.edit'),'auditEdit','secondary',p.id):''}`);
    const tiles=an?`<section class="kpis small">${statTile(_t('au.sec'),an.sec.kwhPerKg!=null?`${nf(an.sec.kwhPerKg,2)} kWh/kg`:'—',{note:an.data.power!=='measured'?_t('au.estimated'):''})}${statTile(_t('au.cycleTime'),an.cycle?`${nf(an.cycle.cycleTimeS,1)} s`:'—')}${statTile(_t('au.energy'),`${nf(an.energy.kwh,1)} kWh`)}${statTile(_t('au.idleShare'),an.idle?`${nf(an.idle.sharePct,1)} %`:'—')}${statTile(_t('au.confidence'),p.confidence?_t('au.conf_'+p.confidence.level):'—')}</section>`:'';
    return `<div class="audit-desk">${tiles}<div class="panel">${adviceBox(p.advice)}${an?confidenceBlock(p):`<p class="muted">${esc(_t('au.noResultYet'))}</p>`}</div>
      <div class="panel"><h2>${esc(_t('au.tab_sec'))}</h2>${secBlock(p)}</div><div class="panel"><h2>${esc(_t('au.tab_cycles'))}</h2>${cycleBlock(p)}${p.product?`<p>${btn(_t('au.editTemplate'),'auditTemplate','secondary',p.product.id)}</p>`:''}</div>
      <div class="panel"><h2>${esc(_t('au.tab_drive'))}</h2>${driveBlock(p,{editable:w})}</div><div class="panel"><h2>${esc(_t('au.tab_upgrade'))}</h2>${proposalBlock(p,{editable:w})}${w?inputs(p):''}</div>
      ${p.photos.length?`<div class="panel"><h2>${esc(_t('au.photos'))}</h2>${p.photos.map(x=>`<a data-photo="${esc(x.id)}">${esc(x.filename)}</a>`).join(' · ')}</div>`:''}
      ${w&&p.meter?`<div class="panel"><h2>${esc(_t('au.rawData'))}</h2><p class="muted">${esc(_t('au.rawHint',{until:p.keepRawUntil?formatDateTime(p.keepRawUntil,'UTC'):'—'}))}</p>${btn(_t('au.exportRaw'),'auditRaw','secondary',p.id)} ${btn(_t('au.deleteRaw'),'auditRawDelete','secondary',p.id)}</div>`:''}</div>`;
  }
  const inputs=p=>{ const A=p.assumptions; return `<h4>${esc(_t('au.yourInputs'))}</h4><div class="form-grid compact">
    <label class="fld"><span>${esc(_t('au.annualHours'))}</span><input data-assume="annualHours" type="number" step="any" value="${esc(A.annualHours??4000)}"></label>
    <label class="fld"><span>${esc(_t('au.retrofitCost'))} (${esc(p.currency)})</span><input data-assume="retrofitCost" type="number" step="any" value="${esc(A.retrofitCost??'')}"></label>
    <label class="fld"><span>${esc(_t('au.fixedLoad'))}</span><input data-assume="fixedLoadKw" type="number" step="any" value="${esc(A.fixedLoadKw??0)}"></label>
    <label class="fld"><span>${esc(_t('au.years'))}</span><input data-assume="years" type="number" step="1" value="${esc(A.years??5)}"></label>
    ${p.analysis?.cycle?`<label class="fld"><span>${esc(_t('au.cycleOffset'))}</span><input data-assume="cycleOffsetS" type="number" step="0.1" value="${esc(A.cycleOffsetS??0)}"></label>`:''}</div>`; };

  // ---------- Meters ----------
  function metersTab() {
    if (state.auditMeters===undefined) { loadMeters().then(render); return `<div class="panel empty">${_t('au.loading')}</div>`; }
    const rows=state.auditMeters.map(m=>`<tr><td><b>${esc(m.name)}</b></td><td>${esc(machineName(m.equipmentId))}</td><td>${esc(_t('au.kind_'+m.kind))}<div class="muted">${esc(_t('au.transport_'+m.transport))}</div></td><td>${esc(fmtMs(m.nominalIntervalMs))}</td>
      <td>${esc(_t('au.advice_short_'+m.advice.cycleMap))}<div class="muted">${esc(m.advice.power==='estimated'?_t('au.advicePowerEst'):_t('au.advicePowerMeasured'))}</div></td><td>${m.lastSeenAt?esc(formatDateTime(m.lastSeenAt,'UTC')):'—'}${m.clockOffsetMs!=null?`<div class="muted">${esc(_t('au.clockOffset',{s:nf(m.clockOffsetMs/1000,1)}))}</div>`:''}</td></tr>`);
    const canKey=is('platform_admin','customer_admin');
    return `<div class="panel">${simpleTable([_t('au.meterName'),_t('au.machine'),_t('au.meterKind'),_t('au.intervalMs'),_t('au.supports'),_t('au.lastSeenShort')],rows,_t('au.noMeters'))}</div>
      <div class="panel"><h2>${esc(_t('au.sendData'))}</h2><p>${esc(_t('au.sendDataText'))}</p><p class="muted">${esc(_t('au.sendDataLimits'))}</p>${canKey?`<p>${btn(_t('au.makeKey'),'auditKey','secondary')}</p>`:`<p class="muted">${esc(_t('au.keyByAdmin'))}</p>`}${state.auditNewKey?`<div class="notice ok"><b>${esc(_t('au.keyOnce'))}</b><br><code>${esc(state.auditNewKey)}</code></div>`:''}
      <p class="muted">${esc(_t('au.registerInApp'))} <a href="/audit/" target="_blank" rel="noopener">/audit/</a></p></div>
      <div class="panel"><h2>${esc(_t('au.registerTitle'))}</h2><ol class="steps">${[1,2,3,4,5,6].map(i=>`<li>${esc(_t('au.reg'+i))}</li>`).join('')}</ol></div>
      ${phoneApp()}`;
  }

  // ---------- Benchmarks, factors, materials ----------
  function settingsTab() {
    const companies=state.data.companies||[];
    if (state.auditCfg===undefined) { loadConfig().then(render); return `<div class="panel empty">${_t('au.loading')}</div>`; }
    const c=state.auditCfg; if (!c) return '';
    const can=manage(c.companyId);
    const pick=companies.length>1?`<label class="tb-field">${esc(_t('ws.company'))} <select id="audit-company">${companies.map(x=>`<option value="${esc(x.id)}" ${x.id===c.companyId?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>`:'';
    const bench=state.auditBench||(state.auditBench=c.benchmarks.map(b=>({...b})));
    const brow=bench.map((b,i)=>`<tr><td><select data-b="${i}.driveType" ${can?'':'disabled'}>${PUMP_TYPES.filter(x=>x!=='unknown').map(x=>`<option value="${x}" ${b.driveType===x?'selected':''}>${esc(pumpLabel(x))}</option>`).join('')}</select></td><td><input data-b="${i}.material" value="${esc(b.material)}" list="audit-mats" ${can?'':'disabled'}></td>
      <td><input data-b="${i}.low" type="number" step="0.01" value="${esc(b.low)}" ${can?'':'disabled'}></td><td><input data-b="${i}.high" type="number" step="0.01" value="${esc(b.high)}" ${can?'':'disabled'}></td><td><input data-b="${i}.note" value="${esc(b.note)}" ${can?'':'disabled'}></td><td>${can?btn('×','auditBenchRemove','secondary small',String(i)):''}</td></tr>`).join('');
    const fac=Object.entries(c.factors).map(([k,set])=>`<details class="panel"><summary><b>${esc(_t('au.factorSet',{from:clsLabel(k.split('>')[0]),to:_t('au.target_'+k.split('>')[1])}))}</b></summary>${simpleTable([_t('au.category'),_t('au.low')+' %',_t('au.typical')+' %',_t('au.high')+' %'],Object.entries(set).map(([cat,v])=>`<tr><td>${esc(_t('au.cat_'+cat))}</td>${v.map((x,i)=>`<td><input data-f="${esc(k)}|${cat}|${i}" type="number" step="1" min="0" max="95" value="${Math.round(x*100)}" ${can?'':'disabled'} style="width:5em"></td>`).join('')}</tr>`))}</details>`).join('');
    return `${pick}<div class="panel"><h2>${esc(_t('au.benchmarkTitle'))}</h2><p class="muted">${esc(_t('au.benchmarkHelp'))} ${esc(c.defaults.benchmarks?_t('au.benchmarkDefault'):_t('au.benchmarkCustom'))}</p>
      <datalist id="audit-mats">${c.materials.map(m=>`<option value="${esc(m)}">`).join('')}</datalist><div class="table-wrap"><table><thead><tr><th>${esc(_t('au.pumpType'))}</th><th>${esc(_t('au.material'))}</th><th>${esc(_t('au.low'))} kWh/kg</th><th>${esc(_t('au.high'))} kWh/kg</th><th>${esc(_t('au.note'))}</th><th></th></tr></thead><tbody>${brow}</tbody></table></div>
      ${can?`<p>${btn(_t('au.addRow'),'auditBenchAdd','secondary')} ${btn(_t('au.saveBenchmarks'),'auditBenchSave')} ${btn(_t('au.resetDefaults'),'auditBenchReset','secondary')}</p>`:`<p class="muted">${esc(_t('au.managersOnly'))}</p>`}</div>
      <div class="panel"><h2>${esc(_t('au.factorsTitle'))}</h2><p class="muted">${esc(_t('au.factorsHelp'))}</p>${fac}${can?`<p>${btn(_t('au.saveFactors'),'auditFactorsSave')} ${btn(_t('au.resetDefaults'),'auditFactorsReset','secondary')}</p>`:''}</div>
      <div class="panel"><h2>${esc(_t('au.materialsTitle'))}</h2><p class="muted">${esc(_t('au.materialsHelp'))}</p><textarea id="audit-materials" rows="6" ${can?'':'disabled'}>${esc(c.materials.join('\n'))}</textarea>${can?`<p>${btn(_t('au.save'),'auditMaterialsSave')} ${btn(_t('au.resetDefaults'),'auditMaterialsReset','secondary')}</p>`:''}</div>`;
  }

  function view() {
    if (state.auditId) return detail();
    const tab=state.energyAuditsTab||'audits';
    header(_t('nav.energyAudits'),_t('au.pageSub'),`<a class="btn-link secondary" href="/audit/" target="_blank" rel="noopener">${esc(_t('au.openPhoneApp'))}</a>`);
    return tabs([['audits',_t('au.audits')],['meters',_t('au.meters')],['settings',_t('au.settingsTab')]],tab)+(tab==='meters'?metersTab():tab==='settings'?settingsTab():listTab());
  }

  async function action(name,id) {
    const p=state.auditCur;
    const reload=async()=>{ state.auditCur=undefined; await loadAudit(state.auditId); render(); };
    try {
      if (name==='auditBack') { state.auditId=null; state.auditCur=undefined; state.auditList=undefined; return render(); }
      if (name==='auditReportEn'||name==='auditReportDe') return await download(`/energy-audits/${p.id}/report?lang=${name==='auditReportEn'?'en':'de'}`,'report.html',true);
      if (name==='auditRaw') return await download(`/energy-audits/${id}/raw.csv`,'raw.csv',false);
      if (name==='auditRawDelete') { if (!await confirmAction(_t('au.deleteRaw'),_t('au.deleteRawConfirm'),{confirmLabel:_t('au.deleteRaw')})) return; const r=await api(`/energy-audits/${id}/raw`,'DELETE'); toast(_t('au.rawDeleted',{n:r.deleted})); return await reload(); }
      if (name==='auditCopyLink') { await navigator.clipboard.writeText(appUrl()); return toast(_t('au.linkCopied')); }
      if (name==='auditKey') { const m=state.auditMeters||[]; const k=await api('/integration-keys','POST',{name:`Energy ${new Date().toISOString().slice(0,10)}`,scopes:['energy']}); state.auditNewKey=k.key; return render(); }
      if (name==='auditEdit') return editDialog(p);
      if (name==='auditTemplate') return templateDialog(p);
      if (name==='auditBenchAdd') { state.auditBench.push({driveType:'fixed',material:'',low:1,high:2,note:''}); return render(); }
      if (name==='auditBenchRemove') { state.auditBench.splice(Number(id),1); return render(); }
      if (name==='auditBenchReset') { if (!await confirmAction(_t('au.resetDefaults'),_t('au.resetConfirm'),{confirmLabel:_t('au.resetDefaults')})) return; await api('/energy-audit/config','PUT',{companyId:state.auditCfg.companyId,benchmarks:null}); state.auditBench=undefined; state.auditCfg=undefined; return render(); }
      if (name==='auditBenchSave') { await api('/energy-audit/config','PUT',{companyId:state.auditCfg.companyId,benchmarks:state.auditBench.map(b=>({...b,low:Number(b.low),high:Number(b.high)}))}); toast(_t('au.saved')); state.auditBench=undefined; state.auditCfg=undefined; return render(); }
      if (name==='auditFactorsSave') { const f={}; document.querySelectorAll('[data-f]').forEach(el=>{ const [k,cat,i]=el.dataset.f.split('|'); ((f[k]??={})[cat]??=[0,0,0])[Number(i)]=Number(el.value)/100; }); await api('/energy-audit/config','PUT',{companyId:state.auditCfg.companyId,factors:f}); toast(_t('au.saved')); state.auditCfg=undefined; return render(); }
      if (name==='auditFactorsReset') { await api('/energy-audit/config','PUT',{companyId:state.auditCfg.companyId,factors:null}); state.auditCfg=undefined; return render(); }
      if (name==='auditMaterialsSave') { await api('/energy-audit/config','PUT',{companyId:state.auditCfg.companyId,materials:document.getElementById('audit-materials').value.split('\n').map(x=>x.trim()).filter(Boolean)}); toast(_t('au.saved')); state.auditCfg=undefined; return render(); }
      if (name==='auditMaterialsReset') { await api('/energy-audit/config','PUT',{companyId:state.auditCfg.companyId,materials:null}); state.auditCfg=undefined; return render(); }
    } catch(e) { fail(e); }
    return false;
  }
  async function download(path,name,open) {
    const r=await fetch('/api'+path,{headers:{authorization:`Bearer ${state.token}`}}); if (!r.ok) throw Error((await r.json().catch(()=>({}))).error||`HTTP ${r.status}`);
    const url=URL.createObjectURL(await r.blob()); if (open) window.open(url,'_blank'); else { const a=document.createElement('a'); a.href=url; a.download=name; a.click(); } setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  function editDialog(p) {
    const np=p.nameplate, body=`<div class="form-grid">${field('title',_t('au.title'),{value:p.title,required:true,wide:true})}${field('material',_t('au.material'),{value:p.material})}${select('massMode',_t('au.massMode'),[['counts',_t('au.massCounts')],['manual',_t('au.massManual')]],{value:p.massMode,required:true})}
      ${field('manualKg',_t('au.goodKgIn'),{type:'number',value:p.manualKg??'',step:'any'})}${field('manualParts',_t('au.goodPartsIn'),{type:'number',value:p.manualParts??'',step:'any'})}${field('motorKw',_t('au.motorKw'),{type:'number',value:np.motorKw??'',step:'any'})}
      ${select('pumpType',_t('au.pumpType'),PUMP_TYPES.map(x=>[x,pumpLabel(x)]),{value:np.pumpType||'unknown',required:true})}${field('clampTonnes',_t('au.clampTonnes'),{type:'number',value:np.clampTonnes??'',step:'any'})}${field('screwDiameterMm',_t('au.screwMm'),{type:'number',value:np.screwDiameterMm??'',step:'any'})}${field('yearBuilt',_t('au.yearBuilt'),{type:'number',value:np.yearBuilt??''})}
      ${field('notes',_t('au.notes'),{type:'textarea',value:p.notes,wide:true})}</div>`;
    openDialog(_t('au.edit'),body,{onSubmit:async fd=>{ const g=k=>fd.get(k)===''||fd.get(k)==null?null:Number(fd.get(k));
      await api('/energy-audits/'+p.id,'PATCH',{title:fd.get('title'),material:fd.get('material'),notes:fd.get('notes'),massMode:fd.get('massMode'),manualKg:g('manualKg'),manualParts:g('manualParts'),nameplate:{motorKw:g('motorKw'),pumpType:fd.get('pumpType'),clampTonnes:g('clampTonnes'),screwDiameterMm:g('screwDiameterMm'),yearBuilt:g('yearBuilt')}});
      state.auditCur=undefined; render(); }});
  }
  async function templateDialog(p) {
    const tm=await api('/energy-audit/templates/'+p.product.id).catch(()=>({phases:[]}));
    const text=tm.phases.map(x=>`${x.name}; ${x.seconds}${x.category?`; ${x.category}`:''}`).join('\n');
    openDialog(_t('au.editTemplate'),`<p class="muted">${esc(_t('au.templateHelp'))}</p><p class="muted">${esc(_t('au.templateLinesHint'))}</p><div class="form-grid">${field('lines',_t('au.phase'),{type:'textarea',value:text,wide:true,rows:12})}</div>`,{onSubmit:async fd=>{
      const phases=String(fd.get('lines')).split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{ const [name,sec,cat]=l.split(/\s*;\s*/); return {name,seconds:Number(String(sec).replace(',','.')),...(cat?{category:cat}:{})}; });
      await api('/energy-audit/templates/'+p.product.id,'PUT',{name:tm.name||p.product.partNumber,phases}); state.auditCur=undefined; render(); }});
  }
  function bind() {
    if (state.page!=='energyAudits') return;
    document.querySelectorAll('[data-audit-open]').forEach(a=>a.onclick=e=>{ e.stopPropagation(); state.auditId=a.dataset.auditOpen; state.auditCur=undefined; render(); window.scrollTo(0,0); });
    document.querySelectorAll('tr[data-audit]').forEach(tr=>tr.onclick=()=>{ state.auditId=tr.dataset.audit; state.auditCur=undefined; render(); window.scrollTo(0,0); });
    const patch=async body=>{ try { await api('/energy-audits/'+state.auditId,'PATCH',body); state.auditCur=undefined; render(); } catch(e) { fail(e); } };
    document.querySelectorAll('[data-assume]').forEach(el=>el.onchange=()=>patch({assumptions:{[el.dataset.assume]:el.tagName==='SELECT'?el.value:el.value===''?null:Number(el.value)}}));
    document.querySelectorAll('[data-target]').forEach(b=>b.onclick=()=>patch({assumptions:{target:b.dataset.target}}));
    document.querySelectorAll('[data-photo]').forEach(a=>a.onclick=()=>download('/attachments/'+a.dataset.photo,'photo.jpg',true).catch(fail));
    document.querySelectorAll('[data-b]').forEach(el=>el.onchange=()=>{ const [i,k]=el.dataset.b.split('.'); state.auditBench[Number(i)][k]=el.value; });
    const sel=document.getElementById('audit-company'); if (sel) sel.onchange=()=>{ state.auditCompany=sel.value; state.auditCfg=undefined; state.auditBench=undefined; render(); };
  }
  const reset=()=>{ state.auditList=undefined; state.auditCur=undefined; state.auditMeters=undefined; state.auditCfg=undefined; state.auditBench=undefined; };
  return {views:{energyAudits:view},action,bind,reset,ACTIONS:['auditCopyLink','auditBack','auditReportEn','auditReportDe','auditRaw','auditRawDelete','auditKey','auditEdit','auditTemplate','auditBenchAdd','auditBenchRemove','auditBenchReset','auditBenchSave','auditFactorsSave','auditFactorsReset','auditMaterialsSave','auditMaterialsReset']};
}
