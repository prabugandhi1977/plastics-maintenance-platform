// Shared UI building blocks for the web workspace: escaping, buttons and pills, filterable tables, catalogue-driven
// form fields with required markers and units, modal dialogs, confirmations and toasts.
import { t, label, t as _t } from './shared/i18n.js';

export const $=s=>document.querySelector(s);
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const btn=(text,action,cls='',id='',title='')=>`<button type="button" class="${cls}" data-action="${action}"${id?` data-id="${esc(id)}"`:''}${title?` title="${esc(title)}"`:''}>${esc(text)}</button>`;
export const pill=(group,value)=>`<span class="pill ${esc(value)}">${esc(label(group,value))}</span>`;

// Option labels for catalogue codes: acronyms and trade terms a plain "humanise" would get wrong.
const OPTION_LABELS={get ppe_missing(){ return _t('ui.ppeMissing'); },get extrusion_blow(){ return _t('ui.extrusionBlowMouldingEbm'); },get injection_blow(){ return _t('ui.injectionBlowMouldingIbm'); },get stretch_blow(){ return _t('ui.stretchBlowMouldingIsbm'); },get temperature_controller(){ return _t('ui.temperatureControlUnitTcu'); },get dosing_blender(){ return _t('ui.dosingBlender'); },get reduced_output(){ return _t('ui.runningReducedOutput'); },get quality_issue(){ return _t('ui.runningQualityIssue'); },get running(){ return _t('ui.runningNormally'); },get stopped(){ return _t('ui.stopped'); },get wear_and_ageing(){ return _t('ui.wearAndAgeing'); },get operation_error(){ return _t('ui.operatingError'); },get maintenance_error(){ return _t('ui.maintenanceError'); },get material_or_supply(){ return _t('ui.materialOrSupply'); },get external_influence(){ return _t('ui.externalInfluence'); },get fail_to_start(){ return _t('ui.failsToStart'); },get fail_to_stop(){ return _t('ui.failsToStop'); },get low_output(){ return _t('ui.lowOrUnstableOutput'); },get erratic_operation(){ return _t('ui.erraticOperation'); },get abnormal_noise_vibration(){ return _t('ui.abnormalNoiseOrVibration'); },get external_leakage(){ return _t('ui.externalLeakage'); },get quality_defect(){ return _t('ui.productQualityDefect'); },get structural_damage(){ return _t('ui.structuralDamage'); },get minor_issue(){ return _t('ui.minorInServiceProblem'); },get software_update(){ return _t('ui.softwareUpdate'); },get temporary_fix(){ return _t('ui.temporaryFix'); },get in_service(){ return _t('ui.inService'); },get out_of_service(){ return _t('ui.outOfService'); },'8x5':'8×5 (office hours)','12x5':'12×5','16x6':'16×6','24x7':'24×7 (round the clock)','24x5':'24×5','16x5':'16×5 (two shifts)',pcs:'pieces',l:'litres',m:'metres',kg:'kg',get A(){ return _t('ui.aProductionCriticalOrSafety'); },get B(){ return _t('ui.bImportantWorkaroundPossible'); },get C(){ return _t('ui.cLowImpact'); }};
export const opt=v=>OPTION_LABELS[v]??label('machine',v)??String(v);
export const humanise=v=>{ const s=OPTION_LABELS[v]??String(v??'').replaceAll('_',' '); return s.charAt(0).toUpperCase()+s.slice(1); };

// ---------- Tables with search and filters ----------
// filters: [{key,label,options:[[value,label]],match:(row,value)=>bool}]; state is kept per table id across renders.
const tableState={};
export function dataTable(id,{rows,columns,search,filters=[],empty=t('msg.noRecords'),actions=''}) {
  const st=tableState[id]??={q:'',f:{}};
  const q=st.q.trim().toLowerCase();
  const visible=rows.filter(r=>(!q||search(r).toLowerCase().includes(q))&&filters.every(f=>!st.f[f.key]||f.match(r,st.f[f.key])));
  const controls=`<div class="table-tools" data-table="${id}"><input type="search" class="tt-search" placeholder="${_t('ui.search')}" aria-label="${_t('ui.search2')}" value="${esc(st.q)}">${filters.map(f=>`<select class="tt-filter" data-key="${f.key}" aria-label="${esc(f.label)}"><option value="">${_t('ui.all',{label:esc(f.label)})}</option>${f.options.map(([v,l])=>`<option value="${esc(v)}" ${st.f[f.key]===v?'selected':''}>${esc(l)}</option>`).join('')}</select>`).join('')}<span class="muted tt-count">${_t('ui.of',{length:visible.length,length2:rows.length})}</span>${actions}</div>`;
  const body=visible.length?visible.map(r=>`<tr>${columns.map(c=>`<td${c.cls?` class="${c.cls}"`:''}>${c.cell(r)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${columns.length}" class="empty">${rows.length?_t('ui.noMatchesClearTheSearch'):esc(empty)}</td></tr>`;
  return `${controls}<div class="table-wrap"><table><thead><tr>${columns.map(c=>`<th${c.cls?` class="${c.cls}"`:''}>${esc(c.title)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// Re-render on input while keeping the cursor in the search box.
export function bindTables(rerender) {
  document.querySelectorAll('.table-tools[data-table]').forEach(box=>{
    const id=box.dataset.table, st=tableState[id];
    const search=box.querySelector('.tt-search');
    search.oninput=()=>{ st.q=search.value; const pos=search.selectionStart; rerender(); const again=document.querySelector(`${`.table-tools[data-table="${id}"] .tt-search`}`); if (again) { again.focus(); again.setSelectionRange(pos,pos); } };
    box.querySelectorAll('.tt-filter').forEach(sel=>sel.onchange=()=>{ st.f[sel.dataset.key]=sel.value; rerender(); });
  });
}
export const simpleTable=(headers,rows,empty=t('msg.noRecords'))=>`<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${headers.length}" class="empty">${esc(empty)}</td></tr>`}</tbody></table></div>`;

// ---------- Form fields ----------
// Every field shows a visible label; required fields carry an asterisk and aria-required. Units sit beside the input.
const req=r=>r?' <span class="req" aria-hidden="true">*</span>':'';
const attrs=o=>Object.entries(o).filter(([,v])=>v!==undefined&&v!==false&&v!==null).map(([k,v])=>v===true?k:`${k}="${esc(v)}"`).join(' ');
export function field(name,text,{type='text',value='',required=false,unit='',help='',wide=false,...rest}={}) {
  const input=type==='textarea'?`<textarea name="${name}" id="f-${name}" ${attrs({required,'aria-required':required||undefined,...rest})}>${esc(value)}</textarea>`
    :`<input name="${name}" id="f-${name}" type="${type}" value="${esc(value)}" ${attrs({required,'aria-required':required||undefined,...rest})}>`;
  return `<div class="fld${wide?' wide':''}"><label for="f-${name}">${esc(text)}${req(required)}</label>${unit?`<div class="with-unit">${input}<span class="unit">${esc(unit)}</span></div>`:input}${help?`<small class="help">${esc(help)}</small>`:''}</div>`;
}
export function select(name,text,options,{value='',required=false,help='',wide=false,placeholder=required?_t('ui.select'):'—',...rest}={}) {
  return `<div class="fld${wide?' wide':''}"><label for="f-${name}">${esc(text)}${req(required)}</label><select name="${name}" id="f-${name}" ${attrs({required,'aria-required':required||undefined,...rest})}><option value="">${esc(placeholder)}</option>${options.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(l)}</option>`).join('')}</select>${help?`<small class="help">${esc(help)}</small>`:''}</div>`;
}
export function checkboxes(name,text,options,{values=[],required=false,help=''}={}) {
  return `<fieldset class="fld wide checks" ${required?'data-required-group="'+name+'"':''}><legend>${esc(text)}${req(required)}</legend>${options.map(([v,l])=>`<label class="check-opt"><input type="checkbox" name="${name}" value="${esc(v)}" ${values.includes(v)?'checked':''}> ${esc(l)}</label>`).join('')}${help?`<small class="help">${esc(help)}</small>`:''}</fieldset>`;
}
export function yesNo(name,text,{value=null,required=false,help=''}={}) {
  return `<fieldset class="fld checks" ${required?'data-required-group="'+name+'"':''}><legend>${esc(text)}${req(required)}</legend><label class="check-opt"><input type="radio" name="${name}" value="no" ${value===false?'checked':''} ${required?'required':''}> ${_t('ui.no')}</label><label class="check-opt"><input type="radio" name="${name}" value="yes" ${value===true?'checked':''}> ${_t('ui.yes')}</label>${help?`<small class="help">${esc(help)}</small>`:''}</fieldset>`;
}
export const section=(title,body,note='')=>`<fieldset class="section"><legend>${esc(title)}</legend>${note?`<p class="muted wide">${esc(note)}</p>`:''}<div class="form-grid">${body}</div></fieldset>`;
// Type-specific technical parameters, generated from the server's catalogue so both always agree.
export function specFields(defs,values={},{equipment=[]}={}) {
  return defs.map(f=>{
    const name=`spec.${f.key}`, value=values?.[f.key]??'';
    if (f.type==='choice') return select(name,f.label,f.options.map(o=>[o,humanise(o)]),{value,required:f.required});
    if (f.type==='equipment') return select(name,f.label,equipment.map(e=>[e.id,`${e.asset_tag?e.asset_tag+' · ':''}${e.make} ${e.model}`]),{value,required:f.required,placeholder:_t('ui.notLinked')});
    if (f.type==='number'||f.type==='integer') return field(name,f.label,{type:'number',value,required:f.required,unit:f.unit,min:f.min,max:f.max,step:f.type==='integer'?1:'any',inputmode:f.type==='integer'?'numeric':'decimal'});
    return field(name,f.label,{value,required:f.required,maxlength:f.max});
  }).join('');
}
export const specsFromForm=fd=>Object.fromEntries([...fd.entries()].filter(([k,v])=>k.startsWith('spec.')&&v!=='').map(([k,v])=>[k.slice(5),v]));

// ---------- Dialogs, confirmations, toasts ----------
// Forms open in a modal <dialog>: Escape closes, focus moves to the first field, server errors show inside.
export function openDialog(title,content,{submitLabel=t('action.save'),onSubmit,wide=true,onOpen}={}) {
  closeDialog();
  const d=document.createElement('dialog'); d.className=`modal${wide?' wide':''}`; d.id='modal';
  d.innerHTML=`<form method="dialog" class="modal-form" novalidate><header><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="${_t('ui.close')}">✕</button></header><div class="modal-body">${content}<p class="form-error notice error" role="alert" hidden></p></div><footer>${onSubmit?_t('ui.required'):''}<span class="spacer"></span><button type="button" class="secondary" data-close>${onSubmit?t('action.cancel'):_t('ui.close')}</button>${onSubmit?`<button type="submit" class="primary">${esc(submitLabel)}</button>`:''}</footer></form>`;
  document.body.append(d);
  d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeDialog());
  d.addEventListener('close',()=>d.remove());
  const formEl=d.querySelector('form');
  // Correcting a field clears its error marking straight away.
  const clearError=e=>{ const holder=e.target.closest('.fld,.checks'); if (holder?.classList.contains('invalid')) { holder.classList.remove('invalid'); formEl.querySelector('.form-error').hidden=true; } };
  formEl.addEventListener('input',clearError); formEl.addEventListener('change',clearError);
  formEl.onsubmit=async e=>{
    e.preventDefault();
    const err=formEl.querySelector('.form-error'); err.hidden=true;
    const problem=validate(formEl); if (problem) { err.textContent=problem; err.hidden=false; return; }
    const submit=formEl.querySelector('[type=submit]'); submit.disabled=true; const label0=submit.textContent; submit.textContent=_t('ui.saving');
    try { await onSubmit(new FormData(formEl),formEl); closeDialog(); }
    catch(ex) { err.textContent=ex.message; err.hidden=false; err.scrollIntoView({block:'nearest'}); }
    finally { if (submit.isConnected) { submit.disabled=false; submit.textContent=label0; } }
  };
  d.showModal(); onOpen?.(d);
  d.querySelector('.modal-body input:not([type=hidden]),.modal-body select,.modal-body textarea')?.focus();
  return d;
}
export function closeDialog() { const d=document.getElementById('modal'); if (d) { if (d.open) d.close(); d.remove(); } }
// Client-side check before sending: marks invalid fields and returns the first problem in words.
function validate(formEl) {
  formEl.querySelectorAll('.invalid').forEach(x=>x.classList.remove('invalid'));
  for (const g of formEl.querySelectorAll('[data-required-group]')) if (!formEl.querySelector(`[name="${g.dataset.requiredGroup}"]:checked`)) { g.classList.add('invalid'); return `${_t('ui.pleaseChooseAtLeastOne',{value:g.querySelector('legend').textContent.replace('*','').trim()})}`; }
  for (const el of formEl.querySelectorAll('input,select,textarea')) {
    if (el.checkValidity()) continue;
    el.closest('.fld')?.classList.add('invalid'); el.focus();
    const name=el.closest('.fld')?.querySelector('label,legend')?.textContent.replace('*','').trim()||el.name;
    return el.validity.valueMissing?`${_t('ui.isRequired',{name:name})}`:`${name}: ${el.validationMessage}`;
  }
  return '';
}
export function confirmAction(title,message,{confirmLabel=_t('ui.confirm'),danger=true}={}) {
  return new Promise(resolve=>{
    // Stacks above an open form dialog instead of replacing it, so declining keeps the form as it was.
    const d=document.createElement('dialog'); d.className='modal confirm'; d.id='confirm-modal'; d.setAttribute('role','alertdialog');
    d.innerHTML=`<div class="modal-body"><h2>${esc(title)}</h2><p>${esc(message)}</p></div><footer><span class="spacer"></span><button type="button" class="secondary" data-no>${t('action.cancel')}</button><button type="button" class="${danger?'danger':'primary'}" data-yes>${esc(confirmLabel)}</button></footer>`;
    document.body.append(d);
    const done=v=>{ d.close(); d.remove(); resolve(v); };
    d.querySelector('[data-no]').onclick=()=>done(false); d.querySelector('[data-yes]').onclick=()=>done(true);
    d.addEventListener('cancel',e=>{ e.preventDefault(); done(false); });
    d.showModal(); d.querySelector('[data-no]').focus();
  });
}
export function toast(text,kind='ok') {
  let box=document.getElementById('toasts'); if (!box) { box=document.createElement('div'); box.id='toasts'; box.setAttribute('role','status'); box.setAttribute('aria-live','polite'); document.body.append(box); }
  const el=document.createElement('div'); el.className=`${`toast ${kind}`}`; el.innerHTML=`<span aria-hidden="true">${kind==='error'?'⚠':'✓'}</span> `; el.append(document.createTextNode(text));
  box.append(el); setTimeout(()=>el.classList.add('hide'),kind==='error'?7000:3500); setTimeout(()=>el.remove(),kind==='error'?7600:4100);
}
// A small "incomplete" badge listing which mandatory fields a legacy record still lacks.
export const incomplete=missing=>missing?.length?`<span class="pill incomplete" title="${_t('ui.missing',{value:esc(missing.join(', '))})}">${_t('ui.incomplete')}</span>`:'';
