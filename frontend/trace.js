// Traceability suite pages: trace search with the full chain (material → production → gates → packing → dispatch →
// field), process control (SPC, deviations, product rules), dispatch with label scanning, and field returns with
// warranty authentication, correlation and supplier scorecards. Plus the batch quality dialog (gates, check sheets,
// deviations, labels) and the recall-scope dialog used from the Batches page.
import { esc, btn, humanise, dataTable, simpleTable, field, select, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber, t as _t } from './shared/i18n.js';
import { barChart, lineChart, statTile } from './charts.js';
import { scanInput, bindScanInput } from './shared/scan.js';
import { qrSvg } from './qr.js';

export function createTrace(ctx) {
  const { state, api, render, fail, when, header, factoryManager, admin, customer } = ctx;
  const canRecord=companyId=>admin()||(customer()&&companyId===state.user.companyId);
  const anyRecord=()=>admin()||customer();
  const companies=()=>(state.data.companies||[]);
  const companyId=()=>state.user.companyId||companies()[0]?.id;
  const tone=s=>({released:'approved',completed:'pending',running:'pending',on_hold:'warning',scrapped:'critical',quarantined:'critical',pass:'approved',fail:'critical',open:'warning',accepted:'approved',rejected:'critical',closed:'inactive',
    packed:'pending',shipped:'approved',returned:'warning',loading:'pending',cancelled:'inactive',genuine:'approved',suspicious:'warning',not_found:'critical'})[s]||'';
  const STATUS_TEXT={running:_t('trace.running'),on_hold:_t('trace.onHold'),not_found:_t('trace.notOurLabel2')};
  const pillOf=(s,text)=>`<span class="pill ${tone(s)}">${esc(text||STATUS_TEXT[s]||humanise(s))}</span>`;
  const codeLink=c=>c?`<a class="trace-code" data-trace="${esc(c)}">${esc(c)}</a>`:'';
  const tabs=(key,list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="${key}:${k}">${esc(l)}</button>`).join('')}</div>`;
  const explainer=(title,html)=>`<details class="panel explainer"><summary><b>${esc(title)}</b> <span class="muted">${_t('trace.aQuickGuide')}</span></summary>${html}</details>`;
  const pct=v=>v==null?'—':`${formatNumber(v,1)} %`;
  const tcat=()=>state.tcat||{gates:{},channels:{},returnKinds:{}};
  const loadCat=async()=>{ if (!state.tcat) state.tcat=await api('/trace/catalog'); };
  const paramDefs=()=>Object.fromEntries(Object.values(state.cat?.processParams||{}).flat().map(([k,l,u])=>[k,{label:l,unit:u}]));
  const pLabel=k=>paramDefs()[k]?.label||humanise(k), pUnit=k=>paramDefs()[k]?.unit||'';
  const fmtTime=t=>new Intl.DateTimeFormat(state.user.preferences.locale,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone}).format(new Date(t));

  // ---------- Trace search & genealogy ----------
  function hubView(){
    if (!state.thub) { Promise.all([api('/trace/kpis'),loadCat()]).then(([k])=>{ state.thub={kpis:k}; render(); }).catch(e=>{ state.thub={kpis:null}; fail(e); }); return `<div class="panel empty">${_t('trace.loadingTraceability')}</div>`; }
    const k=state.thub.kpis||{}, r=state.thubResult;
    const tiles=`<section class="kpis" aria-label="${_t('trace.traceabilityFigures')}">${statTile(_t('trace.complianceReadiness'),pct(k.compliancePct),{status:k.compliancePct==null?'':k.compliancePct>=95?'good':'warning',note:`${_t('trace.batchesWithACompleteRecord',{value:k.periodDays??90})}`})}${statTile(_t('trace.firstTimeQuality'),pct(k.firstTimeQualityPct),{note:_t('trace.gatesPassedFirstTimeNo')})}${statTile(_t('trace.openProcessDeviations'),formatNumber(k.openDeviations??0),{status:k.openDeviations?'critical':'good',note:k.openDeviations?_t('trace.decisionNeeded'):'none'})}${statTile(_t('trace.fieldReturns'),k.fieldPpm==null?'—':`${_t('trace.ppm',{fieldPpm:formatNumber(k.fieldPpm)})}`,{note:`${_t('trace.open',{value:formatNumber(k.openReturns??0)})}`})}${statTile(_t('trace.recallScopeNarrowed'),pct(k.recallReductionPct),{note:_t('trace.vsRecallingAllProductionOf')})}${statTile(_t('trace.labelsInStock'),formatNumber(k.labelsInStock??0),{note:`${_t('trace.shipmentsInDays',{value:formatNumber(k.shipments??0),value2:k.periodDays??90})}`})}</section>`;
    const search=`<div class="panel trace-search"><h2>${_t('trace.findAnything')}</h2><p class="muted">${_t('trace.scanOrTypeABox')}</p><div class="row" style="align-items:flex-start">${scanInput('traceCode',{value:state.thubCode||'',placeholder:_t('trace.eGBHsg2026')})}${btn(_t('trace.trace'),'traceGo','primary')}</div><p class="mini muted">${_t('trace.try',{value:['B-HSG-2026-041-0004','PCABS-7731','DN-2026-00041','FR-2026-0001'].map(codeLink).join(' · ')})}</p></div>`;
    const missing=k.missing?.length?`<div class="panel"><h2>${_t('trace.recordsToComplete')}</h2><p class="muted">${_t('trace.whatKeepsBatchesFromAn')}</p>${k.missing.map(m=>`<div class="spread mini"><span>${esc(m.what)}</span><b>${_t('trace.batch2',{batches:formatNumber(m.batches),value:m.batches===1?'':'es'})}</b></div>`).join('')}</div>`:'';
    const explain=explainer(_t('trace.howTraceabilityWorksHere'),`<ul><li><b>${_t('trace.backward')}</b> ${_t('trace.fromABoxOrComplaint')}</li><li><b>${_t('trace.forward')}</b> ${_t('trace.fromALotOrBatch')}</li><li><b>${_t('trace.realTime')}</b> ${_t('trace.eachProductHasAValidated')} <b>${_t('trace.processWindow2')}</b>${_t('trace.readingsOutsideItOpenA')} <b>${_t('trace.qualityGates2')}</b> ${_t('trace.digitalCheckSheetsPassAnd')}</li><li><b>${_t('trace.dispatch')}</b> ${_t('trace.boxesAreScannedOntoShipments')}</li><li><b>${_t('trace.field')}</b> ${_t('trace.warrantyClaimsAreAuthenticatedAgainst')}</li></ul>`);
    return header(_t('trace.traceability'),_t('trace.fromRawMaterialToCustomer'),anyRecord()?`${btn(_t('trace.dispatch'),'goDispatch','secondary')}${btn(_t('trace.recordFieldReturn'),'newReturn','secondary')}`:'')+tiles+search+(r?chainView(r):'')+missing+explain;
  }
  function chainView(r){
    if (!r.found) return `<div class="panel"><h2>${_t('trace.nothingFoundFor',{thubCode:esc(state.thubCode)})}</h2>${r.suggestions?.length?`<p>${_t('trace.didYouMean',{value:r.suggestions.map(s=>`${codeLink(s.code)} <span class="muted">(${esc(humanise(s.type))})</span>`).join(' · ')})}</p>`:_t('trace.checkTheCodeUnderThe')}</div>`;
    const c=r.chain, f=c.focusUnit;
    const col=(title,count,body)=>`<div class="tcol"><div class="tcol-head"><b>${esc(title)}</b><span class="muted">${count}</span></div>${body||_t('trace.text')}</div>`;
    const lots=c.lots.map(l=>`<div class="tnode">${codeLink(l.lot_number)} ${l.status==='quarantined'?pillOf('quarantined'):''}<div class="mini">${esc(l.material)}</div><div class="mini muted">${esc(l.supplier)} · ${esc(l.certificate||'no certificate')}</div></div>`).join('');
    const batches=c.batches.map(b=>`<div class="tnode">${codeLink(b.batchNumber)} ${pillOf(b.status)}<div class="mini">${esc(b.product?.part_number)} ${esc(b.product?.name)}</div><div class="mini muted">${esc(b.machine?.asset_tag||'')}${b.mould?` ${_t('trace.mould',{value:esc(b.mould.asset_tag||b.mould.model)})}`:''} · ${esc(b.operator)}${b.startedBy?` ${_t('trace.signedIn',{startedBy:esc(b.startedBy)})}`:''}</div><div class="mini muted">${when(b.startedAt)} → ${b.endedAt?when(b.endedAt):'running'}</div>
      <div class="mini">${Object.entries(b.processParams).map(([k,v])=>`${esc(pLabel(k))} ${formatNumber(v,1)} ${esc(pUnit(k))}`).join(' · ')}</div>${b.fifoOverride?`<div class="mini">${_t('trace.fifoOverride',{fifoOverride:esc(b.fifoOverride)})}</div>`:''}${b.holdReason?`<div class="mini"><b>${_t('trace.hold')}</b> ${esc(b.holdReason)}</div>`:''}</div>`).join('');
    const gates=c.batches.map(b=>`<div class="tnode"><b class="mini">${esc(b.batchNumber)}</b>${b.gates.map(g=>`<div class="mini">${g.result?pillOf(g.result,g.result==='pass'?_t('trace.pass'):_t('trace.fail')):_t('trace.notDone')} ${esc(g.label)}${g.by?` <span class="muted">${esc(g.by)}</span>`:''}</div>`).join('')||_t('trace.noGatesSetUp')}${b.deviations.map(d=>`<div class="mini">${pillOf(d.status==='open'?'open':d.status,'Deviation '+d.status)} ${esc(pLabel(d.parameter))} ${formatNumber(d.value,1)} (${d.min??'–'}…${d.max??'–'})</div>`).join('')}</div>`).join('');
    const boxes=c.units.filter(x=>x.kind!=='part'), counts=['packed','shipped','returned'].map(s=>[s,c.units.filter(x=>x.status===s&&x.kind!=='pallet').length]).filter(([,n])=>n);
    const units=`${f?`<div class="tnode focus"><b>${esc(humanise(f.kind))} ${esc(f.serial)}</b> ${pillOf(f.status)}<div class="mini">${formatNumber(f.quantity)} ${esc(c.batches[0]?.product?.unit||'')}${f.pallet?` ${_t('trace.onPallet',{pallet:codeLink(f.pallet)})}`:''}</div></div>`:''}<div class="mini">${counts.map(([s,n])=>`${pillOf(s)} ${n}`).join(' ')}</div><div class="mini chips">${boxes.slice(0,14).map(x=>codeLink(x.serial)).join(' ')}${boxes.length>14?` <span class="muted">${_t('trace.more',{value:boxes.length-14})}</span>`:''}</div>`;
    const ships=c.shipments.map(s=>`<div class="tnode">${codeLink(s.shipmentNumber)} ${pillOf(s.status)}<div class="mini"><b>${esc(s.customer)}</b> · ${esc(s.channel)}</div><div class="mini muted">${esc(s.destination||'')}${s.shippedAt?` · ${when(s.shippedAt)}`:''}</div></div>`).join('');
    const rets=c.returns.map(x=>`<div class="tnode">${codeLink(x.reference)} ${pillOf(x.authenticity)}<div class="mini">${esc(humanise(x.kind))}: ${esc(x.defect)}</div><div class="mini muted">${esc(x.customer)} · ${when(x.reportedAt)} · ${esc(humanise(x.status))}</div></div>`).join('');
    const first=c.batches[0], lot=c.lots[0];
    const acts=`<div class="row">${first?btn(_t('trace.batchQualityLabels'),'batchQuality','secondary small',first.id):''}${first?btn(_t('trace.recallScopeOfThisBatch'),'recallBatch','secondary small',first.id):''}${lot&&r.found.type==='lot'?btn(_t('trace.recallScopeOfThisLot'),'recallLot','danger small',lot.id):''}</div>`;
    return `<div class="panel"><div class="spread"><h2>${esc(humanise(r.found.type))} ${esc(r.found.label)}</h2><span class="mini muted">${_t('trace.tracedInMs',{traceMs:formatNumber(r.traceMs,1)})}</span></div>${acts}
      <div class="tflow">${col(_t('trace.1MaterialBackward'),c.lots.length,lots)}${col(_t('trace.2Production'),c.batches.length,batches)}${col(_t('trace.3QualityGates'),c.batches.reduce((n,b)=>n+b.gates.length,0),gates)}${col(_t('trace.4Packing'),boxes.length,units)}${col(_t('trace.5DispatchForward'),c.shipments.length,ships)}${col(_t('trace.6Field'),c.returns.length,rets)}</div></div>`;
  }
  async function traceGo(code){
    code=String(code||document.querySelector('[name=traceCode]')?.value||'').trim(); if (!code) return toast(_t('trace.scanOrTypeACode'),'error');
    state.thubCode=code; state.thubResult=await api(`/trace/find?code=${encodeURIComponent(code)}`); if (state.page!=='traceHub') { state.page='traceHub'; state.detail=null; } render();
  }

  // ---------- Batch quality dialog: gates, check sheets, deviations, SPC, labels ----------
  async function batchQuality(id){
    await loadCat(); const q=await api(`/trace/batches/${id}/quality`), b=q.batch, can=canRecord(b.company_id), mgr=factoryManager(b.company_id);
    const blockers=q.releaseBlockers.length?`<div class="notice warn"><b>${_t('trace.notReleasableYet')}</b> ${q.releaseBlockers.map(esc).join(' · ')}</div>`:`<div class="notice ok">${_t('trace.readyForReleaseGatesPassed')}</div>`;
    const gates=simpleTable([_t('trace.gate'),_t('trace.required'),_t('trace.result'),_t('trace.by'),_t('trace.when'),''],q.gates.filter(g=>g.required||g.latest).map(g=>`<tr><td><b>${esc(g.label)}</b><div class="muted mini">${_t('trace.checkItems',{length:g.items.length,value:g.attempts>1?` ${_t('trace.attempts',{attempts:g.attempts})}`:''})}</div></td><td>${g.required?_t('trace.yes'):_t('trace.no')}</td><td>${g.latest?pillOf(g.latest.result,g.latest.result==='pass'?_t('trace.pass'):_t('trace.fail')):_t('trace.notDone')}${g.latest?.answers?.filter(a=>!a.ok).map(a=>`<div class="mini">✗ ${esc(a.label)}${a.value!=null?`: ${formatNumber(a.value,2)} ${esc(a.unit||'')}`:''}</div>`).join('')||''}</td><td>${esc(g.latest?.by||'')}</td><td>${g.latest?when(g.latest.at):''}</td><td>${can&&g.required&&b.status!=='scrapped'?btn(g.latest?_t('trace.checkAgain'):_t('trace.fillInCheckSheet'),'gateCheck',g.latest?.result==='pass'?'secondary small':'small',`${id}|${g.gate}`):''}</td></tr>`),_t('trace.noQualityGatesSetUp'));
    const devs=simpleTable([_t('trace.setting'),_t('trace.value'),_t('trace.window'),_t('trace.fromTo'),_t('trace.readings'),_t('trace.decision'),''],q.deviations.map(d=>`<tr><td>${esc(pLabel(d.parameter))}</td><td><b>${formatNumber(d.value,2)}</b> ${esc(pUnit(d.parameter))}</td><td>${d.min??'–'} … ${d.max??'–'}</td><td>${when(d.started_at)}${d.ended_at?` → ${when(d.ended_at)}`:_t('trace.ongoing')}</td><td>${d.readings}</td><td>${pillOf(d.status)}${d.disposition?`<div class="mini">${esc(d.disposition)}</div>`:''}</td><td>${d.status==='open'&&mgr?btn(_t('trace.decide'),'decideDeviation','small',d.id):''}</td></tr>`),_t('trace.noDeviationsEveryReadingStayed'));
    const spcRows=simpleTable([_t('trace.setting'),_t('trace.readings'),_t('trace.mean'),'σ',_t('trace.window'),_t('trace.cpk'),_t('trace.capability'),_t('trace.outside')],q.spc.map(s=>`<tr><td>${esc(pLabel(s.parameter))}</td><td>${s.n}</td><td>${formatNumber(s.mean,2)} ${esc(pUnit(s.parameter))}</td><td>${formatNumber(s.sd,3)}</td><td>${s.lsl??'–'} … ${s.usl??'–'}</td><td><b>${s.cpk==null?'—':formatNumber(s.cpk,2)}</b></td><td>${pillOf(s.cpk==null?'':s.cpk>=1.33?'pass':s.cpk>=1?'open':'fail',s.capability)}</td><td>${s.outside}</td></tr>`),_t('trace.noReadingsRecordedForThis'));
    const boxes=q.units.filter(x=>x.kind!=='part'), unit=b.product?.unit||'';
    const labels=`<p class="muted">${_t('trace.boxesPalletsSerialisedParts',{length:formatNumber(boxes.filter(x=>x.kind==='box').length),length2:formatNumber(boxes.filter(x=>x.kind==='pallet').length),length3:formatNumber(q.units.filter(x=>x.kind==='part').length)})}</p>${can&&['running','completed','released'].includes(b.status)?`<div class="row">${btn(_t('trace.createBoxLabels'),'makeLabels','secondary small',`${id}|box`)}${btn(_t('trace.serialisePartsDmcQr'),'makeLabels','secondary small',`${id}|part`)}${boxes.length?btn(_t('trace.printLabels'),'printBatchLabels','secondary small',id):''}</div>`:''}${simpleTable([_t('trace.label'),_t('trace.kind'),_t('trace.quantity'),_t('trace.status')],boxes.slice(0,30).map(x=>`<tr><td>${codeLink(x.serial)}</td><td>${esc(humanise(x.kind))}</td><td>${formatNumber(x.quantity)} ${esc(unit)}</td><td>${pillOf(x.status)}</td></tr>`),_t('trace.noLabelsYet'))}`;
    const d=openDialog(`${_t('trace.batchQualityLabels2',{batch_number:b.batch_number})}`,`<p>${_t('trace.good2',{status:pillOf(b.status),part_number:esc(b.product?.part_number),name:esc(b.product?.name),value:esc(b.machine?.asset_tag||''),good:formatNumber(b.good,0),unit:esc(unit)})}</p>${blockers}<h3>${_t('trace.qualityGates')}</h3>${gates}<h3>${_t('trace.processDeviations')}</h3>${devs}<h3>${_t('trace.processCapabilitySpc')}</h3>${spcRows}<h3>${_t('trace.labels')}</h3>${labels}`);
    d.addEventListener('click',e=>{ const a=e.target.closest('[data-action],[data-trace]'); if (!a) return; e.preventDefault(); e.stopPropagation(); closeDialog();
      if (a.dataset.trace) return traceGo(a.dataset.trace).catch(fail); action(a.dataset.action,a.dataset.id); });
  }
  async function gateForm(key){
    const [bid,gate]=key.split('|'), q=await api(`/trace/batches/${bid}/quality`), g=q.gates.find(x=>x.gate===gate);
    const items=g.items.map((it,i)=>it.type==='ok'?`<div class="fld wide check-row"><span>${i+1}. ${esc(it.label)}</span><span class="row"><label class="check-opt"><input type="radio" name="i${i}" value="ok" required> ${_t('trace.ok')}</label><label class="check-opt"><input type="radio" name="i${i}" value="nok"> ${_t('trace.notOk')}</label></span></div>`
      :field(`i${i}`,`${i+1}. ${it.label}`,{type:'number',step:'any',required:true,unit:it.unit,help:`${_t('trace.limits',{value:it.min??'–',value2:it.max??'–',value3:it.unit||''})}`}));
    openDialog(`${_t('trace.batch3',{label:g.label,batch_number:q.batch.batch_number})}`,`<p class="muted">${_t('trace.answerEveryItemAValue')}</p><div class="form-grid">${items.join('')}${field('note',_t('trace.note'),{wide:true,maxlength:500})}</div>`,
      {submitLabel:_t('trace.signAndSave'),onSubmit:async fd=>{ const answers=g.items.map((it,i)=>it.type==='ok'?{ok:fd.get(`i${i}`)==='ok'}:{value:fd.get(`i${i}`)});
        const r=await api(`/trace/batches/${bid}/checks`,'POST',{gate,answers,note:fd.get('note')}); toast(r.result==='pass'?`${_t('trace.passed',{label:g.label})}`:`${_t('trace.failedBatchBlocked',{label:g.label})}`,r.result==='pass'?'ok':'error'); state.trace=undefined; state.thub=undefined; render(); setTimeout(()=>batchQuality(bid),50); }});
  }
  function deviationForm(id){
    openDialog(_t('trace.decideOnAProcessDeviation'),`<p class="muted">${_t('trace.acceptWhenThePartsMade')}</p><div class="form-grid">${select('decision',_t('trace.decision'),[['accepted','Accept – parts are fine'],['rejected',_t('trace.rejectPartsMustBeSorted')]],{required:true,value:'accepted',wide:true})}${field('disposition',_t('trace.reasonAndEvidence'),{type:'textarea',required:true,wide:true,help:_t('trace.eG50PartsFrom')})}</div>`,
      {onSubmit:async fd=>{ await api(`/trace/deviations/${id}/decision`,'POST',Object.fromEntries(fd)); toast(_t('trace.decisionSaved')); state.pc=undefined; state.trace=undefined; state.thub=undefined; render(); }});
  }
  async function labelsForm(key){
    const [bid,kind]=key.split('|'), q=await api(`/trace/batches/${bid}/quality`), b=q.batch, prod=(await api('/trace/products')).find(p=>p.id===b.product_id);
    openDialog(kind==='part'?`${_t('trace.serialisePartsBatch',{batch_number:b.batch_number})}`:`${_t('trace.boxLabelsBatch',{batch_number:b.batch_number})}`,`<p class="muted">${_t('trace.labelsCannotExceedTheBatch',{value:kind==='part'?_t('trace.oneSerialPerPartFor'):_t('trace.oneLabelPerBoxKlt'),value2:b.status==='running'?'planned':'good'})}</p><div class="form-grid">${field('count',kind==='part'?_t('trace.numberOfParts'):_t('trace.numberOfBoxes'),{type:'number',required:true,min:1,max:kind==='part'?5000:500,value:kind==='part'?100:10})}${kind==='box'?field('perUnit',_t('trace.quantityPerBox'),{type:'number',required:true,min:1,value:prod?.packQty||'',unit:b.product?.unit}):''}</div>`,
      {submitLabel:_t('trace.createLabels'),onSubmit:async fd=>{ const made=await api(`/trace/batches/${bid}/units`,'POST',{kind,count:Number(fd.get('count')),perUnit:fd.get('perUnit')?Number(fd.get('perUnit')):undefined}); toast(`${_t('trace.labelsCreated',{length:made.length})}`); printLabels(made.map(m=>({...m,product:b.product,batchNumber:b.batch_number,customer:prod?.customer})));
        state.thub=undefined; }});
  }
  // Printable labels (A4 sheet, 2 columns): QR with the serial, part number, description, quantity, batch, customer.
  function printLabels(list){
    const w=window.open('','_blank'); if (!w) return toast(_t('trace.allowPopUpsToPrint'),'error');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${_t('trace.labels')}</title><style>${_t('trace.bodyLLBL')}</style><button onclick="print()">${_t('trace.print')}</button><br>${list.map(x=>`<div class="l">${qrSvg(x.serial,120)}<div><small>${x.kind==='pallet'?_t('trace.pallet'):x.kind==='part'?_t('trace.part'):_t('trace.box')} · ${esc(x.customer||'')}</small><b>${esc(x.product?.part_number||'')}</b><span>${esc(x.product?.name||'')}</span><span>${_t('trace.qty')} <b>${formatNumber(x.quantity)}</b> ${esc(x.product?.unit||'')}</span><span>${_t('trace.batch4',{value:esc(x.batchNumber||x.batch?.batchNumber||'')})}</span><span>S/N <b>${esc(x.serial)}</b></span></div></div>`).join('')}`);
    w.document.close();
  }
  async function printBatchLabels(id){ const q=await api(`/trace/batches/${id}/quality`), prod=(await api('/trace/products')).find(p=>p.id===q.batch.product_id); printLabels(q.units.filter(x=>x.kind!=='part').map(x=>({...x,customer:prod?.customer}))); }

  // ---------- Recall scope ----------
  async function recallDialog(kind,id){
    const r=await api(`/trace/recall?${kind}Id=${encodeURIComponent(id)}`), unit=r.batches[0]?.product?.unit||'';
    openDialog(r.lot?`${_t('trace.recallScopeLot',{lotNumber:r.lot.lotNumber})}`:`${_t('trace.recallScopeBatch',{batchNumber:r.batch.batchNumber})}`,`${r.lot?`<p>${_t('trace.from',{status:pillOf(r.lot.status),material:esc(r.lot.material)})} <b>${esc(r.lot.supplier)}</b></p>`:''}
      <section class="kpis small">${statTile(_t('trace.batchesAffected'),formatNumber(r.batches.length))}${statTile(_t('trace.quantityAffected'),`${formatNumber(r.affectedQty)} ${unit}`,{note:r.reductionPct!=null?`${_t('trace.lessThanWithoutLotRecords',{reductionPct:formatNumber(r.reductionPct,0),scopeWithoutTraceability:formatNumber(r.scopeWithoutTraceability)})}`:''})}${statTile(_t('trace.stillInOurStock'),`${formatNumber(r.inStock.quantity)} ${unit}`,{note:`${_t('trace.labelsBlockAndSortHere',{labels:r.inStock.labels})}`})}${statTile(_t('trace.atCustomers'),`${formatNumber(r.shipped.quantity)} ${unit}`,{status:r.shipped.quantity?'warning':'good',note:`${_t('trace.labelsInShipments',{labels:r.shipped.labels,length:r.shipments.length})}`})}</section>
      <h3>${_t('trace.customersToInform')}</h3>${simpleTable([_t('trace.customer'),_t('trace.channel'),_t('trace.shipments'),_t('trace.quantity')],r.customers.map(c=>`<tr><td><b>${esc(c.customer)}</b></td><td>${esc(c.channel)}</td><td>${c.shipments}</td><td>${formatNumber(c.quantity)} ${esc(unit)}</td></tr>`),_t('trace.nothingShippedYetTheRecall'))}
      <h3>${_t('trace.shipments')}</h3>${simpleTable([_t('trace.deliveryNote'),_t('trace.customer'),_t('trace.shipped'),_t('trace.labels'),_t('trace.quantity')],r.shipments.map(s=>`<tr><td>${codeLink(s.shipmentNumber)}</td><td>${esc(s.customer)}</td><td>${when(s.shippedAt)}</td><td>${s.labels}</td><td>${formatNumber(s.quantity)}</td></tr>`))}
      <h3>${_t('trace.batches')}</h3>${simpleTable([_t('trace.batch'),_t('trace.product'),_t('trace.started'),_t('trace.good'),_t('trace.status')],r.batches.map(b=>`<tr><td>${codeLink(b.batchNumber)}</td><td>${esc(b.product?.part_number)}</td><td>${when(b.startedAt)}</td><td>${formatNumber(b.good)}</td><td>${pillOf(b.status)}</td></tr>`))}
      ${r.lot&&r.lot.status!=='quarantined'?_t('trace.toBlockItQuarantineLot'):''}`);
    document.getElementById('modal')?.addEventListener('click',e=>{ const a=e.target.closest('[data-trace]'); if (a) { e.preventDefault(); closeDialog(); traceGo(a.dataset.trace).catch(fail); } });
  }

  // ---------- Process control: SPC, deviations, product rules ----------
  function pcView(){
    if (!state.pc) { Promise.all([api('/trace/products'),api('/trace/deviations'),loadCat()]).then(([products,deviations])=>{ state.pc={products,deviations,productId:state.pcProduct||products.find(p=>p.id===deviations.find(d=>d.status==='open')?.product_id)?.id||products.find(p=>Object.keys(p.processWindow).length)?.id||products[0]?.id}; render(); }).catch(fail); return `<div class="panel empty">${_t('trace.loadingProcessControl')}</div>`; }
    const tab=state.pcTab||'spc', {products,deviations}=state.pc, open=deviations.filter(d=>d.status==='open').length;
    let body='';
    if (tab==='spc') {
      const pid=state.pc.productId, s=state.pc.spc?.[pid];
      if (pid&&!s) api(`/trace/spc?productId=${pid}&days=30`).then(x=>{ (state.pc.spc??={})[pid]=x; render(); }).catch(fail);
      const sel=`<label class="inline-filter">${_t('trace.product')} <select data-pc-product>${products.map(p=>`<option value="${esc(p.id)}" ${p.id===pid?'selected':''}>${esc(p.partNumber)} – ${esc(p.name)}</option>`).join('')}</select></label>`;
      body=`<div class="panel"><div class="spread">${sel}<span class="muted">${_t('trace.last30Days',{value:s?` ${_t('trace.batches2',{batches:s.batches})}`:''})}</span></div>${!s?_t('trace.loading'):!s.spc.length?_t('trace.noProcessReadingsForThis'):
        simpleTable([_t('trace.setting'),_t('trace.readings'),_t('trace.mean'),'σ',_t('trace.windowLslUsl'),_t('trace.cp'),_t('trace.cpk'),_t('trace.capability')],s.spc.map(x=>`<tr><td><b>${esc(pLabel(x.parameter))}</b></td><td>${x.n}</td><td>${formatNumber(x.mean,2)} ${esc(pUnit(x.parameter))}</td><td>${formatNumber(x.sd,3)}</td><td>${x.lsl??'–'} … ${x.usl??'–'}</td><td>${x.cp==null?'—':formatNumber(x.cp,2)}</td><td><b>${x.cpk==null?'—':formatNumber(x.cpk,2)}</b></td><td>${pillOf(x.cpk==null?'':x.cpk>=1.33?'pass':x.cpk>=1?'open':'fail',x.capability)}</td></tr>`))+
        `<div class="chart-grid">${s.spc.map(x=>lineChart(`spc-${x.parameter}`,{title:`${pLabel(x.parameter)} (${pUnit(x.parameter)})`,subtitle:`${_t('trace.controlChartCpk',{value:x.cpk==null?'—':formatNumber(x.cpk,2)})}`,unit:pUnit(x.parameter),points:x.series,formatTime:fmtTime,
          limits:[...(x.usl!=null?[{value:x.usl,label:_t('trace.usl'),kind:'critical'}]:[]),...(x.lsl!=null?[{value:x.lsl,label:_t('trace.lsl'),kind:'critical'}]:[]),{value:x.ucl,label:_t('trace.ucl'),kind:'warning'},{value:x.lcl,label:_t('trace.lcl'),kind:'warning'}]})).join('')}</div>`}</div>`;
    }
    if (tab==='deviations') body=`<div class="panel">${dataTable('deviations',{rows:deviations,search:d=>`${d.batch_number} ${d.part_number} ${d.parameter}`,filters:[{key:'status',label:_t('trace.decision'),options:['open','accepted','rejected'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:_t('trace.noProcessDeviationsEveryReading'),
      columns:[{title:_t('trace.batch'),cell:d=>`${codeLink(d.batch_number)}<div class="muted">${esc(d.part_number)}</div>`},{title:_t('trace.setting'),cell:d=>esc(pLabel(d.parameter))},{title:_t('trace.worstValue'),cell:d=>`<b>${formatNumber(d.value,2)}</b> ${esc(pUnit(d.parameter))}`},{title:_t('trace.window'),cell:d=>`${d.min??'–'} … ${d.max??'–'}`},{title:_t('trace.when'),cell:d=>`${when(d.started_at)}${d.ended_at?`<div class="muted">${_t('trace.to',{ended_at:when(d.ended_at)})}</div>`:'<div class="muted">ongoing</div>'}`},{title:_t('trace.decision'),cell:d=>`${pillOf(d.status)}${d.disposition?`<div class="mini">${esc(d.disposition)}</div>`:''}`},
        {title:'',cls:'row',cell:d=>`${btn(_t('trace.batchQuality'),'batchQuality','secondary small',d.batch_id)}${d.status==='open'&&factoryManager(d.company_id)?btn(_t('trace.decide'),'decideDeviation','small',d.id):''}`}]})}</div>`;
    if (tab==='rules') body=`<div class="panel">${dataTable('rules',{rows:products,search:p=>`${p.partNumber} ${p.name} ${p.customer}`,empty:_t('trace.noProductsYetAddThem'),
      columns:[{title:_t('trace.product'),cell:p=>`<b>${esc(p.partNumber)}</b><div class="muted">${esc(p.name)}</div>`},{title:_t('trace.customer'),cell:p=>esc(p.customer||'—')},{title:_t('trace.warranty'),cell:p=>`${_t('trace.months',{warrantyMonths:p.warrantyMonths})}`},{title:_t('trace.pack'),cell:p=>p.packQty?`${formatNumber(p.packQty)} ${esc(p.unit)}/box`:'—'},
        {title:_t('trace.processWindow'),cell:p=>Object.entries(p.processWindow).map(([k,w])=>`<div class="mini">${esc(pLabel(k))} ${w.min??'–'} … ${w.max??'–'} ${esc(pUnit(k))}</div>`).join('')||'<span class="muted">not set</span>'},
        {title:_t('trace.qualityGates'),cell:p=>Object.entries(p.checkSheets).map(([g,items])=>`<div class="mini">${esc(tcat().gates[g]||g)} (${items.length})</div>`).join('')||'<span class="muted">none</span>'},{title:_t('trace.onDeviation'),cell:p=>p.holdOnDeviation?'<span class="pill warning">Hold batch</span>':_t('trace.alert')},
        {title:'',cell:p=>factoryManager(p.companyId)?btn(_t('trace.editRules'),'editRules','secondary small',p.id):''}]})}</div>`;
    const explain=explainer(_t('trace.processControlInPlainWords'),`<ul><li><b>${_t('trace.processWindow')}</b> ${_t('trace.theValidatedRangeOfEach')}</li><li><b>${_t('trace.deviation')}</b> ${_t('trace.aLiveReadingOutsideThe')}</li><li><b>${_t('trace.cpk')}</b> ${_t('trace.howWellTheProcessFits')}</li><li><b>${_t('trace.controlChart')}</b> ${_t('trace.theReadingsWith3Control')}</li></ul>`);
    return header(_t('trace.processControl'),_t('trace.processWindowsLiveDeviationsAnd'))+tabs('pc',[['spc',_t('trace.capabilitySpc')],['deviations',`Deviations${open?` ${_t('trace.open3',{open:open})}`:''}`],['rules',_t('trace.productRules')]],tab)+body+explain;
  }
  async function rulesForm(id){
    await loadCat(); const p=state.pc.products.find(x=>x.id===id), types=state.cat?.processParams||{}, params=p.machineType?types[p.machineType]:Object.values(types).flat().filter((x,i,a)=>a.findIndex(y=>y[0]===x[0])===i);
    const sheetText=items=>(items||[]).map(it=>it.type==='ok'?`${it.label} | ok`:`${it.label} | measure | ${it.min??''} | ${it.max??''} | ${it.unit||''}`).join('\n');
    const win=params.map(([k,l,u])=>`<div class="fld"><label>${_t('trace.minMax',{l:esc(l),u:esc(u)})}</label><div class="row"><input name="w.${k}.min" type="number" step="any" placeholder="${_t('trace.min')}" value="${esc(p.processWindow[k]?.min??'')}" aria-label="${_t('trace.minimum',{l:esc(l)})}" style="width:45%"><input name="w.${k}.max" type="number" step="any" placeholder="${_t('trace.max')}" value="${esc(p.processWindow[k]?.max??'')}" aria-label="${_t('trace.maximum',{l:esc(l)})}" style="width:45%"></div></div>`).join('');
    const sheets=Object.entries(tcat().gates).map(([g,l])=>field(`s.${g}`,l,{type:'textarea',wide:true,value:sheetText(p.checkSheets[g]),help:_t('trace.oneItemPerLineLabel')})).join('');
    openDialog(`${_t('trace.traceabilityRules',{partNumber:p.partNumber})}`,section(_t('trace.customerAndPacking'),`${field('customer',_t('trace.customer'),{value:p.customer,maxlength:120,help:_t('trace.onlyThisCustomerSShipments')})}${field('warrantyMonths',_t('trace.warranty'),{type:'number',min:0,max:240,value:p.warrantyMonths,unit:'months'})}${field('packQty',_t('trace.quantityPerBox'),{type:'number',min:1,value:p.packQty??'',unit:p.unit})}${select('holdOnDeviation',_t('trace.whenAReadingLeavesThe'),[['0',_t('trace.alert')],['1',_t('trace.alertAndHoldTheBatch')]],{value:p.holdOnDeviation?'1':'0'})}`)
      +section(_t('trace.processWindowValidatedSettings'),win)+section(_t('trace.qualityGatesDigitalCheckSheets'),sheets),
      {onSubmit:async fd=>{ const processWindow={}, checkSheets={};
        for (const [k] of params) { const min=fd.get(`w.${k}.min`), max=fd.get(`w.${k}.max`); if (min!==''||max!=='') processWindow[k]={min:min===''?null:Number(min),max:max===''?null:Number(max)}; }
        for (const g of Object.keys(tcat().gates)) { const lines=String(fd.get(`s.${g}`)||'').split('\n').map(x=>x.trim()).filter(Boolean); if (!lines.length) continue;
          checkSheets[g]=lines.map((line,i)=>{ const [label,type='ok',min='',max='',unit='']=line.split('|').map(x=>x.trim()); if (!['ok','measure'].includes(type)) throw Error(`${_t('trace.lineTypeMustBeOk',{value:tcat().gates[g],value2:i+1})}`); return type==='ok'?{label,type}:{label,type,min:min===''?null:Number(min),max:max===''?null:Number(max),unit}; }); }
        await api(`/trace/products/${id}`,'PUT',{customer:fd.get('customer'),warrantyMonths:Number(fd.get('warrantyMonths')),packQty:fd.get('packQty')===''?null:Number(fd.get('packQty')),holdOnDeviation:fd.get('holdOnDeviation')==='1',processWindow,checkSheets});
        toast(_t('trace.rulesSaved')); state.pc=undefined; render(); }});
  }

  // ---------- Dispatch ----------
  function dispatchView(){
    if (!state.ship) { Promise.all([api('/trace/shipments'),api('/trace/stock'),loadCat()]).then(([shipments,stock])=>{ state.ship={shipments,stock}; render(); }).catch(fail); return `<div class="panel empty">${_t('trace.loadingShipments')}</div>`; }
    const tab=state.shipTab||'shipments', {shipments,stock}=state.ship;
    const tiles=`<section class="kpis small">${statTile(_t('trace.loadingNow'),formatNumber(shipments.filter(s=>s.status==='loading').length))}${statTile(_t('trace.shippedAllTime'),formatNumber(shipments.filter(s=>s.status==='shipped').length))}${statTile(_t('trace.labelsInStock'),formatNumber(stock.length),{note:`${_t('trace.notReleasedYet',{length:formatNumber(stock.filter(x=>x.batch.status!=='released').length)})}`})}</section>`;
    const list=dataTable('shipments',{rows:shipments,search:s=>`${s.shipment_number} ${s.customer} ${s.destination} ${s.customer_po} ${s.lines.map(l=>l.partNumber+' '+l.batchNumber).join(' ')}`,filters:[{key:'status',label:_t('trace.status'),options:['loading','shipped','cancelled'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:_t('trace.noShipmentsYet'),
      columns:[{title:_t('trace.deliveryNote'),cell:s=>`${codeLink(s.shipment_number)}${s.customer_po?`<div class="muted">${_t('trace.po',{customer_po:esc(s.customer_po)})}</div>`:''}`},{title:_t('trace.customer'),cell:s=>`<b>${esc(s.customer)}</b><div class="muted">${esc(s.channelLabel)}${s.destination?` · ${esc(s.destination)}`:''}</div>`},{title:_t('trace.contents'),cell:s=>s.lines.map(l=>`<div class="mini">${_t('trace.batch5',{partNumber:esc(l.partNumber),batchNumber:esc(l.batchNumber),quantity:formatNumber(l.quantity),unit:esc(l.unit)})}</div>`).join('')||'<span class="muted">empty</span>'},{title:_t('trace.status'),cell:s=>`${pillOf(s.status)}${s.shipped_at?`<div class="muted">${when(s.shipped_at)}</div>`:''}`},
        {title:'',cls:'row',cell:s=>`${s.status==='loading'&&canRecord(s.company_id)?btn(_t('trace.scanLoad'),'loadShipment','small',s.id):''}${s.status!=='cancelled'?btn(_t('trace.deliveryNote'),'deliveryNote','secondary small',s.id):''}`}]});
    const stockTable=dataTable('stock',{rows:stock,search:x=>`${x.serial} ${x.product.part_number} ${x.batch.batchNumber} ${x.product.customer}`,filters:[{key:'kind',label:_t('trace.kind'),options:[['box','Box'],['pallet',_t('trace.pallet2')],['part',_t('trace.part2')]],match:(r,v)=>r.kind===v}],empty:_t('trace.noFinishedGoodsInStock'),
      columns:[{title:_t('trace.label'),cell:x=>codeLink(x.serial)},{title:_t('trace.kind'),cell:x=>esc(humanise(x.kind))},{title:_t('trace.product'),cell:x=>`${esc(x.product.part_number)}<div class="muted">${esc(x.product.customer||'')}</div>`},{title:_t('trace.batch'),cell:x=>`${codeLink(x.batch.batchNumber)} ${pillOf(x.batch.status)}`},{title:_t('trace.quantity'),cell:x=>`${formatNumber(x.quantity)} ${esc(x.product.unit)}`},{title:_t('trace.packed'),cell:x=>when(x.createdAt)}]});
    const explain=explainer(_t('trace.howDispatchWorks'),`<ol><li><b>${_t('trace.newShipment')}</b> ${_t('trace.forACustomerDeliveryNote')}</li><li><b>${_t('trace.scanLoad')}</b>${_t('trace.scanEachBoxOrPallet')}</li><li><b>${_t('trace.ship')}</b> ${_t('trace.closesTheDeliveryNoteEvery')}</li></ol>`);
    const can=anyRecord();
    return header(_t('trace.dispatchShipments'),_t('trace.scanVerifiedLoadingSoOnly'),can?`${btn(_t('trace.buildPallet'),'newPallet','secondary')}${btn(_t('trace.newShipment'),'newShipment','primary')}`:'')+tiles+tabs('ship',[['shipments',`${_t('trace.shipments2',{length:shipments.length})}`],['stock',`${_t('trace.finishedGoodsStock',{length:stock.length})}`]],tab)+`<div class="panel">${tab==='stock'?stockTable:list}</div>`+explain;
  }
  async function shipmentForm(){
    const products=await api('/trace/products'), customers=[...new Set(products.map(p=>p.customer).filter(Boolean))], multi=companies().length>1&&admin();
    openDialog(_t('trace.newShipment'),`<div class="form-grid">${multi?select('companyId',_t('trace.company'),companies().map(c=>[c.id,c.name]),{required:true,value:companyId()}):''}${field('customer',_t('trace.customer'),{required:true,list:'cust-list',maxlength:120})}<datalist id="cust-list">${customers.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>${select('channel',_t('trace.channel'),Object.entries(tcat().channels),{required:true,value:'oem'})}${field('destination',_t('trace.destination'),{maxlength:200,help:_t('trace.plantDockOrWarehouse')})}${field('customerPo',_t('trace.customerPo'),{maxlength:60})}${field('shipmentNumber',_t('trace.deliveryNoteNumber'),{maxlength:60,help:_t('trace.leaveEmptyToNumberIt')})}</div>`,
      {submitLabel:_t('trace.createAndStartLoading'),onSubmit:async fd=>{ const s=await api('/trace/shipments','POST',Object.fromEntries(fd)); state.ship=undefined; render(); setTimeout(()=>loadDialog(s.id),50); }});
  }
  async function loadDialog(id){
    let s=(await api('/trace/shipments')).find(x=>x.id===id);
    const listHtml=()=>`${simpleTable([_t('trace.label'),_t('trace.kind'),_t('trace.product'),_t('trace.batch'),_t('trace.quantity'),''],s.units.filter(x=>!x.parentId||!s.units.some(p=>p.id===x.parentId)).map(x=>`<tr><td><b>${esc(x.serial)}</b></td><td>${esc(humanise(x.kind))}</td><td>${esc(x.product.part_number)}</td><td>${esc(x.batch.batchNumber)}</td><td>${formatNumber(x.quantity)} ${esc(x.product.unit)}</td><td><button type="button" class="link-btn" data-remove="${esc(x.serial)}">${_t('trace.remove')}</button></td></tr>`),_t('trace.nothingLoadedYetScanThe'))}<p><b>${formatNumber(s.quantity)}</b> ${_t('trace.inLine',{length:s.lines.length,value:s.lines.length===1?'':'s',value2:s.lines.map(l=>`${esc(l.partNumber)} × ${formatNumber(l.quantity)}`).join(', ')||'—'})}</p>`;
    const d=openDialog(`${_t('trace.load',{shipment_number:s.shipment_number,customer:s.customer})}`,`<div class="fld wide"><label for="f-dispatchCode">${_t('trace.scanBoxOrPalletLabel')}</label>${scanInput('dispatchCode',{placeholder:_t('trace.scanOrTypeTheLabel')})}</div><div id="load-msg" role="status"></div><div id="load-list">${listHtml()}</div>`,{submitLabel:_t('trace.shipNow'),onSubmit:async()=>{
      if (!await confirmAction(`${_t('trace.ship2',{shipment_number:s.shipment_number})}`,`${_t('trace.unitsToEachLabelIs',{quantity:formatNumber(s.quantity),customer:s.customer})}`,{confirmLabel:_t('trace.ship'),danger:false})) throw Error(_t('trace.notShipped'));
      await api(`/trace/shipments/${id}/ship`,'POST',{}); toast(`${_t('trace.shipped2',{shipment_number:s.shipment_number})}`); state.ship=undefined; state.thub=undefined; render(); }});
    const msg=d.querySelector('#load-msg'), say=(html,kind)=>{ msg.className=`${`notice ${kind}`}`; msg.innerHTML=html; };
    const refresh=()=>{ d.querySelector('#load-list').innerHTML=listHtml(); d.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{ try { s=await api(`/trace/shipments/${id}/remove`,'POST',{serial:b.dataset.remove}); say(`${_t('trace.removed',{remove:esc(b.dataset.remove)})}`,'ok'); refresh(); } catch(e) { say(esc(e.message),'error'); } }); };
    refresh();
    bindScanInput(d,'dispatchCode',async code=>{ const input=d.querySelector('[name=dispatchCode]');
      try { const r=await api(`/trace/shipments/${id}/scan`,'POST',{serial:code}); s=r.shipment; refresh(); say(`${_t('trace.loaded',{added:esc(r.added),value:r.warnings.length?`<br>⚠ ${r.warnings.map(esc).join('<br>⚠ ')}`:''})}`,r.warnings.length?'warn':'ok'); if (navigator.vibrate) navigator.vibrate(60); }
      catch(e) { say(`✗ ${esc(e.message)}`,'error'); if (navigator.vibrate) navigator.vibrate([120,60,120]); }
      input.value=''; input.focus(); },e=>say(`✗ ${esc(e.message)}`,'error'));
  }
  async function deliveryNote(id){
    const s=(await api('/trace/shipments')).find(x=>x.id===id), w=window.open('','_blank'); if (!w) return toast(_t('trace.allowPopUpsToPrint2'),'error');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(s.shipment_number)}</title><style>${_t('trace.bodyTableTdThH1')}</style><button onclick="print()">${_t('trace.print')}</button><div class="top"><div><h1>${_t('trace.deliveryNote2',{shipment_number:esc(s.shipment_number)})}</h1><p>${_t('trace.to2')} <b>${esc(s.customer)}</b> (${esc(s.channelLabel)})<br>${esc(s.destination||'')}<br>${_t('trace.customerPo2',{value:esc(s.customer_po||'—')})}<br>${s.shipped_at?`${_t('trace.shipped3',{value:esc(new Date(s.shipped_at).toLocaleString())})}`:'Status: '+esc(s.status)}</p></div>${qrSvg(s.shipment_number,110)}</div>
      <h2>${_t('trace.lines')}</h2><table><tr><th>${_t('trace.partNumber')}</th><th>${_t('trace.description')}</th><th>${_t('trace.batch')}</th><th>${_t('trace.labels')}</th><th>${_t('trace.quantity')}</th></tr>${s.lines.map(l=>`<tr><td>${esc(l.partNumber)}</td><td>${esc(l.name)}</td><td>${esc(l.batchNumber)}</td><td>${l.units}</td><td>${formatNumber(l.quantity)} ${esc(l.unit)}</td></tr>`).join('')}</table>
      <h2>${_t('trace.labels')}</h2><p>${s.units.map(x=>`${esc(x.serial)}${x.kind==='pallet'?' (pallet)':''}`).join(', ')}</p>`); w.document.close();
  }
  function palletForm(){
    const multi=companies().length>1&&admin();
    const d=openDialog(_t('trace.buildAPallet'),`<p class="muted">${_t('trace.scanTheBoxesGoingOn')}</p><div class="form-grid">${multi?select('companyId',_t('trace.company'),companies().map(c=>[c.id,c.name]),{required:true,value:companyId()}):''}<div class="fld wide"><label for="f-palletCode">${_t('trace.scanBox')}</label>${scanInput('palletCode')}</div>${field('serials',_t('trace.boxesOnThePallet'),{type:'textarea',wide:true,required:true,help:_t('trace.oneLabelPerLineScans')})}</div>`,
      {submitLabel:_t('trace.createPalletLabel'),onSubmit:async fd=>{ const p=await api('/trace/pallets','POST',{companyId:fd.get('companyId')||undefined,serials:String(fd.get('serials')).split(/\s+/).filter(Boolean)}); toast(`${_t('trace.palletBoxes',{serial:p.serial,boxes:p.boxes})}`);
        const x=await api(`/trace/units/${encodeURIComponent(p.serial)}`); printLabels([{...x,batchNumber:x.batch.batchNumber,customer:x.product.customer}]); state.ship=undefined; render(); }});
    bindScanInput(d,'palletCode',code=>{ const ta=d.querySelector('[name=serials]'); if (!ta.value.split(/\s+/).includes(code.toUpperCase())) ta.value=(ta.value.trim()+'\n'+code.toUpperCase()).trim(); const i=d.querySelector('[name=palletCode]'); i.value=''; i.focus(); });
  }

  // ---------- Field returns & warranty ----------
  function frView(){
    if (!state.fr) { Promise.all([api('/trace/returns'),api('/trace/correlation'),api('/trace/suppliers'),loadCat()]).then(([returns,correlation,suppliers])=>{ state.fr={returns,correlation,suppliers}; render(); }).catch(fail); return `<div class="panel empty">${_t('trace.loadingFieldReturns')}</div>`; }
    const tab=state.frTab||'returns', {returns,correlation:c,suppliers}=state.fr;
    const fLabel=f=>f.dimension==='setting'?(([k,band])=>`${pLabel(k)} ≈ ${formatNumber(Number(band))} ${pUnit(k)}`)(f.key.split(':')):f.label;
    const tiles=`<section class="kpis small">${statTile(_t('trace.fieldReturns'),`${_t('trace.ppm2',{ppm:formatNumber(c.ppm)})}`,{note:`${_t('trace.ofShipped',{totalReturned:formatNumber(c.totalReturned),totalShipped:formatNumber(c.totalShipped)})}`})}${statTile(_t('trace.open2'),formatNumber(returns.filter(r=>r.status==='open').length))}${statTile(_t('trace.suspiciousOrUnknownClaims'),formatNumber(returns.filter(r=>r.authenticity!=='genuine').length),{status:returns.some(r=>r.authenticity!=='genuine')?'warning':'',note:_t('trace.duplicatesWrongCustomerCounterfeitLabels')})}</section>`;
    let body='';
    if (tab==='returns') body=dataTable('returns',{rows:returns,search:r=>`${r.reference} ${r.customer} ${r.serial} ${r.batch_number} ${r.defect}`,filters:[{key:'status',label:_t('trace.status'),options:['open','accepted','rejected','closed'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v},{key:'auth',label:_t('trace.authenticity'),options:[['genuine',_t('trace.genuine2')],['suspicious',_t('trace.suspicious2')],['not_found',_t('trace.notFound')]],match:(r,v)=>r.authenticity===v}],empty:_t('trace.noFieldReturnsRecorded'),
      columns:[{title:_t('trace.reference'),cell:r=>`${codeLink(r.reference)}<div class="muted">${esc(tcat().returnKinds[r.kind]||r.kind)}</div>`},{title:_t('trace.customer'),cell:r=>esc(r.customer)},{title:_t('trace.labelBatch'),cell:r=>`${r.serial?codeLink(r.serial):'—'}<div class="muted">${r.batch_number?esc(r.batch_number):''}</div>`},{title:_t('trace.defect'),cell:r=>`${esc(r.defect)} <span class="muted">× ${formatNumber(r.quantity)}</span>`},{title:_t('trace.authenticity'),cell:r=>`${pillOf(r.authenticity)}${r.checks.filter(x=>!x.ok).map(x=>`<div class="mini">✗ ${esc(x.check)}: ${esc(x.detail)}</div>`).join('')}`},{title:_t('trace.reported'),cell:r=>when(r.reported_at)},{title:_t('trace.status'),cell:r=>`${pillOf(r.status)}${r.root_cause?`<div class="mini">${_t('trace.cause',{root_cause:esc(r.root_cause)})}</div>`:''}`},
        {title:'',cell:r=>factoryManager(r.company_id)?btn(_t('trace.decide'),'decideReturn','secondary small',r.id):''}]});
    if (tab==='warranty') body=`<p class="muted">${_t('trace.checkAClaimBeforeAccepting')}</p><div class="form-grid"><div class="fld"><label for="f-authSerial">${_t('trace.serialOnTheLabel')}</label>${scanInput('authSerial')}</div>${field('authCustomer',_t('trace.claimingCustomer'),{maxlength:120})}</div><div class="row">${btn(_t('trace.checkClaim'),'authCheck','primary')}</div><div id="auth-result">${state.frAuth?authHtml(state.frAuth):''}</div>`;
    if (tab==='correlation') body=`<p class="muted">${_t('trace.whatReturnedPartsHaveIn')}</p>${barChart('corr-chart',{title:_t('trace.returnsPer1000Shipped'),subtitle:_t('trace.topFactors'),valueLabel:_t('trace.per1000'),rows:c.factors.slice(0,8).map(f=>({label:`${humanise(f.dimension)}: ${fLabel(f)}`,value:f.per1000}))})}${simpleTable([_t('trace.factor'),_t('trace.value'),_t('trace.batches'),_t('trace.shipped'),_t('trace.returned'),_t('trace.per1000'),_t('trace.average')],c.factors.map(f=>`<tr><td>${esc(humanise(f.dimension))}</td><td><b>${esc(fLabel(f))}</b></td><td>${f.batches}</td><td>${formatNumber(f.shipped)}</td><td>${formatNumber(f.returned)}</td><td>${formatNumber(f.per1000,2)}</td><td>${f.vsAverage==null?'—':`${formatNumber(f.vsAverage,1)}×`}</td></tr>`),_t('trace.noReturnsLinkedToShipped'))}`;
    if (tab==='suppliers') body=`<p class="muted">${_t('trace.perSupplierLotsReceivedLots')}</p>${simpleTable([_t('trace.supplier'),_t('trace.rating'),_t('trace.lots'),_t('trace.delivered'),_t('trace.quarantined'),_t('trace.batchesHeld'),_t('trace.deviations'),_t('trace.fieldReturns'),_t('trace.lastDelivery')],suppliers.map(s=>`<tr><td><b>${esc(s.supplier)}</b><div class="muted mini">${esc(s.materials.join(', '))}</div></td><td>${pillOf(s.rating==='A'?'pass':s.rating==='B'?'open':'fail',`${s.rating} · ${s.score}`)}</td><td>${s.lots}</td><td>${_t('trace.kg',{kg:formatNumber(s.kg)})}</td><td>${s.quarantinedLots}</td><td>${s.batchesHeld}</td><td>${s.deviations}</td><td>${s.fieldReturns}</td><td>${when(s.lastDelivery)}</td></tr>`))}`;
    return header(_t('trace.fieldReturnsWarranty'),_t('trace.complaintsWarrantyClaimsAndField'),anyRecord()?btn(_t('trace.recordFieldReturn'),'newReturn','primary'):'')+tiles+tabs('fr',[['returns',`${_t('trace.returnsClaims',{length:returns.length})}`],['warranty',_t('trace.checkAWarrantyClaim')],['correlation',_t('trace.fieldCorrelation')],['suppliers',_t('trace.supplierQuality')]],tab)+`<div class="panel">${body}</div>`;
  }
  const authHtml=a=>`<div class="panel"><h3>${pillOf(a.authenticity,a.authenticity==='genuine'?_t('trace.genuine'):a.authenticity==='suspicious'?_t('trace.suspicious'):_t('trace.notOurLabel'))} ${a.unit?`${_t('trace.batch6',{part_number:esc(a.unit.product.part_number),batchNumber:codeLink(a.batch.batchNumber)})}`:''}</h3>${a.checks.map(c=>`<div class="spread mini"><span>${c.ok?'✓':'✗'} ${esc(c.check)}</span><span class="muted">${esc(c.detail)}</span></div>`).join('')}</div>`;
  async function authCheck(){
    const serial=document.querySelector('[name=authSerial]')?.value, customer=document.querySelector('[name=authCustomer]')?.value;
    if (!serial) return toast(_t('trace.scanOrTypeTheSerial'),'error');
    state.frAuth=await api(`/trace/authenticate?serial=${encodeURIComponent(serial)}&customer=${encodeURIComponent(customer||'')}`); document.getElementById('auth-result').innerHTML=authHtml(state.frAuth);
  }
  function returnForm(){
    const multi=companies().length>1&&admin();
    const d=openDialog(_t('trace.recordAFieldReturn'),`<p class="muted">${_t('trace.scanOrTypeTheSerial2')}</p><div class="form-grid">${multi?select('companyId',_t('trace.company'),companies().map(c=>[c.id,c.name]),{required:true,value:companyId()}):''}${select('kind',_t('trace.type'),Object.entries(tcat().returnKinds),{required:true,value:'complaint'})}${field('customer',_t('trace.customer'),{required:true,maxlength:120})}<div class="fld"><label for="f-serial">${_t('trace.serialOnTheLabel')}</label>${scanInput('serial')}</div>${field('batchNumber',_t('trace.batchNumberIfNoLabel'),{maxlength:60})}${field('defect',_t('trace.defect'),{required:true,maxlength:120,help:_t('trace.eGCrackedClipShort')})}${field('quantity',_t('trace.quantity'),{type:'number',min:1,value:1})}${field('description',_t('trace.description'),{type:'textarea',wide:true,maxlength:2000})}</div>`,
      {submitLabel:_t('trace.record'),onSubmit:async fd=>{ const r=await api('/trace/returns','POST',Object.fromEntries(fd)); toast(`${_t('trace.recorded',{reference:r.reference,value:r.authenticity==='genuine'?'genuine':r.authenticity==='suspicious'?_t('trace.suspiciousClaim'):_t('trace.labelNotFound')})}`,r.authenticity==='genuine'?'ok':'error'); state.fr=undefined; state.thub=undefined; render(); }});
    bindScanInput(d,'serial',()=>{});
  }
  function decideReturnForm(id){
    const r=state.fr.returns.find(x=>x.id===id);
    openDialog(`${_t('trace.decide2',{reference:r.reference})}`,`${authHtml({authenticity:r.authenticity,checks:r.checks,unit:null})}<div class="form-grid">${select('status',_t('trace.decision'),[['open',_t('trace.openInvestigating')],['accepted','Accepted'],['rejected',_t('trace.rejected')],['closed',_t('trace.closedCorrectiveActionDone')]],{required:true,value:r.status})}${field('rootCause',_t('trace.rootCause'),{type:'textarea',wide:true,value:r.root_cause||''})}${field('correctiveAction',_t('trace.correctiveAction8d'),{type:'textarea',wide:true,value:r.corrective_action||''})}</div>`,
      {onSubmit:async fd=>{ await api(`/trace/returns/${id}`,'PATCH',Object.fromEntries(fd)); toast(_t('trace.saved')); state.fr=undefined; render(); }});
  }

  // ---------- Wiring ----------
  const views={traceHub:hubView,processControl:pcView,dispatch:dispatchView,fieldReturns:frView};
  async function action(name,id){
    try {
      if (name==='traceGo') return await traceGo();
      if (name==='batchQuality') return await batchQuality(id);
      if (name==='gateCheck') return await gateForm(id);
      if (name==='decideDeviation') return deviationForm(id);
      if (name==='makeLabels') return await labelsForm(id);
      if (name==='printBatchLabels') return await printBatchLabels(id);
      if (name==='recallLot') return await recallDialog('lot',id);
      if (name==='recallBatch') return await recallDialog('batch',id);
      if (name==='editRules') return await rulesForm(id);
      if (name==='newShipment') { await loadCat(); return await shipmentForm(); }
      if (name==='loadShipment') return await loadDialog(id);
      if (name==='deliveryNote') return await deliveryNote(id);
      if (name==='newPallet') return palletForm();
      if (name==='newReturn') { await loadCat(); return returnForm(); }
      if (name==='decideReturn') return decideReturnForm(id);
      if (name==='authCheck') return await authCheck();
      if (name==='goDispatch') { state.page='dispatch'; state.detail=null; return render(); }
    } catch (e) { fail(e); }
  }
  function bind(){
    document.querySelectorAll('[data-trace]').forEach(el=>el.onclick=e=>{ e.preventDefault(); traceGo(el.dataset.trace).catch(fail); });
    bindScanInput(document,'traceCode',code=>traceGo(code).catch(fail));
    if (state.page==='fieldReturns') bindScanInput(document,'authSerial',()=>authCheck().catch(fail));
    const ps=document.querySelector('[data-pc-product]'); if (ps) ps.onchange=()=>{ state.pcProduct=ps.value; state.pc.productId=ps.value; render(); };
  }
  const reset=()=>{ state.thub=undefined; state.pc=undefined; state.ship=undefined; state.fr=undefined; };
  return {views,action,bind,reset,ACTIONS:['traceGo','batchQuality','gateCheck','decideDeviation','makeLabels','printBatchLabels','recallLot','recallBatch','editRules','newShipment','loadShipment','deliveryNote','newPallet','newReturn','decideReturn','authCheck','goDispatch']};
}
