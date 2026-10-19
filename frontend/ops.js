// Smart factory pages, stages 3–4: traceability, vision quality, safety, and asset tracking. The app passes in its
// shared state and helpers, so these pages behave exactly like the others (same tables, dialogs, charts and toasts).
import { esc, btn, humanise, dataTable, simpleTable, field, select, checkboxes, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber, formatDuration, t, t as _t } from './shared/i18n.js';
import { scanInput, bindScanInput } from './shared/scan.js';
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
  const explainer=(title,html)=>`<details class="panel explainer"><summary><b>${esc(title)}</b> <span class="muted">${_t('ops.aQuickGuide')}</span></summary>${html}</details>`;
  const tabs=(key,list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="${key}:${k}">${esc(l)}</button>`).join('')}</div>`;

  // ---------- Traceability ----------
  async function loadTrace(){ const [batches,lots]=await Promise.all([api('/trace/batches'),api('/trace/lots')]).catch(e=>{toast(e.message,'error');return [[],[]]}); state.trace={batches,lots}; }
  function traceView(){
    if (!state.trace) { loadTrace().then(render); return `<div class="panel empty">${_t('ops.loadingBatchesAndMaterialLots')}</div>`; }
    const tab=state.traceTab||'batches', {batches,lots}=state.trace, can=recordCompanies().length>0;
    const count=s=>batches.filter(b=>b.status===s).length;
    const tiles=`<section class="kpis small" aria-label="${_t('ops.batches')}">${statTile(_t('ops.running'),formatNumber(count('running')),{note:_t('ops.batchesInProduction')})}${statTile(_t('ops.awaitingRelease'),formatNumber(count('completed')),{status:count('completed')?'warning':'',note:count('completed')?_t('ops.qualityDecisionNeeded'):''})}${statTile(_t('ops.onHold2'),formatNumber(count('on_hold')),{status:count('on_hold')?'critical':'',note:count('on_hold')?_t('ops.blockedFromShipping'):''})}${statTile(_t('ops.quarantinedLots'),formatNumber(lots.filter(l=>l.status==='quarantined').length),{status:lots.some(l=>l.status==='quarantined')?'critical':''})}</section>`;
    const batchTable=dataTable('batches',{rows:batches,search:b=>`${b.batch_number} ${b.product?.part_number} ${b.product?.name} ${b.machine?.asset_tag} ${b.operator_name} ${b.lots.map(l=>l.lotNumber).join(' ')}`,
      filters:[{key:'status',label:_t('ops.status'),options:['running','completed','on_hold','released','scrapped'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:_t('ops.noBatchesYetStartOne'),
      columns:[{title:_t('ops.batch'),cell:b=>`<a data-action="genealogy" data-id="${esc(b.id)}"><b>${esc(b.batch_number)}</b></a>${multiCompany()?`<div class="muted">${esc(companyName(b.company_id))}</div>`:''}`},{title:_t('ops.product'),cell:b=>`${esc(b.product?.part_number)}<div class="muted">${esc(b.product?.name)}</div>`},{title:_t('ops.machine'),cell:b=>esc(b.machine?.asset_tag||'')},{title:_t('ops.started'),cell:b=>`${when(b.started_at)}${b.ended_at?`<div class="muted">${_t('ops.ended',{ended_at:when(b.ended_at)})}</div>`:''}`},
        {title:_t('ops.goodScrap'),cell:b=>`${formatNumber(b.good,0)} · ${formatNumber(b.scrap,0)} <span class="muted">${esc(b.product?.unit||'')}</span>`},{title:_t('ops.materialLots'),cell:b=>b.lots.map(l=>`<span class="${l.status==='quarantined'?'pill critical':''}">${esc(l.lotNumber)}</span>`).join(', ')},{title:_t('ops.status'),cell:b=>`${statusPill(b.status)}${b.hold_reason?`<div class="muted">${esc(b.hold_reason)}</div>`:''}`},
        {title:'',cls:'row',cell:b=>`${btn(_t('ops.batchGenealogy'),'genealogy','secondary small',b.id)}${btn(_t('ops.qualityLabels'),'batchQuality','secondary small',b.id)}${b.status==='running'&&canRecord(b.company_id)?btn(_t('ops.completeBatch'),'completeBatch','small',b.id):''}${['completed','on_hold'].includes(b.status)&&factoryManager(b.company_id)?btn(_t('ops.releaseBatch'),'releaseBatch','small',b.id):''}${['completed','released','running'].includes(b.status)&&factoryManager(b.company_id)?btn(_t('ops.putBatchOnHold'),'holdBatch','secondary small',b.id):''}`}]});
    const lotTable=dataTable('lots',{rows:lots,search:l=>`${l.lot_number} ${l.material} ${l.supplier} ${l.certificate}`,
      filters:[{key:'status',label:_t('ops.status'),options:['released','quarantined','consumed'].map(s=>[s,humanise(s)]),match:(r,v)=>r.status===v}],empty:_t('ops.noMaterialLotsYetRegister'),
      columns:[{title:_t('ops.lot'),cell:l=>`<b>${esc(l.lot_number)}</b>${multiCompany()?`<div class="muted">${esc(companyName(l.company_id))}</div>`:''}`},{title:_t('ops.material'),cell:l=>`${esc(l.material)}<div class="muted">${esc(l.supplier)}</div>`},{title:_t('ops.received'),cell:l=>when(l.received_at)},{title:_t('ops.quantity'),cell:l=>`${formatNumber(l.quantity_kg,0)} kg`},{title:_t('ops.certificate'),cell:l=>esc(l.certificate||'—')},{title:_t('ops.usedIn'),cell:l=>`${_t('ops.batch4',{batches:formatNumber(l.batches),value:l.batches===1?'':'es'})}`},{title:_t('ops.status'),cell:l=>statusPill(l.status)},
        {title:'',cls:'row',cell:l=>`${btn(_t('ops.whereUsedBatches'),'lotUsage','secondary small',l.id)}${btn(_t('ops.recallScope'),'recallLot','secondary small',l.id)}${l.status==='released'&&factoryManager(l.company_id)?btn(_t('ops.quarantineLot'),'quarantineLot','danger small',l.id):''}${l.status==='quarantined'&&factoryManager(l.company_id)?btn(_t('ops.releaseLot'),'releaseLot','small',l.id):''}`}]});
    const actions=can?`${btn(_t('ops.registerMaterialLot'),'newLot','secondary')}${btn(_t('ops.startBatch'),'newBatch','primary')}`:'';
    const explain=explainer(_t('ops.howTraceabilityWorks'),`<p>${_t('ops.every')} <b>${_t('ops.batch2')}</b> ${_t('ops.recordsWhatWentIntoIt')} <b>${_t('ops.materialLots2')}</b> ${_t('ops.resinMasterbatchGlassFibreThe')}</p><ul><li><b>${_t('ops.backward')}</b> ${_t('ops.whatWentIntoThisBatch')} <b>${_t('ops.genealogy')}</b>${_t('ops.lotsSettingsAndWhatHappened')}</li><li><b>${_t('ops.forward')}</b> ${_t('ops.whereDidThisLotGo')} <b>${_t('ops.whereUsed')}</b> ${_t('ops.onALot')}</li><li><b>${_t('ops.targetedRecall')}</b> ${_t('ops.whenASupplierReportsA')} <b>${_t('ops.quarantine')}</b> ${_t('ops.itExactlyTheBatchesThat')}</li></ul><p class="muted">${_t('ops.thisIsTheRecordIatf')}</p>`);
    return header(t('trace'),_t('ops.materialLotsBatchesOutputFor'),actions)+tiles+tabs('trace',[['batches',`${_t('ops.batches2',{length:batches.length})}`],['lots',`${_t('ops.materialLots3',{length:lots.length})}`]],tab)+`<div class="panel">${tab==='lots'?lotTable:batchTable}</div>`+explain;
  }
  const t=k=>ctx.t('nav.'+k);
  function lotForm(){
    const companies=recordCompanies();
    openDialog(_t('ops.registerMaterialLot'),section(_t('ops.delivery'),`${companies.length>1?select('companyId',_t('ops.customer'),companies.map(c=>[c.id,c.name]),{required:true}):''}${field('lotNumber',_t('ops.lotNumber'),{required:true,help:_t('ops.asPrintedOnTheBag')})}${field('material',_t('ops.material'),{required:true,help:_t('ops.gradeEGPpHomopolymer')})}${field('supplier',_t('ops.supplier'),{required:true})}${field('receivedAt',_t('ops.receivedOn'),{type:'date',required:true,value:new Date().toISOString().slice(0,10)})}${field('quantityKg',_t('ops.quantity'),{type:'number',required:true,unit:'kg',min:0.001,step:'any'})}${field('certificate',_t('ops.certificateCoa31'),{help:_t('ops.certificateOfAnalysisNumber')})}`),
      {onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api('/trace/lots','POST',{...v,companyId:v.companyId||companies[0]?.id,quantityKg:Number(v.quantityKg)}); toast(_t('ops.lotRegistered')); state.trace=undefined; state.traceTab='lots'; render(); }});
  }
  function batchForm(){
    const companies=recordCompanies(), products=(state.data.products||[]).filter(p=>p.active!==0&&canRecord(p.company_id));
    if (!products.length) return toast(_t('ops.addAProductFirstSmart'),'error');
    const body=section(_t('ops.whatAndWhere'),`${select('productId',_t('ops.product'),products.map(p=>[p.id,`${p.part_number} – ${p.name}`]),{required:true})}${select('equipmentId',_t('ops.machine'),[],{required:true})}<div id="mould-fld">${select('mouldId',_t('ops.mould'),[],{help:_t('ops.requiredForInjectionMoulding')})}</div>${field('batchNumber',_t('ops.batchNumber'),{required:true,help:_t('ops.yourOrderOrBatchReference')})}${field('operatorName',_t('ops.operator'),{required:true,value:state.user.name})}${field('plannedQty',_t('ops.plannedQuantity'),{type:'number',required:true,min:1,step:'any'})}`)
      +`<div id="lots-fld"></div><div id="params-fld"></div>`;
    openDialog(_t('ops.startBatch'),body,{onOpen:d=>{
      const pSel=d.querySelector('[name=productId]'), mSel=d.querySelector('[name=equipmentId]'), mouldSel=d.querySelector('[name=mouldId]');
      const syncMachine=()=>{ const type=(state.data.equipment||[]).find(e=>e.id===mSel.value)?.machine_type, defs=cat().processParams?.[type]||[];
        d.querySelector('#params-fld').innerHTML=type?section(_t('ops.processSettings'),defs.map(([k,l,u])=>field('pp.'+k,l,{type:'number',required:true,unit:u,step:'any',min:0})).join(''),_t('ops.theSettingsFromTheProcess')):'';
        d.querySelector('#mould-fld').hidden=type&&type!=='injection'; mouldSel.required=type==='injection'; };
      const syncProduct=()=>{ const p=products.find(x=>x.id===pSel.value); if (!p) return;
        const machines=machinesOf(p.company_id), moulds=(state.data.equipment||[]).filter(e=>e.machine_type==='mould'&&e.company_id===p.company_id), lots=(state.trace?.lots||[]).filter(l=>l.company_id===p.company_id&&l.status==='released');
        mSel.innerHTML=`<option value="">${_t('ops.select')}</option>${machines.map(e=>`<option value="${esc(e.id)}" ${e.id===p.default_machine_id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}`;
        mouldSel.innerHTML=`<option value="">—</option>${moulds.map(e=>`<option value="${esc(e.id)}" ${e.id===p.mould_id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}`;
        d.querySelector('#lots-fld').innerHTML=section(_t('ops.materialLots'),lots.length?checkboxes('lotIds',_t('ops.lotsLoadedIntoTheHopper'),lots.map(l=>[l.id,`${l.lot_number} · ${l.material}`]),{required:true}):'<p class="muted wide">No released lots for this customer. Register the material lot first.</p>');
        syncMachine(); };
      pSel.onchange=syncProduct; mSel.onchange=syncMachine; syncProduct(); },
      onSubmit:async fd=>{ const v=Object.fromEntries(fd), processParams=Object.fromEntries([...fd.entries()].filter(([k])=>k.startsWith('pp.')).map(([k,x])=>[k.slice(3),Number(x)]));
        const lotIds=fd.getAll('lotIds'); if (!lotIds.length) throw Error(_t('ops.chooseAtLeastOneMaterial'));
        await api('/trace/batches','POST',{productId:v.productId,equipmentId:v.equipmentId,mouldId:v.mouldId||null,batchNumber:v.batchNumber,operatorName:v.operatorName,plannedQty:Number(v.plannedQty),lots:lotIds.map(lotId=>({lotId})),processParams});
        toast(_t('ops.batchStarted')); state.trace=undefined; state.traceTab='batches'; render(); }});
    void companies;
  }
  async function genealogyDialog(id){
    const g=await api('/trace/batches/'+id), unit=g.product?.unit||'';
    const params=Object.entries(g.process_params||{}), defs=Object.fromEntries(Object.values(cat().processParams||{}).flat().map(([k,l,u])=>[k,[l,u]]));
    const body=`<section class="kpis small">${statTile(_t('ops.goodOutput'),`${formatNumber(g.good,0)} ${unit}`,{note:`${_t('ops.planned',{planned_qty:formatNumber(g.planned_qty,0)})}`})}${statTile(_t('ops.scrap'),`${formatNumber(g.scrap,0)} ${unit}`)}${statTile(_t('ops.oeeWhileRunning'),pctText(g.oee))}${statTile(_t('ops.cameraFpy'),g.vision.inspected?pctText((g.vision.inspected-g.vision.rejected)/g.vision.inspected*100):'—',{note:g.vision.inspected?`${_t('ops.ofRejected',{rejected:formatNumber(g.vision.rejected),inspected:formatNumber(g.vision.inspected)})}`:_t('ops.noCameraData')})}</section>
      <p>${_t('ops.operator2',{status:statusPill(g.status),part_number:esc(g.product?.part_number),name:esc(g.product?.name),value:esc(g.machine?.asset_tag||''),value2:g.mould?`${_t('ops.mould2',{value:esc(g.mould.asset_tag||g.mould.model)})}`:'',operator_name:esc(g.operator_name),started_at:when(g.started_at),value3:g.ended_at?when(g.ended_at):'running',value4:g.hold_reason?`<br><b>${_t('ops.hold')}</b> ${esc(g.hold_reason)}`:''})}</p>
      <h3>${_t('ops.materialLotsBackward')}</h3>${simpleTable([_t('ops.lot'),_t('ops.material'),_t('ops.supplier'),_t('ops.certificate'),_t('ops.used'),_t('ops.status')],g.lots.map(l=>`<tr><td><b>${esc(l.lot_number)}</b></td><td>${esc(l.material)}</td><td>${esc(l.supplier)}</td><td>${esc(l.certificate||'—')}</td><td>${l.used_kg==null?'—':`${formatNumber(l.used_kg,0)} kg`}</td><td>${statusPill(l.status)}</td></tr>`))}
      <h3>${_t('ops.processSettings')}</h3>${simpleTable([_t('ops.setting'),_t('ops.value')],params.map(([k,v])=>`<tr><td>${esc(defs[k]?.[0]||k)}</td><td>${formatNumber(v,1)} ${esc(defs[k]?.[1]||'')}</td></tr>`),_t('ops.notRecorded'))}
      <h3>${_t('ops.stopsWhileItRan')}</h3>${simpleTable([_t('ops.stop'),_t('ops.duration')],g.downtime.slice(0,8).map(l=>`<tr><td>${esc(humanise(l.state))} – ${esc(humanise(l.reason))}</td><td>${formatDuration(l.minutes)}</td></tr>`),_t('ops.noUnplannedStops'))}
      <h3>${_t('ops.alertsAndMaintenance')}</h3>${simpleTable([_t('ops.when'),_t('ops.what')],[...g.alerts.map(a=>`<tr><td>${when(a.created_at)}</td><td>${sevPill(a.severity)} ${esc(a.title)}</td></tr>`),...g.tickets.map(tk=>`<tr><td>${when(tk.created_at)}</td><td>🔧 <a data-action="ticket" data-id="${esc(tk.id)}">${esc(tk.title)}</a> <span class="muted">${esc(humanise(tk.status))}</span></td></tr>`)],_t('ops.nothingRecordedOnThisMachine'))}`;
    const d=openDialog(`${_t('ops.batch3',{batch_number:g.batch_number})}`,body); d.querySelectorAll('[data-action=ticket]').forEach(a=>a.onclick=()=>{ closeDialog(); ctx.action('ticket',a.dataset.id); });
  }
  async function lotUsageDialog(id){
    const l=await api('/trace/lots/'+id);
    openDialog(`${_t('ops.whereUsedLot',{lot_number:l.lot_number})}`,`<p>${_t('ops.fromReceivedKg',{status:statusPill(l.status),material:esc(l.material),supplier:esc(l.supplier),received_at:when(l.received_at),quantity_kg:formatNumber(l.quantity_kg,0)})}</p>${simpleTable([_t('ops.batch'),_t('ops.product'),_t('ops.machine'),_t('ops.started'),_t('ops.output'),_t('ops.status')],l.batches.map(b=>`<tr><td><b>${esc(b.batch_number)}</b></td><td>${esc(b.product?.part_number)}</td><td>${esc(b.machine?.asset_tag||'')}</td><td>${when(b.started_at)}</td><td>${formatNumber(b.good,0)} ${esc(b.product?.unit||'')}</td><td>${statusPill(b.status)}</td></tr>`),_t('ops.notUsedInAnyBatch'))}`);
  }
  function quarantineForm(id){
    const l=state.trace.lots.find(x=>x.id===id);
    openDialog(`${_t('ops.quarantineLot2',{lot_number:l.lot_number})}`,`<p>${_t('ops.everyBatchThatUsedThis',{batches:formatNumber(l.batches)})} <b>${_t('ops.onHold')}</b> ${_t('ops.andTheLotCanNo')}</p><div class="form-grid">${field('reason',_t('ops.reason'),{type:'textarea',required:true,wide:true,help:_t('ops.eGSupplierNoticeBlack')})}</div>`,
      {submitLabel:_t('ops.quarantineLot'),onSubmit:async fd=>{ const r=await api(`/trace/lots/${id}/quarantine`,'POST',{reason:fd.get('reason')}); toast(`${_t('ops.lotQuarantinedBatchOnHold',{length:r.affected.length,value:r.affected.length===1?'':'es'})}`); state.trace=undefined; await ctx.refresh(); }});
  }
  function completeForm(id){
    const b=state.trace.batches.find(x=>x.id===id), unit=b.product?.unit||'';
    openDialog(`${_t('ops.completeBatch2',{batch_number:b.batch_number})}`,`<p class="muted">${_t('ops.leaveTheQuantitiesEmptyTo',{good:formatNumber(b.good,0),scrap:formatNumber(b.scrap,0),unit:esc(unit)})}</p><div class="form-grid">${field('goodQty',_t('ops.goodQuantity'),{type:'number',unit,min:0,step:'any'})}${field('scrapQty',_t('ops.scrap'),{type:'number',unit,min:0,step:'any'})}</div>`,
      {submitLabel:_t('ops.completeBatch'),onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(`/trace/batches/${id}/complete`,'POST',{goodQty:v.goodQty===''?null:Number(v.goodQty),scrapQty:v.scrapQty===''?null:Number(v.scrapQty)}); toast(_t('ops.batchCompletedAwaitingQualityRelease')); state.trace=undefined; render(); }});
  }
  function holdForm(id){
    const b=state.trace.batches.find(x=>x.id===id);
    openDialog(`${_t('ops.holdOrScrapBatch',{batch_number:b.batch_number})}`,`<div class="form-grid">${select('status',_t('ops.decision'),[['on_hold',_t('ops.putOnHoldKeepFor')],['scrapped',_t('ops.scrapDoNotShip')]],{required:true,value:'on_hold',wide:true})}${field('reason',_t('ops.reason'),{type:'textarea',required:true,wide:true})}</div>`,
      {onSubmit:async fd=>{ await api(`/trace/batches/${id}/status`,'POST',{status:fd.get('status'),reason:fd.get('reason')}); toast(_t('ops.batchStatusSaved')); state.trace=undefined; render(); }});
  }

  // ---------- Vision quality ----------
  async function loadQuality(){ const f=state.qualityFilter||(state.qualityFilter={range:'7d',plantId:'',equipmentId:''}); const q=new URLSearchParams({from:new Date(RANGES[f.range][1]()).toISOString(),to:new Date().toISOString(),...(f.plantId?{plantId:f.plantId}:{}),...(f.equipmentId?{equipmentId:f.equipmentId}:{})}); state.quality=await api('/factory/quality?'+q).catch(e=>{toast(e.message,'error');return null}); }
  function filterBar(key,f){ return `<div class="table-tools"><select data-filter="${key}:range" class="tt-filter" aria-label="${_t('ops.period')}">${Object.entries(RANGES).map(([k,[l]])=>`<option value="${k}" ${f.range===k?'selected':''}>${l}</option>`).join('')}</select><select data-filter="${key}:plantId" class="tt-filter" aria-label="${_t('ops.plant')}"><option value="">${_t('ops.allPlants')}</option>${(state.data.plants||[]).map(p=>`<option value="${esc(p.id)}" ${f.plantId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>${'equipmentId' in f?`<select data-filter="${key}:equipmentId" class="tt-filter" aria-label="${_t('ops.machine')}"><option value="">${_t('ops.allMachines')}</option>${machinesOf(null,f.plantId).map(e=>`<option value="${esc(e.id)}" ${f.equipmentId===e.id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}</select>`:''}</div>`; }
  function qualityView(){
    if (state.quality===undefined) { loadQuality().then(render); return `<div class="panel empty">${_t('ops.collectingCameraInspectionResults')}</div>`; }
    const f=state.qualityFilter, qd=state.quality||{total:{},pareto:[],machines:[],daily:[]}, tot=qd.total;
    const band=v=>v==null?{}:v>=99?{status:'good',note:_t('ops.excellent99')}:v>=97?{status:'warning',note:_t('ops.typical9799')}:{status:'critical',note:_t('ops.below97CheckTheProcess')};
    const tiles=`<section class="kpis" aria-label="${_t('ops.quality')}">${statTile(_t('ops.firstPassYield'),pctText(tot.fpy),band(tot.fpy))}${statTile(_t('ops.defectsPerMillion'),tot.ppm==null?'—':formatNumber(tot.ppm,0),{note:_t('ops.ppm')})}${statTile(_t('ops.inspected'),formatNumber(tot.inspected??0,0),{note:_t('ops.partsOrMeasurements')})}${statTile(_t('ops.rejected'),formatNumber(tot.rejected??0,0))}${statTile(_t('ops.topDefect'),qd.pareto[0]?humanise(qd.pareto[0].defect):'—',{note:qd.pareto[0]?`${_t('ops.rejects',{count:formatNumber(qd.pareto[0].count)})}`:''})}</section>`;
    const charts=`<div class="chart-row">${columnChart('chart-fpy-daily',{title:_t('ops.firstPassYieldByDay'),subtitle:_t('ops.shareOfInspectedPartsPassing'),valueLabel:'FPY',points:qd.daily.map(d=>({value:d.fpy??0,label:dayLabel(d.date),tip:dayLabel(d.date)})),formatValue:v=>`${formatNumber(v,2)} %`})}${barChart('chart-pareto',{title:_t('ops.defectPareto'),subtitle:_t('ops.mostFrequentDefectFirstAttack'),valueLabel:_t('ops.rejects2'),rows:qd.pareto.slice(0,8).map(p=>({label:humanise(p.defect),value:p.count})),formatValue:v=>formatNumber(v,0),empty:_t('ops.noRejectsInThisPeriod')})}</div>`;
    const table=`<div class="panel"><h2>${_t('ops.byMachine')}</h2>${simpleTable([_t('ops.machine'),_t('ops.inspected'),_t('ops.rejected'),_t('ops.firstPassYield'),_t('ops.topDefect')],qd.machines.map(m=>`<tr><td><a data-action="equipment" data-id="${esc(m.equipmentId)}">${esc(m.assetTag||'')}</a> <span class="muted">${esc(m.name)}</span></td><td>${formatNumber(m.inspected,0)}</td><td>${formatNumber(m.rejected,0)}</td><td><b>${pctText(m.fpy)}</b></td><td>${m.topDefect?esc(humanise(m.topDefect)):'—'}</td></tr>`),_t('ops.noProductionMachinesInThis'))}</div>`;
    const explain=explainer(_t('ops.howVisionInspectionIsMeasured'),`<p>${_t('ops.aCameraOrOnAn')}</p><ul><li><b>${_t('ops.firstPassYieldFpy')}</b> ${_t('ops.partsPassingFirstTimeParts')}</li><li><b>${_t('ops.ppm')}</b> ${_t('ops.rejectsPerMillionInspectedThe')}</li><li><b>${_t('ops.pareto')}</b> ${_t('ops.usuallyTwoOrThreeDefects')}</li></ul><p>${_t('ops.aRejectRateAbove')} <b>3 %</b> ${_t('ops.overAtLeast50Parts')} <b>8 %</b> ${_t('ops.aCriticalOneEmailedIt')}</p>`);
    return header(t('quality'),_t('ops.cameraInspectionResultsFirstPass'))+filterBar('quality',f)+tiles+charts+table+explain;
  }

  // ---------- Safety ----------
  async function loadSafety(){ const f=state.safetyFilter||(state.safetyFilter={range:'30d',plantId:''}); const days={today:1,'7d':7,'30d':30,'90d':90}[f.range]||30; const q=new URLSearchParams({from:new Date(f.range==='today'?RANGES.today[1]():Date.now()-days*86400000).toISOString(),to:new Date().toISOString(),...(f.plantId?{plantId:f.plantId}:{})}); state.safety=await api('/safety?'+q).catch(e=>{toast(e.message,'error');return null}); }
  function safetyView(){
    if (state.safety===undefined) { loadSafety().then(render); return `<div class="panel empty">${_t('ops.loadingSafetyEvents')}</div>`; }
    const f=state.safetyFilter, s=state.safety||{events:[],byType:[],bySeverity:{}}, ranges={...Object.fromEntries(Object.entries(RANGES).map(([k,[l]])=>[k,l])),'90d':_t('ops.last90Days')};
    const filters=`<div class="table-tools"><select data-filter="safety:range" class="tt-filter" aria-label="${_t('ops.period')}">${Object.entries(ranges).map(([k,l])=>`<option value="${k}" ${f.range===k?'selected':''}>${l}</option>`).join('')}</select><select data-filter="safety:plantId" class="tt-filter" aria-label="${_t('ops.plant')}"><option value="">${_t('ops.allPlants')}</option>${(state.data.plants||[]).map(p=>`<option value="${esc(p.id)}" ${f.plantId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>`;
    const dslti=s.daysSinceLostTime;
    const tiles=`<section class="kpis" aria-label="${_t('ops.safety')}">${statTile(_t('ops.daysWithoutLostTimeInjury'),dslti==null?'—':formatNumber(dslti),dslti==null?{status:'good',note:_t('ops.noLostTimeInjuryRecorded')}:dslti>=100?{status:'good'}:dslti<30?{status:'critical',note:_t('ops.recentLostTimeInjury')}:{status:'warning'})}${statTile(_t('ops.openEvents'),formatNumber(s.open??0),{status:s.open?'warning':'',note:s.open?_t('ops.toInvestigateAndClose'):_t('ops.allClosed')})}${statTile(_t('ops.nearMissesUnsafeConditions'),formatNumber(s.nearMisses??0),{note:_t('ops.reportedInPeriodMoreIs')})}${statTile(_t('ops.criticalEvents'),formatNumber(s.bySeverity?.critical??0),{status:s.bySeverity?.critical?'critical':''})}${statTile(_t('ops.allEvents'),formatNumber(s.total??0))}</section>`;
    const chart=`<div class="chart-row">${barChart('chart-safety-types',{title:_t('ops.eventsByType'),subtitle:_t('ops.inTheSelectedPeriod'),valueLabel:_t('ops.events'),rows:s.byType.map(x=>({label:humanise(x.type),value:x.count})),formatValue:v=>formatNumber(v,0),empty:_t('ops.noSafetyEventsInThis')})}</div>`;
    const table=dataTable('safety',{rows:s.events,search:e=>`${e.event_type} ${e.description} ${e.zone_name||''} ${e.asset_tag||''} ${e.reporter||''}`,
      filters:[{key:'status',label:_t('ops.status'),options:['open','investigating','closed'].map(x=>[x,humanise(x)]),match:(r,v)=>r.status===v},{key:'sev',label:_t('ops.severity'),options:[['critical',_t('ops.critical')],['warning',_t('ops.warning')],['info',_t('ops.info')]],match:(r,v)=>r.severity===v},{key:'source',label:_t('ops.source'),options:[['person',_t('ops.reportedByAPerson')],['camera',_t('ops.camera')],['wearable',_t('ops.wearable')],['sensor',_t('ops.sensor')]],match:(r,v)=>r.source===v}],
      empty:_t('ops.noSafetyEventsInThis'),
      columns:[{title:_t('ops.when'),cell:e=>when(e.occurred_at)},{title:_t('ops.event'),cell:e=>`${sevPill(e.severity)} <b>${esc(humanise(e.event_type))}</b>${e.lost_time?_t('ops.lostTime'):''}<div class="muted">${esc(e.description)}</div>`},{title:_t('ops.where'),cell:e=>`${esc(e.zone_name||'')}${e.asset_tag?` ${esc(e.asset_tag)}`:''}`||'—'},{title:_t('ops.source'),cell:e=>e.source==='person'?`${_t('ops.reportedBy',{value:esc(e.reporter||'—')})}`:esc(humanise(e.source))},
        {title:_t('ops.status'),cell:e=>`${statusPill(e.status)}${e.corrective_action?`<div class="muted"><b>${_t('ops.cause')}</b> ${esc(e.root_cause)}<br><b>${_t('ops.action')}</b> ${esc(e.corrective_action)}</div>`:''}`},{title:'',cls:'row',cell:e=>factoryManager(e.company_id)&&e.status!=='closed'?`${e.status==='open'?btn(_t('ops.startInvestigation'),'investigateSafety','secondary small',e.id):''}${btn(_t('ops.closeEvent'),'closeSafety','small',e.id)}`:''}]});
    const explain=explainer(_t('ops.whyReportNearMisses'),`<p>${_t('ops.forEverySeriousInjuryThere')}</p><ul><li><b>${_t('ops.laggingIndicators')}</b> ${_t('ops.countHarmAfterItHappened')} <b>${_t('ops.daysWithoutLti')}</b>.</li><li><b>${_t('ops.leadingIndicators')}</b> ${_t('ops.showPreventionNearMissesAnd')} <i>${_t('ops.fewer')}</i> ${_t('ops.injuries')}</li><li><b>${_t('ops.detectedEvents')}</b> ${_t('ops.comeFromCamerasMissingPpe')}</li></ul><p>${_t('ops.everyEventIsInvestigatedAnd')} <b>${_t('ops.rootCause2')}</b> ${_t('ops.andA')} <b>${_t('ops.correctiveAction2')}</b> ${_t('ops.theRecordIso45001Asks')}</p>`);
    return header(t('safety'),_t('ops.detectedAndReportedSafetyEvents'),btn(_t('ops.reportSafetyEvent'),'reportSafety','primary'))+filters+tiles+chart+`<div class="panel">${table}</div>`+explain;
  }
  function safetyForm(){
    const plants=(state.data.plants||[]).filter(p=>admin()||is('dispatcher')||p.company_id===state.user.companyId);
    const types=Object.entries(cat().safetyEvents||{});
    openDialog(_t('ops.reportASafetyEvent'),`<p class="muted">${_t('ops.reportAnythingThatCouldHurt')}</p><div class="form-grid">${select('plantId',_t('ops.plant'),plants.map(p=>[p.id,p.name]),{required:true,value:plants.length===1?plants[0].id:''})}${select('eventType',_t('ops.whatHappened'),types.map(([k,sev])=>[k,`${humanise(k)}${sev==='critical'?' (critical)':''}`]),{required:true})}${select('zoneId',_t('ops.area'),[])}${select('equipmentId',_t('ops.machine'),[])}${field('occurredAt',_t('ops.when'),{type:'datetime-local',help:_t('ops.leaveEmptyForNow')})}<label class="check-opt wide" id="lti-fld" hidden><input type="checkbox" name="lostTime"> ${_t('ops.theInjuredPersonCouldNot')}</label>${field('description',_t('ops.description'),{type:'textarea',required:true,wide:true,help:_t('ops.whatHappenedWhoWasInvolved')})}</div>`,
      {submitLabel:_t('ops.report'),onOpen:d=>{ const pSel=d.querySelector('[name=plantId]'), type=d.querySelector('[name=eventType]');
        const sync=()=>{ const zones=(state.zones||[]).filter(z=>z.plant_id===pSel.value), eq=(state.data.equipment||[]).filter(e=>e.plant_id===pSel.value);
          d.querySelector('[name=zoneId]').innerHTML=`<option value="">—</option>${zones.map(z=>`<option value="${esc(z.id)}">${esc(z.name)}</option>`).join('')}`;
          d.querySelector('[name=equipmentId]').innerHTML=`<option value="">—</option>${eq.map(e=>`<option value="${esc(e.id)}">${esc(assetName(e.id))}</option>`).join('')}`; };
        pSel.onchange=sync; type.onchange=()=>{ d.querySelector('#lti-fld').hidden=type.value!=='injury'; }; sync();
        if (!state.zones) api('/zones').then(z=>{ state.zones=z; sync(); }).catch(()=>{}); },
      onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api('/safety/events','POST',{plantId:v.plantId,eventType:v.eventType,zoneId:v.zoneId||null,equipmentId:v.equipmentId||null,occurredAt:v.occurredAt||undefined,description:v.description,lostTime:v.lostTime==='on'&&v.eventType==='injury'}); toast(_t('ops.thankYouEventReported')); state.safety=undefined; await ctx.refresh(); }});
  }
  function closeSafetyForm(id){
    const e=state.safety.events.find(x=>x.id===id);
    openDialog(`${_t('ops.close',{event_type:humanise(e.event_type)})}`,`<p class="muted">${esc(e.description)}</p><div class="form-grid">${field('rootCause',_t('ops.rootCause'),{type:'textarea',required:true,wide:true,help:_t('ops.whyDidItHappenAsk')})}${field('correctiveAction',_t('ops.correctiveAction'),{type:'textarea',required:true,wide:true,help:_t('ops.whatWasChangedSoIt')})}</div>`,
      {submitLabel:_t('ops.closeEvent'),onSubmit:async fd=>{ await api(`/safety/events/${id}/close`,'POST',Object.fromEntries(fd)); toast(_t('ops.eventClosed')); state.safety=undefined; await ctx.refresh(); }});
  }

  // ---------- Asset tracking ----------
  async function loadAssets(){ const [assets,zones]=await Promise.all([api('/assets'),api('/zones')]).catch(e=>{toast(e.message,'error');return [[],[]]}); state.assets=assets; state.zones=zones; }
  function assetsView(){
    if (state.assets===undefined) { loadAssets().then(render); return `<div class="panel empty">${_t('ops.locatingTaggedAssets')}</div>`; }
    const list=state.assets, zones=state.zones||[], tab=state.assetTab||'assets', managerAny=(state.data.companies||[]).some(c=>factoryManager(c.id));
    const low=a=>a.battery_pct!=null&&a.battery_pct<15;
    const tiles=`<section class="kpis small" aria-label="${_t('ops.assets')}">${statTile(_t('ops.trackedAssets'),formatNumber(list.length))}${statTile(_t('ops.missing2'),formatNumber(list.filter(a=>a.missing).length),{status:list.some(a=>a.missing)?'critical':'good',note:list.some(a=>a.missing)?_t('ops.tagNotHeardForToo'):_t('ops.allReporting')})}${statTile(_t('ops.awayFromHome'),formatNumber(list.filter(a=>a.awayFromHome&&!a.missing).length),{note:_t('ops.inUseElsewhere')})}${statTile(_t('ops.lowTagBattery2'),formatNumber(list.filter(low).length),{status:list.some(low)?'warning':''})}</section>`;
    const where=a=>a.missing?`<span class="pill critical">${_t('ops.missing')}</span><div class="muted">${_t('ops.lastInAgo',{value:esc(a.zone?.name||'—'),last_seen_at:since(a.last_seen_at)})}</div>`:a.zone?`<b>${esc(a.zone.name)}</b>${['restricted','outside'].includes(a.zone.kind)?' <span class="pill warning">● '+esc(humanise(a.zone.kind))+'</span>':''}<div class="muted">${_t('ops.ago',{last_seen_at:since(a.last_seen_at)})}</div>`:'<span class="muted">Not seen yet</span>';
    const assetTable=dataTable('assets',{rows:list,search:a=>`${a.name} ${a.tag_id} ${a.kind} ${a.zone?.name||''}`,
      filters:[{key:'kind',label:_t('ops.type'),options:[...new Set(list.map(a=>a.kind))].map(k=>[k,humanise(k)]),match:(r,v)=>r.kind===v},{key:'zone',label:_t('ops.zone'),options:zones.map(z=>[z.id,z.name]),match:(r,v)=>r.last_zone_id===v},{key:'state',label:_t('ops.state'),options:[['missing',_t('ops.missing2')],['away',_t('ops.awayFromHome')],['battery',_t('ops.lowBattery')]],match:(r,v)=>v==='missing'?r.missing:v==='away'?r.awayFromHome:low(r)}],
      empty:_t('ops.noTaggedAssetsYetFix'),
      columns:[{title:_t('ops.asset'),cell:a=>`<b>${esc(a.name)}</b><div class="muted">${esc(humanise(a.kind))}${a.equipment_id?` · ${esc(assetName(a.equipment_id))}`:''}</div>`},{title:_t('ops.whereNow'),cell:where},{title:_t('ops.home'),cell:a=>esc(a.home?.name||'—')},{title:_t('ops.tag'),cell:a=>`${esc(a.tag_id)} <span class="muted">${esc(a.tag_type.toUpperCase())}</span>${a.battery_pct!=null?`<div class="${low(a)?'pill warning':'muted'}">🔋 ${a.battery_pct} %</div>`:''}`},{title:'',cls:'row',cell:a=>`${btn(_t('ops.locationHistory'),'assetHistory','secondary small',a.id)}${factoryManager(a.company_id)?btn(ctx.t('action.edit'),'editAsset','secondary small',a.id):''}`}]});
    const zoneTable=simpleTable([_t('ops.zone'),_t('ops.type'),_t('ops.readerGateway'),_t('ops.assetsHere'),''],zones.map(z=>`<tr><td><b>${esc(z.name)}</b>${multiCompany()?`<div class="muted">${esc(companyName(z.company_id))}</div>`:''}</td><td>${esc(humanise(z.kind))}</td><td><code>${esc(z.reader_id)}</code></td><td>${formatNumber(list.filter(a=>a.last_zone_id===z.id&&!a.missing).length)}</td><td>${factoryManager(z.company_id)?btn(ctx.t('action.edit'),'editZone','secondary small',z.id):''}</td></tr>`),_t('ops.noZonesYetAddOne'));
    const actions=managerAny?`${btn(_t('ops.addLocationZone'),'newZone','secondary')}${btn(_t('ops.addTrackedAsset'),'newAsset','primary')}`:'';
    const explain=explainer(_t('ops.howAssetTrackingWorks'),`<p>${_t('ops.aSmall')} <b>${_t('ops.tag2')}</b> ${_t('ops.isFixedToEachMould')} <b>${_t('ops.zone2')}</b> ${_t('ops.coveredByAReaderWhen')}</p><ul><li><b>${_t('ops.bleBeacons')}</b> ${_t('ops.bluetoothLowEnergySendA')}</li><li><b>${_t('ops.rfidTags')}</b> ${_t('ops.arePassiveAndCheapThey')}</li><li><b>${_t('ops.uwb')}</b> ${_t('ops.givesLocationTo1030')}</li></ul><p>${_t('ops.alertsAMouldToolGauge')} <b>${_t('ops.restrictedOrOutsideZone')}</b>${_t('ops.aTag')} <b>${_t('ops.notHeard')}</b> ${_t('ops.forLongerThanItsMissing')} <b>${_t('ops.lowTagBattery')}</b>${_t('ops.theHistoryShowsWhereAn')}</p>`);
    return header(t('assets'),_t('ops.whereYourMouldsToolsGauges'),actions)+tiles+tabs('asset',[['assets',`${_t('ops.assets2',{length:list.length})}`],['zones',`${_t('ops.zones',{length:zones.length})}`]],tab)+`<div class="panel">${tab==='zones'?zoneTable:assetTable}</div>`+explain;
  }
  // A required ID field that takes a camera QR scan, an NFC read (uid) or a handheld reader/scanner typing into it.
  const scanField=(name,text,value,help,opts={})=>`<div class="fld"><label for="f-${name}">${esc(text)} <span class="req" aria-hidden="true">*</span></label>${scanInput(name,{value:value||'',required:true,placeholder:_t('ops.scanOrTypeTheId'),...opts})}<small class="help scan-msg" hidden></small>${help?`<small class="help">${esc(help)}</small>`:''}</div>`;
  function zoneForm(z){
    const plants=(state.data.plants||[]).filter(p=>factoryManager(p.company_id));
    openDialog(z?`${ctx.t('action.edit')}: ${z.name}`:_t('ops.addZone'),`<div class="form-grid">${z?'':select('plantId',_t('ops.plant'),plants.map(p=>[p.id,p.name]),{required:true,value:plants.length===1?plants[0].id:''})}${field('name',_t('ops.name'),{required:true,value:z?.name,help:_t('ops.eGToolRoomDock')})}${select('kind',_t('ops.type'),(cat().zoneKinds||[]).map(k=>[k,humanise(k)]),{required:true,value:z?.kind,help:_t('ops.mouldsAndToolsInA')})}${scanField('readerId',_t('ops.readerOrGatewayId'),z?.reader_id,z?_t('ops.forAReplacedReaderScan'):_t('ops.theIdTheBleGateway'))}</div>`,
      {onOpen:d=>bindScanInput(d,'readerId',()=>{}),onSubmit:async fd=>{ await api(z?'/zones/'+z.id:'/zones',z?'PATCH':'POST',Object.fromEntries(fd)); toast(z?_t('ops.zoneSaved'):_t('ops.zoneAdded')); state.assets=undefined; state.assetTab='zones'; render(); }});
  }
  function assetForm(a){
    const plants=(state.data.plants||[]).filter(p=>factoryManager(p.company_id)), zones=state.zones||[];
    const body=`<div class="form-grid">${select('plantId',_t('ops.plant'),plants.map(p=>[p.id,p.name]),{required:true,value:a?.plant_id||(plants.length===1?plants[0].id:'')})}${field('name',_t('ops.name'),{required:true,value:a?.name,help:_t('ops.eGMouldM2409')})}${select('kind',_t('ops.type'),(cat().assetKinds||[]).map(k=>[k,humanise(k)]),{required:true,value:a?.kind})}${scanField('tagId',_t('ops.tagId'),a?.tag_id,a?_t('ops.forAReplacedTagScan'):_t('ops.scanQrReadsTheCode'),{uid:true,nfcHint:true})}${select('tagType',_t('ops.tagTechnology'),(cat().tagTypes||[]).map(k=>[k,k.toUpperCase()]),{required:true,value:a?.tag_type||'ble'})}${select('homeZoneId',_t('ops.homeZone'),[],{help:_t('ops.whereItBelongsWhenNot')})}${select('equipmentId',_t('ops.linkedEquipment'),[],{help:_t('ops.forAMouldItsEquipment')})}${field('missingAfterHours',_t('ops.missingAfter'),{type:'number',required:true,unit:'h',min:1,max:720,value:a?.missing_after_hours??24,help:_t('ops.alertWhenTheTagHas')})}</div>`;
    openDialog(a?`${ctx.t('action.edit')}: ${a.name}`:_t('ops.addTrackedAsset'),body,{onOpen:d=>{ bindScanInput(d,'tagId',()=>{}); const pSel=d.querySelector('[name=plantId]'); const sync=()=>{ const plant=(state.data.plants||[]).find(p=>p.id===pSel.value);
        d.querySelector('[name=homeZoneId]').innerHTML=`<option value="">—</option>${zones.filter(z=>z.plant_id===pSel.value).map(z=>`<option value="${esc(z.id)}" ${a?.home_zone_id===z.id?'selected':''}>${esc(z.name)}</option>`).join('')}`;
        d.querySelector('[name=equipmentId]').innerHTML=`<option value="">—</option>${(state.data.equipment||[]).filter(e=>e.company_id===plant?.company_id).map(e=>`<option value="${esc(e.id)}" ${a?.equipment_id===e.id?'selected':''}>${esc(assetName(e.id))}</option>`).join('')}`; };
        pSel.onchange=sync; sync(); },
      onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(a?'/assets/'+a.id:'/assets',a?'PATCH':'POST',{...v,homeZoneId:v.homeZoneId||null,equipmentId:v.equipmentId||null,missingAfterHours:Number(v.missingAfterHours)}); toast(a?_t('ops.assetSaved'):_t('ops.assetAdded')); state.assets=undefined; render(); }});
  }
  async function historyDialog(id){
    const h=await api(`/assets/${id}/history?hours=48`), a=h.asset;
    openDialog(`${_t('ops.whereHasBeen',{name:a.name})}`,`<p class="muted">${_t('ops.last48HoursTag',{tag_id:esc(a.tag_id),value:a.missing?_t('ops.missingNow'):''})}</p>${simpleTable([_t('ops.zone'),_t('ops.from'),_t('ops.to'),_t('ops.stay')],h.stays.map(s=>`<tr><td><b>${esc(s.zone)}</b> <span class="muted">${esc(humanise(s.kind))}</span></td><td>${when(s.from)}</td><td>${when(s.to)}</td><td>${formatDuration(Math.max(1,Math.round((Date.parse(s.to)-Date.parse(s.from))/60000)))}</td></tr>`),_t('ops.noSightingsInTheLast'))}`);
  }

  const views={trace:traceView,quality:qualityView,safety:safetyView,assets:assetsView};
  async function action(name,id){
    if(name==='newLot')return lotForm();
    if(name==='newBatch'){ if (!state.trace) await loadTrace(); return batchForm(); }
    if(name==='genealogy')return genealogyDialog(id).catch(fail);
    if(name==='lotUsage')return lotUsageDialog(id).catch(fail);
    if(name==='quarantineLot')return quarantineForm(id);
    if(name==='releaseLot'){ const l=state.trace.lots.find(x=>x.id===id); if (!await confirmAction(`${_t('ops.releaseLot2',{lot_number:l.lot_number})}`,_t('ops.itCanBeUsedFor'),{confirmLabel:_t('ops.releaseLot'),danger:false})) return; return api(`/trace/lots/${id}/release`,'POST',{}).then(()=>{toast(_t('ops.lotReleased'));state.trace=undefined;render()}).catch(fail); }
    if(name==='completeBatch')return completeForm(id);
    if(name==='releaseBatch'){ const b=state.trace.batches.find(x=>x.id===id); if (!await confirmAction(`${_t('ops.releaseBatch2',{batch_number:b.batch_number})}`,_t('ops.releasingConfirmsItMeetsThe'),{confirmLabel:_t('ops.releaseBatch'),danger:false})) return; return api(`/trace/batches/${id}/status`,'POST',{status:'released'}).then(()=>{toast(_t('ops.batchReleased'));state.trace=undefined;render()}).catch(fail); }
    if(name==='holdBatch')return holdForm(id);
    if(name==='reportSafety')return safetyForm();
    if(name==='investigateSafety')return api(`/safety/events/${id}/investigate`,'POST',{}).then(()=>{toast(_t('ops.markedAsUnderInvestigation'));state.safety=undefined;render()}).catch(fail);
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
