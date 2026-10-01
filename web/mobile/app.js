import { t, label, setLocale, formatDateTime, formatDuration, formatNumber, formatTemperature } from '/shared/i18n.js';
import { signaturePad } from '/shared/signature.js';

// Field app for engineers. Works with poor connectivity: assigned work and opened tickets are cached per user,
// changes are queued in IndexedDB with a client action ID (the server deduplicates replays), applied to the cached
// copy immediately so the engineer sees them, and synced in order when the connection returns.
const $=s=>document.querySelector(s),safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={token:sessionStorage.getItem('mc_token'),user:JSON.parse(sessionStorage.getItem('mc_user')||'null'),tickets:[],selected:null,notice:'',error:'',online:navigator.onLine,pending:0,pad:null};
const TRANSITIONS={assigned:['accepted','declined','escalated'],accepted:['in_progress','escalated'],in_progress:['escalated','completed'],escalated:['in_progress','completed']};
const key=(kind,id='')=>`mc_${kind}_${state.user.id}${id?'_'+id:''}`;
const cache={get:(kind,id)=>{try{return JSON.parse(localStorage.getItem(key(kind,id))||'null')}catch{return null}},set:(kind,value,id)=>{try{localStorage.setItem(key(kind,id),JSON.stringify(value))}catch{}},
  clear:()=>Object.keys(localStorage).filter(k=>k.startsWith(`mc_`)&&k.includes(state.user.id)).forEach(k=>localStorage.removeItem(k))};
if(state.user){setLocale(state.user.preferences?.locale);state.tickets=cache.get('tickets')||[];}
const dbPromise=new Promise((resolve,reject)=>{const r=indexedDB.open('mouldcare-field',1);r.onupgradeneeded=()=>r.result.createObjectStore('actions',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
async function stored(mode,op){const db=await dbPromise;return new Promise((resolve,reject)=>{const tx=db.transaction('actions',mode),store=tx.objectStore('actions'),req=op(store);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});}
const queued=async()=>(await stored('readonly',s=>s.getAll())).filter(x=>x.userId===state.user?.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
async function pending(){state.pending=(await queued()).length;render();}
async function request(path,method='GET',body,actionId){const r=await fetch('/api'+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${state.token}`,...(actionId?{'x-client-action-id':actionId}:{})},body:body==null?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error||`HTTP ${r.status}`),{http:true,status:r.status});return data;}
const zone=()=>state.selected?.plant?.timezone;
const badge=(group,s)=>`<span class="badge ${safe(s)}">${safe(label(group,s))}</span>`;

// Optimistic edits applied to the selected ticket (and its cache) while an action waits in the queue.
function applyLocally(edit){if(!state.selected||!edit)return;edit(state.selected);state.selected.queuedChanges=true;cache.set('ticket',state.selected,state.selected.id);}
async function mutate(path,body,edit){
  const item={id:crypto.randomUUID(),userId:state.user.id,path,body,createdAt:new Date().toISOString()};
  const queue=async text=>{await stored('readwrite',s=>s.put(item));applyLocally(edit);state.notice=text;await pending();};
  if(!navigator.onLine)return queue(t('msg.savedOffline'));
  try{const result=await request(path,'POST',body,item.id);state.notice=result?.declined?t('msg.declined'):t('msg.saved');if(result?.declined)state.selected=null;await refresh();}
  catch(e){if(e.http){state.error=e.message;render();return}await queue('Connection dropped. '+t('msg.savedOffline'));}
}
async function sync(){if(!navigator.onLine||!state.token||!state.user)return;for(const item of await queued()){try{await request(item.path,'POST',item.body,item.id);await stored('readwrite',s=>s.delete(item.id));}catch(e){state.error=e.http?`Queued action needs review: ${e.message}`:'Still offline. Will retry later.';break}}await pending();await refresh();}
// Machine data is shared with field engineers only while the job is open, so it is not requested afterwards.
const withTelemetry=async tk=>({...tk,telemetry:tk.status==='completed'?null:await request(`/equipment/${tk.equipment_id}/readings?limit=1`).catch(()=>null)});
async function open(id){state.selected=cache.get('ticket',id)||state.tickets.find(x=>x.id===id);render();try{state.selected=await withTelemetry(await request(`/tickets/${id}`));cache.set('ticket',state.selected,id);render()}catch(e){if(e.http&&[403,404].includes(e.status)){state.selected=null;state.error=e.message;render()}}}
async function refresh(){
  if(!state.user)return;
  try{state.tickets=await request('/tickets');cache.set('tickets',state.tickets);state.online=true;}catch(e){if(e.http&&e.status===401)return signOut();state.online=false;state.error='Showing cached work. Changes will queue locally.';return render();}
  if(state.selected&&!state.pending){try{state.selected=await withTelemetry(await request(`/tickets/${state.selected.id}`));cache.set('ticket',state.selected,state.selected.id);}catch(e){if(e.http&&[403,404].includes(e.status))state.selected=null;}}
  render();
}
function signOut(){if(state.user)cache.clear();sessionStorage.removeItem('mc_token');sessionStorage.removeItem('mc_user');Object.assign(state,{token:null,user:null,tickets:[],selected:null});render();}

function telemetryCard(m){if(!m)return state.selected?.status==='completed'?'':`<div class="section">${t('section.machineData')}</div><div class="card muted">Unavailable offline or not shared for this asset.</div>`;return `<div class="section">${t('section.machineData')}</div><div class="card"><p>${badge('status',m.status)} ${m.lastObservedAt?`<span class="muted">${formatDateTime(m.lastObservedAt,zone())}</span>`:''}</p>${m.metrics?`<p>Running hours ${formatNumber(m.metrics.runningHours.value,1)} · Cycles ${formatNumber(m.metrics.cycleCount.value)} · ${formatTemperature(m.metrics.temperatureC.value,state.user.preferences?.units)}</p>`:''}${m.activeAlarms.map(a=>`<p>${badge('severity',a.severity)} <b>${safe(a.code)}</b> ${safe(a.message)}</p>`).join('')}</div>`}
function render(){
  if(!state.user){$('#app').innerHTML=`<div class="app"><div class="header"><div class="brand">Mould<span>Care</span> Field</div><div class="sub">${t('app.field')}</div></div><div class="login card"><h2>${t('action.signIn')}</h2><form id="login"><label>${t('label.email')}<input name="email" type="email" value="engineer@demo.test" required></label><label>${t('label.password')}<input name="password" type="password" value="DemoPass123!" required></label><button class="full">${t('action.signIn')}</button></form><p class="muted">Demo: engineer@demo.test, atlas@demo.test, euro@demo.test. Password: DemoPass123!</p>${state.error?`<div class="notice error">${safe(state.error)}</div>`:''}</div></div>`;$('#login').onsubmit=login;return}
  $('#app').innerHTML=`<div class="app"><div class="header"><div class="row"><div><div class="brand">Mould<span>Care</span> Field</div><div class="sub">${safe(state.user.name)} · ${safe(label('role',state.user.role))}</div></div><div>${state.online?'Online':'<span class="offline">Offline</span>'} ${state.pending?`<span class="count">${state.pending} queued</span>`:''}</div></div></div><div class="content">${state.notice?`<div class="notice">${safe(state.notice)}</div>`:''}${state.error?`<div class="notice error">${safe(state.error)}</div>`:''}${state.selected?detail():list()}</div><div class="footer"><button class="secondary" id="back">${state.selected?'← '+t('section.assigned'):t('action.signOut')}</button><button id="sync">${t('action.syncNow')}</button></div></div>`;
  $('#back').onclick=()=>{state.notice='';state.error='';if(state.selected){state.selected=null;render()}else if(state.pending){state.error='Sync queued work before signing out.';render()}else signOut()};
  $('#sync').onclick=sync;
  document.querySelectorAll('[data-ticket]').forEach(x=>x.onclick=()=>open(x.dataset.ticket));
  document.querySelectorAll('[data-form]').forEach(x=>x.onclick=()=>showForm(x.dataset.form));
  document.querySelectorAll('[data-check]').forEach(x=>x.onclick=()=>{const c=state.selected.checklist.find(i=>i.id===x.dataset.check),done=!c.done;if(c.id.startsWith('local-')){state.notice='This item syncs first; tick it after the next sync.';return render()}mutate(`/checklist/${c.id}`,{done,note:c.note},tk=>{tk.checklist.find(i=>i.id===c.id).done=done?1:0})});
  if($('#qr-lookup'))$('#qr-lookup').onsubmit=async e=>{e.preventDefault();const code=new FormData(e.target).get('qr').trim();try{const asset=await request(`/equipment/lookup?qr=${encodeURIComponent(code)}`);const ticket=state.tickets.find(x=>asset.ticketIds.includes(x.id)&&x.status!=='completed')||state.tickets.find(x=>asset.ticketIds.includes(x.id));if(!ticket)throw Error('No assigned ticket for this equipment');state.error='';await open(ticket.id)}catch(err){state.error=err.message;render()}};
}
function list(){return `<div class="card"><form id="qr-lookup"><label>Equipment QR label<input name="qr" placeholder="MC:..." required></label><button class="full">Find assigned work</button></form></div><div class="section">${t('section.assigned')}</div>${state.tickets.length?state.tickets.map(tk=>`<div class="card" data-ticket="${safe(tk.id)}"><div class="row"><h2>${safe(tk.title)}</h2>${badge('priority',tk.priority)}</div><p class="muted">${safe(tk.symptoms)}</p><div class="row"><span>${badge('status',tk.status)}</span><span class="muted">${formatDateTime(tk.created_at)}</span></div></div>`).join(''):`<div class="card empty">${t('msg.noRecords')}</div>`}`}
function detail(){
  const tk=state.selected,work=tk.workLogs||[],check=tk.checklist||[],events=tk.events||[],open=tk.status!=='completed';
  return `<div class="actions">${TRANSITIONS[tk.status]?`<button class="secondary" data-form="status">${t('action.updateStatus')}</button>`:''}${open?`<button data-form="work">${t('action.logWork')}</button><button class="secondary" data-form="check">${t('action.checklist')}</button>`:''}<button class="secondary" data-form="part">${t('action.requestPart')}</button><button class="secondary" data-form="photo">Photo</button>${tk.status==='completed'&&!tk.signoff?`<button data-form="signoff">${t('action.signoff')}</button>`:''}</div><div id="form-slot"></div>
  ${tk.queuedChanges&&!state.notice?`<div class="notice">${t('msg.savedOffline')}</div>`:''}<div class="card"><div class="row"><h2>${safe(tk.title)}</h2>${badge('priority',tk.priority)}</div><p>${badge('status',tk.status)} · ${safe(tk.error_codes||'—')}</p><p><b>${t('label.asset')}</b><br>${safe(tk.asset?.make||'')} ${safe(tk.asset?.model||'')} · ${safe(tk.asset?.serial_number||'')}<br>${safe(tk.plant?.name||'')} · ${safe(tk.asset?.location||'')}</p><p><b>${t('label.symptoms')}</b><br>${safe(tk.symptoms)}</p><p><b>${t('label.impact')}</b><br>${safe(tk.production_impact)}</p><p class="muted">${t('label.downtime')}: ${formatDuration(tk.downtime_minutes)}${tk.responseDueAt?` · ${t('label.responseDue')}: ${formatDateTime(tk.responseDueAt,zone())}`:''}</p>${tk.coverage?`<p class="muted">${safe(tk.coverage.title)} · ${t('label.exclusions')}: ${safe(tk.coverage.exclusions)}</p>`:''}</div>${telemetryCard(tk.telemetry)}
  <div class="section">${t('section.checklist')}</div><div class="card">${check.length?check.map(c=>`<div class="check ${c.done?'done':''}" ${open?`data-check="${safe(c.id)}" role="button"`:''}><span class="box">${c.done?'☑':'☐'}</span><span>${safe(c.item)}${c.note?` <span class="muted">${safe(c.note)}</span>`:''}</span></div>`).join(''):t('msg.noRecords')}</div>
  <div class="section">${t('section.work')}</div><div class="card">${work.length?work.map(w=>`<p>${safe(w.description)}<br><span class="muted">${formatDuration(w.minutes)} · ${safe(w.parts_used)}</span></p>`).join(''):t('msg.noRecords')}</div>
  ${tk.signoff?`<div class="card">${safe(t('msg.signedBy',{name:tk.signoff.signer_name,date:formatDateTime(tk.signoff.signed_at,zone())}))}</div>`:''}
  <div class="section">${t('section.activity')}</div><div class="card">${events.length?events.map(x=>`<p>${badge('status',x.event_type)}<br><span class="muted">${formatDateTime(x.created_at,zone())} · ${safe(x.detail)}</span></p>`).join(''):t('msg.noRecords')}</div>`;
}
function showForm(kind){
  const tk=state.selected,assignee=['engineer','provider_admin','provider_engineer'].includes(state.user.role);let html='';
  if(kind==='status')html=`<label>${t('label.status')}<select name="status">${TRANSITIONS[tk.status].filter(s=>s!=='declined'||assignee).map(x=>`<option value="${x}">${safe(label('status',x))}</option>`).join('')}</select></label><label>${t('label.downtime')} (${t('label.minutes')})<input name="downtimeMinutes" type="number" min="0" value="${tk.downtime_minutes}"></label><label>${t('label.note')} <span class="muted">${t('msg.noteRequired')}</span><textarea name="note"></textarea></label>`;
  if(kind==='work')html=`<label>Work performed<textarea name="description" required></textarea></label><label>${t('label.minutes')}<input name="minutes" type="number" min="1" required></label><label>Parts used<input name="partsUsed"></label>`;
  if(kind==='check')html=`<label>Inspection item<input name="item" required></label><label>${t('label.note')}<input name="note"></label>`;
  if(kind==='part')html=`<label>Part description<input name="item" required></label><label>Quantity<input name="quantity" type="number" min="1" value="1" required></label>`;
  if(kind==='photo')html='<label>Photo evidence<input name="file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>';
  if(kind==='signoff')html=`<label>${t('label.signerName')}<input name="signerName" required></label><label>${t('label.signature')}</label><canvas class="signature" id="sig"></canvas><button class="secondary" type="button" id="clear-sig">${t('action.clear')}</button>`;
  $('#form-slot').innerHTML=`<div class="card"><h2>${safe({status:t('action.updateStatus'),work:t('action.logWork'),check:t('action.checklist'),part:t('action.requestPart'),photo:'Photo',signoff:t('action.signoff')}[kind])}</h2><form id="action-form">${html}<button class="full">${t('action.save')}</button></form></div>`;
  if(kind==='signoff'){state.pad=signaturePad($('#sig'));$('#clear-sig').onclick=()=>state.pad.clear();}
  $('#action-form').onsubmit=e=>submit(e,kind);
}
async function submit(e,kind){
  e.preventDefault();const f=new FormData(e.target),v=Object.fromEntries(f),tk=state.selected,now=new Date().toISOString();let path,body,edit;
  if(kind==='status'){if(['declined','escalated'].includes(v.status)&&!v.note.trim()){state.error=t('msg.noteRequired');return render()}path=`/tickets/${tk.id}/status`;body={status:v.status,note:v.note,downtimeMinutes:Number(v.downtimeMinutes)};edit=x=>{x.status=v.status==='declined'?'open':v.status;x.downtime_minutes=body.downtimeMinutes;x.events=[...(x.events||[]),{event_type:v.status,detail:v.note,created_at:now}]}}
  if(kind==='work'){path=`/tickets/${tk.id}/work-logs`;body={description:v.description,minutes:Number(v.minutes),partsUsed:v.partsUsed};edit=x=>{x.workLogs=[...(x.workLogs||[]),{description:v.description,minutes:body.minutes,parts_used:v.partsUsed}]}}
  if(kind==='check'){path=`/tickets/${tk.id}/checklist`;body={item:v.item,note:v.note,done:false};edit=x=>{x.checklist=[...(x.checklist||[]),{id:'local-'+crypto.randomUUID(),item:v.item,note:v.note,done:0}]}}
  if(kind==='part'){path=`/tickets/${tk.id}/parts`;body={item:v.item,quantity:Number(v.quantity)}}
  if(kind==='photo'){const file=f.get('file');if(file.size>5*1024*1024){state.error='Photo exceeds 5 MB';return render()}const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file)});path='/attachments';body={entityType:'ticket',entityId:tk.id,kind:'evidence',filename:file.name,mime:file.type,base64}}
  if(kind==='signoff'){if(!state.pad||state.pad.isEmpty()){state.error=t('msg.signFirst');return render()}path=`/tickets/${tk.id}/signoff`;body={signerName:v.signerName,signatureBase64:state.pad.toBase64()};edit=x=>{x.signoff={signer_name:v.signerName,signed_at:now,method:'on_site'}};state.pad=null}
  state.error='';$('#form-slot').innerHTML='';await mutate(path,body,edit);
}
async function login(e){e.preventDefault();const v=Object.fromEntries(new FormData(e.target));try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)}),data=await r.json();if(!r.ok)throw Error(data.error);state.token=data.token;state.user=data.user;setLocale(data.user.preferences.locale);sessionStorage.setItem('mc_token',data.token);sessionStorage.setItem('mc_user',JSON.stringify(data.user));state.error='';if(data.user.mustChangePassword)state.notice=t('msg.mustChange')+' (web workspace → Account)';state.tickets=cache.get('tickets')||[];await pending();await sync()}catch(err){state.error=err.message;render()}}
window.addEventListener('online',()=>{state.online=true;sync()});window.addEventListener('offline',()=>{state.online=false;render()});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/mobile/sw.js').catch(()=>{});
if(state.user){pending().then(refresh)}else render();
