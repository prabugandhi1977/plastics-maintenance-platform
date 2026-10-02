// Smart factory pages, stages 3–4: traceability, vision quality, safety, and asset tracking. The app passes in its
// shared state and helpers, so these pages behave exactly like the others (same tables, dialogs, charts and toasts).
import { esc, btn, humanise, dataTable, simpleTable, field, select, checkboxes, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber, formatDuration } from './shared/i18n.js';
import { columnChart, barChart, statTile, bindCharts } from './charts.js';

export function createOps(ctx) {
  const { state, api, save, render, fail, when, assetName, header, RANGES, pctText, since, factoryManager, admin, is, customer } = ctx;
  const cat=()=>state.cat||{};
  const companyName=id=>(state.data.companies||[]).find(c=>c.id===id)?.name||'';
  const multiCompany=()=>(state.data.companies||[]).length>1;
  const machinesOf=(companyId,plantId)=>(state.data.equipment||[]).filter(e=>(cat().productionMachines||[]).includes(e.machine_type)&&(!companyId||e.company_id===companyId)&&(!plantId||e.plant_id===plantId));
  const canRecord=companyId=>admin()||(customer()&&companyId===state.user.companyId);
  const recordCompanies=()=>(state.data.companies||[]).filter(c=>canRecord(c.id));
  const tone=s=>({released:'approved',completed:'approved',running:'pending',on_hold:'warning',scrapped:'critical',quarantined:'critical',consumed:'inactive',open:'critical',investigating:'pending',closed:'approved'})[s]||'';
  const statusPill=s=>`<span class="pill ${tone(s)}">${esc(humanise(s))}</span>`;
  const sevPill=s=>`<span class="pill ${s==='critical'?'critical':s==='warning'?'warning':''}">${s==='critical'?'⚠ ':s==='warning'?'● ':''}${esc(humanise(s))}</span>`;
  const dayLabel=d=>new Intl.DateTimeFormat(state.user.preferences.locale,{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(d+'T00:00:00Z'));
  const explainer=(title,html)=>`<details class="panel explainer"><summary><b>${esc(title)}</b> <span class="muted">– a quick guide</span></summary>${html}</details>`;
  const tabs=(key,list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="${key}:${k}">${esc(l)}</button>`).join('')}</div>`;

  // ---------- Traceability ----------
  async function loadTrace(){ const [batches,lots]=await Promise.all([api('/trace/batches'),api('/trace/lots')]).catch(e=>{toast(e.message,'error');return [[],[]]}); state.trace={batches,lots}; }
  function traceView(){
    if (!state.trace) { loadTrace().then(render); return `<div class="panel empty">Loading batches and material lots…</div>`; }
    const tab=state.traceTab||'batches', {batches,lots}=state.trace, can=recordCompanies().length>0;
    const count=s=>batches.filter(b=>b.status===s).length;
    const tiles=`<section class="kpis small" aria-label="Batches">${statTile('Running',formatNumber(count('running')),{note:'batches in production'})}${statTile('Awaiting release',formatNumber(count('completed')),{status:count('completed')?'warning':'',note:count('completed')?'quality decision needed':''})}${statTile('On hold',formatNumber(count('on_hold')),{status:count('on_hold')?'critical':'',note:count('on_hold')?'blocked from shipping':''})}${statTile('Quarantined lots',formatNumber(lots.filter(l=>l.status==='quarantined').length),{status:lots.some(l=>l.status==='quarantined')?'critical':''})}</section>`;
    const batchTable=dataTable('batches',{rows:batches,search:b=>`${b.batch_number} ${b.product?.part_number} ${b.product?.name} ${b.machine?.asset_tag} ${b.operator_name} ${b.lots.map(l=>l.lotNumber).join(' ')}`,
      filters:[{key:'status',label:'Status',options:['running','completed','on_hold','released','scrapped'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:'No batches yet. Start one when production of an order begins.',
      columns:[{title:'Batch',cell:b=>`<a data-action="genealogy" data-id="${esc(b.id)}"><b>${esc(b.batch_number)}</b></a>${multiCompany()?`<div class="muted">${esc(companyName(b.company_id))}</div>`:''}`},{title:'Product',cell:b=>`${esc(b.product?.part_number)}<div class="muted">${esc(b.product?.name)}</div>`},{title:'Machine',cell:b=>esc(b.machine?.asset_tag||'')},{title:'Started',cell:b=>`${when(b.started_at)}${b.ended_at?`<div class="muted">ended ${when(b.ended_at)}</div>`:''}`},
        {title:'Good · scrap',cell:b=>`${formatNumber(b.good,0)} · ${formatNumber(b.scrap,0)} <span class="muted">${esc(b.product?.unit||'')}</span>`},{title:'Material lots',cell:b=>b.lots.map(l=>`<span class="${l.status==='quarantined'?'pill critical':''}">${esc(l.lotNumber)}</span>`).join(', ')},{title:'Status',cell:b=>`${statusPill(b.status)}${b.hold_reason?`<div class="muted">${esc(b.hold_reason)}</div>`:''}`},
        {title:'',cls:'row',cell:b=>`${btn('Batch genealogy','genealogy','secondary small',b.id)}${btn('Quality & labels','batchQuality','secondary small',b.id)}${b.status==='running'&&canRecord(b.company_id)?btn('Complete batch','completeBatch','small',b.id):''}${['completed','on_hold'].includes(b.status)&&factoryManager(b.company_id)?btn('Release batch','releaseBatch','small',b.id):''}${['completed','released','running'].includes(b.status)&&factoryManager(b.company_id)?btn('Put batch on hold','holdBatch','secondary small',b.id):''}`}]});
    const lotTable=dataTable('lots',{rows:lots,search:l=>`${l.lot_number} ${l.material} ${l.supplier} ${l.certificate}`,
      filters:[{key:'status',label:'Status',options:['released','quarantined','consumed'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:'No material lots yet. Register each delivery of resin, masterbatch or additive when it arrives.',
      columns:[{title:'Lot',cell:l=>`<b>${esc(l.lot_number)}</b>${multiCompany()?`<div class="muted">${esc(companyName(l.company_id))}</div>`:''}`},{title:'Material',cell:l=>`${esc(l.material)}<div class="muted">${esc(l.supplier)}</div>`},{title:'Received',cell:l=>when(l.received_at)},{title:'Quantity',cell:l=>`${formatNumber(l.quantity_kg,0)} kg`},{title:'Certificate',cell:l=>esc(l.certificate||'—')},{title:'Used in',cell:l=>`${formatNumber(l.batches)} batch${l.batches===1?'':'es'}`},{title:'Status',cell:l=>statusPill(l.status)},
        {title:'',cls:'row',cell:l=>`${btn('Where used (batches)','lotUsage','secondary small',l.id)}${btn('Recall scope','recallLot','secondary small',l.id)}${l.status==='released'&&factoryManager(l.company_id)?btn('Quarantine lot','quarantineLot','danger small',l.id):''}${l.status==='quarantined'&&factoryManager(l.company_id)?btn('Release lot','releaseLot','small',l.id):''}`}]});
    const actions=can?`${btn('Register material lot','newLot','secondary')}${btn('Start batch','newBatch','primary')}`:'';
    const explain=explainer('How traceability works',`<p>Every <b>batch</b> records what went into it and how it was made: the <b>material lots</b> (resin, masterbatch, glass fibre…), the machine and mould, the operator and the process settings. The machine's own counts give its output.</p><ul><li><b>Backward</b> – “what went into this batch?” Open a batch's <b>genealogy</b>: lots, settings, and what happened on the machine while it ran (stops, alerts, maintenance, camera rejects).</li><li><b>Forward</b> – “where did this lot go?” Use <b>Where used</b> on a lot.</li><li><b>Targeted recall</b> – when a supplier reports a bad lot, <b>Quarantine</b> it: exactly the batches that used it go on hold, and the lot cannot be used for new batches. Everything else keeps shipping.</li></ul><p class="muted">This is the record IATF 16949, ISO 13485 (medical) and EU food-contact rules expect you to produce within hours.</p>`);
    return header(t('trace'),'Material lots → batches → output, for fast and targeted recalls',actions)+tiles+tabs('trace',[['batches',`Batches (${batches.length})`],['lots',`Material lots (${lots.length})`]],tab)+`<div class="panel">${tab==='lots'?lotTable:batchTable}</div>`+explain;
  }
  const t=k=>ctx.t('nav.'+k);
  function lotForm(){
    const companies=recordCompanies();
    openDialog('Register material lot',section('Delivery',`${companies.length>1?select('companyId','Customer',companies.map(c=>[c.id,c.name]),{required:true}):''}${field('lotNumber','Lot number',{required:true,help:'As printed on the bag, octabin or silo delivery note'})}${field('material','Material',{required:true,help:'Grade, e.g. PP homopolymer MFI 12'})}${field('supplier','Supplier',{required:true})}${field('receivedAt','Received on',{type:'date',required:true,value:new Date().toISOString().slice(0,10)})}${field('quantityKg','Quantity',{type:'number',required:true,unit:'kg',min:0.001,step:'any'})}${field('certificate','Certificate (CoA / 3.1)',{help:'Certificate of analysis number'})}`),
      {onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api('/trace/lots','POST',{...v,companyId:v.companyId||companies[0]?.id,quantityKg:Number(v.quantityKg)}); toast('Lot registered'); state.trace=undefined; state.traceTab='lots'; render(); }});
  }
  function batchForm(){
    const companies=recordCompanies(), products=(state.data.products||[]).filter(p=>p.active!==0&&canRecord(p.company_id));
    if (!products.length) return toast('Add a product first (Smart factory → Products).','error');
    const body=section('What and where',`${select('productId','Product',products.map(p=>[p.id,`${p.part_number} – ${p.name}`]),{required:true})}${select('equipmentId','Machine',[],{required:true})}<div id="mould-fld">${select('mouldId','Mould',[],{help:'Required for injection moulding'})}</div>${field('batchNumber','Batch number',{required:true,help:'Your order or batch reference'})}${field('operatorName','Operator',{required:true,value:state.user.name})}${field('plannedQty','Planned quantity',{type:'number',required:true,min:1,step:'any'})}`)
      +`<div id="lots-fld"></div><div id="params-fld"></div>`;
    openDialog('Start batch',body,{onOpen:d=>{
      const pSel=d.querySelector('[name=productId]'), mSel=d.querySelector('[name=equipmentId]'), mouldSel=d.querySelector('[name=mouldId]');
      const syncMachine=()=>{ const type=(state.data.equipment||[]).find(e=>e.id===mSel.value)?.machine_type, defs=cat().processParams?.[type]||[];
        d.querySelector('#params-fld').innerHTML=type?section('Process settings',defs.map(([k,l,u])=>field('pp.'+k,l,{type:'number',required:true,unit:u,step:'any',min:0})).join(''),'The settings from the process sheet at the start of the batch.'):'';
        d.querySelector('#mould-fld').hidden=type&&type!=='injection'; mouldSel.required=type==='injection'; };
      const syncProduct=()=>{ const p=products.find(x=>x.id===pSel.value); if (!p) return;
        const machines=machinesOf(p.company_id), moulds=(state.data.equipment||[]).filter(e=>e.machine_type==='mould'&&e.company_id===p.company_id), lots=(state.trace?.lots||[]).filter(l=>l.company_id===p.company_id&&l.status==='released');
        mSel.innerHTML=`<option value="">Select…</option>${machines.map(e=>`<option value="${esc(e.id)}" ${e.id===p.default_machine_id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}`;
        mouldSel.innerHTML=`<option value="">—</option>${moulds.map(e=>`<option value="${esc(e.id)}" ${e.id===p.mould_id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}`;
        d.querySelector('#lots-fld').innerHTML=section('Material lots',lots.length?checkboxes('lotIds','Lots loaded into the hopper or dosing unit',lots.map(l=>[l.id,`${l.lot_number} · ${l.material}`]),{required:true}):'<p class="muted wide">No released lots for this customer. Register the material lot first.</p>');
        syncMachine(); };
      pSel.onchange=syncProduct; mSel.onchange=syncMachine; syncProduct(); },
      onSubmit:async fd=>{ const v=Object.fromEntries(fd), processParams=Object.fromEntries([...fd.entries()].filter(([k])=>k.startsWith('pp.')).map(([k,x])=>[k.slice(3),Number(x)]));
        const lotIds=fd.getAll('lotIds'); if (!lotIds.length) throw Error('Choose at least one material lot.');
        await api('/trace/batches','POST',{productId:v.productId,equipmentId:v.equipmentId,mouldId:v.mouldId||null,batchNumber:v.batchNumber,operatorName:v.operatorName,plannedQty:Number(v.plannedQty),lots:lotIds.map(lotId=>({lotId})),processParams});
        toast('Batch started'); state.trace=undefined; state.traceTab='batches'; render(); }});
    void companies;
  }
  async function genealogyDialog(id){
    const g=await api('/trace/batches/'+id), unit=g.product?.unit||'';
    const params=Object.entries(g.process_params||{}), defs=Object.fromEntries(Object.values(cat().processParams||{}).flat().map(([k,l,u])=>[k,[l,u]]));
    const body=`<section class="kpis small">${statTile('Good output',`${formatNumber(g.good,0)} ${unit}`,{note:`planned ${formatNumber(g.planned_qty,0)}`})}${statTile('Scrap',`${formatNumber(g.scrap,0)} ${unit}`)}${statTile('OEE while running',pctText(g.oee))}${statTile('Camera FPY',g.vision.inspected?pctText((g.vision.inspected-g.vision.rejected)/g.vision.inspected*100):'—',{note:g.vision.inspected?`${formatNumber(g.vision.rejected)} of ${formatNumber(g.vision.inspected)} rejected`:'no camera data'})}</section>
      <p>${statusPill(g.status)} ${esc(g.product?.part_number)} ${esc(g.product?.name)} · ${esc(g.machine?.asset_tag||'')} ${g.mould?`· mould ${esc(g.mould.asset_tag||g.mould.model)}`:''} · operator ${esc(g.operator_name)} · ${when(g.started_at)} → ${g.ended_at?when(g.ended_at):'running'}${g.hold_reason?`<br><b>Hold:</b> ${esc(g.hold_reason)}`:''}</p>
      <h3>Material lots (backward)</h3>${simpleTable(['Lot','Material','Supplier','Certificate','Used','Status'],g.lots.map(l=>`<tr><td><b>${esc(l.lot_number)}</b></td><td>${esc(l.material)}</td><td>${esc(l.supplier)}</td><td>${esc(l.certificate||'—')}</td><td>${l.used_kg==null?'—':`${formatNumber(l.used_kg,0)} kg`}</td><td>${statusPill(l.status)}</td></tr>`))}
      <h3>Process settings</h3>${simpleTable(['Setting','Value'],params.map(([k,v])=>`<tr><td>${esc(defs[k]?.[0]||k)}</td><td>${formatNumber(v,1)} ${esc(defs[k]?.[1]||'')}</td></tr>`),'Not recorded')}
      <h3>Stops while it ran</h3>${simpleTable(['Stop','Duration'],g.downtime.slice(0,8).map(l=>`<tr><td>${esc(humanise(l.state))} – ${esc(humanise(l.reason))}</td><td>${formatDuration(l.minutes)}</td></tr>`),'No unplanned stops')}
      <h3>Alerts and maintenance</h3>${simpleTable(['When','What'],[...g.alerts.map(a=>`<tr><td>${when(a.created_at)}</td><td>${sevPill(a.severity)} ${esc(a.title)}</td></tr>`),...g.tickets.map(tk=>`<tr><td>${when(tk.created_at)}</td><td>🔧 <a data-action="ticket" data-id="${esc(tk.id)}">${esc(tk.title)}</a> <span class="muted">${esc(humanise(tk.status))}</span></td></tr>`)],'Nothing recorded on this machine during the batch')}`;
    const d=openDialog(`Batch ${g.batch_number}`,body); d.querySelectorAll('[data-action=ticket]').forEach(a=>a.onclick=()=>{ closeDialog(); ctx.action('ticket',a.dataset.id); });
  }
  async function lotUsageDialog(id){
    const l=await api('/trace/lots/'+id);
    openDialog(`Where used: lot ${l.lot_number}`,`<p>${statusPill(l.status)} ${esc(l.material)} from ${esc(l.supplier)} · received ${when(l.received_at)} · ${formatNumber(l.quantity_kg,0)} kg</p>${simpleTable(['Batch','Product','Machine','Started','Output','Status'],l.batches.map(b=>`<tr><td><b>${esc(b.batch_number)}</b></td><td>${esc(b.product?.part_number)}</td><td>${esc(b.machine?.asset_tag||'')}</td><td>${when(b.started_at)}</td><td>${formatNumber(b.good,0)} ${esc(b.product?.unit||'')}</td><td>${statusPill(b.status)}</td></tr>`),'Not used in any batch yet')}`);
  }
  function quarantineForm(id){
    const l=state.trace.lots.find(x=>x.id===id);
    openDialog(`Quarantine lot ${l.lot_number}`,`<p>Every batch that used this lot (${formatNumber(l.batches)}) is put <b>on hold</b> and the lot can no longer be used. A quality alert is raised.</p><div class="form-grid">${field('reason','Reason',{type:'textarea',required:true,wide:true,help:'e.g. supplier notice, black specks found, wrong MFI on the certificate'})}</div>`,
      {submitLabel:'Quarantine lot',onSubmit:async fd=>{ const r=await api(`/trace/lots/${id}/quarantine`,'POST',{reason:fd.get('reason')}); toast(`Lot quarantined – ${r.affected.length} batch${r.affected.length===1?'':'es'} on hold`); state.trace=undefined; await ctx.refresh(); }});
  }
  function completeForm(id){
    const b=state.trace.batches.find(x=>x.id===id), unit=b.product?.unit||'';
    openDialog(`Complete batch ${b.batch_number}`,`<p class="muted">Leave the quantities empty to use the machine's own counts (so far ${formatNumber(b.good,0)} good and ${formatNumber(b.scrap,0)} scrap ${esc(unit)}).</p><div class="form-grid">${field('goodQty','Good quantity',{type:'number',unit,min:0,step:'any'})}${field('scrapQty','Scrap',{type:'number',unit,min:0,step:'any'})}</div>`,
      {submitLabel:'Complete batch',onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(`/trace/batches/${id}/complete`,'POST',{goodQty:v.goodQty===''?null:Number(v.goodQty),scrapQty:v.scrapQty===''?null:Number(v.scrapQty)}); toast('Batch completed – awaiting quality release'); state.trace=undefined; render(); }});
  }
  function holdForm(id){
    const b=state.trace.batches.find(x=>x.id===id);
    openDialog(`Hold or scrap batch ${b.batch_number}`,`<div class="form-grid">${select('status','Decision',[['on_hold','Put on hold – keep for investigation'],['scrapped','Scrap – do not ship']],{required:true,value:'on_hold',wide:true})}${field('reason','Reason',{type:'textarea',required:true,wide:true})}</div>`,
      {onSubmit:async fd=>{ await api(`/trace/batches/${id}/status`,'POST',{status:fd.get('status'),reason:fd.get('reason')}); toast('Batch status saved'); state.trace=undefined; render(); }});
  }

  // ---------- Vision quality ----------
  async function loadQuality(){ const f=state.qualityFilter||(state.qualityFilter={range:'7d',plantId:'',equipmentId:''}); const q=new URLSearchParams({from:new Date(RANGES[f.range][1]()).toISOString(),to:new Date().toISOString(),...(f.plantId?{plantId:f.plantId}:{}),...(f.equipmentId?{equipmentId:f.equipmentId}:{})}); state.quality=await api('/factory/quality?'+q).catch(e=>{toast(e.message,'error');return null}); }
  function filterBar(key,f){ return `<div class="table-tools"><select data-filter="${key}:range" class="tt-filter" aria-label="Period">${Object.entries(RANGES).map(([k,[l]])=>`<option value="${k}" ${f.range===k?'selected':''}>${l}</option>`).join('')}</select><select data-filter="${key}:plantId" class="tt-filter" aria-label="Plant"><option value="">All plants</option>${(state.data.plants||[]).map(p=>`<option value="${esc(p.id)}" ${f.plantId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>${'equipmentId' in f?`<select data-filter="${key}:equipmentId" class="tt-filter" aria-label="Machine"><option value="">All machines</option>${machinesOf(null,f.plantId).map(e=>`<option value="${esc(e.id)}" ${f.equipmentId===e.id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}</select>`:''}</div>`; }
  function qualityView(){
    if (state.quality===undefined) { loadQuality().then(render); return `<div class="panel empty">Collecting camera inspection results…</div>`; }
    const f=state.qualityFilter, qd=state.quality||{total:{},pareto:[],machines:[],daily:[]}, tot=qd.total;
    const band=v=>v==null?{}:v>=99?{status:'good',note:'excellent (99 %+)'}:v>=97?{status:'warning',note:'typical (97–99 %)'}:{status:'critical',note:'below 97 %: check the process'};
    const tiles=`<section class="kpis" aria-label="Quality">${statTile('First-pass yield',pctText(tot.fpy),band(tot.fpy))}${statTile('Defects per million',tot.ppm==null?'—':formatNumber(tot.ppm,0),{note:'PPM'})}${statTile('Inspected',formatNumber(tot.inspected??0,0),{note:'parts or measurements'})}${statTile('Rejected',formatNumber(tot.rejected??0,0))}${statTile('Top defect',qd.pareto[0]?humanise(qd.pareto[0].defect):'—',{note:qd.pareto[0]?`${formatNumber(qd.pareto[0].count)} rejects`:''})}</section>`;
    const charts=`<div class="chart-row">${columnChart('chart-fpy-daily',{title:'First-pass yield by day',subtitle:'Share of inspected parts passing first time',valueLabel:'FPY',points:qd.daily.map(d=>({value:d.fpy??0,label:dayLabel(d.date),tip:dayLabel(d.date)})),formatValue:v=>`${formatNumber(v,2)} %`})}${barChart('chart-pareto',{title:'Defect Pareto',subtitle:'Most frequent defect first – attack the top bar',valueLabel:'Rejects',rows:qd.pareto.slice(0,8).map(p=>({label:humanise(p.defect),value:p.count})),formatValue:v=>formatNumber(v,0),empty:'No rejects in this period.'})}</div>`;
    const table=`<div class="panel"><h2>By machine</h2>${simpleTable(['Machine','Inspected','Rejected','First-pass yield','Top defect'],qd.machines.map(m=>`<tr><td><a data-action="equipment" data-id="${esc(m.equipmentId)}">${esc(m.assetTag||'')}</a> <span class="muted">${esc(m.name)}</span></td><td>${formatNumber(m.inspected,0)}</td><td>${formatNumber(m.rejected,0)}</td><td><b>${pctText(m.fpy)}</b></td><td>${m.topDefect?esc(humanise(m.topDefect)):'—'}</td></tr>`),'No production machines in this selection.')}</div>`;
    const explain=explainer('How vision inspection is measured',`<p>A camera (or, on an extrusion line, an inline gauge) checks every part at the machine outlet and classifies rejects by defect: short shot, flash, sink mark, black spot, wall thickness, ovality…</p><ul><li><b>First-pass yield (FPY)</b> = parts passing first time ÷ parts inspected. 99 %+ is excellent for moulding.</li><li><b>PPM</b> = rejects per million inspected – the unit customers use in quality agreements.</li><li><b>Pareto</b> – usually two or three defects cause most rejects. Fix the top one first: short shots point to filling (temperature, pressure, venting), flash to clamp force or a worn parting line, sink marks to hold pressure or cooling.</li></ul><p>A reject rate above <b>3 %</b> over at least 50 parts raises a warning alert, above <b>8 %</b> a critical one (emailed). It clears by itself when the rate falls below 1.5 %.</p>`);
    return header(t('quality'),'Camera inspection results: first-pass yield, rejects and defect Pareto')+filterBar('quality',f)+tiles+charts+table+explain;
  }

  // ---------- Safety ----------
  async function loadSafety(){ const f=state.safetyFilter||(state.safetyFilter={range:'30d',plantId:''}); const days={today:1,'7d':7,'30d':30,'90d':90}[f.range]||30; const q=new URLSearchParams({from:new Date(f.range==='today'?RANGES.today[1]():Date.now()-days*86400000).toISOString(),to:new Date().toISOString(),...(f.plantId?{plantId:f.plantId}:{})}); state.safety=await api('/safety?'+q).catch(e=>{toast(e.message,'error');return null}); }
  function safetyView(){
    if (state.safety===undefined) { loadSafety().then(render); return `<div class="panel empty">Loading safety events…</div>`; }
    const f=state.safetyFilter, s=state.safety||{events:[],byType:[],bySeverity:{}}, ranges={...Object.fromEntries(Object.entries(RANGES).map(([k,[l]])=>[k,l])),'90d':'Last 90 days'};
    const filters=`<div class="table-tools"><select data-filter="safety:range" class="tt-filter" aria-label="Period">${Object.entries(ranges).map(([k,l])=>`<option value="${k}" ${f.range===k?'selected':''}>${l}</option>`).join('')}</select><select data-filter="safety:plantId" class="tt-filter" aria-label="Plant"><option value="">All plants</option>${(state.data.plants||[]).map(p=>`<option value="${esc(p.id)}" ${f.plantId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>`;
    const dslti=s.daysSinceLostTime;
    const tiles=`<section class="kpis" aria-label="Safety">${statTile('Days without lost-time injury',dslti==null?'—':formatNumber(dslti),dslti==null?{status:'good',note:'no lost-time injury recorded'}:dslti>=100?{status:'good'}:dslti<30?{status:'critical',note:'recent lost-time injury'}:{status:'warning'})}${statTile('Open events',formatNumber(s.open??0),{status:s.open?'warning':'',note:s.open?'to investigate and close':'all closed'})}${statTile('Near misses & unsafe conditions',formatNumber(s.nearMisses??0),{note:'reported in period – more is better'})}${statTile('Critical events',formatNumber(s.bySeverity?.critical??0),{status:s.bySeverity?.critical?'critical':''})}${statTile('All events',formatNumber(s.total??0))}</section>`;
    const chart=`<div class="chart-row">${barChart('chart-safety-types',{title:'Events by type',subtitle:'In the selected period',valueLabel:'Events',rows:s.byType.map(x=>({label:humanise(x.type),value:x.count})),formatValue:v=>formatNumber(v,0),empty:'No safety events in this period.'})}</div>`;
    const table=dataTable('safety',{rows:s.events,search:e=>`${e.event_type} ${e.description} ${e.zone_name||''} ${e.asset_tag||''} ${e.reporter||''}`,
      filters:[{key:'status',label:'Status',options:['open','investigating','closed'].map(x=>[x,humanise(x)]),match:(r,v)=>r.status===v},{key:'sev',label:'Severity',options:[['critical','Critical'],['warning','Warning'],['info','Info']],match:(r,v)=>r.severity===v},{key:'source',label:'Source',options:[['person','Reported by a person'],['camera','Camera'],['wearable','Wearable'],['sensor','Sensor']],match:(r,v)=>r.source===v}],
      empty:'No safety events in this period.',
      columns:[{title:'When',cell:e=>when(e.occurred_at)},{title:'Event',cell:e=>`${sevPill(e.severity)} <b>${esc(humanise(e.event_type))}</b>${e.lost_time?' <span class="pill critical">Lost time</span>':''}<div class="muted">${esc(e.description)}</div>`},{title:'Where',cell:e=>`${esc(e.zone_name||'')}${e.asset_tag?` ${esc(e.asset_tag)}`:''}`||'—'},{title:'Source',cell:e=>e.source==='person'?`Reported by ${esc(e.reporter||'—')}`:esc(humanise(e.source))},
        {title:'Status',cell:e=>`${statusPill(e.status)}${e.corrective_action?`<div class="muted"><b>Cause:</b> ${esc(e.root_cause)}<br><b>Action:</b> ${esc(e.corrective_action)}</div>`:''}`},{title:'',cls:'row',cell:e=>factoryManager(e.company_id)&&e.status!=='closed'?`${e.status==='open'?btn('Start investigation','investigateSafety','secondary small',e.id):''}${btn('Close event','closeSafety','small',e.id)}`:''}]});
    const explain=explainer('Why report near misses',`<p>For every serious injury there are many minor ones and hundreds of near misses and unsafe conditions (the “safety pyramid”). Each near miss is a free lesson: fixing its cause prevents the injury that would follow.</p><ul><li><b>Lagging indicators</b> count harm after it happened: lost-time injuries (LTI), first-aid cases, <b>days without LTI</b>.</li><li><b>Leading indicators</b> show prevention: near misses and unsafe conditions reported and closed. A plant reporting many near misses usually has <i>fewer</i> injuries.</li><li><b>Detected events</b> come from cameras (missing PPE, a person in the robot area), wearables (man-down, fall) and sensors (guard opened while cycling). Warning and critical events raise alerts; critical ones are emailed.</li></ul><p>Every event is investigated and closed with a <b>root cause</b> and a <b>corrective action</b> – the record ISO 45001 asks for.</p>`);
    return header(t('safety'),'Detected and reported safety events, investigations and leading indicators',btn('Report safety event','reportSafety','primary'))+filters+tiles+chart+`<div class="panel">${table}</div>`+explain;
  }
  function safetyForm(){
    const plants=(state.data.plants||[]).filter(p=>admin()||is('dispatcher')||p.company_id===state.user.companyId);
    const types=Object.entries(cat().safetyEvents||{});
    openDialog('Report a safety event',`<p class="muted">Report anything that could hurt someone – even if nothing happened. Reporting is never about blame.</p><div class="form-grid">${select('plantId','Plant',plants.map(p=>[p.id,p.name]),{required:true,value:plants.length===1?plants[0].id:''})}${select('eventType','What happened',types.map(([k,sev])=>[k,`${humanise(k)}${sev==='critical'?' (critical)':''}`]),{required:true})}${select('zoneId','Area',[])}${select('equipmentId','Machine',[])}${field('occurredAt','When',{type:'datetime-local',help:'Leave empty for now'})}<label class="check-opt wide" id="lti-fld" hidden><input type="checkbox" name="lostTime"> The injured person could not work their next shift (lost-time injury)</label>${field('description','Description',{type:'textarea',required:true,wide:true,help:'What happened, who was involved (no names needed), what could have happened'})}</div>`,
      {submitLabel:'Report',onOpen:d=>{ const pSel=d.querySelector('[name=plantId]'), type=d.querySelector('[name=eventType]');
        const sync=()=>{ const zones=(state.zones||[]).filter(z=>z.plant_id===pSel.value), eq=(state.data.equipment||[]).filter(e=>e.plant_id===pSel.value);
          d.querySelector('[name=zoneId]').innerHTML=`<option value="">—</option>${zones.map(z=>`<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}`;
          d.querySelector('[name=equipmentId]').innerHTML=`<option value="">—</option>${eq.map(e=>`<option value="${esc(e.id)}">${esc(assetName(e.id))}</option>`).join('')}`; };
        pSel.onchange=sync; type.onchange=()=>{ d.querySelector('#lti-fld').hidden=type.value!=='injury'; }; sync();
        if (!state.zones) api('/zones').then(z=>{ state.zones=z; sync(); }).catch(()=>{}); },
      onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api('/safety/events','POST',{plantId:v.plantId,eventType:v.eventType,zoneId:v.zoneId||null,equipmentId:v.equipmentId||null,occurredAt:v.occurredAt||undefined,description:v.description,lostTime:v.lostTime==='on'&&v.eventType==='injury'}); toast('Thank you – event reported'); state.safety=undefined; await ctx.refresh(); }});
  }
  function closeSafetyForm(id){
    const e=state.safety.events.find(x=>x.id===id);
    openDialog(`Close: ${humanise(e.event_type)}`,`<p class="muted">${esc(e.description)}</p><div class="form-grid">${field('rootCause','Root cause',{type:'textarea',required:true,wide:true,help:'Why did it happen? Ask “why” until you reach something you can change (equipment, procedure, training, behaviour).'})}${field('correctiveAction','Corrective action',{type:'textarea',required:true,wide:true,help:'What was changed so it does not happen again'})}</div>`,
      {submitLabel:'Close event',onSubmit:async fd=>{ await api(`/safety/events/${id}/close`,'POST',Object.fromEntries(fd)); toast('Event closed'); state.safety=undefined; await ctx.refresh(); }});
  }

  // ---------- Asset tracking ----------
  async function loadAssets(){ const [assets,zones]=await Promise.all([api('/assets'),api('/zones')]).catch(e=>{toast(e.message,'error');return [[],[]]}); state.assets=assets; state.zones=zones; }
  function assetsView(){
    if (state.assets===undefined) { loadAssets().then(render); return `<div class="panel empty">Locating tagged assets…</div>`; }
    const list=state.assets, zones=state.zones||[], tab=state.assetTab||'assets', managerAny=(state.data.companies||[]).some(c=>factoryManager(c.id));
    const low=a=>a.battery_pct!=null&&a.battery_pct<15;
    const tiles=`<section class="kpis small" aria-label="Assets">${statTile('Tracked assets',formatNumber(list.length))}${statTile('Missing',formatNumber(list.filter(a=>a.missing).length),{status:list.some(a=>a.missing)?'critical':'good',note:list.some(a=>a.missing)?'tag not heard for too long':'all reporting'})}${statTile('Away from home',formatNumber(list.filter(a=>a.awayFromHome&&!a.missing).length),{note:'in use elsewhere'})}${statTile('Low tag battery',formatNumber(list.filter(low).length),{status:list.some(low)?'warning':''})}</section>`;
    const where=a=>a.missing?`<span class="pill critical">⚠ Missing</span><div class="muted">last in ${esc(a.zone?.name||'—')} ${since(a.last_seen_at)} ago</div>`:a.zone?`<b>${esc(a.zone.name)}</b>${['restricted','outside'].includes(a.zone.kind)?' <span class="pill warning">● '+esc(humanise(a.zone.kind))+'</span>':''}<div class="muted">${since(a.last_seen_at)} ago</div>`:'<span class="muted">Not seen yet</span>';
    const assetTable=dataTable('assets',{rows:list,search:a=>`${a.name} ${a.tag_id} ${a.kind} ${a.zone?.name||''}`,
      filters:[{key:'kind',label:'Type',options:[...new Set(list.map(a=>a.kind))].map(k=>[k,humanise(k)]),match:(r,v)=>r.kind===v},{key:'zone',label:'Zone',options:zones.map(z=>[z.id,z.name]),match:(r,v)=>r.last_zone_id===v},{key:'state',label:'State',options:[['missing','Missing'],['away','Away from home'],['battery','Low battery']],match:(r,v)=>v==='missing'?r.missing:v==='away'?r.awayFromHome:low(r)}],
      empty:'No tagged assets yet. Fix a BLE beacon or RFID tag to a mould, tool or trolley and register it here.',
      columns:[{title:'Asset',cell:a=>`<b>${esc(a.name)}</b><div class="muted">${esc(humanise(a.kind))}${a.equipment_id?` · ${esc(assetName(a.equipment_id))}`:''}</div>`},{title:'Where now',cell:where},{title:'Home',cell:a=>esc(a.home?.name||'—')},{title:'Tag',cell:a=>`${esc(a.tag_id)} <span class="muted">${esc(a.tag_type.toUpperCase())}</span>${a.battery_pct!=null?`<div class="${low(a)?'pill warning':'muted'}">🔋 ${a.battery_pct} %</div>`:''}`},{title:'',cls:'row',cell:a=>`${btn('Location history','assetHistory','secondary small',a.id)}${factoryManager(a.company_id)?btn(ctx.t('action.edit'),'editAsset','secondary small',a.id):''}`}]});
    const zoneTable=simpleTable(['Zone','Type','Reader / gateway','Assets here',''],zones.map(z=>`<tr><td><b>${esc(z.name)}</b>${multiCompany()?`<div class="muted">${esc(companyName(z.company_id))}</div>`:''}</td><td>${esc(humanise(z.kind))}</td><td><code>${esc(z.reader_id)}</code></td><td>${formatNumber(list.filter(a=>a.last_zone_id===z.id&&!a.missing).length)}</td><td>${factoryManager(z.company_id)?btn(ctx.t('action.edit'),'editZone','secondary small',z.id):''}</td></tr>`),'No zones yet. Add one for each area covered by a BLE gateway or RFID reader.');
    const actions=managerAny?`${btn('Add location zone','newZone','secondary')}${btn('Add tracked asset','newAsset','primary')}`:'';
    const explain=explainer('How asset tracking works',`<p>A small <b>tag</b> is fixed to each mould, tool, gauge or trolley. Each area of the plant – moulding hall, tool room, warehouse, dock – is a <b>zone</b> covered by a reader. When a reader hears a tag, the asset's location is updated.</p><ul><li><b>BLE beacons</b> (Bluetooth Low Energy) send a signal every few seconds; gateways hear them 10–50 m away. Battery-powered (2–5 years), good for continuous room-level location.</li><li><b>RFID tags</b> are passive and cheap; they are read when they pass a reader, e.g. at a dock door or gate. Best for “it went through here”.</li><li><b>UWB</b> gives location to 10–30 cm where that matters (e.g. forklifts), at higher cost.</li></ul><p>Alerts: a mould, tool, gauge or fixture detected in a <b>restricted or outside zone</b>; a tag <b>not heard</b> for longer than its “missing after” time; a <b>low tag battery</b>. The history shows where an asset has been, so a missing gauge is found where it was last seen.</p>`);
    return header(t('assets'),'Where your moulds, tools, gauges and trolleys are – from BLE beacons and RFID tags',actions)+tiles+tabs('asset',[['assets',`Assets (${list.length})`],['zones',`Zones (${zones.length})`]],tab)+`<div class="panel">${tab==='zones'?zoneTable:assetTable}</div>`+explain;
  }
  function zoneForm(z){
    const plants=(state.data.plants||[]).filter(p=>factoryManager(p.company_id));
    openDialog(z?`${ctx.t('action.edit')}: ${z.name}`:'Add zone',`<div class="form-grid">${z?'':select('plantId','Plant',plants.map(p=>[p.id,p.name]),{required:true,value:plants.length===1?plants[0].id:''})}${field('name','Name',{required:true,value:z?.name,help:'e.g. Tool room, Dock door 2'})}${select('kind','Type',(cat().zoneKinds||[]).map(k=>[k,humanise(k)]),{required:true,value:z?.kind,help:'Moulds and tools in a restricted or outside zone raise an alert'})}${z?'':field('readerId','Reader or gateway ID',{required:true,help:'The ID the BLE gateway or RFID reader sends with each read'})}</div>`,
      {onSubmit:async fd=>{ await api(z?'/zones/'+z.id:'/zones',z?'PATCH':'POST',Object.fromEntries(fd)); toast(z?'Zone saved':'Zone added'); state.assets=undefined; state.assetTab='zones'; render(); }});
  }
  function assetForm(a){
    const plants=(state.data.plants||[]).filter(p=>factoryManager(p.company_id)), zones=state.zones||[];
    const body=`<div class="form-grid">${select('plantId','Plant',plants.map(p=>[p.id,p.name]),{required:true,value:a?.plant_id||(plants.length===1?plants[0].id:'')})}${field('name','Name',{required:true,value:a?.name,help:'e.g. Mould M-2409, Torque wrench 40–200 Nm'})}${select('kind','Type',(cat().assetKinds||[]).map(k=>[k,humanise(k)]),{required:true,value:a?.kind})}${a?'':field('tagId','Tag ID',{required:true,help:'Printed on the beacon or RFID tag'})}${select('tagType','Tag technology',(cat().tagTypes||[]).map(k=>[k,k.toUpperCase()]),{required:true,value:a?.tag_type||'ble'})}${select('homeZoneId','Home zone',[],{help:'Where it belongs when not in use'})}${select('equipmentId','Linked equipment',[],{help:'For a mould: its equipment record'})}${field('missingAfterHours','Missing after',{type:'number',required:true,unit:'h',min:1,max:720,value:a?.missing_after_hours??24,help:'Alert when the tag has not been heard this long'})}</div>`;
    openDialog(a?`${ctx.t('action.edit')}: ${a.name}`:'Add tracked asset',body,{onOpen:d=>{ const pSel=d.querySelector('[name=plantId]'); const sync=()=>{ const plant=(state.data.plants||[]).find(p=>p.id===pSel.value);
        d.querySelector('[name=homeZoneId]').innerHTML=`<option value="">—</option>${zones.filter(z=>z.plant_id===pSel.value).map(z=>`<option value="${esc(z.id)}" ${a?.home_zone_id===z.id?'selected':''}>${esc(z.name)}</option>`).join('')}`;
        d.querySelector('[name=equipmentId]').innerHTML=`<option value="">—</option>${(state.data.equipment||[]).filter(e=>e.company_id===plant?.company_id).map(e=>`<option value="${esc(e.id)}" ${a?.equipment_id===e.id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}`; };
        pSel.onchange=sync; sync(); },
      onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(a?'/assets/'+a.id:'/assets',a?'PATCH':'POST',{...v,homeZoneId:v.homeZoneId||null,equipmentId:v.equipmentId||null,missingAfterHours:Number(v.missingAfterHours)}); toast(a?'Asset saved':'Asset added'); state.assets=undefined; render(); }});
  }
  async function historyDialog(id){
    const h=await api(`/assets/${id}/history?hours=48`), a=h.asset;
    openDialog(`Where ${a.name} has been`,`<p class="muted">Last 48 hours · tag ${esc(a.tag_id)}${a.missing?' · <b>missing now</b>':''}</p>${simpleTable(['Zone','From','To','Stay'],h.stays.map(s=>`<tr><td><b>${esc(s.zone)}</b> <span class="muted">${esc(humanise(s.kind))}</span></td><td>${when(s.from)}</td><td>${when(s.to)}</td><td>${formatDuration(Math.max(1,Math.round((Date.parse(s.to)-Date.parse(s.from))/60000)))}</td></tr>`),'No sightings in the last 48 hours.')}`);
  }

  const views={trace:traceView,quality:qualityView,safety:safetyView,assets:assetsView};
  async function action(name,id){
    if(name==='newLot')return lotForm();
    if(name==='newBatch'){ if (!state.trace) await loadTrace(); return batchForm(); }
    if(name==='genealogy')return genealogyDialog(id).catch(fail);
    if(name==='lotUsage')return lotUsageDialog(id).catch(fail);
    if(name==='quarantineLot')return quarantineForm(id);
    if(name==='releaseLot'){ const l=state.trace.lots.find(x=>x.id===id); if (!await confirmAction(`Release lot ${l.lot_number}?`,'It can be used for new batches again. Batches on hold stay on hold until you release each one.',{confirmLabel:'Release lot',danger:false})) return; return api(`/trace/lots/${id}/release`,'POST',{}).then(()=>{toast('Lot released');state.trace=undefined;render()}).catch(fail); }
    if(name==='completeBatch')return completeForm(id);
    if(name==='releaseBatch'){ const b=state.trace.batches.find(x=>x.id===id); if (!await confirmAction(`Release batch ${b.batch_number}?`,'Releasing confirms it meets the quality requirements and may be shipped.',{confirmLabel:'Release batch',danger:false})) return; return api(`/trace/batches/${id}/status`,'POST',{status:'released'}).then(()=>{toast('Batch released');state.trace=undefined;render()}).catch(fail); }
    if(name==='holdBatch')return holdForm(id);
    if(name==='reportSafety')return safetyForm();
    if(name==='investigateSafety')return api(`/safety/events/${id}/investigate`,'POST',{}).then(()=>{toast('Marked as under investigation');state.safety=undefined;render()}).catch(fail);
    if(name==='closeSafety')return closeSafetyForm(id);
    if(name==='newZone')return zoneForm();
    if(name==='editZone')return zoneForm(state.zones.find(z=>z.id===id));
    if(name==='newAsset')return assetForm();
    if(name==='editAsset')return assetForm(state.assets.find(a=>a.id===id));
    if(name==='assetHistory')return historyDialog(id).catch(fail);
    return false;
  }
  // Filters and tabs on these pages.
  function bind(){
    document.querySelectorAll('[data-filter]').forEach(el=>el.onchange=()=>{ const [page,key]=el.dataset.filter.split(':'), f=state[page+'Filter']; f[key]=el.value; if (key==='plantId'&&'equipmentId' in f) f.equipmentId=''; state[page]=undefined; render(); });
    document.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>{ const [page,tab]=el.dataset.tab.split(':'); state[page+'Tab']=tab; render(); });
    bindCharts();
  }
  const reset=()=>{ state.trace=undefined; state.quality=undefined; state.safety=undefined; state.assets=undefined; };
  return {views,action,bind,reset,ACTIONS:['newLot','newBatch','genealogy','lotUsage','quarantineLot','releaseLot','completeBatch','releaseBatch','holdBatch','reportSafety','investigateSafety','closeSafety','newZone','editZone','newAsset','editAsset','assetHistory']};
}
