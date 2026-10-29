// Mould process fingerprint panel: status, sample size, drift score over time, per-setting table (good-run range against
// the recent run), "Ask AI for advice" with its sources, and the outcome buttons. Shown on the process-control (SPC) page
// for a product and on a mould's page. Viewers see everything; managers (customer admins, plant managers, platform
// administrators) can also build, accept the new normal, reset, check now and ask for advice. The advice is a suggestion:
// nothing here changes a machine setting.
import { esc, btn, simpleTable, field, openDialog, confirmAction, toast } from './ui.js';
import { formatNumber, t as _t } from './shared/i18n.js';
import { lineChart, statTile } from './charts.js';

export function createFingerprint(ctx) {
  const { state, api, render, fail, when } = ctx;
  const cache=()=>(state.fp??={}), advice=()=>(state.fpAdvice??={});
  const signed=(n,d=1)=>n==null?'—':`${n>0?'+':''}${formatNumber(n,d)}`;
  const tone=l=>({ok:'approved',warning:'warning',critical:'critical'})[l]||'';
  const fmtTime=t=>new Intl.DateTimeFormat(state.user.preferences.locale,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone}).format(new Date(t));
  const day=iso=>iso?iso.slice(0,10):'—';
  const reasonText=r=>_t(`fp.reason.${r.code}`,Object.fromEntries(Object.entries(r.vars||{}).map(([k,v])=>[k,String(v)])));
  const urlOf=(kind,id)=>kind==='product'?`/process/fingerprints?productId=${encodeURIComponent(id)}`:`/moulds/${encodeURIComponent(id)}/fingerprint`;

  // ---------- Loading ----------
  function load(kind,id) {
    const key=`${kind}:${id}`, c=cache();
    if (!c[key]) {
      c[key]={loading:true};
      api(urlOf(kind,id)).then(async data=>{
        c[key]={data};
        for (const sc of data.scopes) if (sc.status==='active') { try { advice()[sc.key]={list:await api(`/moulds/${encodeURIComponent(sc.mouldId)}/process-advice?equipmentId=${encodeURIComponent(sc.equipmentId)}&productId=${encodeURIComponent(sc.productId)}`)}; } catch { advice()[sc.key]={list:[]}; } }
        render();
      }).catch(e=>{ c[key]={error:e.message}; render(); });
    }
    return c[key];
  }
  const reload=()=>{ state.fp={}; render(); };

  // ---------- Rendering ----------
  function statusPill(sc) {
    return sc.status==='active'?`<span class="pill ${tone(sc.drift.level)}">${esc(sc.drift.level?_t(`fp.level.${sc.drift.level}`):_t('fp.status.active'))}</span>`
      :`<span class="pill ${sc.status==='reset'?'warning':'inactive'}">${esc(_t(`fp.status.${sc.status}`))}</span>`;
  }
  function paramTable(sc) {
    const d=sc.drift, rows=d.parameters?.length?d.parameters:Object.entries(sc.params).map(([k,p])=>({parameter:k,label:p.label,unit:p.unit,centre:p.mean,sd:p.sd,low:p.p05,high:p.p95,recent:null}));
    return simpleTable([_t('fp.col.setting'),_t('fp.col.goodRange'),_t('fp.col.typical'),_t('fp.col.recent'),_t('fp.col.moved'),_t('fp.col.share')],rows.map(p=>{
      const label=p.label||sc.params[p.parameter]?.label, unit=p.unit??sc.params[p.parameter]?.unit??'';
      return `<tr class="${p.moved?'fp-moved':''}"><td><b>${esc(label)}</b>${unit?` <span class="muted">${esc(unit)}</span>`:''}</td><td>${formatNumber(p.low,2)} … ${formatNumber(p.high,2)}</td><td>${formatNumber(p.centre,2)} ± ${formatNumber(p.sd,2)}</td>`
        +(p.recent==null?`<td>—</td><td>—</td><td>—</td>`:`<td><b>${formatNumber(p.recent,2)}</b>${p.outsideRange?` <span class="pill warning">${esc(_t('fp.outside'))}</span>`:''}</td><td>${esc(_t('fp.movedBy',{delta:signed(p.delta,2),unit,z:signed(p.z,1),pct:signed(p.pctOfRange,0)}))}</td><td>${formatNumber(Math.max(0,p.contribution)*100,0)} %</td>`)+'</tr>';
    }));
  }
  function scopeChart(sc,i) {
    const d=sc.drift;
    return lineChart(`fp-drift-${i}`,{title:_t('fp.chartTitle'),subtitle:_t('fp.chartSub',{hours:d.recentHours,warning:d.thresholds.warning,critical:d.thresholds.critical}),unit:'',points:d.series,formatTime:fmtTime,
      limits:[{value:d.thresholds.warning,label:_t('fp.limitWarn'),kind:'warning'},{value:d.thresholds.critical,label:_t('fp.limitCrit'),kind:'critical'}]});
  }
  function shiftDetails(sc) {
    const shiftRows=(sc.shifts||[]).map(s=>`<tr><td><b>${esc(s.name)}</b></td><td>${formatNumber(s.n)}</td>${Object.keys(sc.params).map(k=>`<td>${s.offsets[k]==null?'—':signed(s.offsets[k],2)}</td>`).join('')}</tr>`);
    const recentShift=(sc.drift.byShift||[]).map(s=>`<span class="pill ${tone(s.level)}" title="${esc(s.date)}">${esc(s.date.slice(5))} ${esc(s.shift)}: ${formatNumber(s.score,1)}</span>`).join(' ');
    const daysLine=(sc.days||[]).slice(-14).map(x=>`<span class="pill" title="${esc(x.date)}">${esc(x.date.slice(5))}: ${formatNumber(x.score,1)}</span>`).join(' ');
    return `<details class="fp-more"><summary>${esc(_t('fp.shifts.title'))}</summary>
        ${recentShift?`<p class="mini"><b>${esc(_t('fp.shifts.recent'))}</b> ${recentShift}</p>`:''}
        ${shiftRows.length?`<p class="mini muted">${esc(_t('fp.shifts.learned'))}</p>${simpleTable([_t('fp.shifts.shift'),_t('fp.shifts.n'),...Object.values(sc.params).map(p=>p.label)],shiftRows)}`:''}
        ${daysLine?`<p class="mini"><b>${esc(_t('fp.days.title'))}</b> ${daysLine}</p>`:''}</details>`;
  }
  function labelDetails(sc) {
    const l=sc.labels||{}, c=l.criteria||{}, ev=l.evidence||{}, left=l.readingsLeftOut||{};
    const excluded=(l.excluded||[]).map(x=>`<li>${esc(x.batchNumber)}: ${esc(_t(`fp.exclude.${x.code}`))}${x.scrapPct!=null?` (${formatNumber(x.scrapPct,1)} %)`:''}</li>`).join('');
    return `<details class="fp-more"><summary>${esc(_t('fp.labels.title'))}</summary>
        <p class="mini">${esc(_t('fp.labels.text',{scrap:c.maxScrapPct,slot:c.slotRejectPct}))}</p>
        <p class="mini">${esc(_t('fp.labels.counts',{used:(l.batches||[]).length,counted:ev.batchesWithCounts??0,excluded:(l.excluded||[]).length,dev:left.deviation??0,slot:left.highRejectSlot??0}))}</p>${excluded?`<ul class="mini">${excluded}</ul>`:''}</details>`;
  }
  function versionDetails(sc) {
    if (!sc.versions?.length) return '';
    return `<details class="fp-more"><summary>${esc(_t('fp.versions.title'))}</summary>${simpleTable([_t('fp.version'),_t('fp.versions.status'),_t('fp.versions.how'),_t('fp.sample'),_t('fp.period'),_t('fp.reason')],sc.versions.map(v=>`<tr><td>${v.version}</td><td>${esc(_t(`fp.vstatus.${v.status}`))}</td><td>${esc(_t(`fp.origin.${v.origin}`))}<div class="mini muted">${when(v.createdAt)}</div></td><td>${formatNumber(v.sampleSize)} / ${formatNumber(v.batches)}</td><td>${esc(day(v.periodFrom))} … ${esc(day(v.periodTo))}</td><td>${esc(v.reason||'—')}</td></tr>`))}</details>`;
  }
  const sourceLabel=(s,sc)=>{ const m=/^(FP|NOW):(.+)$/.exec(s.id); return m?_t(`fp.src.${m[1]}`,{label:sc.params?.[m[2]]?.label||m[2]}):s.id; };
  function adviceCard(a,sc,{latest}) {
    const adv=a.advice||{}, changes=adv.changes||[], byId=Object.fromEntries((a.sources||[]).map(s=>[s.id,s])), cited=[...new Set(changes.flatMap(c=>c.evidence||[]))].filter(x=>byId[x]);
    const head=a.source==='ai'?_t('fp.advice.aiLabel',{model:a.model||''}):_t('fp.advice.ruleLabel');
    const items=changes.map(c=>`<li><div class="fp-change"><b>${esc(_t('fp.advice.change',{rank:c.rank,direction:_t(`fp.dir.${c.direction}`),label:c.label,step:formatNumber(c.step,3),unit:c.unit}))}</b>
        <span class="muted">${esc(_t('fp.advice.nowTo',{current:formatNumber(c.current,3),target:formatNumber(c.target,3),unit:c.unit}))}</span></div>
        ${c.clamped?`<div class="mini"><span class="pill warning">${esc(_t(`fp.clamped.${c.clamped}`,{pct:a.maxStepPct,requested:formatNumber(c.requestedStep,3),unit:c.unit}))}</span></div>`:''}
        ${c.towardFingerprint===false?`<div class="mini"><span class="pill warning">${esc(_t('fp.advice.awayNote'))}</span></div>`:''}
        <div class="mini"><b>${esc(_t('fp.advice.expected'))}:</b> ${esc(c.expectedEffect)}</div><div class="mini"><b>${esc(_t('fp.advice.why'))}:</b> ${esc(c.rationale)}</div><div class="mini"><b>${esc(_t('fp.advice.risk'))}:</b> ${esc(c.risk)}</div>
        <div class="mini muted">${esc(_t('fp.advice.basedOn'))}: ${(c.evidence||[]).map(e=>`<span class="chip" title="${esc(byId[e]?.text||'')}">${esc(sourceLabel({id:e},sc))}</span>`).join(' ')}</div></li>`).join('');
    const list=(title,xs)=>xs?.length?`<h3 class="section-title">${esc(title)}</h3><ul class="mini">${xs.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'';
    const outcome=a.outcome?`<span class="pill ${a.outcome==='helped'?'approved':a.outcome==='did_not_help'?'critical':'inactive'}">${esc(_t(`fp.outcome.${a.outcome}`))}</span> <span class="muted mini">${esc(a.outcomeBy||'')} ${a.outcomeAt?when(a.outcomeAt):''}</span>`:`<span class="muted mini">${esc(_t('fp.outcome.none'))}</span>`;
    return `<div class="fp-advice${latest?' latest':''}">
      <div class="spread"><b>${esc(head)}</b><span class="muted mini">${esc(_t('fp.advice.askedBy',{who:a.askedBy||'—',date:when(a.askedAt)}))} · v${a.fingerprintVersion}</span></div>
      <div class="notice" role="note">${esc(_t('fp.advice.suggestionOnly'))}</div>
      ${adv.note?`<p class="mini muted">${esc(_t('fp.advice.fallbackNote'))}</p>`:''}
      <p>${esc(adv.summary||'')} ${adv.confidence?`<span class="muted mini">${esc(_t('fp.advice.confidence',{value:_t(`fp.confidence.${adv.confidence}`)}))}</span>`:''}</p>
      ${changes.length?`<ol class="fp-changes">${items}</ol>`:`<p><b>${esc(_t('fp.advice.noChange'))}</b></p>`}
      ${list(_t('fp.advice.checkFirst'),adv.checkFirst)}${list(_t('fp.advice.risks'),adv.risks)}${list(_t('fp.advice.gaps'),adv.dataGaps)}
      ${cited.length?`<details class="fp-more"><summary>${esc(_t('fp.advice.sources'))}</summary><ul class="mini">${cited.map(x=>`<li><b>${esc(sourceLabel(byId[x],sc))}</b> <span class="muted">${esc(byId[x].text)}</span></li>`).join('')}</ul></details>`:''}
      <div class="row fp-outcome"><b>${esc(_t('fp.outcome.title'))}</b> ${outcome}
        ${a.askedById===state.user.id||sc.canManage?['helped','did_not_help','not_tried'].map(o=>btn(_t(`fp.outcome.${o}`),'fpOutcome',`secondary small${a.outcome===o?' active':''}`,`${a.id}~${o}`)).join(''):''}</div></div>`;
  }
  function adviceBlock(sc) {
    const st=advice()[sc.key], list=st?.list||[], busy=st?.error;
    return `<div class="fp-advice-area">${list.length?adviceCard(list[0],sc,{latest:true}):''}
      ${list.length>1?`<details class="fp-more"><summary>${esc(_t('fp.advice.history'))} (${list.length-1})</summary>${list.slice(1).map(a=>adviceCard(a,sc,{latest:false})).join('')}</details>`:''}${busy?`<p class="notice warn">${esc(busy)}</p>`:''}</div>`;
  }
  function scopePanel(sc,data,i) {
    sc.canManage=data.canManage;
    const head=`<div class="spread"><h2>${esc(_t('fp.title'))}</h2>${statusPill(sc)}</div><p class="muted">${esc(_t('fp.scopeLine',{mould:sc.mould?.assetTag||sc.mould?.name||'',machine:sc.machine?.assetTag||sc.machine?.name||'',product:sc.product?.partNumber||''}))}</p>`;
    if (sc.status!=='active') {
      const why=sc.reasons?.length?`<ul class="mini">${sc.reasons.map(r=>`<li>${esc(reasonText(r))}</li>`).join('')}</ul>`:'';
      const can=sc.canBuild?`<p>${esc(_t('fp.canBuild',{readings:formatNumber(sc.buildPreview.sampleSize),batches:sc.buildPreview.batches}))}</p>${data.canManage?`<div class="row">${btn(_t('fp.btn.build'),'fpBuild','primary',sc.key)}</div>`:''}`:'';
      return `<div class="panel fp">${head}<p>${esc(sc.status==='reset'?_t('fp.resetNote'):_t('fp.noneText'))}</p>${why}${can}${versionDetails(sc)}</div>`;
    }
    const d=sc.drift, moved=(d.parameters||[]).filter(p=>p.moved).slice(0,3).map(p=>`${p.label} ${signed(p.delta,2)} ${p.unit} (${signed(p.z,1)} sd)`).join(', ');
    const tiles=`<section class="kpis small" aria-label="${esc(_t('fp.title'))}">${statTile(_t('fp.driftScore'),d.score==null?'—':formatNumber(d.score,1),{status:d.level==='critical'?'critical':d.level==='warning'?'warning':d.level==='ok'?'good':'',note:d.level?_t(`fp.level.${d.level}`):''})}`
      +`${statTile(_t('fp.version'),`v${sc.version}`,{note:_t('fp.versionNote',{date:when(sc.builtAt),origin:_t(`fp.origin.${sc.origin}`)})})}`
      +`${statTile(_t('fp.sample'),formatNumber(sc.sampleSize),{note:_t('fp.sampleNote',{readings:formatNumber(sc.sampleSize),batches:sc.batches})})}`
      +`${statTile(_t('fp.period'),`${day(sc.periodFrom).slice(5)} … ${day(sc.periodTo).slice(5)}`,{note:day(sc.periodFrom).slice(0,4)})}</section>`;
    const state_=d.status==='insufficient'?`<p class="notice warn">${esc(d.message==='no_readings'?_t('fp.noReadings'):_t('fp.insufficient',{have:d.recentReadings??0,hours:d.recentHours,need:d.minRecent}))}</p>`
      :`${d.stale?`<p class="notice warn">${esc(_t('fp.staleNote',{hours:formatNumber(d.ageHours,0)}))}</p>`:''}${d.level&&d.level!=='ok'&&moved?`<p class="notice ${d.level==='critical'?'danger':'warn'}" role="status"><b>${esc(_t('fp.whichMoved',{list:moved}))}</b></p>`:''}`;
    const actions=data.canManage?`<div class="row fp-actions">${btn(_t('fp.btn.advice'),'fpAdvice','primary',sc.key)}${btn(_t('fp.btn.check'),'fpCheck','secondary',sc.key)}${btn(_t('fp.btn.rebaseline'),'fpRebaseline','secondary',sc.key)}${btn(_t('fp.btn.reset'),'fpReset','secondary',sc.key)}</div>${data.aiEnabled?'':`<p class="mini muted">${esc(_t('fp.advice.noKeyHint'))}</p>`}`:'';
    return `<div class="panel fp">${head}${tiles}${state_}${d.series?.length?scopeChart(sc,i):''}<div class="fp-section"><h3 class="section-title">${esc(_t('fp.table.title',{hours:d.recentHours}))}</h3>${paramTable(sc)}</div>${actions}${adviceBlock(sc)}${shiftDetails(sc)}${labelDetails(sc)}${versionDetails(sc)}</div>`;
  }
  // The panel(s) for a product (process-control page) or a mould (its own page).
  function block(kind,id) {
    if (!id) return '';
    const c=load(kind,id);
    if (c.loading) return `<div class="panel empty">${esc(_t('fp.loading'))}</div>`;
    if (c.error) return `<div class="panel"><h2>${esc(_t('fp.title'))}</h2><p class="notice warn">${esc(c.error)}</p></div>`;
    const data=c.data;
    if (!data.scopes.length) return `<div class="panel"><h2>${esc(_t('fp.title'))}</h2><p class="muted">${esc(kind==='product'?_t('fp.noMoulds'):_t('fp.noScopes'))}</p></div>`;
    return `<div class="fp-block"><p class="muted fp-intro">${esc(_t('fp.intro'))}</p>${data.scopes.map((sc,i)=>scopePanel(sc,data,i)).join('')}</div>`;
  }

  // ---------- Actions ----------
  const find=key=>{ for (const c of Object.values(cache())) { const sc=c.data?.scopes?.find(s=>s.key===key); if (sc) return {sc,data:c.data}; } return {}; };
  const body=sc=>({equipmentId:sc.equipmentId,productId:sc.productId});
  const url=(sc,path)=>`/moulds/${encodeURIComponent(sc.mouldId)}/${path}`;
  async function action(name,id) {
    try {
      if (name==='fpOutcome') {
        const [adviceId,outcome]=id.split('~'), key=Object.keys(advice()).find(k=>advice()[k].list?.some(a=>a.id===adviceId)), {sc}=find(key);
        await api(`/process-advice/${encodeURIComponent(adviceId)}/outcome`,'POST',{outcome}); toast(_t('fp.outcome.saved'));
        advice()[key]={list:await api(`/moulds/${encodeURIComponent(sc.mouldId)}/process-advice?equipmentId=${encodeURIComponent(sc.equipmentId)}&productId=${encodeURIComponent(sc.productId)}`)}; return render();
      }
      const {sc,data}=find(id); if (!sc) return;
      if (name==='fpBuild') { if (!await confirmAction(_t('fp.btn.build'),_t('fp.build.confirm',{readings:formatNumber(sc.buildPreview.sampleSize),batches:sc.buildPreview.batches}),{danger:false,confirmLabel:_t('fp.btn.build')})) return; const r=await api(url(sc,'fingerprint/build'),'POST',body(sc)); toast(_t('fp.toast.built',{version:r.version})); return reload(); }
      if (name==='fpCheck') { const r=await api(url(sc,'fingerprint/check'),'POST',{}); toast(_t('fp.toast.checked',{level:r.level?_t(`fp.level.${r.level}`):'—'})); return reload(); }
      if (name==='fpRebaseline') return openDialog(_t('fp.rebaseline.title'),`<p>${esc(_t('fp.rebaseline.text'))}</p><div class="form-grid">${field('days',_t('fp.rebaseline.days'),{type:'number',value:7,required:true,min:1,max:90,step:1,help:_t('fp.rebaseline.daysHelp')})}${field('reason',_t('fp.reason'),{type:'textarea',required:true,wide:true,maxlength:500,help:_t('fp.reasonHelp')})}</div>`,
        {submitLabel:_t('fp.btn.rebaseline'),onSubmit:async fd=>{ const r=await api(url(sc,'fingerprint/rebaseline'),'POST',{...body(sc),days:Number(fd.get('days')),reason:fd.get('reason')}); toast(_t('fp.toast.rebaselined',{version:r.version})); reload(); }});
      if (name==='fpReset') return openDialog(_t('fp.reset.title'),`<p>${esc(_t('fp.reset.text'))}</p><div class="form-grid">${field('reason',_t('fp.reason'),{type:'textarea',required:true,wide:true,maxlength:500,help:_t('fp.reasonHelp')})}</div>`,
        {submitLabel:_t('fp.btn.reset'),onSubmit:async fd=>{ await api(url(sc,'fingerprint/reset'),'POST',{...body(sc),reason:fd.get('reason')}); toast(_t('fp.toast.reset')); reload(); }});
      if (name==='fpAdvice') {
        const lim=data.stepLimit||{defaultPct:5,confirmedMaxPct:25};
        return openDialog(_t('fp.advice.title'),`<p>${esc(_t('fp.advice.text'))}</p><div class="form-grid">${field('question',_t('fp.advice.question'),{type:'textarea',wide:true,maxlength:500})}
          <div class="fld wide"><label class="check"><input type="checkbox" name="larger" value="1"> ${esc(_t('fp.advice.larger'))}</label><small class="help">${esc(_t('fp.advice.largerHelp',{default:lim.defaultPct,max:lim.confirmedMaxPct}))}</small></div></div>`,
          {submitLabel:_t('fp.advice.submit'),onSubmit:async fd=>{
            const a=await api(url(sc,'process-advice'),'POST',{...body(sc),question:fd.get('question')||undefined,confirmLargerStep:fd.get('larger')==='1'||undefined});
            const st=advice()[sc.key]??={list:[]}; st.list=[a,...(st.list||[])]; st.error=''; render(); }});
      }
    } catch (e) { fail(e); }
  }
  const ACTIONS=['fpBuild','fpCheck','fpRebaseline','fpReset','fpAdvice','fpOutcome'];
  const reset=()=>{ state.fp=undefined; state.fpAdvice=undefined; };
  return {block,action,ACTIONS,reset};
}
