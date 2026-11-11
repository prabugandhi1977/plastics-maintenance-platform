// Procedures in the field app. The ticket's procedures come with the cached ticket, so a technician who opened the job
// while online can keep recording steps without a connection. A step is one queued action (with its photo inside, because the
// photo's id does not exist yet), applied to the cached copy straight away and replayed in order when the connection returns.
// A queued action the server refuses stops the queue, so every rule the server checks is checked here first.
const RUNNING=['accepted','in_progress','escalated'];
const ROLES=['engineer','provider_admin','provider_engineer','platform_admin','dispatcher'];
const MAX_PHOTO=5*1024*1024;

export function createProcedures({safe,t,_t,formatNumber,formatDateTime,zone}) {
  const canRecord=(tk,role)=>ROLES.includes(role)&&RUNNING.includes(tk.status);
  const canAdd=(tk,role)=>ROLES.includes(role)&&tk.status!=='completed';
  const stepOf=(tk,id)=>{ for (const r of tk.procedures||[]) { const s=r.steps.find(x=>x.id===id); if (s) return s; } return null; };
  const limits=m=>m.min!=null&&m.max!=null?`${formatNumber(m.min,2)} – ${formatNumber(m.max,2)}`:m.min!=null?`≥ ${formatNumber(m.min,2)}`:m.max!=null?`≤ ${formatNumber(m.max,2)}`:'';
  // Mandatory steps still to do, as "procedure: step".
  const openSteps=tk=>(tk.procedures||[]).flatMap(r=>r.steps.filter(s=>s.mandatory&&s.status==='pending').map(s=>`${r.title}: ${s.title}`));

  function recordedHtml(s) {
    if (s.status==='pending') return '';
    const bits=[];
    if (s.measurement&&s.measurementValue!=null) bits.push(`<b>${safe(s.measurement.name)}: ${formatNumber(s.measurementValue,3)}${s.measurement.unit?' '+safe(s.measurement.unit):''}</b> <span class="badge ${s.inRange?'approved':'critical'}">${safe(s.inRange?_t('prc.inRange'):_t('prc.outOfRange'))}</span>`);
    if (s.photoId||s.photoPending) bits.push(s.photoPending?'📷':`📷 ${safe(_t('prc.photo'))}`);
    if (s.note) bits.push(`${safe(_t('prc.noteLabel'))}: ${safe(s.note)}`);
    if (s.deviation) bits.push(`<span class="overdue">${safe(_t('prc.deviationLabel'))}: ${safe(s.deviation)}</span>`);
    return `<p class="muted">${bits.join('<br>')}<br>${s.pending?`<i>${safe(t('msg.savedOffline'))}</i>`:`${safe(s.status==='skipped'?_t('prc.skipped'):_t('prc.doneBy'))} · ${formatDateTime(s.completedAt,zone())}`}</p>`;
  }
  function stepHtml(tk,s,role) {
    const m=s.measurement, can=canRecord(tk,role);
    const buttons=!can?'':s.status==='pending'?`<button data-step="record" data-id="${safe(s.id)}">${safe(_t('prc.record'))}</button>${s.mandatory?'':`<button class="secondary" data-step="skip" data-id="${safe(s.id)}">${safe(_t('prc.skip'))}</button>`}`:`<button class="secondary" data-step="undo" data-id="${safe(s.id)}">${safe(t('action.undo'))}</button>`;
    return `<div class="pstep ${s.status}"><div class="row"><b>${s.position}. ${safe(s.title)}</b><span class="badge ${s.status==='done'?'approved':''}">${safe(_t('prc.status.'+s.status))}</span></div>`
      +(s.safety?`<div class="notice pstep-safety">⚠ ${safe(s.safety)}</div>`:'')+(s.instruction?`<p>${safe(s.instruction).replaceAll('\n','<br>')}</p>`:'')
      +(s.spec?`<p class="muted"><b>${safe(_t('prc.spec'))}:</b> ${safe(s.spec)}</p>`:'')
      +(m?`<p class="muted"><b>${safe(_t('prc.measure'))}:</b> ${safe(m.name)}${limits(m)?` · ${limits(m)}`:''}${m.unit?' '+safe(m.unit):''}</p>`:'')
      +(s.requiresPhoto?`<p class="muted">📷 ${safe(_t('prc.photoRequired'))}</p>`:'')
      +(s.parts?.length?`<p class="muted"><b>${safe(_t('prc.parts'))}:</b> ${s.parts.map(p=>`${safe(p.partNumber)} × ${p.quantity}`).join(', ')}</p>`:'')
      +recordedHtml(s)+(buttons?`<div class="actions">${buttons}</div>`:'')+`</div>`;
  }
  // The section on the ticket page; online-only "Add procedure" is a form button (data-form="procedure").
  function card(tk,role) {
    const runs=tk.procedures||[], add=canAdd(tk,role);
    if (!runs.length&&!add) return '';
    const body=runs.map(r=>{ const mand=r.steps.filter(s=>s.mandatory), done=mand.filter(s=>s.status==='done').length;
      return `<div class="card"><div class="row"><h2>${safe(r.title)} <span class="muted">v${r.version}</span></h2><span class="badge ${r.status==='completed'?'approved':''}">${safe(_t('prc.runStatus.'+r.status))}</span></div><p class="muted">${safe(_t('prc.progress',{done,total:mand.length}))}</p>${r.steps.map(s=>stepHtml(tk,s,role)).join('')}</div>`; }).join('');
    const hint=runs.length&&ROLES.includes(role)&&!RUNNING.includes(tk.status)&&tk.status!=='completed'?`<p class="muted">${safe(_t('prc.acceptFirst'))}</p>`:'';
    return `<div class="section">${safe(_t('prc.title'))}</div>${body||`<div class="card muted">${safe(_t('prc.none'))}</div>`}${hint}${add?`<div class="actions"><button class="secondary" data-form="procedure">${safe(_t('prc.add'))}</button></div>`:''}`;
  }
  // Form fields for recording or skipping a step.
  function formHtml(kind,s) {
    if (kind==='skip') return `<p><b>${safe(s.title)}</b></p><label>${safe(_t('prc.whySkipped'))}<textarea name="note" required maxlength="1000"></textarea></label>`;
    const m=s.measurement;
    return `<p><b>${safe(s.title)}</b></p>${s.safety?`<div class="notice pstep-safety">⚠ ${safe(s.safety)}</div>`:''}${s.instruction?`<p>${safe(s.instruction).replaceAll('\n','<br>')}</p>`:''}${s.spec?`<p class="muted"><b>${safe(_t('prc.spec'))}:</b> ${safe(s.spec)}</p>`:''}`
      +(m?`<label>${safe(m.name)}${m.unit?` (${safe(m.unit)})`:''}<input name="measurementValue" type="number" step="any" inputmode="decimal" required></label>${limits(m)?`<small class="help">${safe(_t('prc.limits',{value:limits(m)}))}</small>`:''}`:'')
      +(s.requiresPhoto?`<label>${safe(_t('prc.photoField'))}<input name="file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>`:'')
      +`<label>${safe(_t('prc.noteField'))}<textarea name="note" maxlength="1000"></textarea></label><label>${safe(_t('prc.deviationField'))}<textarea name="deviation" maxlength="500"></textarea></label><small class="help">${safe(_t('prc.deviationHelp'))}</small>`;
  }
  const toBase64=file=>new Promise((resolve,reject)=>{ const r=new FileReader(); r.onload=()=>resolve(String(r.result).split(',')[1]); r.onerror=reject; r.readAsDataURL(file); });
  // Turns the form into the queued action's body, or {error}. The same rules as the server.
  async function prepare(kind,s,fd) {
    const note=String(fd.get('note')||'').trim();
    if (kind==='skip') { if (!note) return {error:_t('prc.whySkipped')}; return {body:{status:'skipped',note},local:{status:'skipped',note}}; }
    const deviation=String(fd.get('deviation')||'').trim(), body={status:'done',note,deviation}, local={status:'done',note,deviation};
    const m=s.measurement;
    if (m) {
      const raw=fd.get('measurementValue'), v=raw===''||raw==null?NaN:Number(raw);
      if (!Number.isFinite(v)) return {error:_t('prc.enterValue',{value:m.name})};
      const inRange=(m.min==null||v>=m.min)&&(m.max==null||v<=m.max);
      if (!inRange&&!deviation) return {error:_t('prc.valueOutside',{name:m.name,value:formatNumber(v,3),limits:limits(m)})};
      body.measurementValue=v; local.measurementValue=v; local.inRange=inRange;
    }
    if (s.requiresPhoto) {
      const f=fd.get('file'); if (!f||!f.size) return {error:_t('prc.photoNeeded')};
      if (f.size>MAX_PHOTO) return {error:_t('field.photoExceeds5Mb')};
      body.photo={filename:f.name,mime:f.type,base64:await toBase64(f)}; local.photoPending=true;
    }
    return {body,local};
  }
  // The cached copy shows the step as recorded at once, marked as waiting to sync, and the run's status follows.
  function applyLocal(tk,stepId,patch,userId) {
    for (const r of tk.procedures||[]) { const s=r.steps.find(x=>x.id===stepId); if (!s) continue;
      if (patch.status==='pending') Object.assign(s,{status:'pending',measurementValue:null,inRange:null,photoId:null,photoPending:false,note:'',deviation:'',completedAt:null,completedBy:null,seconds:null,pending:true});
      else Object.assign(s,{measurementValue:null,inRange:null,photoId:null,photoPending:false,note:'',deviation:''},patch,{completedAt:new Date().toISOString(),completedBy:userId,seconds:null,pending:true});
      const left=r.steps.filter(x=>x.mandatory&&x.status==='pending').length; r.status=left?'in_progress':'completed'; r.completedAt=left?null:r.completedAt||new Date().toISOString(); return; }
  }
  return { card, formHtml, prepare, applyLocal, openSteps, stepOf, canRecord, canAdd };
}
