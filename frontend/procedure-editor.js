// Procedure editor (Administration → Procedures): the list of procedures with their versions, a step editor for drafts, publish
// and retire, a new version of a published procedure, and the per-step analytics from recorded runs. Platform administrators and
// dispatchers only; the server applies the rules. What technicians see is in procedures.js.
import { esc, btn, field, simpleTable, toast, confirmAction } from './ui.js';
import { formatNumber, label, t as _t } from './shared/i18n.js';
import { statTile } from './charts.js';

export function createProcedureEditor(ctx) {
  const { state, api, render, fail, header } = ctx;
  const types=()=>state.cat?.machineTypes||['injection','blow','extrusion','mould','auxiliary'];
  const pe=()=>(state.pe??={});
  const EMPTY_STEP=()=>({title:'',instruction:'',safety:'',spec:'',partsText:'',mName:'',mUnit:'',mMin:'',mMax:'',requiresPhoto:false,mandatory:true,expectedMinutes:''});
  const TONE={draft:'pending',active:'approved',retired:''};
  const num=v=>v===''||v==null?null:Number(v);

  // ---------- API shape <-> form shape ----------
  const toForm=p=>({id:p.id,code:p.code,version:p.version,status:p.status,title:p.title,machineTypes:p.machineTypes||[],autoAttach:!!p.autoAttach,
    steps:(p.steps||[]).map(s=>({title:s.title,instruction:s.instruction,safety:s.safety,spec:s.spec,partsText:(s.parts||[]).map(x=>`${x.partNumber} ${x.quantity}`).join('\n'),
      mName:s.measurement?.name||'',mUnit:s.measurement?.unit||'',mMin:s.measurement?.min??'',mMax:s.measurement?.max??'',requiresPhoto:!!s.requiresPhoto,mandatory:s.mandatory!==false,expectedMinutes:s.expectedMinutes??''}))});
  function parseParts(text) {
    return String(text||'').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{ const m=l.match(/^(.*?)(?:\s+(\d+))?$/); return {partNumber:m[1].trim(),quantity:m[2]?Number(m[2]):1}; });
  }
  const toApi=f=>({title:f.title,machineTypes:f.machineTypes,autoAttach:f.autoAttach,steps:f.steps.map(s=>({title:s.title,instruction:s.instruction,safety:s.safety,spec:s.spec,parts:parseParts(s.partsText),
    measurement:s.mName.trim()?{name:s.mName.trim(),unit:s.mUnit.trim(),min:num(s.mMin),max:num(s.mMax)}:null,requiresPhoto:s.requiresPhoto,mandatory:s.mandatory,expectedMinutes:num(s.expectedMinutes)}))});

  // ---------- Reading the page into the form state ----------
  function collect() {
    const f=pe().form; if (!f||f.status!=='draft') return;
    const v=id=>document.getElementById(id)?.value??'', on=id=>!!document.getElementById(id)?.checked;
    if (!f.id) f.code=v('f-pe_code').trim();
    f.title=v('f-pe_title'); f.autoAttach=on('pe-auto'); f.machineTypes=[...document.querySelectorAll('input[name=pe_types]:checked')].map(x=>x.value);
    f.steps.forEach((s,i)=>{ const k=n=>`f-s${i}_${n}`; s.title=v(k('title')); s.instruction=v(k('instruction')); s.safety=v(k('safety')); s.spec=v(k('spec')); s.partsText=v(k('parts'));
      s.mName=v(k('mName')); s.mUnit=v(k('mUnit')); s.mMin=v(k('mMin')); s.mMax=v(k('mMax')); s.expectedMinutes=v(k('expected')); s.requiresPhoto=on(`s${i}-photo`); s.mandatory=on(`s${i}-mand`); });
  }

  // ---------- Views ----------
  const loadList=()=>{ api('/procedures').then(list=>{ pe().list=list; render(); }).catch(e=>{ pe().list=[]; fail(e); render(); }); };
  function listView() {
    const x=pe(); if (!x.list) { loadList(); return header(_t('nav.procedures'),_t('pe.sub'))+`<div class="panel empty">${esc(_t('pe.loading'))}</div>`; }
    const active=x.list.filter(p=>p.status==='active').length, drafts=x.list.filter(p=>p.status==='draft').length;
    const tiles=`<section class="kpis">${statTile(_t('pe.tileActive'),String(active),{status:active?'good':''})}${statTile(_t('pe.tileDrafts'),String(drafts))}${statTile(_t('pe.tileTotal'),String(x.list.length))}</section>`;
    const rows=x.list.map(p=>`<tr><td><b>${esc(p.code)}</b> <span class="muted">v${p.version}</span></td><td>${esc(p.title)}</td><td>${p.machineTypes.length?p.machineTypes.map(m=>esc(label('machine',m))).join(', '):`<span class="muted">—</span>`}</td><td>${p.stepCount}</td><td>${p.autoAttach?esc(_t('pe.yes')):'—'}</td><td><span class="pill ${TONE[p.status]}">${esc(_t('pe.status.'+p.status))}</span></td>`
      +`<td>${btn(p.status==='draft'?_t('action.edit'):_t('pe.open'),'peOpen','secondary',p.id)}${p.status==='draft'?btn(_t('pe.publish'),'pePublishRow','primary',p.id):''}${p.status==='active'?btn(_t('pe.retire'),'peRetire','secondary',p.id):''}${p.status!=='draft'?btn(_t('pe.newVersion'),'peNewVersion','secondary',p.id):''}${btn(_t('pe.analytics'),'peAnalytics','secondary',p.code)}</td></tr>`);
    return header(_t('nav.procedures'),_t('pe.sub'),btn(_t('pe.new'),'peNew','primary'))+tiles+simpleTable([_t('pe.code'),_t('pe.title'),_t('pe.machineTypes'),_t('pe.steps'),_t('pe.autoAttach'),_t('pe.state'),''],rows,_t('pe.empty'));
  }
  function stepCard(s,i,n,editable) {
    const k=name=>`s${i}_${name}`;
    if (!editable) return `<div class="proc-step"><div class="spread"><b>${i+1}. ${esc(s.title)}</b>${s.mandatory?'':`<span class="pill">${esc(_t('prc.optional'))}</span>`}</div>${s.safety?`<div class="notice warn proc-safety">⚠ ${esc(s.safety)}</div>`:''}${s.instruction?`<p>${esc(s.instruction).replaceAll('\n','<br>')}</p>`:''}${s.spec?`<p class="mini"><b>${esc(_t('prc.spec'))}:</b> ${esc(s.spec)}</p>`:''}${s.mName?`<p class="mini"><b>${esc(_t('prc.measure'))}:</b> ${esc(s.mName)} ${esc(s.mMin!==''?s.mMin:'…')} – ${esc(s.mMax!==''?s.mMax:'…')} ${esc(s.mUnit)}</p>`:''}${s.partsText?`<p class="mini"><b>${esc(_t('prc.parts'))}:</b> ${esc(s.partsText.replaceAll('\n',', '))}</p>`:''}${s.requiresPhoto?`<p class="mini">📷 ${esc(_t('prc.photoRequired'))}</p>`:''}</div>`;
    return `<div class="proc-step pe-step"><div class="spread"><b>${esc(_t('pe.stepN',{value:i+1}))}</b><span class="pe-tools">${btn('↑','peUp','secondary',String(i))}${btn('↓','peDown','secondary',String(i))}${btn(_t('pe.removeStep'),'peRemove','secondary',String(i))}</span></div>`
      +`<div class="form-grid">${field(k('title'),_t('pe.stepTitle'),{value:s.title,required:true,maxlength:160,wide:true})}${field(k('instruction'),_t('pe.instruction'),{type:'textarea',value:s.instruction,maxlength:2000,wide:true})}${field(k('safety'),_t('pe.safety'),{value:s.safety,maxlength:500,wide:true,help:_t('pe.safetyHelp')})}${field(k('spec'),_t('pe.spec'),{value:s.spec,maxlength:200,help:_t('pe.specHelp')})}${field(k('expected'),_t('pe.expected'),{type:'number',min:1,max:1440,step:1,value:s.expectedMinutes,unit:'min'})}`
      +`${field(k('parts'),_t('pe.parts'),{type:'textarea',value:s.partsText,wide:true,help:_t('pe.partsHelp')})}${field(k('mName'),_t('pe.mName'),{value:s.mName,maxlength:80,help:_t('pe.mHelp')})}${field(k('mUnit'),_t('pe.mUnit'),{value:s.mUnit,maxlength:20})}${field(k('mMin'),_t('pe.mMin'),{type:'number',step:'any',value:s.mMin})}${field(k('mMax'),_t('pe.mMax'),{type:'number',step:'any',value:s.mMax})}`
      +`<label class="check-opt"><input type="checkbox" id="s${i}-photo" ${s.requiresPhoto?'checked':''}> ${esc(_t('pe.requiresPhoto'))}</label><label class="check-opt"><input type="checkbox" id="s${i}-mand" ${s.mandatory?'checked':''}> ${esc(_t('pe.mandatory'))}</label></div></div>`;
  }
  function editView() {
    const f=pe().form, editable=f.status==='draft';
    const top=`<div class="section-actions">${btn('← '+_t('nav.procedures'),'peBack','secondary')}${editable?btn(_t('pe.save'),'peSave','primary')+btn(_t('pe.saveAndPublish'),'pePublish','secondary'):f.status==='active'?btn(_t('pe.retire'),'peRetire','secondary',f.id)+btn(_t('pe.newVersion'),'peNewVersion','secondary',f.id):btn(_t('pe.newVersion'),'peNewVersion','secondary',f.id)}</div>`;
    const meta=editable
      ?`<div class="panel"><div class="form-grid">${f.id?`<div class="fld"><label>${esc(_t('pe.code'))}</label><div><b>${esc(f.code)}</b> <span class="muted">v${f.version}</span></div></div>`:field('pe_code',_t('pe.code'),{value:f.code,required:true,maxlength:40,help:_t('pe.codeHelp')})}${field('pe_title',_t('pe.title'),{value:f.title,required:true,maxlength:160,wide:true})}`
        +`<fieldset class="fld wide checks"><legend>${esc(_t('pe.machineTypesFor'))}</legend>${types().map(m=>`<label class="check-opt"><input type="checkbox" name="pe_types" value="${esc(m)}" ${f.machineTypes.includes(m)?'checked':''}> ${esc(label('machine',m))}</label>`).join('')}</fieldset>`
        +`<label class="check-opt wide"><input type="checkbox" id="pe-auto" ${f.autoAttach?'checked':''}> ${esc(_t('pe.autoAttachText'))}</label></div></div>`
      :`<div class="panel"><h2>${esc(f.title)} <span class="muted">${esc(f.code)} v${f.version}</span> <span class="pill ${TONE[f.status]}">${esc(_t('pe.status.'+f.status))}</span></h2><p class="mini">${f.machineTypes.map(m=>esc(label('machine',m))).join(', ')||'—'}${f.autoAttach?` · ${esc(_t('pe.autoAttachShort'))}`:''}</p><p class="mini muted">${esc(_t('pe.readOnly'))}</p></div>`;
    const steps=f.steps.map((s,i)=>stepCard(s,i,f.steps.length,editable)).join('')||`<div class="panel empty">${esc(_t('pe.noSteps'))}</div>`;
    return header(f.id?`${f.code} v${f.version}`:_t('pe.new'),_t('pe.editSub'))+top+meta+`<h3>${esc(_t('pe.steps'))}</h3>${steps}${editable?`<p>${btn(_t('pe.addStep'),'peAddStep','secondary')}</p>`:''}`;
  }
  function analyticsView() {
    const a=pe().analytics; if (!a) return header(_t('pe.analytics'),'')+`<div class="panel empty">${esc(_t('pe.loading'))}</div>`;
    const pct=n=>`${formatNumber(Math.round(n*1000)/10,1)} %`;
    const rows=a.steps.map(s=>`<tr><td>v${s.version}</td><td>${s.position}. ${esc(s.title)}</td><td>${s.runs}</td><td>${s.done}</td><td>${s.skipped}</td><td>${pct(s.outOfRangeRate)}</td><td>${pct(s.deviationRate)}</td><td>${s.averageMinutes==null?'—':formatNumber(s.averageMinutes,1)}${s.expectedMinutes!=null?` <span class="muted">/ ${s.expectedMinutes}</span>`:''}${s.overExpected?` <span class="pill warning">${esc(_t('pe.overExpected'))}</span>`:''}</td></tr>`);
    return header(`${_t('pe.analytics')}: ${a.code}`,_t('pe.analyticsSub'),btn('← '+_t('nav.procedures'),'peBack','secondary'))
      +`<section class="kpis">${statTile(_t('pe.runs'),String(a.runs))}${statTile(_t('pe.completedRuns'),String(a.completedRuns))}${statTile(_t('pe.avgRun'),a.averageRunMinutes==null?'—':`${formatNumber(a.averageRunMinutes,1)} min`)}</section>`
      +simpleTable([_t('pe.version'),_t('pe.step'),_t('pe.runs'),_t('pe.done'),_t('pe.skipped'),_t('pe.outOfRange'),_t('pe.deviations'),_t('pe.avgMinutes')],rows,_t('pe.noRuns'))+`<p class="muted">${esc(_t('pe.analyticsNote'))}</p>`;
  }
  function procedureView() { const x=pe(); return x.mode==='edit'&&x.form?editView():x.mode==='analytics'?analyticsView():listView(); }

  // ---------- Actions ----------
  const goList=()=>{ pe().mode='list'; pe().form=null; pe().list=undefined; render(); };
  async function save() {
    collect(); const f=pe().form;
    if (f.id) await api(`/procedures/${f.id}`,'PATCH',toApi(f));
    else { const made=await api('/procedures','POST',{code:f.code,...toApi(f)}); f.id=made.id; f.version=made.version; }
    toast(_t('msg.saved')); return f.id;
  }
  async function act(name,id) {
    const form=pe().form;
    if (name==='peNew') { pe().mode='edit'; pe().form={id:null,code:'',version:1,status:'draft',title:'',machineTypes:[],autoAttach:false,steps:[EMPTY_STEP()]}; return render(); }
    if (name==='peOpen') { pe().form=toForm(await api(`/procedures/${id}`)); pe().mode='edit'; return render(); }
    if (name==='peBack') return goList();
    if (name==='peAddStep') { collect(); form.steps.push(EMPTY_STEP()); return render(); }
    if (['peUp','peDown','peRemove'].includes(name)) { collect(); const i=Number(id), steps=form.steps;
      if (name==='peRemove') steps.splice(i,1); else { const j=name==='peUp'?i-1:i+1; if (j>=0&&j<steps.length) [steps[i],steps[j]]=[steps[j],steps[i]]; } return render(); }
    if (name==='peSave') { await save(); const p=await api(`/procedures/${form.id}`); pe().form=toForm(p); return render(); }
    if (name==='pePublish') { const key=await save(); await api(`/procedures/${key}/publish`,'POST'); toast(_t('pe.published')); return goList(); }
    if (name==='pePublishRow') { await api(`/procedures/${id}/publish`,'POST'); toast(_t('pe.published')); return goList(); }
    if (name==='peRetire') { if (!await confirmAction(_t('pe.retireTitle'),_t('pe.retireText'),{confirmLabel:_t('pe.retire'),danger:true})) return; await api(`/procedures/${id}/retire`,'POST'); toast(_t('pe.retired')); return goList(); }
    if (name==='peNewVersion') { const p=await api(`/procedures/${id}`); const made=await api('/procedures','POST',{code:p.code,...toApi(toForm(p))}); toast(_t('pe.newVersionMade',{value:made.version})); pe().form=toForm(made); pe().mode='edit'; return render(); }
    if (name==='peAnalytics') { pe().mode='analytics'; pe().analytics=null; render(); pe().analytics=await api(`/procedures/by-code/${encodeURIComponent(id)}/analytics`); return render(); }
  }
  const action=(name,id)=>{ act(name,id).catch(e=>{ fail(e); }); return true; };
  const reset=()=>{ const x=pe(); if (x.mode!=='edit') { x.list=undefined; x.mode='list'; } };
  return { views:{procedures:procedureView}, action, reset, ACTIONS:['peNew','peOpen','peBack','peAddStep','peUp','peDown','peRemove','peSave','pePublish','pePublishRow','peRetire','peNewVersion','peAnalytics'] };
}
