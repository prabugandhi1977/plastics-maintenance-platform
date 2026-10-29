// Energy audit app: phone-first, installable. An engineer at an injection moulding machine creates an audit, sees which data path
// the meter supports before starting, runs a test, and reads SEC, cycle map, drive and the upgrade case. Own page (like the operator
// tablet) because the work is a long form + a live test run + large charts, not a ticket. Signs in with a person's account.
import { t, setLocale, formatNumber as nf, formatDateTime } from '/shared/i18n.js';
import { esc, adviceBox, confidenceBlock, secBlock, cycleBlock, driveBlock, proposalBlock, fmtMs, pumpLabel, clsLabel, PUMP_TYPES, statusLabel, money } from '/shared/audit-view.js';
import { decodeNotification, bleSupported, uuidOf } from '/shared/ble-decode.js';
import { helpView } from '/audit/help.js';

const $=s=>document.querySelector(s);
const store={get:(a,k)=>{try{return window[a].getItem(k)}catch{return null}},set:(a,k,v)=>{try{window[a].setItem(k,v)}catch{}},del:(a,k)=>{try{window[a].removeItem(k)}catch{}}};
const S={token:store.get('sessionStorage','mc_audit_token'),user:null,view:'list',tab:'overview',audits:[],audit:null,config:null,equipment:[],products:[],plants:[],meters:[],error:'',notice:'',busy:false,form:null,meter:null,tmpl:null,online:navigator.onLine,live:null,ble:null};
let timer=null;

async function api(path,method='GET',body) {
  const r=await fetch('/api'+path,{method,headers:{'content-type':'application/json',...(S.token?{authorization:`Bearer ${S.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if (r.status===401&&S.token&&!path.endsWith('/login')) { signOut(t('au.sessionEnded')); throw Object.assign(Error(t('au.sessionEnded')),{quiet:true}); }
  if (!r.ok) throw Object.assign(Error(data.error||`HTTP ${r.status}`),{status:r.status,data});
  return data;
}
const fail=e=>{ if (e.quiet) return; S.error=e.message==='Failed to fetch'?t('au.offline'):e.message; S.busy=false; render(); window.scrollTo(0,0); };
const ok=m=>{ S.notice=m; S.error=''; };
function signOut(msg='') { store.del('sessionStorage','mc_audit_token'); Object.assign(S,{token:null,user:null,error:msg,view:'list',audit:null}); clearInterval(timer); render(); }
const canWrite=()=>['platform_admin','customer_admin','plant_manager','maintenance'].includes(S.user?.role);
const canManage=()=>['platform_admin','customer_admin','plant_manager'].includes(S.user?.role);
const machineName=e=>`${e.asset_tag||''} ${e.make} ${e.model}`.trim();
const num=v=>v===''||v==null?null:Number(v);
const field=(name,label,value='',attrs='')=>`<label class="f">${esc(label)}<input name="${name}" value="${esc(value??'')}" ${attrs}></label>`;
const sel=(name,label,options,value='',attrs='')=>`<label class="f">${esc(label)}<select name="${name}" ${attrs}>${options.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
const localInput=ms=>{ const d=new Date(ms); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); };

// ---------- Start ----------
async function start() {
  try { const me=await api('/me'); S.user=me; setLocale(me.preferences.locale); } catch(e) { return fail(e); }
  try { [S.equipment,S.products,S.plants,S.config]=await Promise.all([api('/equipment').catch(()=>[]),api('/products').catch(()=>[]),api('/plants').catch(()=>[]),api('/energy-audit/config').catch(()=>null)]); } catch(e) { return fail(e); }
  S.equipment=S.equipment.filter(e=>e.machine_type==='injection');
  await loadList();
}
async function loadList() { try { S.audits=await api('/energy-audits'); } catch(e) { return fail(e); } S.view='list'; render(); }
async function openAudit(id,tab='overview') {
  try { S.audit=await api('/energy-audits/'+encodeURIComponent(id)); } catch(e) { return fail(e); }
  S.view='audit'; S.tab=tab; S.error=''; S.live=null; render(); schedule();
}
function schedule() {
  clearInterval(timer); if (S.view!=='audit'||S.audit?.status!=='running') return;
  timer=setInterval(async()=>{ if (S.view!=='audit'||S.audit?.status!=='running'||document.querySelector('input:focus,textarea:focus,select:focus')) return;
    try { S.audit=await api('/energy-audits/'+S.audit.id); if (S.audit.meter) S.live=await api(`/energy-audit/meters/${S.audit.meter.id}/live`); } catch {} if (S.view==='audit') render(); },5000);
}

// ---------- Shell ----------
function shell(body,{back=null,title=''}={}) {
  return `<header class="top">${back?`<button type="button" class="icon" data-act="${back}" aria-label="${esc(t('au.back'))}">‹</button>`:''}<div class="ttl"><div class="brand">Mould<span>Care</span> <small>${esc(t('au.appName'))}</small></div>${title?`<div class="sub">${esc(title)}</div>`:''}</div>
    <div class="tools"><button type="button" class="icon" data-act="help" aria-label="${esc(t('au.help'))}">?</button><button type="button" class="icon" data-act="signout" aria-label="${esc(t('au.signOut'))}">⎋</button></div></header>
    <main class="content">${S.error?`<p class="notice error" role="alert">${esc(S.error)}</p>`:''}${S.notice?`<p class="notice ok" role="status">${esc(S.notice)}</p>`:''}${!S.online?`<p class="notice warn">${esc(t('au.offline'))}</p>`:''}${body}</main>`;
}
const navBar=()=>`<nav class="bottom" aria-label="${esc(t('au.nav'))}">${[['list',t('au.audits')],['meters',t('au.meters')],['settings',t('au.settings')]].map(([k,l])=>`<button type="button" class="${S.view===k||(k==='list'&&['audit','new'].includes(S.view))?'on':''}" data-act="nav:${k}">${esc(l)}</button>`).join('')}</nav>`;

function loginView() {
  $('#app').innerHTML=`<main class="login"><div class="brand big">Mould<span>Care</span> <small>${esc(t('au.appName'))}</small></div><p class="muted">${esc(t('au.loginIntro'))}</p>${S.error?`<p class="notice error" role="alert">${esc(S.error)}</p>`:''}
    <form id="login" class="card"><label class="f">${esc(t('au.email'))}<input name="email" type="email" autocomplete="username" required></label><label class="f">${esc(t('au.password'))}<input name="password" type="password" autocomplete="current-password" required></label><button class="primary full">${esc(t('au.signIn'))}</button></form></main>`;
  $('#login').onsubmit=async e=>{ e.preventDefault(); const f=new FormData(e.target); try { const r=await api('/auth/login','POST',{email:String(f.get('email')).trim(),password:String(f.get('password'))}); S.token=r.token; store.set('sessionStorage','mc_audit_token',r.token); S.error=''; await start(); } catch(err) { fail(err); } };
}

// ---------- List ----------
const secLine=a=>a.secKwhPerKg!=null?`<b>${nf(a.secKwhPerKg,2)}</b> kWh/kg${a.secEstimated?` <span class="ac-est">${esc(t('au.estimated'))}</span>`:''}`:`<span class="muted">${esc(t('au.noSecYet'))}</span>`;
function listView() {
  const cards=S.audits.map(a=>`<button type="button" class="card auditcard" data-open="${esc(a.id)}"><div class="row"><b>${esc(a.title)}</b><span class="badge ${esc(a.status)}">${esc(statusLabel(a.status))}</span></div><div class="muted">${esc(a.machine)} · ${esc(a.plantName)}</div>
    <div class="row"><span>${secLine(a)}</span>${a.benchmarkPosition?`<span class="chip ${a.benchmarkPosition}">${esc(t('au.pos_'+a.benchmarkPosition))}</span>`:''}</div>
    ${a.annualMoneyTypical!=null?`<div class="muted">${esc(t('au.typicalSaving',{v:money(a.annualMoneyTypical,a.currency)}))}</div>`:a.proposalStatus==='efficient'?`<div class="muted">${esc(t('au.noUpgradeCase'))}</div>`:''}</button>`).join('');
  return shell(`${canWrite()?`<button type="button" class="primary full" data-act="new">${esc(t('au.newAudit'))}</button>`:''}<h2 class="section">${esc(t('au.audits'))}</h2>${cards||`<p class="empty">${esc(t('au.noAudits'))}</p>`}`)+navBar();
}

// ---------- New audit ----------
const adviceFor=(measures,ms,observed)=>{ const r=ms<=250?'fine':ms<=2000?'good':ms<=5000?'coarse':'interval'; return {measures,intervalMs:ms,resolution:r,sec:true,cycleMap:r==='fine'||r==='good'?'yes':r==='coarse'?'limited':'no',power:measures==='current'?'estimated':'measured',phaseEdgesS:ms<=2000?Math.max(ms*2,200)/1000:null,observed:!!observed}; };
async function newView() {
  const f=S.form||(S.form={equipmentId:S.equipment[0]?.id||'',productId:'',material:'',meterId:'',mode:'now',mass:'counts',nameplate:{},from:localInput(Date.now()-3600000),to:localInput(Date.now()),title:'',notes:'',manualKg:'',manualParts:''});
  const eq=S.equipment.find(e=>e.id===f.equipmentId), prods=S.products.filter(p=>!eq||p.company_id===eq.company_id), meters=S.meters.filter(m=>m.equipmentId===f.equipmentId&&m.active);
  const meter=meters.find(m=>m.id===f.meterId), adv=meter?meter.advice:adviceFor('energy',900000);
  const np=f.nameplate, mats=S.config?.materials||[];
  const html=shell(`<form id="newform" class="stack"><h2 class="section">${esc(t('au.secMachine'))}</h2>
    ${sel('equipmentId',t('au.machine'),S.equipment.map(e=>[e.id,machineName(e)]),f.equipmentId)}
    ${sel('productId',t('au.productMould'),[['',t('au.none')],...prods.map(p=>[p.id,`${p.part_number} · ${p.name}${p.part_weight_g?` · ${p.part_weight_g} g`:''}${p.ideal_cycle_s?` · ${p.ideal_cycle_s} s`:''}`])],f.productId)}
    <label class="f">${esc(t('au.material'))}<input name="material" value="${esc(f.material)}" list="mats" autocomplete="off" placeholder="${esc(t('au.materialPh'))}"><datalist id="mats">${mats.map(m=>`<option value="${esc(m)}">`).join('')}</datalist></label>
    <h2 class="section">${esc(t('au.secMeter'))}</h2>
    ${sel('meterId',t('au.meterUsed'),[['',t('au.noMeterReadings')],...meters.map(m=>[m.id,`${m.name} · ${fmtMs(m.nominalIntervalMs)}`])],f.meterId)}
    ${adviceBox(adv)}<button type="button" class="secondary" data-act="newmeter">${esc(t('au.registerMeter'))}</button>
    <h2 class="section">${esc(t('au.secNameplate'))}</h2><div class="grid2">
    ${field('motorKw',t('au.motorKw'),np.motorKw,'type="number" step="any" inputmode="decimal"')}${sel('pumpType',t('au.pumpType'),PUMP_TYPES.map(x=>[x,pumpLabel(x)]),np.pumpType||'unknown')}
    ${field('clampTonnes',t('au.clampTonnes'),np.clampTonnes,'type="number" step="any" inputmode="decimal"')}${field('screwDiameterMm',t('au.screwMm'),np.screwDiameterMm,'type="number" step="any" inputmode="decimal"')}${field('yearBuilt',t('au.yearBuilt'),np.yearBuilt,'type="number" inputmode="numeric"')}</div>
    <p class="muted">${esc(t('au.pumpHint'))}</p>
    <h2 class="section">${esc(t('au.secTest'))}</h2>
    <div class="seg" role="radiogroup"><button type="button" class="${f.mode==='now'?'on':''}" data-mode="now">${esc(t('au.startRun'))}</button><button type="button" class="${f.mode==='past'?'on':''}" data-mode="past">${esc(t('au.pastPeriod'))}</button></div>
    ${f.mode==='past'?`<div class="grid2"><label class="f">${esc(t('au.from'))}<input type="datetime-local" name="from" value="${esc(f.from)}"></label><label class="f">${esc(t('au.to'))}<input type="datetime-local" name="to" value="${esc(f.to)}"></label></div>`:`<p class="muted">${esc(t('au.startRunHint'))}</p>`}
    <div class="seg"><button type="button" class="${f.mass==='counts'?'on':''}" data-mass="counts">${esc(t('au.massCounts'))}</button><button type="button" class="${f.mass==='manual'?'on':''}" data-mass="manual">${esc(t('au.massManual'))}</button></div>
    ${f.mass==='manual'?`<div class="grid2">${field('manualKg',t('au.goodKgIn'),f.manualKg,'type="number" step="any" inputmode="decimal"')}${field('manualParts',t('au.goodPartsIn'),f.manualParts,'type="number" step="any" inputmode="numeric"')}</div>`:`<p class="muted">${esc(t('au.massCountsHint'))}</p>`}
    ${field('title',t('au.title'),f.title,'maxlength="120"')}<label class="f">${esc(t('au.notes'))}<textarea name="notes" maxlength="4000">${esc(f.notes)}</textarea></label>
    <button class="primary full" ${S.busy?'disabled':''}>${esc(f.mode==='now'?t('au.createAndStart'):t('au.createAndAnalyse'))}</button></form>`,{back:'nav:list',title:t('au.newAudit')})+navBar();
  $('#app').innerHTML=html;
  const form=$('#newform'), read=()=>{ const d=new FormData(form); f.equipmentId=d.get('equipmentId'); f.productId=d.get('productId'); f.material=d.get('material'); f.meterId=d.get('meterId'); f.title=d.get('title'); f.notes=d.get('notes');
    f.nameplate={motorKw:num(d.get('motorKw')),pumpType:d.get('pumpType'),clampTonnes:num(d.get('clampTonnes')),screwDiameterMm:num(d.get('screwDiameterMm')),yearBuilt:num(d.get('yearBuilt'))}; if (f.mode==='past') { f.from=d.get('from'); f.to=d.get('to'); } if (f.mass==='manual') { f.manualKg=d.get('manualKg'); f.manualParts=d.get('manualParts'); } };
  form.querySelectorAll('[name=equipmentId]').forEach(el=>el.onchange=async()=>{ read(); f.meterId=''; f.productId=''; S.meters=await api('/energy-audit/meters?equipmentId='+encodeURIComponent(f.equipmentId)).catch(()=>[]); newView(); });
  form.querySelectorAll('[name=meterId],[name=productId]').forEach(el=>el.onchange=()=>{ read(); newView(); });
  form.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{ read(); f.mode=b.dataset.mode; newView(); });
  form.querySelectorAll('[data-mass]').forEach(b=>b.onclick=()=>{ read(); f.mass=b.dataset.mass; newView(); });
  $('[data-act=newmeter]').onclick=()=>{ read(); S.meter={equipmentId:f.equipmentId,returnTo:'new'}; };
  form.onsubmit=async e=>{ e.preventDefault(); read(); S.busy=true; S.error='';
    const eqn=eq?machineName(eq):'', prod=prods.find(p=>p.id===f.productId);
    const body={equipmentId:f.equipmentId,productId:f.productId||null,meterId:f.meterId||null,material:f.material,massMode:f.mass,nameplate:Object.fromEntries(Object.entries(f.nameplate).filter(([,v])=>v!=null&&v!=='')),notes:f.notes,title:f.title||`${eqn}${prod?' · '+prod.part_number:''}`,
      ...(f.mass==='manual'?{manualKg:num(f.manualKg),manualParts:num(f.manualParts)}:{}),...(f.mode==='past'?{periodStart:new Date(f.from).toISOString(),periodEnd:new Date(f.to).toISOString()}:{})};
    try { let a=await api('/energy-audits','POST',body); a=f.mode==='now'?await api(`/energy-audits/${a.id}/start`,'POST',{}):await api(`/energy-audits/${a.id}/complete`,'POST',{}); S.form=null; S.busy=false; S.audit=a; S.view='audit'; S.tab=f.mode==='now'?'overview':'sec'; ok(t('au.created')); render(); schedule(); } catch(err) { fail(err); } };
  bind();
}
async function newViewInit() { S.meters=await api('/energy-audit/meters?'+new URLSearchParams(S.form?.equipmentId||S.equipment[0]?.id?{equipmentId:S.form?.equipmentId||S.equipment[0].id}:{})).catch(()=>[]); }

// ---------- Audit detail ----------
const TABS=['overview','sec','cycles','drive','upgrade','setup','report'];
function elapsed(a) { if (!a.periodStart) return ''; const ms=(a.periodEnd?Date.parse(a.periodEnd):Date.now())-Date.parse(a.periodStart); const m=Math.floor(ms/60000), s=Math.floor(ms/1000)%60; return `${m}:${String(s).padStart(2,'0')}`; }
function auditView() {
  const a=S.audit, an=a.analysis, tabs=`<div class="tabs" role="tablist">${TABS.map(k=>`<button type="button" role="tab" class="${S.tab===k?'on':''}" aria-selected="${S.tab===k}" data-tab="${k}">${esc(t('au.tab_'+k))}</button>`).join('')}</div>`;
  let body='';
  if (S.tab==='overview') body=overview(a);
  else if (S.tab==='sec') body=secBlock(a);
  else if (S.tab==='cycles') body=cyclesTab(a);
  else if (S.tab==='drive') body=`${driveBlock(a,{editable:canWrite()})}`;
  else if (S.tab==='upgrade') body=upgradeTab(a);
  else if (S.tab==='setup') body=setupTab(a);
  else body=reportTab(a);
  return shell(`<div class="audit-head"><b>${esc(a.title)}</b><div class="muted">${esc(`${a.machine.assetTag||''} ${a.machine.make} ${a.machine.model}`.trim())} · ${esc(a.plant.name)}</div><span class="badge ${esc(a.status)}">${esc(statusLabel(a.status))}</span></div>${tabs}<section class="pane">${body}</section>`,{back:'nav:list',title:a.title})+navBar();
}
function overview(a) {
  const an=a.analysis, run=a.status==='running';
  const ctl=!canWrite()?'':a.status==='draft'?`<button type="button" class="primary full" data-act="start">${esc(t('au.startRun'))}</button>${a.periodStart&&a.periodEnd?`<button type="button" class="secondary full" data-act="complete">${esc(t('au.analysePeriod'))}</button>`:''}`:run?`<div class="runbox"><div class="big" aria-live="polite">${esc(t('au.running'))} <b>${elapsed(a)}</b></div>${a.meter?`<p class="muted">${S.live?esc(t('au.liveLine',{n:S.live.samplesLastMinute,kw:S.live.last.length?nf(S.live.last.at(-1).kw??0,1):'—'})):esc(t('au.waitingData'))}</p>`:`<p class="muted">${esc(t('au.liveNoMeter'))}</p>`}</div><button type="button" class="danger full" data-act="stop">${esc(t('au.stopRun'))}</button>`:'';
  const sum=an?`<div class="ac-tiles"><div class="ac-tile"><small>${esc(t('au.sec'))}</small><b>${an.sec.kwhPerKg!=null?nf(an.sec.kwhPerKg,2):'—'}</b><span class="muted">kWh/kg${an.data.power!=='measured'?' · '+esc(t('au.estimated')):''}</span></div>
    <div class="ac-tile"><small>${esc(t('au.cycleTime'))}</small><b>${an.cycle?nf(an.cycle.cycleTimeS,1)+' s':'—'}</b></div><div class="ac-tile"><small>${esc(t('au.energy'))}</small><b>${nf(an.energy.kwh,1)} kWh</b></div></div>`:'';
  return `${adviceBox(a.advice)}${a.frozen&&a.status==='completed'?'':''}${ctl}${sum}${an?confidenceBlock(a):''}${a.meter?`<p class="muted">${esc(t('au.meterLine',{name:a.meter.name,off:a.meter.clockOffsetMs!=null?nf(a.meter.clockOffsetMs/1000,1):'—'}).replace(/ · [^·]*— s$/,''))}</p>`:`<p class="muted">${esc(a.meterNote||t('au.noMeterReadings'))}</p>`}`;
}
function cyclesTab(a) {
  const tm=a.template, offs=a.assumptions.cycleOffsetS??0;
  return `${cycleBlock(a)}<h3>${esc(t('au.template'))}</h3>${tm?.phases?.length?`<p class="muted">${esc(t('au.templateLine',{n:tm.phases.length,s:nf(tm.phases.reduce((s,p)=>s+p.seconds,0),1)}))}</p>`:`<p class="muted">${esc(t('au.templateNone'))}</p>`}
    ${a.product&&canWrite()?`<button type="button" class="secondary" data-act="template">${esc(t('au.editTemplate'))}</button>`:`<p class="muted">${esc(t('au.templateNeedsProduct'))}</p>`}
    ${canWrite()&&a.analysis?.cycle?`<label class="f">${esc(t('au.cycleOffset'))}<input data-assume="cycleOffsetS" type="number" step="0.1" min="-60" max="60" value="${esc(offs)}"></label><p class="muted">${esc(t('au.cycleOffsetHint'))}</p>`:''}`;
}
function upgradeTab(a) {
  const A=a.assumptions, w=canWrite();
  return `${proposalBlock(a,{editable:w})}${w?`<h4>${esc(t('au.yourInputs'))}</h4><div class="grid2">
    <label class="f">${esc(t('au.annualHours'))}<input data-assume="annualHours" type="number" step="any" inputmode="decimal" value="${esc(A.annualHours??4000)}"></label>
    <label class="f">${esc(t('au.retrofitCost'))} (${esc(a.currency)})<input data-assume="retrofitCost" type="number" step="any" inputmode="decimal" value="${esc(A.retrofitCost??'')}"></label>
    <label class="f">${esc(t('au.fixedLoad'))}<input data-assume="fixedLoadKw" type="number" step="any" inputmode="decimal" value="${esc(A.fixedLoadKw??0)}"></label>
    <label class="f">${esc(t('au.years'))}<input data-assume="years" type="number" step="1" inputmode="numeric" value="${esc(A.years??5)}"></label></div><p class="muted">${esc(t('au.fixedLoadHint'))}</p>`:''}`;
}
function setupTab(a) {
  const np=a.nameplate, w=canWrite(), A=a.assumptions, mats=S.config?.materials||[];
  const photos=a.photos.map(p=>`<a class="photo" data-photo="${esc(p.id)}">${esc(p.filename)}</a>`).join(' ');
  return `<form id="setupform" class="stack"><fieldset ${w?'':'disabled'}>${field('title',t('au.title'),a.title)}
    <label class="f">${esc(t('au.material'))}<input name="material" value="${esc(a.material)}" list="mats" autocomplete="off"><datalist id="mats">${mats.map(m=>`<option value="${esc(m)}">`).join('')}</datalist></label>
    <div class="grid2">${field('motorKw',t('au.motorKw'),np.motorKw,'type="number" step="any"')}${sel('pumpType',t('au.pumpType'),PUMP_TYPES.map(x=>[x,pumpLabel(x)]),np.pumpType||'unknown')}${field('clampTonnes',t('au.clampTonnes'),np.clampTonnes,'type="number" step="any"')}${field('screwDiameterMm',t('au.screwMm'),np.screwDiameterMm,'type="number" step="any"')}${field('yearBuilt',t('au.yearBuilt'),np.yearBuilt,'type="number"')}</div>
    ${sel('massMode',t('au.massMode'),[['counts',t('au.massCounts')],['manual',t('au.massManual')]],a.massMode)}<div class="grid2">${field('manualKg',t('au.goodKgIn'),a.manualKg,'type="number" step="any"')}${field('manualParts',t('au.goodPartsIn'),a.manualParts,'type="number" step="any"')}</div>
    ${a.meter&&a.meter.measures==='current'?`<div class="grid2">${field('lineVoltage',t('au.lineVoltage'),A.lineVoltage??a.meter.voltageV,'type="number" step="any"')}${field('assumedPf',t('au.assumedPf'),A.assumedPf??a.meter.assumedPf,'type="number" step="0.01" min="0.3" max="1"')}</div><p class="muted">${esc(t('au.currentOnlyHint'))}</p>`:''}
    <label class="f">${esc(t('au.notes'))}<textarea name="notes">${esc(a.notes)}</textarea></label>${w?`<button class="primary full">${esc(t('au.save'))}</button>`:''}</fieldset></form>
    <h3>${esc(t('au.photos'))}</h3><div>${photos||`<span class="muted">${esc(t('au.noPhotos'))}</span>`}</div>${w&&a.status!=='cancelled'?`<label class="secondary filebtn">${esc(t('au.addPhoto'))}<input type="file" id="photo" accept="image/*" capture="environment" hidden></label>`:''}
    ${w&&a.meter?`<h3>${esc(t('au.rawData'))}</h3><p class="muted">${esc(t('au.rawHint',{until:a.keepRawUntil?formatDateTime(a.keepRawUntil,'UTC'):'—'}))}</p><div class="actions"><button type="button" class="secondary" data-act="rawcsv">${esc(t('au.exportRaw'))}</button><button type="button" class="danger" data-act="rawdelete">${esc(t('au.deleteRaw'))}</button></div>`:''}
    ${w&&a.status!=='cancelled'&&a.status!=='running'?`<button type="button" class="danger" data-act="cancel">${esc(t('au.cancelAudit'))}</button>`:''}`;
}
const reportTab=a=>a.analysis?`<p>${esc(t('au.reportIntro'))}</p><div class="actions"><button type="button" class="primary" data-act="report:en">${esc(t('au.reportEn'))}</button><button type="button" class="primary" data-act="report:de">${esc(t('au.reportDe'))}</button></div><p class="muted">${esc(t('au.reportHint'))}</p>`:`<p class="muted">${esc(t('au.noResultYet'))}</p>`;

// ---------- Meters ----------
async function metersView() {
  const list=await api('/energy-audit/meters').catch(()=>[]); S.meters=list;
  const rows=list.map(m=>`<button type="button" class="card auditcard" data-meter="${esc(m.id)}"><div class="row"><b>${esc(m.name)}</b><span class="badge ${m.active?'completed':'cancelled'}">${esc(m.active?t('au.active'):t('au.inactive'))}</span></div><div class="muted">${esc(machineName(S.equipment.find(e=>e.id===m.equipmentId)||{make:'',model:''}))} · ${esc(t('au.kind_'+m.kind))} · ${esc(fmtMs(m.nominalIntervalMs))}</div>
    <div class="muted">${m.lastSeenAt?esc(t('au.lastSeen',{t:formatDateTime(m.lastSeenAt,'UTC')})):esc(t('au.neverSeen'))}${m.clockOffsetMs!=null?` · ${esc(t('au.clockOffset',{s:nf(m.clockOffsetMs/1000,1)}))}`:''}</div></button>`).join('');
  $('#app').innerHTML=shell(`${canWrite()?`<button type="button" class="primary full" data-act="newmeter0">${esc(t('au.registerMeter'))}</button>`:''}<h2 class="section">${esc(t('au.meters'))}</h2>${rows||`<p class="empty">${esc(t('au.noMeters'))}</p>`}`)+navBar();
  bind();
}
const MAP_NAMES=['time','kw','kva','kvar','pf','volts','amps','thd','kwhTotal','cycle','kw1','kw2','kw3','v1','v2','v3','i1','i2','i3','pf1','pf2','pf3'];
const mappingText=m=>Object.entries(m||{}).map(([k,v])=>k==='objectPath'?`objectPath=${v}`:`${k}=${v.path}${v.scale&&v.scale!==1?` *${v.scale}`:''}${v.offset?` +${v.offset}`:''}`).join('\n');
function parseMappingText(txt) {
  const out={}; for (const line of String(txt).split('\n').map(l=>l.trim()).filter(Boolean)) {
    const m=line.match(/^(\w+)\s*=\s*([^\s*+]+)\s*(?:\*\s*(-?[\d.eE+-]+))?\s*(?:\+\s*(-?[\d.eE+-]+))?$/); if (!m) throw Error(t('au.mappingLine',{line}));
    out[m[1]]=m[1]==='objectPath'?m[2]:{path:m[2],...(m[3]?{scale:Number(m[3])}:{}),...(m[4]?{offset:Number(m[4])}:{})}; }
  return out;
}
function meterView() {
  const m=S.meter, edit=!!m.id, adv=m.id?m.advice:null, kind=m.kind||'analyzer', ble=m.bleConfig||{};
  const url=location.origin+(m.ingest?.samples||'/api/integrations/energy-samples');
  const info=edit?`<div class="card"><h3>${esc(t('au.sendData'))}</h3><p>${esc(t('au.sendDataText'))}</p><dl class="kv"><dt>${esc(t('au.meterId'))}</dt><dd><code>${esc(m.id)}</code></dd><dt>HTTP</dt><dd><code>POST ${esc(url)}</code></dd><dt>${esc(t('au.header'))}</dt><dd><code>X-Integration-Key: mck_…</code></dd><dt>${esc(t('au.payloadUrl'))}</dt><dd><code>POST ${esc(location.origin+m.ingest.payload)}</code></dd><dt>LoRaWAN</dt><dd><code>POST ${esc(location.origin+m.ingest.lorawan)}</code></dd></dl>
    <pre class="code">{"meterId":"${esc(m.id)}","t0":"2026-10-01T09:30:00.000Z","dtMs":100,
 "kw":[12.4,12.6,…],"pf":[0.81,0.81,…]}</pre><p class="muted">${esc(t('au.sendDataLimits'))}</p>
    ${S.user.role==='customer_admin'||S.user.role==='platform_admin'?`<button type="button" class="secondary" data-act="makekey">${esc(t('au.makeKey'))}</button>`:`<p class="muted">${esc(t('au.keyByAdmin'))}</p>`}${S.newKey?`<div class="notice ok"><b>${esc(t('au.keyOnce'))}</b><br><code class="key">${esc(S.newKey)}</code></div>`:''}</div>`:'';
  const bleCard=`<div class="card"><h3>${esc(t('au.bluetooth'))} <span class="ac-est">${esc(t('au.experimental'))}</span></h3><p class="muted">${esc(t('au.bleText'))}</p>
    <div class="grid2">${field('serviceUuid',t('au.bleService'),ble.serviceUuid||'')}${field('characteristicUuid',t('au.bleChar'),ble.characteristicUuid||'')}</div>
    <label class="f">${esc(t('au.bleDecoder'))}<textarea name="bleFields" placeholder="kw float32 le 0 1&#10;pf uint16 be 4 0.001">${esc((ble.decoder?.fields||[]).map(f=>`${f.name} ${f.type} ${f.endian} ${f.offset} ${f.scale}`).join('\n'))}</textarea></label>
    ${edit&&ble.serviceUuid?`<button type="button" class="secondary" data-act="blestart" ${bleSupported()?'':'disabled'}>${esc(t('au.bleStart'))}</button>${bleSupported()?'':`<p class="muted">${esc(t('au.bleUnsupported'))}</p>`}${S.ble?`<p class="notice ok">${esc(t('au.bleStatus',{sent:S.ble.sent,buffered:S.ble.buf.length}))}</p>`:''}`:''}</div>`;
  $('#app').innerHTML=shell(`<form id="meterform" class="stack">${edit?'':sel('equipmentId',t('au.machine'),S.equipment.map(e=>[e.id,machineName(e)]),m.equipmentId)}
    ${field('name',t('au.meterName'),m.name||'','required maxlength="80"')}
    ${sel('kind',t('au.meterKind'),[['analyzer',t('au.kind_analyzer')],['lorawan_ct',t('au.kind_lorawan_ct')],['generic',t('au.kind_generic')]],kind,edit?'disabled':'')}
    <div class="grid2">${sel('measures',t('au.measures'),[['power',t('au.measures_power')],['current',t('au.measures_current')],['energy',t('au.measures_energy')]],m.measures||(kind==='lorawan_ct'?'current':'power'))}${sel('transport',t('au.transport'),['http','mqtt','lorawan','ble'].map(x=>[x,t('au.transport_'+x)]),m.transport||(kind==='lorawan_ct'?'lorawan':'http'))}
    ${field('nominalIntervalMs',t('au.intervalMs'),m.nominalIntervalMs??(kind==='lorawan_ct'?600000:100),'type="number" min="10" max="86400000" inputmode="numeric"')}${field('deviceId',t('au.deviceId'),m.deviceId||'')}
    ${field('voltageV',t('au.lineVoltage'),m.voltageV??'','type="number" step="any"')}${field('assumedPf',t('au.assumedPf'),m.assumedPf??'','type="number" step="0.01"')}
    ${sel('voltageBasis',t('au.voltageBasis'),[['ll',t('au.vb_ll')],['ln',t('au.vb_ln')]],m.voltageBasis||'ll')}${sel('clockMode',t('au.clockMode'),[['device',t('au.clock_device')],['receive',t('au.clock_receive')]],m.clockMode||'device')}</div>
    <label class="f">${esc(t('au.mapping'))}<textarea name="mapping" rows="5" placeholder="kw=pwr.total *0.001&#10;pf=pwr.pf&#10;time=ts">${esc(mappingText(m.mapping))}</textarea></label><p class="muted">${esc(t('au.mappingHint',{names:MAP_NAMES.join(', ')}))}</p>
    ${bleCard}<button class="primary full">${esc(t('au.save'))}</button></form>${edit?`<div class="card"><h3>${esc(t('au.testMapping'))}</h3><textarea id="testpayload" rows="4" placeholder='{"object":{"i_avg":18.5}}'></textarea><label class="check"><input type="checkbox" id="testlora"> ${esc(t('au.testLora'))}</label><button type="button" class="secondary" data-act="testmap">${esc(t('au.testMapping'))}</button><pre class="code" id="testout"></pre></div>${info}`:''}`,{back:S.meter.returnTo==='new'?'cancelmeter':'nav:meters',title:edit?m.name:t('au.registerMeter')})+navBar();
  const f=$('#meterform');
  f.onsubmit=async e=>{ e.preventDefault(); const d=new FormData(f);
    try {
      const bleFields=String(d.get('bleFields')||'').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{ const [name,type,endian,offset,scale]=l.split(/\s+/); return {name,type,endian,offset:Number(offset),scale:Number(scale||1)}; });
      const body={name:d.get('name'),measures:d.get('measures'),transport:d.get('transport'),nominalIntervalMs:num(d.get('nominalIntervalMs')),deviceId:d.get('deviceId'),voltageV:num(d.get('voltageV')),assumedPf:num(d.get('assumedPf')),voltageBasis:d.get('voltageBasis'),clockMode:d.get('clockMode'),mapping:parseMappingText(d.get('mapping')),
        ...(d.get('serviceUuid')?{bleConfig:{serviceUuid:d.get('serviceUuid'),characteristicUuid:d.get('characteristicUuid'),sampleIntervalMs:num(d.get('nominalIntervalMs')),decoder:{fields:bleFields}}}:{})};
      if (edit) S.meter=await api('/energy-audit/meters/'+m.id,'PATCH',body); else S.meter=await api('/energy-audit/meters','POST',{...body,equipmentId:d.get('equipmentId'),kind:d.get('kind')});
      ok(t('au.saved')); if (!edit&&m.returnTo==='new'&&S.form) { S.form.meterId=S.meter.id; S.meters=await api('/energy-audit/meters?equipmentId='+encodeURIComponent(S.form.equipmentId)); S.view='new'; await render(); return; }
      meterView();
    } catch(err) { fail(err); } };
  bind();
}

// ---------- Template editor ----------
const CATS=['close','lockup','injection','holding','charge','cooling','open','eject','other'];
function templateView() {
  const tm=S.tmpl, rows=tm.phases.map((p,i)=>`<div class="phase" data-i="${i}"><input name="n${i}" value="${esc(p.name)}" aria-label="${esc(t('au.phase'))}" maxlength="60"><input name="s${i}" value="${esc(p.seconds)}" type="number" step="0.1" min="0.1" inputmode="decimal" aria-label="s"><select name="c${i}" aria-label="${esc(t('au.category'))}">${CATS.map(c=>`<option value="${c}" ${p.category===c?'selected':''}>${esc(t('au.cat_'+c))}</option>`).join('')}</select><button type="button" class="icon" data-rm="${i}" aria-label="${esc(t('au.remove'))}">×</button></div>`).join('');
  $('#app').innerHTML=shell(`<p class="muted">${esc(t('au.templateHelp'))}</p><form id="tform" class="stack">${rows}<button type="button" class="secondary" data-act="addphase">${esc(t('au.addPhase'))}</button>
    <label class="f">${esc(t('au.pasteLines'))}<textarea name="paste" rows="4" placeholder="Mould close 2.5&#10;Lock up 1.0&#10;Filling 2.0"></textarea></label><button type="button" class="secondary" data-act="importlines">${esc(t('au.importLines'))}</button>
    <p class="muted" id="tsum"></p><button class="primary full">${esc(t('au.saveTemplate'))}</button></form>`,{back:'cancelmeter',title:t('au.editTemplate')})+navBar();
  const f=$('#tform'), read=()=>{ const d=new FormData(f); tm.phases=tm.phases.map((p,i)=>({name:d.get('n'+i),seconds:Number(d.get('s'+i)),category:d.get('c'+i)})); };
  const sum=()=>{ read(); $('#tsum').textContent=t('au.templateLine',{n:tm.phases.length,s:nf(tm.phases.reduce((s,p)=>s+(p.seconds||0),0),1)}); }; sum();
  f.addEventListener('input',sum);
  f.querySelectorAll('[name^=n]').forEach((el,i)=>el.addEventListener('change',()=>{ read(); const g=guess(tm.phases[i].name); if (g) { tm.phases[i].category=g; templateView(); } }));
  f.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{ read(); tm.phases.splice(Number(b.dataset.rm),1); templateView(); });
  f.onsubmit=async e=>{ e.preventDefault(); read(); try { await api('/energy-audit/templates/'+tm.productId,'PUT',{name:tm.name,phases:tm.phases}); ok(t('au.saved')); S.audit=await api('/energy-audits/'+S.audit.id); S.view='audit'; S.tab='cycles'; render(); } catch(err) { fail(err); } };
  $('[data-act=addphase]').onclick=()=>{ read(); tm.phases.push({name:'',seconds:1,category:'other'}); templateView(); };
  $('[data-act=importlines]').onclick=()=>{ read(); const txt=new FormData(f).get('paste'); const add=String(txt).split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{ const m=l.match(/^(.*?)[\s:;,=-]+(\d+(?:[.,]\d+)?)\s*s?$/i); return m?{name:m[1].trim(),seconds:Number(m[2].replace(',','.')),category:guess(m[1])||'other'}:null; }).filter(Boolean); if (!add.length) { S.error=t('au.noLines'); render(); return; } tm.phases=tm.phases.filter(p=>p.name).concat(add); templateView(); };
  bind();
}
const guess=name=>{ const n=String(name).toLowerCase(); return /lock[\s-]*up|zuhalt|verriegel/.test(n)?'lockup':/unlock|entriegel|open|öffn|oeffn/.test(n)?'open':/clos|schlie|zufahr/.test(n)?'close':/fill|inject|einspritz|füll|fuell/.test(n)?'injection':/hold|nachdruck|pack/.test(n)?'holding':/charg|dos|plast|schnecke/.test(n)?'charge':/cool|kühl|kuehl/.test(n)?'cooling':/eject|auswerf|entform/.test(n)?'eject':null; };

// ---------- Settings ----------
function settingsView() {
  const c=S.config, w=canManage();
  $('#app').innerHTML=shell(`<h2 class="section">${esc(t('au.materialsTitle'))}</h2><p class="muted">${esc(t('au.materialsHelp'))}</p><form id="sform" class="stack"><fieldset ${w?'':'disabled'}><textarea name="materials" rows="10">${esc((c?.materials||[]).join('\n'))}</textarea>${w?`<button class="primary full">${esc(t('au.save'))}</button><button type="button" class="secondary" data-act="resetmaterials">${esc(t('au.resetDefaults'))}</button>`:`<p class="muted">${esc(t('au.managersOnly'))}</p>`}</fieldset></form>
    <h2 class="section">${esc(t('au.benchmarkTitle'))}</h2><p class="muted">${esc(t('au.benchmarkHelp'))}</p><table class="ac-table"><thead><tr><th>${esc(t('au.pumpType'))}</th><th>${esc(t('au.material'))}</th><th>kWh/kg</th></tr></thead><tbody>${(c?.benchmarks||[]).map(b=>`<tr><td>${esc(pumpLabel(b.driveType))}</td><td>${esc(b.material||'—')}</td><td>${nf(b.low,2)}–${nf(b.high,2)}</td></tr>`).join('')}</tbody></table><p class="muted">${esc(c?.defaults?.benchmarks?t('au.benchmarkDefault'):t('au.benchmarkCustom'))} ${esc(t('au.desktopEdit'))}</p>`)+navBar();
  const f=$('#sform'); f.onsubmit=async e=>{ e.preventDefault(); try { const mats=String(new FormData(f).get('materials')).split('\n').map(x=>x.trim()).filter(Boolean); S.config=await api('/energy-audit/config','PUT',{materials:mats}); ok(t('au.saved')); settingsView(); } catch(err) { fail(err); } };
  const r=$('[data-act=resetmaterials]'); if (r) r.onclick=async()=>{ try { S.config=await api('/energy-audit/config','PUT',{materials:null}); ok(t('au.saved')); settingsView(); } catch(err) { fail(err); } };
  bind();
}

// ---------- Bluetooth relay (experimental) ----------
// Subscribes to the configured characteristic, decodes each notification with the configured byte layout and relays batches to the
// backend; samples are buffered in memory (and localStorage) while the phone is offline and sent when the connection returns.
async function bleStart() {
  const m=S.meter, cfg=m.bleConfig; if (!cfg?.serviceUuid) return;
  try {
    const dev=await navigator.bluetooth.requestDevice({filters:[{services:[uuidOf(cfg.serviceUuid)]}]});
    const srv=await dev.gatt.connect(), svc=await srv.getPrimaryService(uuidOf(cfg.serviceUuid)), ch=await svc.getCharacteristic(uuidOf(cfg.characteristicUuid));
    S.ble={sent:0,buf:(()=>{ try { return JSON.parse(store.get('localStorage','mc_ble_'+m.id)||'[]'); } catch { return []; } })(),dev};
    const flush=async()=>{ if (!navigator.onLine||!S.ble.buf.length) return; const batch=S.ble.buf.slice(0,1200); try { await api(`/energy-audit/meters/${m.id}/relay`,'POST',{samples:batch}); S.ble.buf.splice(0,batch.length); S.ble.sent+=batch.length; store.set('localStorage','mc_ble_'+m.id,JSON.stringify(S.ble.buf.slice(-20000))); } catch(e) { if (e.status===429) return; if (e.status===400) { S.ble.buf.splice(0,batch.length); } } };
    ch.addEventListener('characteristicvaluechanged',ev=>{ const v=decodeNotification(ev.target.value,cfg.decoder.fields); if (v) S.ble.buf.push({t:Date.now(),...v}); });
    await ch.startNotifications(); S.ble.timer=setInterval(()=>{ flush(); if ($('.notice.ok')&&S.view==='meter') meterView(); },5000); window.addEventListener('online',flush);
    ok(t('au.bleConnected')); meterView();
  } catch(e) { S.error=e.message; meterView(); }
}

// ---------- Events ----------
async function download(path,name,type) {
  const r=await fetch('/api'+path,{headers:{authorization:`Bearer ${S.token}`}}); if (!r.ok) throw Error((await r.json().catch(()=>({}))).error||`HTTP ${r.status}`);
  const blob=await r.blob(), url=URL.createObjectURL(blob); if (type==='html') window.open(url,'_blank'); else { const a=document.createElement('a'); a.href=url; a.download=name; a.click(); } setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function patchAudit(body) { S.audit=await api('/energy-audits/'+S.audit.id,'PATCH',body); }
function bind() {
  document.querySelectorAll('[data-act]').forEach(b=>{ if (b.dataset.bound) return; b.dataset.bound='1'; b.addEventListener('click',()=>act(b.dataset.act)); });
  document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openAudit(b.dataset.open));
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{ S.tab=b.dataset.tab; S.notice=''; render(); });
  document.querySelectorAll('[data-meter]').forEach(b=>b.onclick=async()=>{ S.meter=await api('/energy-audit/meters/'+b.dataset.meter).catch(fail); S.newKey=null; S.view='meter'; render(); });
  document.querySelectorAll('[data-assume]').forEach(el=>el.addEventListener('change',async()=>{ const k=el.dataset.assume, v=el.tagName==='SELECT'?el.value:el.value===''?null:Number(el.value); try { await patchAudit({assumptions:{[k]:v===''?null:v}}); render(); } catch(e) { fail(e); } }));
  document.querySelectorAll('[data-target]').forEach(b=>b.onclick=async()=>{ try { await patchAudit({assumptions:{target:b.dataset.target}}); render(); } catch(e) { fail(e); } });
  const sf=$('#setupform'); if (sf) sf.onsubmit=async e=>{ e.preventDefault(); const d=new FormData(sf), g=k=>d.get(k)===''||d.get(k)==null?null:Number(d.get(k));
    try { await patchAudit({title:d.get('title'),material:d.get('material'),notes:d.get('notes'),massMode:d.get('massMode'),manualKg:g('manualKg'),manualParts:g('manualParts'),nameplate:{motorKw:g('motorKw'),pumpType:d.get('pumpType'),clampTonnes:g('clampTonnes'),screwDiameterMm:g('screwDiameterMm'),yearBuilt:g('yearBuilt')},
      assumptions:{...(d.get('lineVoltage')?{lineVoltage:g('lineVoltage')}:{}),...(d.get('assumedPf')?{assumedPf:g('assumedPf')}:{})}}); ok(t('au.saved')); render(); } catch(err) { fail(err); } };
  const ph=$('#photo'); if (ph) ph.onchange=()=>{ const file=ph.files[0]; if (!file) return; const rd=new FileReader(); rd.onload=async()=>{ try { const img=new Image(); img.onload=async()=>{ const sc=Math.min(1,1600/Math.max(img.width,img.height)), cv=document.createElement('canvas'); cv.width=Math.round(img.width*sc); cv.height=Math.round(img.height*sc); cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
      const b64=cv.toDataURL('image/jpeg',0.82).split(',')[1]; try { await api('/attachments','POST',{entityType:'energy_audit',entityId:S.audit.id,kind:'photo',filename:(file.name||'photo').replace(/\.\w+$/,'')+'.jpg',mime:'image/jpeg',base64:b64}); S.audit=await api('/energy-audits/'+S.audit.id); ok(t('au.saved')); render(); } catch(err) { fail(err); } }; img.src=rd.result; } catch(err) { fail(err); } }; rd.readAsDataURL(file); };
  document.querySelectorAll('[data-photo]').forEach(a=>a.onclick=()=>download('/attachments/'+a.dataset.photo,'photo.jpg','html').catch(fail));
}
async function act(a) {
  S.notice=''; S.error='';
  try {
    if (a==='signout') return signOut();
    if (a==='help') { $('#app').innerHTML=helpView(S.view); $('#helpback').onclick=()=>render(); return; }
    if (a==='new') { S.form=null; S.meters=[]; S.view='new'; await newViewInit(); return render(); }
    if (a==='cancelmeter') { S.view=S.meter?.returnTo==='new'?'new':'meters'; return render(); }
    if (a.startsWith('nav:')) { const v=a.slice(4); clearInterval(timer); if (v==='list') return loadList(); S.view=v; return render(); }
    if (a==='newmeter0') { S.meter={equipmentId:S.equipment[0]?.id,returnTo:'meters'}; S.view='meter'; return render(); }
    if (a==='newmeter') { S.view='meter'; return render(); }
    if (a==='start') { S.audit=await api(`/energy-audits/${S.audit.id}/start`,'POST',{}); ok(t('au.runStarted')); render(); return schedule(); }
    if (a==='stop') { S.audit=await api(`/energy-audits/${S.audit.id}/stop`,'POST',{}); clearInterval(timer); S.tab='sec'; ok(t('au.runStopped')); return render(); }
    if (a==='complete') { S.audit=await api(`/energy-audits/${S.audit.id}/complete`,'POST',{}); S.tab='sec'; return render(); }
    if (a==='cancel') { if (!confirm(t('au.cancelConfirm'))) return; S.audit=await api(`/energy-audits/${S.audit.id}/cancel`,'POST',{}); return render(); }
    if (a==='template') { const tm=S.audit.template; S.tmpl={productId:S.audit.product.id,name:tm?.name||S.audit.product.partNumber,phases:(tm?.phases||[]).map(p=>({...p}))}; S.view='template'; return render(); }
    if (a.startsWith('report:')) return await download(`/energy-audits/${S.audit.id}/report?lang=${a.slice(7)}`,'report.html','html');
    if (a==='rawcsv') return await download(`/energy-audits/${S.audit.id}/raw.csv`,'raw.csv','csv');
    if (a==='rawdelete') { if (!confirm(t('au.deleteRawConfirm'))) return; const r=await api(`/energy-audits/${S.audit.id}/raw`,'DELETE'); ok(t('au.rawDeleted',{n:r.deleted})); return render(); }
    if (a==='makekey') { const k=await api('/integration-keys','POST',{name:`${S.meter.name} (energy)`,scopes:['energy']}); S.newKey=k.key; return meterView(); }
    if (a==='testmap') { const raw=$('#testpayload').value; let payload; try { payload=JSON.parse(raw); } catch { throw Error(t('au.badJson')); } const r=await api(`/energy-audit/meters/${S.meter.id}/test-mapping`,'POST',{payload,lorawan:$('#testlora').checked}); $('#testout').textContent=JSON.stringify(r.stored,null,1); return; }
    if (a==='blestart') return await bleStart();
  } catch(e) { fail(e); }
}

async function render() {
  clearTimeout(window.__rt);
  if (!S.token||!S.user) return loginView();
  if (S.view==='list') $('#app').innerHTML=listView();
  else if (S.view==='new') return await newView();
  else if (S.view==='audit') $('#app').innerHTML=auditView();
  else if (S.view==='meters') return await metersView();
  else if (S.view==='meter') return meterView();
  else if (S.view==='template') return templateView();
  else if (S.view==='settings') return settingsView();
  bind();
  if (S.notice) window.__rt=setTimeout(()=>{ S.notice=''; const n=$('.notice.ok'); if (n) n.remove(); },5000);
}
window.addEventListener('online',()=>{ S.online=true; render(); }); window.addEventListener('offline',()=>{ S.online=false; render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/audit/sw.js').catch(()=>{});
if (S.token) start(); else render();
