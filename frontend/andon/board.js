// Andon board for a hall TV: one tile per machine of a plant, coloured by state, with open andon calls and their timers.
// Dark, large type, refreshes every 15 seconds. Signs in as a board station (code + PIN, stays signed in for 30 days)
// or uses the desktop sign-in of this browser; a person can pick the plant (?plantId=).
import { t, setLocale, formatNumber } from '/shared/i18n.js';
import { ANDON_ICONS, stateLabel, reasonLabel, typeLabel, callStatusLabel, tickTimers, elapsed } from '/shared/andon.js';

const $=s=>document.querySelector(s), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const get=(a,k)=>{try{return window[a].getItem(k)}catch{return null}}, set=(a,k,v)=>{try{window[a].setItem(k,v)}catch{}}, del=(a,k)=>{try{window[a].removeItem(k)}catch{}};
const BOARD_KEY='mc_board_station', params=new URLSearchParams(location.search);
const S={token:get('localStorage',BOARD_KEY)||get('localStorage','mc_op_station')||get('sessionStorage','pmp_session')||get('localStorage','pmp_session'),plantId:params.get('plantId')||'',board:null,plants:[],error:'',updated:null,failed:false};

async function api(path,method='GET',body) {
  const r=await fetch('/api'+path,{method,headers:{'content-type':'application/json',...(S.token?{authorization:`Bearer ${S.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({})); if (!r.ok) throw Object.assign(Error(data.error||`HTTP ${r.status}`),{status:r.status}); return data;
}
function loginView() {
  $('#app').innerHTML=`<main class="login"><h1>${esc(t('board.title'))}</h1><p>${esc(t('board.loginIntro'))}</p>${S.error?`<p class="err" role="alert">${esc(S.error)}</p>`:''}
    <form id="login"><label for="code">${esc(t('op.stationCode'))}</label><input id="code" name="code" autocapitalize="characters" required><label for="pin">${esc(t('op.pin'))}</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" required><button>${esc(t('op.signIn'))}</button></form>
    <p class="hint">${esc(t('board.loginHint'))}</p></main>`;
  $('#login').onsubmit=async e=>{ e.preventDefault(); const f=new FormData(e.target);
    try { const r=await api('/operator/login','POST',{code:String(f.get('code')),pin:String(f.get('pin'))}); S.token=r.token; set('localStorage',BOARD_KEY,r.token); S.error=''; await start(); } catch (err) { S.error=err.message; loginView(); } };
}
async function start() {
  const me=await api('/operator/me'); setLocale(me.locale||'en');
  if (me.plants) { S.plants=me.plants; if (!S.plantId&&me.plants.length) S.plantId=me.plants[0].id; }
  await load();
}
async function load() {
  try { S.board=await api(`/andon/board${S.plantId?`?plantId=${encodeURIComponent(S.plantId)}`:''}`); S.updated=Date.now(); S.failed=false; }
  catch (e) { if (e.status===401) { del('localStorage',BOARD_KEY); S.token=null; S.board=null; S.error=t('op.sessionEnded'); return loginView(); } S.failed=true; }
  render();
}
const pct=v=>v==null?'—':`${formatNumber(v,0)} %`;
function tile(m) {
  const waiting=m.calls.some(c=>c.status==='open'), worst=m.calls.find(c=>c.type==='safety')||m.calls[0];
  return `<article class="tile s-${esc(m.state)} ${m.calls.length?'has-call':''} ${waiting?'waiting':''} ${worst?'c-'+esc(worst.type):''}" aria-label="${esc(m.assetTag)}: ${esc(stateLabel(m.state))}${m.calls.length?', '+esc(t('board.openCalls',{n:m.calls.length})):''}">
    <header><b>${esc(m.assetTag||m.name)}</b><span class="oee">OEE ${pct(m.oee)}</span></header>
    <div class="st"><strong>${esc(stateLabel(m.state))}</strong><time data-since="${esc(m.since||'')}">${elapsed(m.since)}</time></div>
    <div class="sub">${m.reason?esc(reasonLabel(m.reason)):esc(m.product||'')}</div>
    ${m.calls.map(c=>`<div class="callband ${esc(c.type)} ${esc(c.status)}"><span>${ANDON_ICONS[c.type]} ${esc(typeLabel(c.type))}${c.level?` <em>▲${c.level}</em>`:''}</span><time data-since="${esc(c.raisedAt)}">${elapsed(c.raisedAt)}</time><small>${c.status==='open'?esc(t('board.waiting')):esc(t('op.answeredBy',{name:c.acknowledgedBy||callStatusLabel(c.status)}))}</small></div>`).join('')}
  </article>`;
}
function render() {
  const b=S.board; if (!b) return;
  const n=s=>b.tiles.filter(x=>x.state===s).length, calls=b.tiles.reduce((a,x)=>a+x.calls.length,0), waiting=b.tiles.reduce((a,x)=>a+x.calls.filter(c=>c.status==='open').length,0);
  const picker=S.plants.length>1?`<select id="plant" aria-label="${esc(t('board.plant'))}">${S.plants.map(p=>`<option value="${esc(p.id)}" ${p.id===b.plant.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>`:'';
  $('#app').innerHTML=`<header class="bar"><div><h1>${esc(b.plant.name)}</h1><span>${b.shift?esc(t('op.shift',{name:b.shift.name})):esc(t('board.noShift'))}</span></div>
    <div class="counts"><span class="c run">${n('running')} <small>${esc(stateLabel('running'))}</small></span><span class="c down">${n('down')} <small>${esc(stateLabel('down'))}</small></span><span class="c wait">${n('idle')+n('setup')} <small>${esc(t('board.idleSetup'))}</small></span><span class="c call ${waiting?'blink':''}">${calls} <small>${esc(t('board.calls'))}</small></span></div>
    <div class="right">${picker}<span class="clock" id="clock"></span><button type="button" id="fs" aria-label="${esc(t('board.fullScreen'))}">⛶</button></div></header>
    ${S.failed?`<p class="err" role="alert">${esc(t('board.stale',{time:new Date(S.updated||Date.now()).toLocaleTimeString()}))}</p>`:''}
    <main class="grid">${b.tiles.length?b.tiles.map(tile).join(''):`<p class="empty">${esc(t('board.noMachines'))}</p>`}</main>`;
  const sel=$('#plant'); if (sel) sel.onchange=()=>{ S.plantId=sel.value; const u=new URL(location.href); u.searchParams.set('plantId',S.plantId); history.replaceState(null,'',u); load(); };
  $('#fs').onclick=()=>document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen?.().catch(()=>{});
  clock();
}
function clock() { const c=$('#clock'); if (c&&S.board) c.textContent=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:S.board.plant.timezone}).format(new Date()); }
setInterval(()=>{ tickTimers(); clock(); },1000);
setInterval(()=>{ if (S.board) load(); },15000);
(async()=>{ if (!S.token) return loginView(); try { await start(); } catch (e) { if (e.status===401||e.status===403) { del('localStorage',BOARD_KEY); S.token=null; S.error=e.status===403?e.message:''; } else S.error=e.message; loginView(); } })();
