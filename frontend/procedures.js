// Procedures on a ticket: the technician's step-by-step view. Each attached procedure shows its steps with the safety callout,
// instruction, specification, parts and the measurement expected; the technician records a step (value, photo, note, deviation),
// skips one that is not mandatory, or reopens one. Staff who see the ticket see what was recorded. The server applies the rules
// (a value outside the limits needs a deviation note, a required photo, mandatory steps cannot be skipped).
import { esc, btn, field, openDialog, confirmAction, toast } from './ui.js';
import { formatNumber, t as _t } from './shared/i18n.js';

export function createProcedures(ctx) {
  const { state, api, fail, refresh, fieldWorker, when, fileBase64 } = ctx;
  const RUNNING=['accepted','in_progress','escalated'];
  const ticket=()=>state.detail?.value;
  const canRecord=tk=>fieldWorker()&&RUNNING.includes(tk.status);
  const stepOf=id=>{ for (const r of ticket()?.procedures||[]) { const s=r.steps.find(x=>x.id===id); if (s) return {run:r,step:s}; } return {}; };
  const limits=m=>m.min!=null&&m.max!=null?`${formatNumber(m.min,2)} – ${formatNumber(m.max,2)}`:m.min!=null?`≥ ${formatNumber(m.min,2)}`:m.max!=null?`≤ ${formatNumber(m.max,2)}`:'';
  const minutes=sec=>sec==null?'':`${sec<60?'< 1':formatNumber(Math.round(sec/60))} min`;

  function recorded(s,zone) {
    if (s.status==='pending') return '';
    const bits=[];
    if (s.measurement&&s.measurementValue!=null) bits.push(`<b>${esc(s.measurement.name)}: ${formatNumber(s.measurementValue,3)}${s.measurement.unit?' '+esc(s.measurement.unit):''}</b> <span class="pill ${s.inRange?'approved':'critical'}">${esc(s.inRange?_t('prc.inRange'):_t('prc.outOfRange'))}</span>`);
    if (s.photoId) bits.push(`<a href="/api/attachments/${esc(s.photoId)}" data-download="${esc(s.photoId)}">${esc(_t('prc.photo'))}</a>`);
    if (s.note) bits.push(`${esc(_t('prc.noteLabel'))}: ${esc(s.note)}`);
    if (s.deviation) bits.push(`<span class="overdue">${esc(_t('prc.deviationLabel'))}: ${esc(s.deviation)}</span>`);
    const who=`${esc(s.status==='skipped'?_t('prc.skipped'):_t('prc.doneBy'))} ${esc(s.completedBy===state.user.id?_t('prc.you'):s.completedBy||'')} · ${when(s.completedAt,zone)}${s.seconds!=null&&s.status==='done'?` · ${minutes(s.seconds)}`:''}`;
    return `<div class="mini proc-record">${bits.map(b=>`<p>${b}</p>`).join('')}<p class="muted">${who}</p></div>`;
  }
  function stepHtml(tk,s,zone) {
    const m=s.measurement, can=canRecord(tk);
    const actions=!can?'':s.status==='pending'?btn(_t('prc.record'),'procStep','primary',s.id)+(s.mandatory?'':btn(_t('prc.skip'),'procSkip','secondary',s.id)):btn(_t('action.undo'),'procUndo','secondary',s.id);
    return `<div class="proc-step ${s.status}"><div class="spread"><b>${s.position}. ${esc(s.title)}</b><span>${s.mandatory?'':`<span class="pill">${esc(_t('prc.optional'))}</span> `}<span class="pill ${s.status==='done'?'approved':s.status==='skipped'?'':'pending'}">${esc(_t('prc.status.'+s.status))}</span></span></div>`
      +(s.safety?`<div class="notice warn proc-safety" role="note">⚠ ${esc(s.safety)}</div>`:'')
      +(s.instruction?`<p>${esc(s.instruction).replaceAll('\n','<br>')}</p>`:'')
      +(s.spec?`<p class="mini"><b>${esc(_t('prc.spec'))}:</b> ${esc(s.spec)}</p>`:'')
      +(m?`<p class="mini"><b>${esc(_t('prc.measure'))}:</b> ${esc(m.name)}${limits(m)?` · ${limits(m)}`:''}${m.unit?' '+esc(m.unit):''}</p>`:'')
      +(s.requiresPhoto?`<p class="mini">📷 ${esc(_t('prc.photoRequired'))}</p>`:'')
      +(s.parts?.length?`<p class="mini"><b>${esc(_t('prc.parts'))}:</b> ${s.parts.map(p=>`${esc(p.partNumber)} × ${p.quantity}`).join(', ')}</p>`:'')
      +(s.expectedMinutes?`<p class="mini muted">${esc(_t('prc.expected',{value:s.expectedMinutes}))}</p>`:'')
      +recorded(s,zone)+(actions?`<div class="proc-actions">${actions}</div>`:'')+`</div>`;
  }
  function panel(tk,zone) {
    const runs=tk.procedures||[], canAdd=fieldWorker()&&tk.status!=='completed';
    if (!runs.length&&!canAdd) return '';
    const body=runs.map(r=>{ const mand=r.steps.filter(s=>s.mandatory), done=mand.filter(s=>s.status==='done').length;
      return `<div class="proc-run"><div class="spread"><h3>${esc(r.title)} <span class="muted">v${r.version}</span></h3><span><span class="muted">${esc(_t('prc.progress',{done,total:mand.length}))}</span> <span class="pill ${r.status==='completed'?'approved':'pending'}">${esc(_t('prc.runStatus.'+r.status))}</span></span></div>${r.steps.map(s=>stepHtml(tk,s,zone)).join('')}</div>`; }).join('');
    const hint=runs.length&&fieldWorker()&&!canRecord(tk)&&tk.status!=='completed'?`<p class="mini muted">${esc(_t('prc.acceptFirst'))}</p>`:'';
    return `<div class="panel"><div class="spread"><h2>${esc(_t('prc.title'))}</h2>${canAdd?btn(_t('prc.add'),'procAttach','secondary'):''}</div>${body||`<p class="muted">${esc(_t('prc.none'))}</p>`}${hint}</div>`;
  }

  async function attachDialog() {
    const tk=ticket(), list=await api(`/procedures?status=active&machineType=${encodeURIComponent(tk.asset?.machine_type||'')}`).catch(e=>{ fail(e); return null; });
    if (!list) return;
    const have=new Set((tk.procedures||[]).map(r=>r.code)), open=list.filter(p=>!have.has(p.code));
    if (!open.length) return toast(_t('prc.nonAvailable'),'error');
    openDialog(_t('prc.add'),`<div class="form-grid"><div class="fld wide"><label for="f-procedureId">${esc(_t('prc.choose'))} <span class="req">*</span></label><select name="procedureId" id="f-procedureId" required>${open.map(p=>`<option value="${esc(p.id)}">${esc(p.title)} (${esc(p.code)} v${p.version}, ${esc(_t('prc.steps',{value:p.stepCount}))})</option>`).join('')}</select></div></div>`,
      {submitLabel:_t('prc.attach'),onSubmit:async fd=>{ await api(`/tickets/${tk.id}/procedures`,'POST',{procedureId:fd.get('procedureId')}); toast(_t('prc.attached')); await refresh(); }});
  }
  function stepDialog(s) {
    const tk=ticket(), m=s.measurement;
    const body=`${s.safety?`<div class="notice warn wide" role="note">⚠ ${esc(s.safety)}</div>`:''}${s.instruction?`<p class="wide">${esc(s.instruction).replaceAll('\n','<br>')}</p>`:''}${s.spec?`<p class="wide mini"><b>${esc(_t('prc.spec'))}:</b> ${esc(s.spec)}</p>`:''}`
      +(m?field('measurementValue',`${m.name}${m.unit?` (${m.unit})`:''}`,{type:'number',step:'any',required:true,help:limits(m)?_t('prc.limits',{value:limits(m)}):''}):'')
      +(s.requiresPhoto?`<div class="fld wide"><label for="f-file">${esc(_t('prc.photoField'))} <span class="req">*</span></label><input id="f-file" name="file" type="file" accept="image/png,image/jpeg,image/webp" required></div>`:'')
      +field('note',_t('prc.noteField'),{type:'textarea',wide:true,maxlength:1000})
      +field('deviation',_t('prc.deviationField'),{type:'textarea',wide:true,maxlength:500,help:_t('prc.deviationHelp')});
    openDialog(`${s.position}. ${s.title}`,`<div class="form-grid">${body}</div>`,{submitLabel:_t('prc.markDone'),onSubmit:async fd=>{
      const b={status:'done',note:String(fd.get('note')||'').trim(),deviation:String(fd.get('deviation')||'').trim()};
      if (m) b.measurementValue=fd.get('measurementValue')===''?null:Number(fd.get('measurementValue'));
      const f=fd.get('file'); if (s.requiresPhoto&&f&&f.size) b.photoId=(await api('/attachments','POST',{entityType:'ticket',entityId:tk.id,kind:'photo',filename:f.name,mime:f.type,base64:await fileBase64(f)})).id;
      await api(`/procedure-steps/${s.id}`,'PATCH',b); toast(_t('prc.stepSaved')); await refresh();
    }});
  }
  function skipDialog(s) {
    openDialog(`${_t('prc.skip')}: ${s.title}`,`<div class="form-grid">${field('note',_t('prc.whySkipped'),{type:'textarea',wide:true,required:true,maxlength:1000})}</div>`,
      {submitLabel:_t('prc.skip'),onSubmit:async fd=>{ await api(`/procedure-steps/${s.id}`,'PATCH',{status:'skipped',note:String(fd.get('note')||'').trim()}); toast(_t('prc.stepSaved')); await refresh(); }});
  }
  async function undo(s) {
    if (!await confirmAction(_t('prc.undoTitle'),_t('prc.undoText',{value:s.title}),{confirmLabel:_t('action.undo'),danger:false})) return;
    try { await api(`/procedure-steps/${s.id}`,'PATCH',{status:'pending'}); toast(_t('prc.stepSaved')); await refresh(); } catch (e) { fail(e); }
  }
  function action(name,id) {
    if (name==='procAttach') { attachDialog(); return true; }
    const { step }=stepOf(id); if (!step) return true;
    if (name==='procStep') stepDialog(step); else if (name==='procSkip') skipDialog(step); else if (name==='procUndo') undo(step);
    return true;
  }
  return { panel, action, ACTIONS:['procAttach','procStep','procSkip','procUndo'] };
}
