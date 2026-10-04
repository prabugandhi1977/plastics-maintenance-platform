// Traceability suite pages: trace search with the full chain (material → production → gates → packing → dispatch →
// field), process control (SPC, deviations, product rules), dispatch with label scanning, and field returns with
// warranty authentication, correlation and supplier scorecards. Plus the batch quality dialog (gates, check sheets,
// deviations, labels) and the recall-scope dialog used from the Batches page.
import { esc, btn, humanise, dataTable, simpleTable, field, select, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber } from './shared/i18n.js';
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
  const STATUS_TEXT={running:'Running',on_hold:'On hold',not_found:'Not our label'};
  const pillOf=(s,text)=>`<span class="pill ${tone(s)}">${esc(text||STATUS_TEXT[s]||humanise(s))}</span>`;
  const codeLink=c=>c?`<a class="trace-code" data-trace="${esc(c)}">${esc(c)}</a>`:'';
  const tabs=(key,list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="${key}:${k}">${esc(l)}</button>`).join('')}</div>`;
  const explainer=(title,html)=>`<details class="panel explainer"><summary><b>${esc(title)}</b> <span class="muted">– a quick guide</span></summary>${html}</details>`;
  const pct=v=>v==null?'—':`${formatNumber(v,1)} %`;
  const tcat=()=>state.tcat||{gates:{},channels:{},returnKinds:{}};
  const loadCat=async()=>{ if (!state.tcat) state.tcat=await api('/trace/catalog'); };
  const paramDefs=()=>Object.fromEntries(Object.values(state.cat?.processParams||{}).flat().map(([k,l,u])=>[k,{label:l,unit:u}]));
  const pLabel=k=>paramDefs()[k]?.label||humanise(k), pUnit=k=>paramDefs()[k]?.unit||'';
  const fmtTime=t=>new Intl.DateTimeFormat(state.user.preferences.locale,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:state.user.preferences.timezone}).format(new Date(t));

  // ---------- Trace search & genealogy ----------
  function hubView(){
    if (!state.thub) { Promise.all([api('/trace/kpis'),loadCat()]).then(([k])=>{ state.thub={kpis:k}; render(); }).catch(e=>{ state.thub={kpis:null}; fail(e); }); return `<div class="panel empty">Loading traceability…</div>`; }
    const k=state.thub.kpis||{}, r=state.thubResult;
    const tiles=`<section class="kpis" aria-label="Traceability figures">${statTile('Compliance readiness',pct(k.compliancePct),{status:k.compliancePct==null?'':k.compliancePct>=95?'good':'warning',note:`batches with a complete record, last ${k.periodDays??90} days`})}${statTile('First-time quality',pct(k.firstTimeQualityPct),{note:'gates passed first time, no deviation or hold'})}${statTile('Open process deviations',formatNumber(k.openDeviations??0),{status:k.openDeviations?'critical':'good',note:k.openDeviations?'decision needed':'none'})}${statTile('Field returns',k.fieldPpm==null?'—':`${formatNumber(k.fieldPpm)} ppm`,{note:`${formatNumber(k.openReturns??0)} open`})}${statTile('Recall scope narrowed',pct(k.recallReductionPct),{note:'vs. recalling all production of the product'})}${statTile('Labels in stock',formatNumber(k.labelsInStock??0),{note:`${formatNumber(k.shipments??0)} shipments in ${k.periodDays??90} days`})}</section>`;
    const search=`<div class="panel trace-search"><h2>Find anything</h2><p class="muted">Scan or type a box or pallet label, part serial, batch, material lot, delivery note or return reference. You get the full chain: what went in, how it was made, where it went.</p><div class="row" style="align-items:flex-start">${scanInput('traceCode',{value:state.thubCode||'',placeholder:'e.g. B-HSG-2026-041-0004, PCABS-7731, DN-2026-00042'})}${btn('Trace','traceGo','primary')}</div><p class="mini muted">Try: ${['B-HSG-2026-041-0004','PCABS-7731','DN-2026-00041','FR-2026-0001'].map(codeLink).join(' · ')}</p></div>`;
    const missing=k.missing?.length?`<div class="panel"><h2>Records to complete</h2><p class="muted">What keeps batches from an audit-ready record (IATF 16949 / ISO 9001 / FDA 21 CFR 820):</p>${k.missing.map(m=>`<div class="spread mini"><span>${esc(m.what)}</span><b>${formatNumber(m.batches)} batch${m.batches===1?'':'es'}</b></div>`).join('')}</div>`:'';
    const explain=explainer('How traceability works here',`<ul><li><b>Backward</b> – from a box or complaint to the material lots and their supplier certificates, the machine, mould, operator, process settings and readings, quality-gate results and anything that happened on the machine.</li><li><b>Forward</b> – from a lot or batch to every box and pallet, every shipment and customer. A bad lot becomes a targeted recall of exact boxes, not of a month of production.</li><li><b>Real time</b> – each product has a validated <b>process window</b>; readings outside it open a deviation and an alert, and a batch cannot be released until its <b>quality gates</b> (digital check sheets) pass and deviations are decided.</li><li><b>Dispatch</b> – boxes are scanned onto shipments; only released batches for the right customer can be loaded, and older stock is suggested first (FIFO).</li><li><b>Field</b> – warranty claims are authenticated against the label: printed by us, shipped to that customer, within warranty, not claimed before.</li></ul>`);
    return header('Traceability','From raw material to customer – and back',anyRecord()?`${btn('Dispatch','goDispatch','secondary')}${btn('Record field return','newReturn','secondary')}`:'')+tiles+search+(r?chainView(r):'')+missing+explain;
  }
  function chainView(r){
    if (!r.found) return `<div class="panel"><h2>Nothing found for “${esc(state.thubCode)}”</h2>${r.suggestions?.length?`<p>Did you mean: ${r.suggestions.map(s=>`${codeLink(s.code)} <span class="muted">(${esc(humanise(s.type))})</span>`).join(' · ')}</p>`:'<p class="muted">Check the code under the label.</p>'}</div>`;
    const c=r.chain, f=c.focusUnit;
    const col=(title,count,body)=>`<div class="tcol"><div class="tcol-head"><b>${esc(title)}</b><span class="muted">${count}</span></div>${body||'<p class="muted mini">—</p>'}</div>`;
    const lots=c.lots.map(l=>`<div class="tnode">${codeLink(l.lot_number)} ${l.status==='quarantined'?pillOf('quarantined'):''}<div class="mini">${esc(l.material)}</div><div class="mini muted">${esc(l.supplier)} · ${esc(l.certificate||'no certificate')}</div></div>`).join('');
    const batches=c.batches.map(b=>`<div class="tnode">${codeLink(b.batchNumber)} ${pillOf(b.status)}<div class="mini">${esc(b.product?.part_number)} ${esc(b.product?.name)}</div><div class="mini muted">${esc(b.machine?.asset_tag||'')}${b.mould?` · mould ${esc(b.mould.asset_tag||b.mould.model)}`:''} · ${esc(b.operator)}${b.startedBy?` (signed in: ${esc(b.startedBy)})`:''}</div><div class="mini muted">${when(b.startedAt)} → ${b.endedAt?when(b.endedAt):'running'}</div>
      <div class="mini">${Object.entries(b.processParams).map(([k,v])=>`${esc(pLabel(k))} ${formatNumber(v,1)} ${esc(pUnit(k))}`).join(' · ')}</div>${b.fifoOverride?`<div class="mini">⚠ FIFO override: ${esc(b.fifoOverride)}</div>`:''}${b.holdReason?`<div class="mini"><b>Hold:</b> ${esc(b.holdReason)}</div>`:''}</div>`).join('');
    const gates=c.batches.map(b=>`<div class="tnode"><b class="mini">${esc(b.batchNumber)}</b>${b.gates.map(g=>`<div class="mini">${g.result?pillOf(g.result,g.result==='pass'?'✓ Pass':'✗ Fail'):'<span class="pill">Not done</span>'} ${esc(g.label)}${g.by?` <span class="muted">${esc(g.by)}</span>`:''}</div>`).join('')||'<div class="mini muted">No gates set up</div>'}${b.deviations.map(d=>`<div class="mini">${pillOf(d.status==='open'?'open':d.status,'Deviation '+d.status)} ${esc(pLabel(d.parameter))} ${formatNumber(d.value,1)} (${d.min??'–'}…${d.max??'–'})</div>`).join('')}</div>`).join('');
    const boxes=c.units.filter(x=>x.kind!=='part'), counts=['packed','shipped','returned'].map(s=>[s,c.units.filter(x=>x.status===s&&x.kind!=='pallet').length]).filter(([,n])=>n);
    const units=`${f?`<div class="tnode focus"><b>${esc(humanise(f.kind))} ${esc(f.serial)}</b> ${pillOf(f.status)}<div class="mini">${formatNumber(f.quantity)} ${esc(c.batches[0]?.product?.unit||'')}${f.pallet?` · on pallet ${codeLink(f.pallet)}`:''}</div></div>`:''}<div class="mini">${counts.map(([s,n])=>`${pillOf(s)} ${n}`).join(' ')}</div><div class="mini chips">${boxes.slice(0,14).map(x=>codeLink(x.serial)).join(' ')}${boxes.length>14?` <span class="muted">+${boxes.length-14} more</span>`:''}</div>`;
    const ships=c.shipments.map(s=>`<div class="tnode">${codeLink(s.shipmentNumber)} ${pillOf(s.status)}<div class="mini"><b>${esc(s.customer)}</b> · ${esc(s.channel)}</div><div class="mini muted">${esc(s.destination||'')}${s.shippedAt?` · ${when(s.shippedAt)}`:''}</div></div>`).join('');
    const rets=c.returns.map(x=>`<div class="tnode">${codeLink(x.reference)} ${pillOf(x.authenticity)}<div class="mini">${esc(humanise(x.kind))}: ${esc(x.defect)}</div><div class="mini muted">${esc(x.customer)} · ${when(x.reportedAt)} · ${esc(humanise(x.status))}</div></div>`).join('');
    const first=c.batches[0], lot=c.lots[0];
    const acts=`<div class="row">${first?btn('Batch quality & labels','batchQuality','secondary small',first.id):''}${first?btn('Recall scope of this batch','recallBatch','secondary small',first.id):''}${lot&&r.found.type==='lot'?btn('Recall scope of this lot','recallLot','danger small',lot.id):''}</div>`;
    return `<div class="panel"><div class="spread"><h2>${esc(humanise(r.found.type))} ${esc(r.found.label)}</h2><span class="mini muted">Traced in ${formatNumber(r.traceMs,1)} ms</span></div>${acts}
      <div class="tflow">${col('1 · Material (backward)',c.lots.length,lots)}${col('2 · Production',c.batches.length,batches)}${col('3 · Quality gates',c.batches.reduce((n,b)=>n+b.gates.length,0),gates)}${col('4 · Packing',boxes.length,units)}${col('5 · Dispatch (forward)',c.shipments.length,ships)}${col('6 · Field',c.returns.length,rets)}</div></div>`;
  }
  async function traceGo(code){
    code=String(code||document.querySelector('[name=traceCode]')?.value||'').trim(); if (!code) return toast('Scan or type a code','error');
    state.thubCode=code; state.thubResult=await api(`/trace/find?code=${encodeURIComponent(code)}`); if (state.page!=='traceHub') { state.page='traceHub'; state.detail=null; } render();
  }

  // ---------- Batch quality dialog: gates, check sheets, deviations, SPC, labels ----------
  async function batchQuality(id){
    await loadCat(); const q=await api(`/trace/batches/${id}/quality`), b=q.batch, can=canRecord(b.company_id), mgr=factoryManager(b.company_id);
    const blockers=q.releaseBlockers.length?`<div class="notice warn"><b>Not releasable yet:</b> ${q.releaseBlockers.map(esc).join(' · ')}</div>`:`<div class="notice ok">✓ Ready for release: gates passed, no open deviations, materials released.</div>`;
    const gates=simpleTable(['Gate','Required','Result','By','When',''],q.gates.filter(g=>g.required||g.latest).map(g=>`<tr><td><b>${esc(g.label)}</b><div class="muted mini">${g.items.length} check items${g.attempts>1?` · ${g.attempts} attempts`:''}</div></td><td>${g.required?'Yes':'No'}</td><td>${g.latest?pillOf(g.latest.result,g.latest.result==='pass'?'✓ Pass':'✗ Fail'):'<span class="pill">Not done</span>'}${g.latest?.answers?.filter(a=>!a.ok).map(a=>`<div class="mini">✗ ${esc(a.label)}${a.value!=null?`: ${formatNumber(a.value,2)} ${esc(a.unit||'')}`:''}</div>`).join('')||''}</td><td>${esc(g.latest?.by||'')}</td><td>${g.latest?when(g.latest.at):''}</td><td>${can&&g.required&&b.status!=='scrapped'?btn(g.latest?'Check again':'Fill in check sheet','gateCheck',g.latest?.result==='pass'?'secondary small':'small',`${id}|${g.gate}`):''}</td></tr>`),'No quality gates set up for this product. Add check sheets under Process control → Product rules.');
    const devs=simpleTable(['Setting','Value','Window','From → to','Readings','Decision',''],q.deviations.map(d=>`<tr><td>${esc(pLabel(d.parameter))}</td><td><b>${formatNumber(d.value,2)}</b> ${esc(pUnit(d.parameter))}</td><td>${d.min??'–'} … ${d.max??'–'}</td><td>${when(d.started_at)}${d.ended_at?` → ${when(d.ended_at)}`:' → ongoing'}</td><td>${d.readings}</td><td>${pillOf(d.status)}${d.disposition?`<div class="mini">${esc(d.disposition)}</div>`:''}</td><td>${d.status==='open'&&mgr?btn('Decide','decideDeviation','small',d.id):''}</td></tr>`),'No deviations: every reading stayed inside the process window.');
    const spcRows=simpleTable(['Setting','Readings','Mean','σ','Window','Cpk','Capability','Outside'],q.spc.map(s=>`<tr><td>${esc(pLabel(s.parameter))}</td><td>${s.n}</td><td>${formatNumber(s.mean,2)} ${esc(pUnit(s.parameter))}</td><td>${formatNumber(s.sd,3)}</td><td>${s.lsl??'–'} … ${s.usl??'–'}</td><td><b>${s.cpk==null?'—':formatNumber(s.cpk,2)}</b></td><td>${pillOf(s.cpk==null?'':s.cpk>=1.33?'pass':s.cpk>=1?'open':'fail',s.capability)}</td><td>${s.outside}</td></tr>`),'No readings recorded for this batch.');
    const boxes=q.units.filter(x=>x.kind!=='part'), unit=b.product?.unit||'';
    const labels=`<p class="muted">${formatNumber(boxes.filter(x=>x.kind==='box').length)} boxes · ${formatNumber(boxes.filter(x=>x.kind==='pallet').length)} pallets · ${formatNumber(q.units.filter(x=>x.kind==='part').length)} serialised parts</p>${can&&['running','completed','released'].includes(b.status)?`<div class="row">${btn('Create box labels','makeLabels','secondary small',`${id}|box`)}${btn('Serialise parts (DMC/QR)','makeLabels','secondary small',`${id}|part`)}${boxes.length?btn('Print labels','printBatchLabels','secondary small',id):''}</div>`:''}${simpleTable(['Label','Kind','Quantity','Status'],boxes.slice(0,30).map(x=>`<tr><td>${codeLink(x.serial)}</td><td>${esc(humanise(x.kind))}</td><td>${formatNumber(x.quantity)} ${esc(unit)}</td><td>${pillOf(x.status)}</td></tr>`),'No labels yet.')}`;
    const d=openDialog(`Batch ${b.batch_number} – quality & labels`,`<p>${pillOf(b.status)} ${esc(b.product?.part_number)} ${esc(b.product?.name)} · ${esc(b.machine?.asset_tag||'')} · good ${formatNumber(b.good,0)} ${esc(unit)}</p>${blockers}<h3>Quality gates</h3>${gates}<h3>Process deviations</h3>${devs}<h3>Process capability (SPC)</h3>${spcRows}<h3>Labels</h3>${labels}`);
    d.addEventListener('click',e=>{ const a=e.target.closest('[data-action],[data-trace]'); if (!a) return; e.preventDefault(); e.stopPropagation(); closeDialog();
      if (a.dataset.trace) return traceGo(a.dataset.trace).catch(fail); action(a.dataset.action,a.dataset.id); });
  }
  async function gateForm(key){
    const [bid,gate]=key.split('|'), q=await api(`/trace/batches/${bid}/quality`), g=q.gates.find(x=>x.gate===gate);
    const items=g.items.map((it,i)=>it.type==='ok'?`<div class="fld wide check-row"><span>${i+1}. ${esc(it.label)}</span><span class="row"><label class="check-opt"><input type="radio" name="i${i}" value="ok" required> OK</label><label class="check-opt"><input type="radio" name="i${i}" value="nok"> Not OK</label></span></div>`
      :field(`i${i}`,`${i+1}. ${it.label}`,{type:'number',step:'any',required:true,unit:it.unit,help:`Limits ${it.min??'–'} … ${it.max??'–'} ${it.unit||''}`}));
    openDialog(`${g.label} – batch ${q.batch.batch_number}`,`<p class="muted">Answer every item. A value outside its limits or a “Not OK” fails the gate: the batch cannot be released (and a finished batch goes on hold) until the gate is checked again and passes.</p><div class="form-grid">${items.join('')}${field('note','Note',{wide:true,maxlength:500})}</div>`,
      {submitLabel:'Sign and save',onSubmit:async fd=>{ const answers=g.items.map((it,i)=>it.type==='ok'?{ok:fd.get(`i${i}`)==='ok'}:{value:fd.get(`i${i}`)});
        const r=await api(`/trace/batches/${bid}/checks`,'POST',{gate,answers,note:fd.get('note')}); toast(r.result==='pass'?`${g.label} passed`:`${g.label} failed – batch blocked`,r.result==='pass'?'ok':'error'); state.trace=undefined; state.thub=undefined; render(); setTimeout(()=>batchQuality(bid),50); }});
  }
  function deviationForm(id){
    openDialog('Decide on a process deviation',`<p class="muted">Accept when the parts made during the deviation were checked and are fine; reject when they must be sorted or scrapped (the batch then cannot be released).</p><div class="form-grid">${select('decision','Decision',[['accepted','Accept – parts are fine'],['rejected','Reject – parts must be sorted or scrapped']],{required:true,value:'accepted',wide:true})}${field('disposition','Reason and evidence',{type:'textarea',required:true,wide:true,help:'e.g. 50 parts from the period measured, all within drawing; or: 2 h of production sorted 100 %'})}</div>`,
      {onSubmit:async fd=>{ await api(`/trace/deviations/${id}/decision`,'POST',Object.fromEntries(fd)); toast('Decision saved'); state.pc=undefined; state.trace=undefined; state.thub=undefined; render(); }});
  }
  async function labelsForm(key){
    const [bid,kind]=key.split('|'), q=await api(`/trace/batches/${bid}/quality`), b=q.batch, prod=(await api('/trace/products')).find(p=>p.id===b.product_id);
    openDialog(kind==='part'?`Serialise parts – batch ${b.batch_number}`:`Box labels – batch ${b.batch_number}`,`<p class="muted">${kind==='part'?'One serial per part, for a DMC or QR code lasered or printed on the part.':'One label per box (KLT or carton), with part number, quantity, batch and a unique serial in a QR code.'} Labels cannot exceed the batch's ${b.status==='running'?'planned':'good'} quantity.</p><div class="form-grid">${field('count',kind==='part'?'Number of parts':'Number of boxes',{type:'number',required:true,min:1,max:kind==='part'?5000:500,value:kind==='part'?100:10})}${kind==='box'?field('perUnit','Quantity per box',{type:'number',required:true,min:1,value:prod?.packQty||'',unit:b.product?.unit}):''}</div>`,
      {submitLabel:'Create labels',onSubmit:async fd=>{ const made=await api(`/trace/batches/${bid}/units`,'POST',{kind,count:Number(fd.get('count')),perUnit:fd.get('perUnit')?Number(fd.get('perUnit')):undefined}); toast(`${made.length} labels created`); printLabels(made.map(m=>({...m,product:b.product,batchNumber:b.batch_number,customer:prod?.customer})));
        state.thub=undefined; }});
  }
  // Printable labels (A4 sheet, 2 columns): QR with the serial, part number, description, quantity, batch, customer.
  function printLabels(list){
    const w=window.open('','_blank'); if (!w) return toast('Allow pop-ups to print labels','error');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Labels</title><style>body{font:12px system-ui,sans-serif;margin:10mm}.l{display:inline-flex;gap:10px;width:88mm;height:46mm;border:1px solid #000;margin:2mm;padding:3mm;box-sizing:border-box;vertical-align:top;page-break-inside:avoid}.l b{font-size:15px}.l div{display:flex;flex-direction:column;gap:2px}small{color:#333}@media print{button{display:none}}</style><button onclick="print()">Print</button><br>${list.map(x=>`<div class="l">${qrSvg(x.serial,120)}<div><small>${x.kind==='pallet'?'PALLET':x.kind==='part'?'PART':'BOX'} · ${esc(x.customer||'')}</small><b>${esc(x.product?.part_number||'')}</b><span>${esc(x.product?.name||'')}</span><span>Qty <b>${formatNumber(x.quantity)}</b> ${esc(x.product?.unit||'')}</span><span>Batch ${esc(x.batchNumber||x.batch?.batchNumber||'')}</span><span>S/N <b>${esc(x.serial)}</b></span></div></div>`).join('')}`);
    w.document.close();
  }
  async function printBatchLabels(id){ const q=await api(`/trace/batches/${id}/quality`), prod=(await api('/trace/products')).find(p=>p.id===q.batch.product_id); printLabels(q.units.filter(x=>x.kind!=='part').map(x=>({...x,customer:prod?.customer}))); }

  // ---------- Recall scope ----------
  async function recallDialog(kind,id){
    const r=await api(`/trace/recall?${kind}Id=${encodeURIComponent(id)}`), unit=r.batches[0]?.product?.unit||'';
    openDialog(r.lot?`Recall scope – lot ${r.lot.lotNumber}`:`Recall scope – batch ${r.batch.batchNumber}`,`${r.lot?`<p>${pillOf(r.lot.status)} ${esc(r.lot.material)} from <b>${esc(r.lot.supplier)}</b></p>`:''}
      <section class="kpis small">${statTile('Batches affected',formatNumber(r.batches.length))}${statTile('Quantity affected',`${formatNumber(r.affectedQty)} ${unit}`,{note:r.reductionPct!=null?`${formatNumber(r.reductionPct,0)} % less than without lot records (${formatNumber(r.scopeWithoutTraceability)})`:''})}${statTile('Still in our stock',`${formatNumber(r.inStock.quantity)} ${unit}`,{note:`${r.inStock.labels} labels – block and sort here`})}${statTile('At customers',`${formatNumber(r.shipped.quantity)} ${unit}`,{status:r.shipped.quantity?'warning':'good',note:`${r.shipped.labels} labels in ${r.shipments.length} shipments`})}</section>
      <h3>Customers to inform</h3>${simpleTable(['Customer','Channel','Shipments','Quantity'],r.customers.map(c=>`<tr><td><b>${esc(c.customer)}</b></td><td>${esc(c.channel)}</td><td>${c.shipments}</td><td>${formatNumber(c.quantity)} ${esc(unit)}</td></tr>`),'Nothing shipped yet – the recall stays in-house.')}
      <h3>Shipments</h3>${simpleTable(['Delivery note','Customer','Shipped','Labels','Quantity'],r.shipments.map(s=>`<tr><td>${codeLink(s.shipmentNumber)}</td><td>${esc(s.customer)}</td><td>${when(s.shippedAt)}</td><td>${s.labels}</td><td>${formatNumber(s.quantity)}</td></tr>`))}
      <h3>Batches</h3>${simpleTable(['Batch','Product','Started','Good','Status'],r.batches.map(b=>`<tr><td>${codeLink(b.batchNumber)}</td><td>${esc(b.product?.part_number)}</td><td>${when(b.startedAt)}</td><td>${formatNumber(b.good)}</td><td>${pillOf(b.status)}</td></tr>`))}
      ${r.lot&&r.lot.status!=='quarantined'?'<p class="muted">To block it: <b>Quarantine lot</b> on the Batches & material lots page puts every batch above on hold.</p>':''}`);
    document.getElementById('modal')?.addEventListener('click',e=>{ const a=e.target.closest('[data-trace]'); if (a) { e.preventDefault(); closeDialog(); traceGo(a.dataset.trace).catch(fail); } });
  }

  // ---------- Process control: SPC, deviations, product rules ----------
  function pcView(){
    if (!state.pc) { Promise.all([api('/trace/products'),api('/trace/deviations'),loadCat()]).then(([products,deviations])=>{ state.pc={products,deviations,productId:state.pcProduct||products.find(p=>p.id===deviations.find(d=>d.status==='open')?.product_id)?.id||products.find(p=>Object.keys(p.processWindow).length)?.id||products[0]?.id}; render(); }).catch(fail); return `<div class="panel empty">Loading process control…</div>`; }
    const tab=state.pcTab||'spc', {products,deviations}=state.pc, open=deviations.filter(d=>d.status==='open').length;
    let body='';
    if (tab==='spc') {
      const pid=state.pc.productId, s=state.pc.spc?.[pid];
      if (pid&&!s) api(`/trace/spc?productId=${pid}&days=30`).then(x=>{ (state.pc.spc??={})[pid]=x; render(); }).catch(fail);
      const sel=`<label class="inline-filter">Product <select data-pc-product>${products.map(p=>`<option value="${esc(p.id)}" ${p.id===pid?'selected':''}>${esc(p.partNumber)} – ${esc(p.name)}</option>`).join('')}</select></label>`;
      body=`<div class="panel"><div class="spread">${sel}<span class="muted">Last 30 days${s?` · ${s.batches} batches`:''}</span></div>${!s?'<p class="muted">Loading…</p>':!s.spc.length?'<p class="muted">No process readings for this product yet. Readings come from the machine (IoT) or are entered on the batch.</p>':
        simpleTable(['Setting','Readings','Mean','σ','Window (LSL … USL)','Cp','Cpk','Capability'],s.spc.map(x=>`<tr><td><b>${esc(pLabel(x.parameter))}</b></td><td>${x.n}</td><td>${formatNumber(x.mean,2)} ${esc(pUnit(x.parameter))}</td><td>${formatNumber(x.sd,3)}</td><td>${x.lsl??'–'} … ${x.usl??'–'}</td><td>${x.cp==null?'—':formatNumber(x.cp,2)}</td><td><b>${x.cpk==null?'—':formatNumber(x.cpk,2)}</b></td><td>${pillOf(x.cpk==null?'':x.cpk>=1.33?'pass':x.cpk>=1?'open':'fail',x.capability)}</td></tr>`))+
        `<div class="chart-grid">${s.spc.map(x=>lineChart(`spc-${x.parameter}`,{title:`${pLabel(x.parameter)} (${pUnit(x.parameter)})`,subtitle:`Control chart · Cpk ${x.cpk==null?'—':formatNumber(x.cpk,2)}`,unit:pUnit(x.parameter),points:x.series,formatTime:fmtTime,
          limits:[...(x.usl!=null?[{value:x.usl,label:'USL',kind:'critical'}]:[]),...(x.lsl!=null?[{value:x.lsl,label:'LSL',kind:'critical'}]:[]),{value:x.ucl,label:'UCL',kind:'warning'},{value:x.lcl,label:'LCL',kind:'warning'}]})).join('')}</div>`}</div>`;
    }
    if (tab==='deviations') body=`<div class="panel">${dataTable('deviations',{rows:deviations,search:d=>`${d.batch_number} ${d.part_number} ${d.parameter}`,filters:[{key:'status',label:'Decision',options:['open','accepted','rejected'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:'No process deviations. Every reading stayed inside its window.',
      columns:[{title:'Batch',cell:d=>`${codeLink(d.batch_number)}<div class="muted">${esc(d.part_number)}</div>`},{title:'Setting',cell:d=>esc(pLabel(d.parameter))},{title:'Worst value',cell:d=>`<b>${formatNumber(d.value,2)}</b> ${esc(pUnit(d.parameter))}`},{title:'Window',cell:d=>`${d.min??'–'} … ${d.max??'–'}`},{title:'When',cell:d=>`${when(d.started_at)}${d.ended_at?`<div class="muted">to ${when(d.ended_at)}</div>`:'<div class="muted">ongoing</div>'}`},{title:'Decision',cell:d=>`${pillOf(d.status)}${d.disposition?`<div class="mini">${esc(d.disposition)}</div>`:''}`},
        {title:'',cls:'row',cell:d=>`${btn('Batch quality','batchQuality','secondary small',d.batch_id)}${d.status==='open'&&factoryManager(d.company_id)?btn('Decide','decideDeviation','small',d.id):''}`}]})}</div>`;
    if (tab==='rules') body=`<div class="panel">${dataTable('rules',{rows:products,search:p=>`${p.partNumber} ${p.name} ${p.customer}`,empty:'No products yet. Add them under Products & cycle times.',
      columns:[{title:'Product',cell:p=>`<b>${esc(p.partNumber)}</b><div class="muted">${esc(p.name)}</div>`},{title:'Customer',cell:p=>esc(p.customer||'—')},{title:'Warranty',cell:p=>`${p.warrantyMonths} months`},{title:'Pack',cell:p=>p.packQty?`${formatNumber(p.packQty)} ${esc(p.unit)}/box`:'—'},
        {title:'Process window',cell:p=>Object.entries(p.processWindow).map(([k,w])=>`<div class="mini">${esc(pLabel(k))} ${w.min??'–'} … ${w.max??'–'} ${esc(pUnit(k))}</div>`).join('')||'<span class="muted">not set</span>'},
        {title:'Quality gates',cell:p=>Object.entries(p.checkSheets).map(([g,items])=>`<div class="mini">${esc(tcat().gates[g]||g)} (${items.length})</div>`).join('')||'<span class="muted">none</span>'},{title:'On deviation',cell:p=>p.holdOnDeviation?'<span class="pill warning">Hold batch</span>':'Alert'},
        {title:'',cell:p=>factoryManager(p.companyId)?btn('Edit rules','editRules','secondary small',p.id):''}]})}</div>`;
    const explain=explainer('Process control in plain words',`<ul><li><b>Process window</b> – the validated range of each setting (melt temperature, hold pressure, cycle time…) for a product, from the PPAP / process validation. Batches cannot start outside it.</li><li><b>Deviation</b> – a live reading outside the window opens a deviation and an alert. Someone decides whether the parts made meanwhile are fine; until then the batch cannot be released.</li><li><b>Cpk</b> – how well the process fits the window. ≥ 1.33 is capable (automotive usually asks 1.33, or 1.67 for special characteristics); below 1.0 the process produces outside the window.</li><li><b>Control chart</b> – the readings with ±3σ control limits (UCL/LCL) and the window (USL/LSL).</li></ul>`);
    return header('Process control','Process windows, live deviations and capability (SPC)')+tabs('pc',[['spc','Capability (SPC)'],['deviations',`Deviations${open?` (${open} open)`:''}`],['rules','Product rules']],tab)+body+explain;
  }
  async function rulesForm(id){
    await loadCat(); const p=state.pc.products.find(x=>x.id===id), types=state.cat?.processParams||{}, params=p.machineType?types[p.machineType]:Object.values(types).flat().filter((x,i,a)=>a.findIndex(y=>y[0]===x[0])===i);
    const sheetText=items=>(items||[]).map(it=>it.type==='ok'?`${it.label} | ok`:`${it.label} | measure | ${it.min??''} | ${it.max??''} | ${it.unit||''}`).join('\n');
    const win=params.map(([k,l,u])=>`<div class="fld"><label>${esc(l)} (${esc(u)}) – min … max</label><div class="row"><input name="w.${k}.min" type="number" step="any" placeholder="min" value="${esc(p.processWindow[k]?.min??'')}" aria-label="${esc(l)} minimum" style="width:45%"><input name="w.${k}.max" type="number" step="any" placeholder="max" value="${esc(p.processWindow[k]?.max??'')}" aria-label="${esc(l)} maximum" style="width:45%"></div></div>`).join('');
    const sheets=Object.entries(tcat().gates).map(([g,l])=>field(`s.${g}`,l,{type:'textarea',wide:true,value:sheetText(p.checkSheets[g]),help:'One item per line: “Label | ok”, or “Label | measure | min | max | unit”. Leave empty if this gate is not used.'})).join('');
    openDialog(`Traceability rules – ${p.partNumber}`,section('Customer and packing',`${field('customer','Customer',{value:p.customer,maxlength:120,help:'Only this customer\'s shipments can load this part'})}${field('warrantyMonths','Warranty',{type:'number',min:0,max:240,value:p.warrantyMonths,unit:'months'})}${field('packQty','Quantity per box',{type:'number',min:1,value:p.packQty??'',unit:p.unit})}${select('holdOnDeviation','When a reading leaves the window',[['0','Alert'],['1','Alert and hold the batch until decided']],{value:p.holdOnDeviation?'1':'0'})}`)
      +section('Process window (validated settings)',win)+section('Quality gates – digital check sheets',sheets),
      {onSubmit:async fd=>{ const processWindow={}, checkSheets={};
        for (const [k] of params) { const min=fd.get(`w.${k}.min`), max=fd.get(`w.${k}.max`); if (min!==''||max!=='') processWindow[k]={min:min===''?null:Number(min),max:max===''?null:Number(max)}; }
        for (const g of Object.keys(tcat().gates)) { const lines=String(fd.get(`s.${g}`)||'').split('\n').map(x=>x.trim()).filter(Boolean); if (!lines.length) continue;
          checkSheets[g]=lines.map((line,i)=>{ const [label,type='ok',min='',max='',unit='']=line.split('|').map(x=>x.trim()); if (!['ok','measure'].includes(type)) throw Error(`${tcat().gates[g]}, line ${i+1}: type must be ok or measure`); return type==='ok'?{label,type}:{label,type,min:min===''?null:Number(min),max:max===''?null:Number(max),unit}; }); }
        await api(`/trace/products/${id}`,'PUT',{customer:fd.get('customer'),warrantyMonths:Number(fd.get('warrantyMonths')),packQty:fd.get('packQty')===''?null:Number(fd.get('packQty')),holdOnDeviation:fd.get('holdOnDeviation')==='1',processWindow,checkSheets});
        toast('Rules saved'); state.pc=undefined; render(); }});
  }

  // ---------- Dispatch ----------
  function dispatchView(){
    if (!state.ship) { Promise.all([api('/trace/shipments'),api('/trace/stock'),loadCat()]).then(([shipments,stock])=>{ state.ship={shipments,stock}; render(); }).catch(fail); return `<div class="panel empty">Loading shipments…</div>`; }
    const tab=state.shipTab||'shipments', {shipments,stock}=state.ship;
    const tiles=`<section class="kpis small">${statTile('Loading now',formatNumber(shipments.filter(s=>s.status==='loading').length))}${statTile('Shipped (all time)',formatNumber(shipments.filter(s=>s.status==='shipped').length))}${statTile('Labels in stock',formatNumber(stock.length),{note:`${formatNumber(stock.filter(x=>x.batch.status!=='released').length)} not released yet`})}</section>`;
    const list=dataTable('shipments',{rows:shipments,search:s=>`${s.shipment_number} ${s.customer} ${s.destination} ${s.customer_po} ${s.lines.map(l=>l.partNumber+' '+l.batchNumber).join(' ')}`,filters:[{key:'status',label:'Status',options:['loading','shipped','cancelled'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:'No shipments yet.',
      columns:[{title:'Delivery note',cell:s=>`${codeLink(s.shipment_number)}${s.customer_po?`<div class="muted">PO ${esc(s.customer_po)}</div>`:''}`},{title:'Customer',cell:s=>`<b>${esc(s.customer)}</b><div class="muted">${esc(s.channelLabel)}${s.destination?` · ${esc(s.destination)}`:''}</div>`},{title:'Contents',cell:s=>s.lines.map(l=>`<div class="mini">${esc(l.partNumber)} · batch ${esc(l.batchNumber)} · ${formatNumber(l.quantity)} ${esc(l.unit)}</div>`).join('')||'<span class="muted">empty</span>'},{title:'Status',cell:s=>`${pillOf(s.status)}${s.shipped_at?`<div class="muted">${when(s.shipped_at)}</div>`:''}`},
        {title:'',cls:'row',cell:s=>`${s.status==='loading'&&canRecord(s.company_id)?btn('Scan & load','loadShipment','small',s.id):''}${s.status!=='cancelled'?btn('Delivery note','deliveryNote','secondary small',s.id):''}`}]});
    const stockTable=dataTable('stock',{rows:stock,search:x=>`${x.serial} ${x.product.part_number} ${x.batch.batchNumber} ${x.product.customer}`,filters:[{key:'kind',label:'Kind',options:[['box','Box'],['pallet','Pallet'],['part','Part']],match:(r,v)=>r.kind===v}],empty:'No finished goods in stock.',
      columns:[{title:'Label',cell:x=>codeLink(x.serial)},{title:'Kind',cell:x=>esc(humanise(x.kind))},{title:'Product',cell:x=>`${esc(x.product.part_number)}<div class="muted">${esc(x.product.customer||'')}</div>`},{title:'Batch',cell:x=>`${codeLink(x.batch.batchNumber)} ${pillOf(x.batch.status)}`},{title:'Quantity',cell:x=>`${formatNumber(x.quantity)} ${esc(x.product.unit)}`},{title:'Packed',cell:x=>when(x.createdAt)}]});
    const explain=explainer('How dispatch works',`<ol><li><b>New shipment</b> for a customer (delivery note number is created if you leave it empty).</li><li><b>Scan & load</b>: scan each box or pallet label with a handheld scanner or the phone camera. The platform refuses labels of batches that are not released (gates, deviations, quarantined material), labels of parts made for another customer, and boxes already on a pallet or shipment. It warns when older stock of the same part is still in the warehouse (FIFO).</li><li><b>Ship</b> closes the delivery note; every label on it is then traceable to the customer.</li></ol>`);
    const can=anyRecord();
    return header('Dispatch & shipments','Scan-verified loading, so only released parts reach the right customer',can?`${btn('Build pallet','newPallet','secondary')}${btn('New shipment','newShipment','primary')}`:'')+tiles+tabs('ship',[['shipments',`Shipments (${shipments.length})`],['stock',`Finished goods stock (${stock.length})`]],tab)+`<div class="panel">${tab==='stock'?stockTable:list}</div>`+explain;
  }
  async function shipmentForm(){
    const products=await api('/trace/products'), customers=[...new Set(products.map(p=>p.customer).filter(Boolean))], multi=companies().length>1&&admin();
    openDialog('New shipment',`<div class="form-grid">${multi?select('companyId','Company',companies().map(c=>[c.id,c.name]),{required:true,value:companyId()}):''}${field('customer','Customer',{required:true,list:'cust-list',maxlength:120})}<datalist id="cust-list">${customers.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>${select('channel','Channel',Object.entries(tcat().channels),{required:true,value:'oem'})}${field('destination','Destination',{maxlength:200,help:'Plant, dock or warehouse'})}${field('customerPo','Customer PO',{maxlength:60})}${field('shipmentNumber','Delivery note number',{maxlength:60,help:'Leave empty to number it automatically'})}</div>`,
      {submitLabel:'Create and start loading',onSubmit:async fd=>{ const s=await api('/trace/shipments','POST',Object.fromEntries(fd)); state.ship=undefined; render(); setTimeout(()=>loadDialog(s.id),50); }});
  }
  async function loadDialog(id){
    let s=(await api('/trace/shipments')).find(x=>x.id===id);
    const listHtml=()=>`${simpleTable(['Label','Kind','Product','Batch','Quantity',''],s.units.filter(x=>!x.parentId||!s.units.some(p=>p.id===x.parentId)).map(x=>`<tr><td><b>${esc(x.serial)}</b></td><td>${esc(humanise(x.kind))}</td><td>${esc(x.product.part_number)}</td><td>${esc(x.batch.batchNumber)}</td><td>${formatNumber(x.quantity)} ${esc(x.product.unit)}</td><td><button type="button" class="link-btn" data-remove="${esc(x.serial)}">Remove</button></td></tr>`),'Nothing loaded yet. Scan the first label.')}<p><b>${formatNumber(s.quantity)}</b> in ${s.lines.length} line${s.lines.length===1?'':'s'}: ${s.lines.map(l=>`${esc(l.partNumber)} × ${formatNumber(l.quantity)}`).join(', ')||'—'}</p>`;
    const d=openDialog(`Load ${s.shipment_number} – ${s.customer}`,`<div class="fld wide"><label for="f-dispatchCode">Scan box or pallet label</label>${scanInput('dispatchCode',{placeholder:'Scan, or type the label serial'})}</div><div id="load-msg" role="status"></div><div id="load-list">${listHtml()}</div>`,{submitLabel:'Ship now',onSubmit:async()=>{
      if (!await confirmAction(`Ship ${s.shipment_number}?`,`${formatNumber(s.quantity)} units to ${s.customer}. Each label is checked again before closing.`,{confirmLabel:'Ship',danger:false})) throw Error('Not shipped');
      await api(`/trace/shipments/${id}/ship`,'POST',{}); toast(`${s.shipment_number} shipped`); state.ship=undefined; state.thub=undefined; render(); }});
    const msg=d.querySelector('#load-msg'), say=(html,kind)=>{ msg.className=`notice ${kind}`; msg.innerHTML=html; };
    const refresh=()=>{ d.querySelector('#load-list').innerHTML=listHtml(); d.querySelectorAll('[data-remove]').forEach(b=>b.onclick=async()=>{ try { s=await api(`/trace/shipments/${id}/remove`,'POST',{serial:b.dataset.remove}); say(`Removed ${esc(b.dataset.remove)}`,'ok'); refresh(); } catch(e) { say(esc(e.message),'error'); } }); };
    refresh();
    bindScanInput(d,'dispatchCode',async code=>{ const input=d.querySelector('[name=dispatchCode]');
      try { const r=await api(`/trace/shipments/${id}/scan`,'POST',{serial:code}); s=r.shipment; refresh(); say(`✓ ${esc(r.added)} loaded${r.warnings.length?`<br>⚠ ${r.warnings.map(esc).join('<br>⚠ ')}`:''}`,r.warnings.length?'warn':'ok'); if (navigator.vibrate) navigator.vibrate(60); }
      catch(e) { say(`✗ ${esc(e.message)}`,'error'); if (navigator.vibrate) navigator.vibrate([120,60,120]); }
      input.value=''; input.focus(); },e=>say(`✗ ${esc(e.message)}`,'error'));
  }
  async function deliveryNote(id){
    const s=(await api('/trace/shipments')).find(x=>x.id===id), w=window.open('','_blank'); if (!w) return toast('Allow pop-ups to print','error');
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(s.shipment_number)}</title><style>body{font:13px system-ui,sans-serif;margin:15mm}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px;text-align:left}h1{font-size:20px}.top{display:flex;justify-content:space-between}@media print{button{display:none}}</style><button onclick="print()">Print</button><div class="top"><div><h1>Delivery note ${esc(s.shipment_number)}</h1><p>To: <b>${esc(s.customer)}</b> (${esc(s.channelLabel)})<br>${esc(s.destination||'')}<br>Customer PO: ${esc(s.customer_po||'—')}<br>${s.shipped_at?`Shipped: ${esc(new Date(s.shipped_at).toLocaleString())}`:'Status: '+esc(s.status)}</p></div>${qrSvg(s.shipment_number,110)}</div>
      <h2>Lines</h2><table><tr><th>Part number</th><th>Description</th><th>Batch</th><th>Labels</th><th>Quantity</th></tr>${s.lines.map(l=>`<tr><td>${esc(l.partNumber)}</td><td>${esc(l.name)}</td><td>${esc(l.batchNumber)}</td><td>${l.units}</td><td>${formatNumber(l.quantity)} ${esc(l.unit)}</td></tr>`).join('')}</table>
      <h2>Labels</h2><p>${s.units.map(x=>`${esc(x.serial)}${x.kind==='pallet'?' (pallet)':''}`).join(', ')}</p>`); w.document.close();
  }
  function palletForm(){
    const multi=companies().length>1&&admin();
    const d=openDialog('Build a pallet',`<p class="muted">Scan the boxes going on the pallet. A pallet label is created; scanning it later loads all its boxes at once.</p><div class="form-grid">${multi?select('companyId','Company',companies().map(c=>[c.id,c.name]),{required:true,value:companyId()}):''}<div class="fld wide"><label for="f-palletCode">Scan box</label>${scanInput('palletCode')}</div>${field('serials','Boxes on the pallet',{type:'textarea',wide:true,required:true,help:'One label per line (scans are added here)'})}</div>`,
      {submitLabel:'Create pallet label',onSubmit:async fd=>{ const p=await api('/trace/pallets','POST',{companyId:fd.get('companyId')||undefined,serials:String(fd.get('serials')).split(/\s+/).filter(Boolean)}); toast(`Pallet ${p.serial}: ${p.boxes} boxes`);
        const x=await api(`/trace/units/${encodeURIComponent(p.serial)}`); printLabels([{...x,batchNumber:x.batch.batchNumber,customer:x.product.customer}]); state.ship=undefined; render(); }});
    bindScanInput(d,'palletCode',code=>{ const ta=d.querySelector('[name=serials]'); if (!ta.value.split(/\s+/).includes(code.toUpperCase())) ta.value=(ta.value.trim()+'\n'+code.toUpperCase()).trim(); const i=d.querySelector('[name=palletCode]'); i.value=''; i.focus(); });
  }

  // ---------- Field returns & warranty ----------
  function frView(){
    if (!state.fr) { Promise.all([api('/trace/returns'),api('/trace/correlation'),api('/trace/suppliers'),loadCat()]).then(([returns,correlation,suppliers])=>{ state.fr={returns,correlation,suppliers}; render(); }).catch(fail); return `<div class="panel empty">Loading field returns…</div>`; }
    const tab=state.frTab||'returns', {returns,correlation:c,suppliers}=state.fr;
    const fLabel=f=>f.dimension==='setting'?(([k,band])=>`${pLabel(k)} ≈ ${formatNumber(Number(band))} ${pUnit(k)}`)(f.key.split(':')):f.label;
    const tiles=`<section class="kpis small">${statTile('Field returns',`${formatNumber(c.ppm)} ppm`,{note:`${formatNumber(c.totalReturned)} of ${formatNumber(c.totalShipped)} shipped`})}${statTile('Open',formatNumber(returns.filter(r=>r.status==='open').length))}${statTile('Suspicious or unknown claims',formatNumber(returns.filter(r=>r.authenticity!=='genuine').length),{status:returns.some(r=>r.authenticity!=='genuine')?'warning':'',note:'duplicates, wrong customer, counterfeit labels'})}</section>`;
    let body='';
    if (tab==='returns') body=dataTable('returns',{rows:returns,search:r=>`${r.reference} ${r.customer} ${r.serial} ${r.batch_number} ${r.defect}`,filters:[{key:'status',label:'Status',options:['open','accepted','rejected','closed'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v},{key:'auth',label:'Authenticity',options:[['genuine','Genuine'],['suspicious','Suspicious'],['not_found','Not found']],match:(r,v)=>r.authenticity===v}],empty:'No field returns recorded.',
      columns:[{title:'Reference',cell:r=>`${codeLink(r.reference)}<div class="muted">${esc(tcat().returnKinds[r.kind]||r.kind)}</div>`},{title:'Customer',cell:r=>esc(r.customer)},{title:'Label / batch',cell:r=>`${r.serial?codeLink(r.serial):'—'}<div class="muted">${r.batch_number?esc(r.batch_number):''}</div>`},{title:'Defect',cell:r=>`${esc(r.defect)} <span class="muted">× ${formatNumber(r.quantity)}</span>`},{title:'Authenticity',cell:r=>`${pillOf(r.authenticity)}${r.checks.filter(x=>!x.ok).map(x=>`<div class="mini">✗ ${esc(x.check)}: ${esc(x.detail)}</div>`).join('')}`},{title:'Reported',cell:r=>when(r.reported_at)},{title:'Status',cell:r=>`${pillOf(r.status)}${r.root_cause?`<div class="mini">Cause: ${esc(r.root_cause)}</div>`:''}`},
        {title:'',cell:r=>factoryManager(r.company_id)?btn('Decide','decideReturn','secondary small',r.id):''}]});
    if (tab==='warranty') body=`<p class="muted">Check a claim before accepting it: the serial on the label must be one we printed, shipped to this customer, within warranty and not claimed before.</p><div class="form-grid"><div class="fld"><label for="f-authSerial">Serial on the label</label>${scanInput('authSerial')}</div>${field('authCustomer','Claiming customer',{maxlength:120})}</div><div class="row">${btn('Check claim','authCheck','primary')}</div><div id="auth-result">${state.frAuth?authHtml(state.frAuth):''}</div>`;
    if (tab==='correlation') body=`<p class="muted">What returned parts have in common: returns per 1,000 shipped, by material lot, supplier, machine, mould, operator and process setting. Factors well above the average (× average) point to the root cause. Factors that tie come from the same batches: compare batches that differ in one factor.</p>${barChart('corr-chart',{title:'Returns per 1,000 shipped',subtitle:'Top factors',valueLabel:'Per 1,000',rows:c.factors.slice(0,8).map(f=>({label:`${humanise(f.dimension)}: ${fLabel(f)}`,value:f.per1000}))})}${simpleTable(['Factor','Value','Batches','Shipped','Returned','Per 1,000','× average'],c.factors.map(f=>`<tr><td>${esc(humanise(f.dimension))}</td><td><b>${esc(fLabel(f))}</b></td><td>${f.batches}</td><td>${formatNumber(f.shipped)}</td><td>${formatNumber(f.returned)}</td><td>${formatNumber(f.per1000,2)}</td><td>${f.vsAverage==null?'—':`${formatNumber(f.vsAverage,1)}×`}</td></tr>`),'No returns linked to shipped batches yet.')}`;
    if (tab==='suppliers') body=`<p class="muted">Per supplier: lots received, lots quarantined, and what their material caused downstream (batches held, process deviations, field returns). Score from 100; rating A ≥ 90, B ≥ 75.</p>${simpleTable(['Supplier','Rating','Lots','Delivered','Quarantined','Batches held','Deviations','Field returns','Last delivery'],suppliers.map(s=>`<tr><td><b>${esc(s.supplier)}</b><div class="muted mini">${esc(s.materials.join(', '))}</div></td><td>${pillOf(s.rating==='A'?'pass':s.rating==='B'?'open':'fail',`${s.rating} · ${s.score}`)}</td><td>${s.lots}</td><td>${formatNumber(s.kg)} kg</td><td>${s.quarantinedLots}</td><td>${s.batchesHeld}</td><td>${s.deviations}</td><td>${s.fieldReturns}</td><td>${when(s.lastDelivery)}</td></tr>`))}`;
    return header('Field returns & warranty','Complaints, warranty claims and field failures, linked back to how the parts were made',anyRecord()?btn('Record field return','newReturn','primary'):'')+tiles+tabs('fr',[['returns',`Returns & claims (${returns.length})`],['warranty','Check a warranty claim'],['correlation','Field correlation'],['suppliers','Supplier quality']],tab)+`<div class="panel">${body}</div>`;
  }
  const authHtml=a=>`<div class="panel"><h3>${pillOf(a.authenticity,a.authenticity==='genuine'?'✓ Genuine':a.authenticity==='suspicious'?'⚠ Suspicious':'✗ Not our label')} ${a.unit?`${esc(a.unit.product.part_number)} · batch ${codeLink(a.batch.batchNumber)}`:''}</h3>${a.checks.map(c=>`<div class="spread mini"><span>${c.ok?'✓':'✗'} ${esc(c.check)}</span><span class="muted">${esc(c.detail)}</span></div>`).join('')}</div>`;
  async function authCheck(){
    const serial=document.querySelector('[name=authSerial]')?.value, customer=document.querySelector('[name=authCustomer]')?.value;
    if (!serial) return toast('Scan or type the serial','error');
    state.frAuth=await api(`/trace/authenticate?serial=${encodeURIComponent(serial)}&customer=${encodeURIComponent(customer||'')}`); document.getElementById('auth-result').innerHTML=authHtml(state.frAuth);
  }
  function returnForm(){
    const multi=companies().length>1&&admin();
    const d=openDialog('Record a field return',`<p class="muted">Scan or type the serial on the label: the claim is authenticated and linked to its batch automatically. Without a label, give the batch number printed on the part.</p><div class="form-grid">${multi?select('companyId','Company',companies().map(c=>[c.id,c.name]),{required:true,value:companyId()}):''}${select('kind','Type',Object.entries(tcat().returnKinds),{required:true,value:'complaint'})}${field('customer','Customer',{required:true,maxlength:120})}<div class="fld"><label for="f-serial">Serial on the label</label>${scanInput('serial')}</div>${field('batchNumber','Batch number (if no label)',{maxlength:60})}${field('defect','Defect',{required:true,maxlength:120,help:'e.g. cracked clip, short shot, black specks'})}${field('quantity','Quantity',{type:'number',min:1,value:1})}${field('description','Description',{type:'textarea',wide:true,maxlength:2000})}</div>`,
      {submitLabel:'Record',onSubmit:async fd=>{ const r=await api('/trace/returns','POST',Object.fromEntries(fd)); toast(`${r.reference} recorded – ${r.authenticity==='genuine'?'genuine':r.authenticity==='suspicious'?'⚠ suspicious claim':'⚠ label not found'}`,r.authenticity==='genuine'?'ok':'error'); state.fr=undefined; state.thub=undefined; render(); }});
    bindScanInput(d,'serial',()=>{});
  }
  function decideReturnForm(id){
    const r=state.fr.returns.find(x=>x.id===id);
    openDialog(`Decide ${r.reference}`,`${authHtml({authenticity:r.authenticity,checks:r.checks,unit:null})}<div class="form-grid">${select('status','Decision',[['open','Open – investigating'],['accepted','Accepted'],['rejected','Rejected'],['closed','Closed – corrective action done']],{required:true,value:r.status})}${field('rootCause','Root cause',{type:'textarea',wide:true,value:r.root_cause||''})}${field('correctiveAction','Corrective action (8D)',{type:'textarea',wide:true,value:r.corrective_action||''})}</div>`,
      {onSubmit:async fd=>{ await api(`/trace/returns/${id}`,'PATCH',Object.fromEntries(fd)); toast('Saved'); state.fr=undefined; render(); }});
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
