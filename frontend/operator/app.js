// Operator tablet: mounted at a machine (or a line), big touch targets, landscape 768-1280 px and phones. A station
// signs in with its code and PIN and works only on its own machines; a person can also sign in with their account.
// The operator records downtime reasons, scrap, jobs and mould changes and raises andon calls.
import { t, setLocale, formatNumber, formatDateTime } from '/shared/i18n.js';
import { ANDON_TYPES, ANDON_ICONS, stateLabel, reasonLabel, typeLabel, callStatusLabel, tickTimers, elapsed } from '/shared/andon.js';

const $=s=>document.querySelector(s), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store={get:(a,k)=>{try{return window[a].getItem(k)}catch{return null}},set:(a,k,v)=>{try{window[a].setItem(k,v)}catch{}},del:(a,k)=>{try{window[a].removeItem(k)}catch{}}};
// A station token is kept on the device (a mounted tablet survives a reload); a person's sign-in only for this tab.
const ST_KEY='mc_op_station', USER_KEY='mc_op_user', OP_KEY='mc_op_operator';
const S={token:store.get('localStorage',ST_KEY)||store.get('sessionStorage',USER_KEY),me:null,machineId:null,view:null,sheet:null,error:'',notice:'',tab:'station',pin:'',code:store.get('localStorage','mc_op_code')||'',operator:store.get('localStorage',OP_KEY)||''};

async function api(path,method='GET',body) {
  const r=await fetch('/api'+path,{method,headers:{'content-type':'application/json',...(S.token?{authorization:`Bearer ${S.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if (r.status===401&&S.token&&!path.endsWith('/login')) { signOut(t('op.sessionEnded')); throw Object.assign(Error(t('op.sessionEnded')),{quiet:true}); }
  if (!r.ok) throw Object.assign(Error(data.error||`HTTP ${r.status}`),{status:r.status});
  return data;
}
const fail=e=>{ if (e.quiet) return; S.error=e.message==='Failed to fetch'?t('op.offline'):e.message; render(); };
function signOut(message='') { store.del('localStorage',ST_KEY); store.del('sessionStorage',USER_KEY); Object.assign(S,{token:null,me:null,view:null,sheet:null,machineId:null,pin:'',error:message}); render(); }
const withOperator=body=>({...body,...(S.operator?{operator:S.operator}:{})});
const machineKey=()=>`mc_op_machine_${S.me?.station?.id||S.me?.user?.id||''}`;

// ---------- Sign-in ----------
function loginView() {
  const dots=[...Array(Math.max(4,S.pin.length))].map((_,i)=>`<span class="dot ${i<S.pin.length?'on':''}"></span>`).join('');
  const keys=['1','2','3','4','5','6','7','8','9','del','0','ok'].map(k=>k==='del'?`<button type="button" class="key secondary" data-key="del" aria-label="${esc(t('op.deleteDigit'))}">⌫</button>`:k==='ok'?`<button type="button" class="key go" data-key="ok">${esc(t('op.signIn'))}</button>`:`<button type="button" class="key" data-key="${k}">${k}</button>`).join('');
  const station=`<form id="station-login" class="login-form" autocomplete="off"><label for="code">${esc(t('op.stationCode'))}</label><input id="code" name="code" value="${esc(S.code)}" autocapitalize="characters" spellcheck="false" placeholder="ABCD2345" maxlength="12" required>
    <label>${esc(t('op.pin'))}</label><div class="pin-dots" aria-live="polite" aria-label="${esc(t('op.pinDigits',{n:S.pin.length}))}">${dots}</div><div class="keypad">${keys}</div></form>`;
  const person=`<form id="user-login" class="login-form"><label for="email">${esc(t('label.email'))}</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">${esc(t('label.password'))}</label><input id="password" name="password" type="password" autocomplete="current-password" required><button class="big go">${esc(t('op.signIn'))}</button></form>`;
  $('#app').innerHTML=`<main class="login"><div class="brand">Mould<span>Care</span> <small>${esc(t('op.title'))}</small></div><p class="muted">${esc(t('op.loginIntro'))}</p>
    <div class="tabs" role="tablist"><button type="button" role="tab" class="tab ${S.tab==='station'?'active':''}" aria-selected="${S.tab==='station'}" data-tab="station">${esc(t('op.stationLogin'))}</button><button type="button" role="tab" class="tab ${S.tab==='person'?'active':''}" aria-selected="${S.tab==='person'}" data-tab="person">${esc(t('op.personLogin'))}</button></div>
    ${S.error?`<p class="notice error" role="alert">${esc(S.error)}</p>`:''}${S.tab==='station'?station:person}</main>`;
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{ S.tab=b.dataset.tab; S.error=''; render(); });
  const code=$('#code'); if (code) code.oninput=()=>{ S.code=code.value; };
  document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>{ const k=b.dataset.key; if (k==='del') S.pin=S.pin.slice(0,-1); else if (k==='ok') return stationLogin(); else if (S.pin.length<8) S.pin+=k; loginView(); });
  const sf=$('#station-login'); if (sf) sf.onsubmit=e=>{ e.preventDefault(); stationLogin(); };
  const uf=$('#user-login'); if (uf) uf.onsubmit=async e=>{ e.preventDefault(); const f=new FormData(uf);
    try { const r=await api('/auth/login','POST',{email:String(f.get('email')).trim(),password:String(f.get('password'))}); S.token=r.token; store.set('sessionStorage',USER_KEY,r.token); S.error=''; await start(); } catch (err) { fail(err); } };
}
async function stationLogin() {
  if (!S.code.trim()) { S.error=t('op.enterCode'); return render(); }
  if (S.pin.length<4) { S.error=t('op.enterPin'); return render(); }
  try { const r=await api('/operator/login','POST',{code:S.code,pin:S.pin}); S.token=r.token; S.pin=''; store.set('localStorage',ST_KEY,r.token); store.set('localStorage','mc_op_code',S.code.trim().toUpperCase()); S.error=''; await start(); }
  catch (e) { S.pin=''; fail(e); }
}

// ---------- Machine screen ----------
async function start() {
  S.me=await api('/operator/me'); setLocale(S.me.locale||'en');
  const saved=store.get('localStorage',machineKey());
  S.machineId=S.me.machines.some(m=>m.id===saved)?saved:S.me.machines.length===1?S.me.machines[0].id:null;
  if (S.me.station?.kind==='board') { location.href='/andon/'; return; }
  await load();
}
async function load() { if (S.machineId) S.view=await api(`/operator/machines/${encodeURIComponent(S.machineId)}`).catch(e=>{ fail(e); return S.view; }); render(); }
const pct=v=>v==null?'—':`${formatNumber(v,1)} %`;
const num=(v,d=0)=>v==null?'—':formatNumber(v,d);
function header() {
  const v=S.view, who=S.me.station?S.me.station.name:S.me.user.name;
  return `<header class="op-top"><div class="brand">Mould<span>Care</span></div><div class="op-title">${v?`<b>${esc(v.machine.assetTag||'')}</b> <span>${esc(v.machine.make)} ${esc(v.machine.model)}</span><small>${esc(v.machine.plantName)}${v.machine.location?' · '+esc(v.machine.location):''}${v.shift?` · ${esc(t('op.shift',{name:v.shift.name}))}`:''}</small>`:`<b>${esc(who)}</b>`}</div>
    <div class="op-tools"><button type="button" class="chip" data-act="operator" aria-label="${esc(t('op.changeOperator'))}">👤 ${esc(S.operator||t('op.whoIsWorking'))}</button>${S.me.machines.length>1&&v?`<button type="button" class="chip" data-act="machines">${esc(t('op.otherMachine'))}</button>`:''}<button type="button" class="chip" data-act="signout">${esc(t('op.signOut'))}</button></div></header>`;
}
function pickerView() {
  return `${header()}<main class="op-pick"><h1>${esc(t('op.pickMachine'))}</h1>${S.me.machines.length?`<div class="pick-grid">${S.me.machines.map(m=>`<button type="button" class="pick" data-machine="${esc(m.id)}"><b>${esc(m.assetTag||'')}</b><span>${esc(m.make)} ${esc(m.model)}</span><small>${esc(m.location||'')}</small></button>`).join('')}</div>`:`<p class="notice">${esc(t('op.noMachines'))}</p>`}</main>`;
}
function machineView() {
  const v=S.view, st=v.state, open=st.state!=='running'&&st.state!=='offline';
  const current=v.stops.find(s=>s.open), needsReason=open&&current&&!current.classified&&st.reason!=='no_production_planned';
  const unit=v.product.unit==='parts'?t('op.parts'):v.product.unit;
  const cycle=v.cycle.idealS?`<b>${num(v.cycle.actualS,1)} s</b><small>${esc(t('op.idealCycle',{value:num(v.cycle.idealS,1)}))}</small>`:`<b>${num(v.cycle.actualRate,1)}</b><small>${esc(t('op.idealRate',{value:num(v.cycle.idealRate,1),unit:v.product.unit}))}</small>`;
  const slow=v.cycle.actualS&&v.cycle.idealS&&v.cycle.actualS>v.cycle.idealS*1.1;
  const calls=v.calls.length?`<ul class="calls">${v.calls.map(c=>`<li class="call ${esc(c.type)} ${esc(c.status)}"><div><b>${ANDON_ICONS[c.type]} ${esc(typeLabel(c.type))}</b> <span class="badge">${esc(callStatusLabel(c.status))}${c.level?` · ${esc(t('op.level',{n:c.level}))}`:''}</span><small>${c.acknowledgedBy?esc(t('op.answeredBy',{name:c.acknowledgedBy})):esc(t('op.waitingForHelp'))}${c.ticketId?` · ${esc(t('op.ticketRaised'))}`:''}</small></div><time data-since="${esc(c.raisedAt)}">${elapsed(c.raisedAt)}</time>
    <div class="call-acts">${c.status==='open'?`<button type="button" class="secondary" data-ack="${esc(c.id)}">${esc(t('op.helpArrived'))}</button>`:''}${c.type==='maintenance'&&!c.ticketId?`<button type="button" class="secondary" data-ticket="${esc(c.id)}">${esc(t('op.makeTicket'))}</button>`:''}<button type="button" data-resolve="${esc(c.id)}">${esc(t('op.resolved'))}</button></div></li>`).join('')}</ul>`:'';
  const stops=v.stops.filter(s=>s.state!=='planned_stop'||s.reason!=='no_production_planned').slice(0,6);
  return `${header()}<main class="op-main">
    ${S.error?`<p class="notice error" role="alert">${esc(S.error)}</p>`:''}${S.notice?`<p class="notice ok" role="status">${esc(S.notice)}</p>`:''}
    <section class="op-state s-${esc(st.state)}" aria-live="polite"><div><small>${esc(t('op.machineIs'))}</small><strong>${esc(stateLabel(st.state))}</strong>${st.reason?`<span class="reason">${esc(reasonLabel(st.reason))}</span>`:''}</div><div class="since"><small>${esc(t('op.for'))}</small><time data-since="${esc(st.since||'')}">${elapsed(st.since)}</time></div>
      ${needsReason?`<button type="button" class="big reason-btn" data-act="downtime" data-state-id="${esc(current.id)}">${esc(t('op.giveReason'))}</button>`:''}</section>
    <section class="op-kpis"><div class="kpi"><small>${esc(t('op.shiftOee'))}</small><b>${pct(v.shift?.oee)}</b><small>A ${pct(v.shift?.availability)} · P ${pct(v.shift?.performance)} · Q ${pct(v.shift?.quality)}</small></div>
      <div class="kpi"><small>${esc(t('op.goodToday'))}</small><b>${num(v.today.good,1)}</b><small>${esc(unit)}</small></div><div class="kpi ${v.today.scrap?'warn':''}"><small>${esc(t('op.scrapToday'))}</small><b>${num(v.today.scrap,1)}</b><small>${esc(unit)}</small></div>
      <div class="kpi ${slow?'warn':''}"><small>${esc(v.cycle.idealS?t('op.cycleTime'):t('op.rate'))}</small>${cycle}</div>
      <div class="kpi wide"><small>${esc(v.mouldChange?t('op.mouldChangeRunning'):v.job?t('op.job'):t('op.product'))}</small><b class="text">${esc(v.product.partNumber||'')} ${esc(v.product.name)}</b>${v.mouldChange?`<small><time data-since="${esc(v.mouldChange.startedAt)}">${elapsed(v.mouldChange.startedAt)}</time></small>`:v.job?`<small>${esc(t('op.since',{time:formatDateTime(v.job.startedAt,v.machine.timezone)}))}</small>`:''}</div></section>
    <section class="op-andon" aria-label="${esc(t('op.andon'))}"><h2>${esc(t('op.callForHelp'))}</h2><div class="andon-btns">${ANDON_TYPES.map(x=>`<button type="button" class="andon ${x}" data-andon="${x}"><span aria-hidden="true">${ANDON_ICONS[x]}</span>${esc(typeLabel(x))}</button>`).join('')}</div>${calls}</section>
    <section class="op-actions"><button type="button" class="big" data-act="downtime">${esc(t('op.downtimeReason'))}</button><button type="button" class="big" data-act="scrap">${esc(t('op.logScrap'))}</button><button type="button" class="big" data-act="job">${esc(v.mouldChange?t('op.finishMouldChange'):t('op.jobMouldChange'))}</button>
      ${st.manual?(st.state==='running'?`<button type="button" class="big stop" data-act="downtime">${esc(t('op.machineStopped'))}</button>`:`<button type="button" class="big go" data-act="resume">${esc(t('op.runningAgain'))}</button>`):''}</section>
    <section class="op-stops"><h2>${esc(t('op.recentStops'))}</h2>${stops.length?`<ul>${stops.map(s=>`<li><span class="dotc s-${esc(s.state)}"></span><div><b>${esc(stateLabel(s.state))}</b> ${s.reason?esc(reasonLabel(s.reason)):`<em>${esc(t('op.noReason'))}</em>`}<small>${esc(formatDateTime(s.startedAt,v.machine.timezone))} · ${num(s.minutes,0)} min${s.classified?` · ${esc(t('op.reasonGiven'))}`:''}</small></div><button type="button" class="secondary" data-act="downtime" data-state-id="${esc(s.id)}">${esc(s.classified?t('op.change'):t('op.giveReasonShort'))}</button></li>`).join('')}</ul>`:`<p class="muted">${esc(t('op.noStops'))}</p>`}</section>
  </main>${sheetView()}`;
}

// ---------- Sheets (one at a time, over the screen) ----------
function sheetView() {
  const sh=S.sheet; if (!sh) return ''; const v=S.view;
  const wrap=(title,body)=>`<div class="sheet-back" data-close></div><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button type="button" class="chip" data-close aria-label="${esc(t('op.close'))}">✕</button></header>${sh.error?`<p class="notice error" role="alert">${esc(sh.error)}</p>`:''}${body}</section>`;
  if (sh.kind==='downtime') {
    const group=sh.group||(v.state.state in v.reasons?v.state.state:'down');
    return wrap(t('op.whyStopped'),`<div class="tabs">${Object.keys(v.reasons).map(g=>`<button type="button" class="tab ${g===group?'active':''}" data-group="${g}">${esc(stateLabel(g))}</button>`).join('')}</div>
      <div class="choice-grid">${v.reasons[group].map(r=>`<button type="button" class="choice" data-reason="${esc(r)}" data-state="${group}">${esc(reasonLabel(r))}</button>`).join('')}</div><label class="lbl" for="dt-note">${esc(t('op.noteOptional'))}</label><input id="dt-note" maxlength="500" value="${esc(sh.note||'')}">`);
  }
  if (sh.kind==='scrap') return wrap(t('op.logScrap'),`<div class="choice-grid">${v.scrapReasons.map(r=>`<button type="button" class="choice ${sh.reason===r?'active':''}" data-scrap-reason="${esc(r)}" aria-pressed="${sh.reason===r}">${esc(reasonLabel(r))}</button>`).join('')}</div>
    <label class="lbl" for="scrap-qty">${esc(t('op.quantity',{unit:v.product.unit==='parts'?t('op.parts'):v.product.unit}))}</label><div class="stepper"><button type="button" class="secondary" data-step="-10">−10</button><button type="button" class="secondary" data-step="-1">−1</button><input id="scrap-qty" type="number" inputmode="${v.product.unit==='parts'?'numeric':'decimal'}" min="0" step="${v.product.unit==='parts'?1:'any'}" value="${esc(sh.qty??1)}"><button type="button" class="secondary" data-step="1">+1</button><button type="button" class="secondary" data-step="10">+10</button></div>
    <button type="button" class="big go" data-save-scrap ${sh.reason?'':'disabled'}>${esc(t('op.saveScrap'))}</button>`);
  if (sh.kind==='job') {
    const products=v.products.map(p=>`<button type="button" class="choice ${sh.productId===p.id?'active':''}" data-product="${esc(p.id)}" aria-pressed="${sh.productId===p.id}"><b>${esc(p.partNumber)}</b> ${esc(p.name)}</button>`).join('');
    if (v.mouldChange) return wrap(t('op.finishMouldChange'),`<p>${esc(t('op.nextProduct'))}</p><div class="choice-grid">${products}</div><button type="button" class="big go" data-job="finish:mould_change">${esc(t('op.finishMouldChange'))}</button>`);
    return wrap(t('op.jobMouldChange'),`<p>${esc(t('op.startJobOn'))}</p><div class="choice-grid">${products}</div><div class="row-btns"><button type="button" class="big go" data-job="start:job" ${sh.productId?'':'disabled'}>${esc(t('op.startJob'))}</button>${v.job?`<button type="button" class="big secondary" data-job="finish:job">${esc(t('op.finishJob'))}</button>`:''}<button type="button" class="big" data-job="start:mould_change">${esc(t('op.startMouldChange'))}</button></div>`);
  }
  if (sh.kind==='andon') return wrap(`${ANDON_ICONS[sh.type]} ${typeLabel(sh.type)}`,`<p>${esc(t(sh.type==='safety'?'op.safetyCallInfo':'op.callInfo'))}</p><label class="lbl" for="andon-note">${esc(t('op.whatIsWrong'))}</label><input id="andon-note" maxlength="500"><button type="button" class="big andon ${esc(sh.type)}" data-call="${esc(sh.type)}">${esc(t('op.callNow'))}</button>`);
  if (sh.kind==='resolve') return wrap(t('op.resolved'),`<label class="lbl" for="resolution">${esc(t('op.whatWasDone'))}</label><input id="resolution" maxlength="500"><button type="button" class="big go" data-do-resolve="${esc(sh.id)}">${esc(t('op.closeCall'))}</button>`);
  if (sh.kind==='operator') return wrap(t('op.whoIsWorking'),`<label class="lbl" for="op-name">${esc(t('op.nameOrBadge'))}</label><input id="op-name" maxlength="80" value="${esc(S.operator)}" autocomplete="off"><button type="button" class="big go" data-save-operator>${esc(t('op.save'))}</button>`);
  return '';
}
async function act(fn,done) {
  try { await fn(); S.sheet=null; S.error=''; S.notice=done||''; await load(); setTimeout(()=>{ if (S.notice===done) { S.notice=''; render(); } },4000); }
  catch (e) { if (S.sheet) { S.sheet.error=e.message; render(); } else fail(e); }
}
const machinePath=p=>`/operator/machines/${encodeURIComponent(S.machineId)}/${p}`;

function bind() {
  document.querySelectorAll('[data-machine]').forEach(b=>b.onclick=()=>{ S.machineId=b.dataset.machine; store.set('localStorage',machineKey(),S.machineId); load(); });
  document.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.act;
    if (a==='signout') return signOut();
    if (a==='machines') { S.machineId=null; S.view=null; store.del('localStorage',machineKey()); return render(); }
    if (a==='resume') return act(()=>api(machinePath('resume'),'POST',withOperator({})),t('op.savedRunning'));
    S.sheet={kind:a,stateId:b.dataset.stateId||null}; render(); $('.sheet input, .sheet button')?.focus();
  });
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{ S.sheet=null; render(); });
  document.querySelectorAll('[data-andon]').forEach(b=>b.onclick=()=>{ S.sheet={kind:'andon',type:b.dataset.andon}; render(); $('#andon-note')?.focus(); });
  document.querySelectorAll('[data-group]').forEach(b=>b.onclick=()=>{ S.sheet.group=b.dataset.group; S.sheet.note=$('#dt-note')?.value; render(); });
  document.querySelectorAll('[data-reason]').forEach(b=>b.onclick=()=>act(()=>api(machinePath('downtime'),'POST',withOperator({state:b.dataset.state,reason:b.dataset.reason,...(S.sheet.stateId?{stateId:S.sheet.stateId}:{}),note:$('#dt-note')?.value||''})),t('op.savedReason')));
  document.querySelectorAll('[data-scrap-reason]').forEach(b=>b.onclick=()=>{ S.sheet.reason=b.dataset.scrapReason; S.sheet.qty=$('#scrap-qty').value; render(); });
  document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{ const q=$('#scrap-qty'); q.value=String(Math.max(0,(Number(q.value)||0)+Number(b.dataset.step))); S.sheet.qty=q.value; });
  const save=$('[data-save-scrap]'); if (save) save.onclick=()=>act(()=>api(machinePath('scrap'),'POST',withOperator({reason:S.sheet.reason,quantity:Number($('#scrap-qty').value)})),t('op.savedScrap'));
  document.querySelectorAll('[data-product]').forEach(b=>b.onclick=()=>{ S.sheet.productId=S.sheet.productId===b.dataset.product?null:b.dataset.product; render(); });
  document.querySelectorAll('[data-job]').forEach(b=>b.onclick=()=>{ const [action,kind]=b.dataset.job.split(':'); act(()=>api(machinePath('job'),'POST',withOperator({action,kind,...(S.sheet.productId&&!(action==='finish'&&kind==='job')?{productId:S.sheet.productId}:{})})),t('op.savedJob')); });
  document.querySelectorAll('[data-call]').forEach(b=>b.onclick=()=>act(()=>api(machinePath('andon'),'POST',withOperator({type:b.dataset.call,note:$('#andon-note').value})),t('op.callSent')));
  document.querySelectorAll('[data-ack]').forEach(b=>b.onclick=()=>act(()=>api(`/andon/calls/${b.dataset.ack}/acknowledge`,'POST',withOperator({})),t('op.savedAck')));
  document.querySelectorAll('[data-ticket]').forEach(b=>b.onclick=()=>act(()=>api(`/andon/calls/${b.dataset.ticket}/ticket`,'POST',withOperator({})),t('op.savedTicket')));
  document.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=()=>{ S.sheet={kind:'resolve',id:b.dataset.resolve}; render(); $('#resolution')?.focus(); });
  const res=$('[data-do-resolve]'); if (res) res.onclick=()=>act(()=>api(`/andon/calls/${res.dataset.doResolve}/resolve`,'POST',withOperator({resolution:$('#resolution').value})),t('op.savedResolved'));
  const op=$('[data-save-operator]'); if (op) op.onclick=()=>{ S.operator=$('#op-name').value.trim().slice(0,80); store.set('localStorage',OP_KEY,S.operator); S.sheet=null; render(); };
  const back=$('.sheet-back'); if (back) document.onkeydown=e=>{ if (e.key==='Escape') { S.sheet=null; render(); } }; else document.onkeydown=null;
}
function render() {
  if (!S.token||!S.me) { loginView(); return; }
  $('#app').innerHTML=S.machineId&&S.view?machineView():pickerView();
  bind();
}
// Live: timers every second; data every 15 seconds while no sheet is open.
setInterval(()=>tickTimers(),1000);
setInterval(()=>{ if (S.token&&S.me&&S.machineId&&!S.sheet&&document.visibilityState==='visible') load(); },15000);
(async()=>{ if (S.token) { try { await start(); return; } catch (e) { if (!e.quiet) { store.del('localStorage',ST_KEY); store.del('sessionStorage',USER_KEY); S.token=null; } } } render(); })();
