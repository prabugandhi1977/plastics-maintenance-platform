// Training and competencies page: who holds which training (valid, expiring, expired or missing), the requirements for
// each machine type with their enforcement, and how a learning management system (LMS) sends completions. Dispatchers and
// the platform administrator define requirements and record completions by hand; provider administrators see their own
// engineers and engineers see themselves. The rules are applied by the server when a ticket is assigned.
import { esc, btn, simpleTable, field, select, checkboxes, openDialog, toast } from './ui.js';
import { formatDate, label, t as _t } from './shared/i18n.js';
import { statTile } from './charts.js';

export function createTraining(ctx) {
  const { state, api, render, fail, header, is, refresh } = ctx;
  const manage=()=>is('platform_admin','dispatcher');
  const types=()=>state.cat?.machineTypes||['injection','blow','extrusion','mould','auxiliary'];
  const TONE={valid:'approved',expiring:'warning',expired:'critical',missing:'pending'};
  const typeNames=list=>list.length?list.map(x=>esc(label('machine',x))).join(', '):`<span class="muted">${_t('trn.noTypes')}</span>`;
  const day=iso=>iso?formatDate(iso,state.user.preferences.timezone):'';
  // A date picked in the form becomes an instant: noon UTC for a past day, and now for today (or a day that is already today
  // in a zone ahead of UTC), because the server refuses a completion in the future.
  const asInstant=(d,notAfterNow=false)=>{ const noon=`${d}T12:00:00Z`; return notAfterNow&&noon>new Date().toISOString()?new Date().toISOString():noon; };
  const done=async message=>{ toast(message); await refresh(); };

  async function loadData(type) {
    const q=type?`?machineType=${encodeURIComponent(type)}`:'';
    const [defs,matrix]=await Promise.all([api('/competencies'),api(`/competencies/matrix${q}`)]);
    state.training={defs,matrix,type:type||''};
  }
  const tabs=(list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="training:${k}">${esc(l)}</button>`).join('')}</div>`;

  function cell(s,c) {
    if (!s) return '—';
    const when=s.status==='missing'?'':` · ${esc(day(s.expiresAt||s.completedAt))}`;
    const tone=s.status==='missing'&&c?.enforcement==='block'?'critical':TONE[s.status];
    return `<span class="pill ${tone}" title="${esc(s.completedAt?`${_t('trn.completed')} ${day(s.completedAt)}`:'')}">${esc(_t('trn.status.'+s.status))}${when}</span>`;
  }
  function standingTab(x) {
    const comps=x.matrix.competencies, people=x.matrix.people;
    const counts={valid:0,expiring:0,expired:0,missing:0};
    for (const p of people) for (const c of comps) counts[p.standing[c.code]?.status||'missing']++;
    const filter=`<div class="table-tools"><label class="tb-field">${esc(_t('trn.machineType'))} <select id="trn-type"><option value="">${esc(_t('trn.allTypes'))}</option>${types().map(m=>`<option value="${esc(m)}" ${x.type===m?'selected':''}>${esc(label('machine',m))}</option>`).join('')}</select></label></div>`;
    const tiles=`<section class="kpis" aria-label="${esc(_t('ws.keyFigures'))}">${statTile(_t('trn.people'),String(people.length))}${statTile(_t('trn.status.valid'),String(counts.valid),{status:'good'})}${statTile(_t('trn.status.expiring'),String(counts.expiring),{status:counts.expiring?'warning':'good'})}${statTile(_t('trn.expiredOrMissing'),String(counts.expired+counts.missing),{status:counts.expired+counts.missing?'critical':'good'})}</section>`;
    if (!comps.length) return `${tiles}${filter}<div class="panel empty">${_t(x.type?'trn.noneForType':manage()?'trn.noRequirementsManage':'trn.noRequirements')}</div>`;
    const rows=people.map(p=>`<tr><td><b>${esc(p.name)}</b><div class="muted">${esc(p.email)}${p.providerId?` · ${esc(_t('ws.provider'))}`:''}${p.active?'':` · ${esc(_t('trn.inactive'))}`}</div></td>${comps.map(c=>`<td>${cell(p.standing[c.code],c)}</td>`).join('')}</tr>`);
    return `${tiles}${filter}${simpleTable([_t('trn.person'),...comps.map(c=>`${c.name} (${c.enforcement==='block'?_t('trn.block'):_t('trn.flag')})`)],rows,_t('trn.noPeople'))}<p class="muted">${_t('trn.legend')}</p>`;
  }
  function requirementsTab(x) {
    const rows=x.defs.map(c=>`<tr><td><b>${esc(c.code)}</b></td><td>${esc(c.name)}</td><td>${typeNames(c.machineTypes)}</td><td>${c.validityMonths?esc(_t('trn.months',{value:c.validityMonths})):`<span class="muted">${_t('trn.neverExpires')}</span>`}</td><td><span class="pill ${c.enforcement==='block'?'critical':'warning'}">${esc(c.enforcement==='block'?_t('trn.block'):_t('trn.flag'))}</span></td><td>${c.active?_t('trn.active'):`<span class="muted">${_t('trn.off')}</span>`}</td>${manage()?`<td>${btn(_t('action.edit'),'trnEdit','secondary',c.id)}</td>`:''}</tr>`);
    const connect=`<div class="panel"><h2>${_t('trn.connectTitle')}</h2><p>${_t('trn.connectText')}</p><p><code>POST ${esc(location.origin)}/api/integrations/lms/completions</code></p><p class="muted">${_t('trn.connectKey')}</p></div>`;
    return `${connect}${simpleTable([_t('trn.code'),_t('trn.name'),_t('trn.machineTypes'),_t('trn.validity'),_t('trn.enforcement'),_t('trn.state'),...(manage()?['']:[])],rows,_t('trn.noRequirements'))}`;
  }
  function trainingView() {
    if (!state.training) { state.training={loading:true}; loadData(state.trainingType).then(render).catch(e=>{ state.training={error:e.message}; render(); }); }
    const x=state.training, tab=state.trainingTab||'standing';
    const actions=manage()&&x.defs?`${btn(_t('trn.addRequirement'),'trnNew','primary')}${btn(_t('trn.recordCompletion'),'trnRecord','secondary')}`:'';
    if (x.loading) return header(_t('nav.training'),_t('trn.sub'))+`<div class="panel empty">${_t('trn.loading')}</div>`;
    if (x.error) return header(_t('nav.training'),_t('trn.sub'))+`<div class="panel empty">${esc(x.error)}</div>`;
    return header(_t('nav.training'),_t('trn.sub'),actions)+tabs([['standing',_t('trn.tabStanding')],['requirements',_t('trn.tabRequirements')]],tab)+(tab==='requirements'?requirementsTab(x):standingTab(x));
  }

  function requirementForm(c) {
    const body=`${field('code',_t('trn.code'),{value:c?.code||'',required:true,maxlength:40,help:_t('trn.codeHelp')})}${field('name',_t('trn.name'),{value:c?.name||'',required:true,maxlength:120})}`
      +checkboxes('machineTypes',_t('trn.machineTypesRequired'),types().map(m=>[m,label('machine',m)]),{values:c?.machineTypes||[],help:_t('trn.machineTypesHelp')})
      +field('validityMonths',_t('trn.validityMonths'),{type:'number',min:1,max:120,step:1,value:c?.validityMonths??'',help:_t('trn.validityHelp')})
      +select('enforcement',_t('trn.enforcement'),[['flag',_t('trn.flagLong')],['block',_t('trn.blockLong')]],{value:c?.enforcement||'flag',required:true})
      +(c?`<label class="check-opt wide"><input type="checkbox" name="active" ${c.active?'checked':''}> ${_t('trn.activeCheck')}</label>`:'');
    openDialog(c?`${_t('action.edit')}: ${c.code}`:_t('trn.addRequirement'),`<div class="form-grid">${body}</div>`,{onSubmit:async fd=>{
      const v=Object.fromEntries(fd), b={code:v.code,name:v.name,machineTypes:fd.getAll('machineTypes'),validityMonths:v.validityMonths===''?null:Number(v.validityMonths),enforcement:v.enforcement};
      if (c) { b.active=fd.has('active'); await api(`/competencies/${c.id}`,'PATCH',b); } else await api('/competencies','POST',b);
      await done(_t('msg.saved'));
    }});
  }
  function recordForm() {
    const x=state.training, people=x.matrix.people, defs=x.defs.filter(c=>c.active);
    if (!defs.length) return toast(_t('trn.createFirst'),'error');
    const body=select('userId',_t('trn.person'),people.map(p=>[p.userId,`${p.name} (${p.email})`]),{required:true,wide:true})
      +select('code',_t('trn.requirement'),defs.map(c=>[c.code,`${c.code} · ${c.name}`]),{required:true,wide:true})
      +field('completedAt',_t('trn.completedOn'),{type:'date',required:true,value:new Date().toISOString().slice(0,10),max:new Date().toISOString().slice(0,10)})
      +field('expiresAt',_t('trn.expiresOn'),{type:'date',help:_t('trn.expiresHelp')})
      +field('note',_t('trn.note'),{maxlength:500,wide:true});
    openDialog(_t('trn.recordCompletion'),`<div class="form-grid">${body}</div>`,{onSubmit:async fd=>{
      const v=Object.fromEntries(fd), b={userId:v.userId,code:v.code,completedAt:asInstant(v.completedAt,true),note:v.note};
      if (v.expiresAt) b.expiresAt=asInstant(v.expiresAt);
      await api('/competencies/records','POST',b); await done(_t('trn.recorded'));
    }});
  }
  function action(name,id) {
    if (name==='trnNew') { requirementForm(); return true; }
    if (name==='trnEdit') { const c=(state.training?.defs||[]).find(x=>x.id===id); if (c) requirementForm(c); return true; }
    if (name==='trnRecord') { recordForm(); return true; }
    return false;
  }
  // The machine type filter reloads the standing.
  function bind() {
    const sel=document.querySelector('#trn-type'); if (!sel) return;
    sel.onchange=()=>{ state.trainingType=sel.value; state.training=undefined; render(); };
  }
  const reset=()=>{ state.training=undefined; };
  return { views:{training:trainingView}, action, bind, reset, ACTIONS:['trnNew','trnEdit','trnRecord'] };
}
