// Spare parts stock page: catalogue with stock per plant and bin, part detail (movements, where used, QR label), the
// reorder list grouped by supplier, upcoming preventive maintenance against stock, and purchase orders. Also the
// dialogs used from tickets and the parts requests page (issue from stock, return to stock).
import { esc, btn, humanise, dataTable, simpleTable, field, select, checkboxes, section, openDialog, closeDialog, confirmAction, toast } from './ui.js';
import { formatNumber, formatMoney, toMinorUnits, formatDate, label, t as _t } from './shared/i18n.js';
import { statTile } from './charts.js';
import { qrSvg } from './qr.js';
import { scanInput, bindScanInput } from './shared/scan.js';

export function createStock(ctx) {
  const { state, api, render, fail, when, assetName, header, is, refresh, importDialog } = ctx;
  const mine=companyId=>state.user.companyId===companyId;
  const canManage=companyId=>is('platform_admin')||(is('customer_admin','plant_manager')&&mine(companyId));
  const canIssue=companyId=>is('platform_admin','dispatcher')||(is('customer_admin','plant_manager','maintenance')&&mine(companyId));
  const canGoNegative=companyId=>is('platform_admin')||(is('customer_admin')&&mine(companyId));
  const parts=()=>state.data.spareParts||[];
  const partOf=id=>parts().find(p=>p.id===id)||(state.stockPart?.id===id?state.stockPart:null);
  const qty=(n,unit)=>`${formatNumber(n,3)}${unit?` ${esc(unit)}`:''}`;
  const plantsOf=companyId=>(state.data.plants||[]).filter(p=>p.company_id===companyId);
  const companyName=id=>(state.data.companies||[]).find(c=>c.id===id)?.name||'';
  const currencyOf=companyId=>(state.data.companies||[]).find(c=>c.id===companyId)?.currency||state.user.preferences.currency||'USD';
  const multi=()=>(state.data.companies||[]).length>1;
  const statusPill=p=>!p.active?`<span class="pill decommissioned">${_t('ws.spInactive')}</span>`:p.low?`<span class="pill critical">⚠ ${_t('ws.spBelowReorder')}</span>`:`<span class="pill approved">✓ ${_t('ws.spStockOk')}</span>`;
  const MOVE_TONE={receive:'approved',issue:'pending',return:'approved',adjust:'warning',transfer_out:'',transfer_in:''};
  const moveType=type=>`<span class="pill ${MOVE_TONE[type]??''}">${esc(_t('ws.spMove_'+type))}</span>`;
  const signed=(n,unit)=>`${n>0?'+':''}${qty(n,unit)}`;
  const tabs=(list,current)=>`<div class="tabs" role="tablist">${list.map(([k,l])=>`<button type="button" role="tab" class="tab ${current===k?'active':''}" aria-selected="${current===k}" data-tab="stock:${k}">${esc(l)}</button>`).join('')}</div>`;
  const binList=(id,p)=>`<datalist id="${id}">${[...new Set((p?.stock||[]).map(s=>s.bin).filter(Boolean))].map(b=>`<option value="${esc(b)}">`).join('')}</datalist>`;
  const downloadCsv=async()=>{ try { const r=await fetch('/api/spare-parts/reorder/csv',{headers:{authorization:`Bearer ${state.token}`}}); if (!r.ok) throw Error((await r.json()).error); const url=URL.createObjectURL(await r.blob()), a=document.createElement('a'); a.href=url; a.download=`spare-parts-reorder-${new Date().toISOString().slice(0,10)}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); } catch (e) { toast(e.message,'error'); } };
  const done=async message=>{ toast(message); await refresh(); };

  async function loadExtra(){
    const [reorder,demand,orders]=await Promise.all([api('/spare-parts/reorder'),api('/spare-parts/pm-demand'),api('/spare-orders')]).catch(e=>{ toast(e.message,'error'); return [{lines:[],suppliers:[]},[],[]]; });
    state.stockExtra={reorder,demand,orders};
  }
  async function loadPart(){ state.stockPart=await api(`/spare-parts/${state.stockPartId}`).catch(e=>{ toast(e.message,'error'); state.stockPartId=null; return null; }); }

  // ---------- Page ----------
  function stockView(){
    if (state.stockPartId) {
      if (!state.stockPart||state.stockPart.id!==state.stockPartId) { loadPart().then(render); return header(_t('nav.stock'),_t('ws.spSub'))+`<div class="panel empty">${_t('ws.spLoading')}</div>`; }
      return detailView(state.stockPart);
    }
    if (!state.stockExtra) { loadExtra().then(render); }
    const rows=parts(), x=state.stockExtra, tab=state.stockTab||'list', low=rows.filter(p=>p.low);
    const currencies=[...new Set(rows.map(p=>p.currency))], value=rows.reduce((n,p)=>n+Math.max(0,p.valueMinor),0);
    const anyManage=(state.data.companies||[]).some(c=>canManage(c.id))||is('platform_admin');
    const tiles=`<section class="kpis" aria-label="${_t('ws.keyFigures')}">${statTile(_t('ws.spParts'),formatNumber(rows.filter(p=>p.active).length),{note:_t('ws.spInCatalogue')})}${statTile(_t('ws.spLowStock'),formatNumber(low.length),{status:low.length?'warning':'good',note:low.length?_t('ws.spNeedsOrdering'):_t('ws.spAllAbove')})}${statTile(_t('ws.spOnOrder'),formatNumber(x?.orders?.length??0),{note:_t('ws.spOpenOrders')})}${statTile(_t('ws.spStockValue'),currencies.length===1?formatMoney(value,currencies[0]):'—',{note:currencies.length>1?_t('ws.spSeveralCurrencies'):_t('ws.spAtUnitCost')})}</section>`;
    const actions=`${anyManage?btn(_t('ws.spAddPart'),'spNewPart','primary')+btn(_t('ws.importFromCsv'),'spImport','secondary'):''}${btn(_t('ws.spReorderCsv'),'spReorderCsv','secondary')}`;
    const body=tab==='reorder'?reorderTab(x):tab==='pm'?pmTab(x):tab==='orders'?ordersTab(x):listTab(rows);
    return header(_t('nav.stock'),_t('ws.spSub'),actions)+tiles+tabs([['list',_t('ws.spTabStock')],['reorder',`${_t('ws.spTabReorder')}${x?.reorder?.lines?.length?` (${x.reorder.lines.length})`:''}`],['pm',_t('ws.spTabPm')],['orders',_t('ws.spTabOrders')]],tab)+body;
  }
  function listTab(rows){
    const cats=[...new Set(rows.map(p=>p.category).filter(Boolean))].sort();
    const filters=[{key:'plant',label:_t('ws.plant'),options:(state.data.plants||[]).map(p=>[p.id,multi()?`${p.name} (${companyName(p.company_id)})`:p.name]),match:(r,v)=>r.stock.some(s=>s.plantId===v)},
      {key:'cat',label:_t('ws.spCategory'),options:cats.map(c=>[c,c]),match:(r,v)=>r.category===v},
      {key:'low',label:_t('ws.spStockLevel'),options:[['low',_t('ws.spBelowReorder')],['ok',_t('ws.spStockOk')],['inactive',_t('ws.spInactive')]],match:(r,v)=>v==='low'?r.low:v==='ok'?r.active&&!r.low:!r.active},
      ...(multi()?[{key:'co',label:_t('ws.spCompany'),options:(state.data.companies||[]).map(c=>[c.id,c.name]),match:(r,v)=>r.company_id===v}]:[])];
    const plantCell=p=>p.byPlant.length>1||multi()?`<div class="muted">${p.byPlant.map(b=>`${esc(b.plantName)}: ${formatNumber(b.onHand,3)}`).join(' · ')}</div>`:p.stock.length?`<div class="muted">${p.stock.map(s=>`${esc(s.bin||'—')}: ${formatNumber(s.onHand,3)}`).join(' · ')}</div>`:'';
    return `<div class="panel"><div class="fld wide stock-scan"><label for="f-spCode">${_t('ws.spScanToOpen')}</label>${scanInput('spCode',{placeholder:_t('ws.spScanPlaceholder')})}<small class="scan-msg help" hidden></small></div>${dataTable('stock',{rows,
      search:p=>`${p.part_number} ${p.name} ${p.maker} ${p.category} ${p.supplier} ${p.barcode||''} ${p.qr_code} ${p.stock.map(s=>s.bin).join(' ')}`,filters,empty:_t('ws.spNoParts'),
      columns:[{title:_t('ws.part'),cell:p=>`<a data-action="spPart" data-id="${esc(p.id)}"><b>${esc(p.part_number)}</b></a><div class="muted">${esc(p.name)}${p.maker?` · ${esc(p.maker)}`:''}${multi()?` · ${esc(p.companyName)}`:''}</div>`},
        {title:_t('ws.spCategory'),cell:p=>esc(p.category||'—')},
        {title:_t('ws.spOnHand'),cell:p=>`<b>${qty(p.onHand,p.unit)}</b>${plantCell(p)}`},
        {title:_t('ws.spOnOrder'),cell:p=>p.onOrder?qty(p.onOrder,p.unit):'—'},
        {title:_t('ws.spReorderPoint'),cell:p=>p.reorder_point?qty(p.reorder_point,p.unit):'—'},
        {title:_t('label.status'),cell:statusPill},
        {title:_t('ws.spUnitCost'),cell:p=>formatMoney(p.unit_cost_minor,p.currency)},
        {title:'',cls:'row',cell:p=>`${canIssue(p.company_id)&&p.onHand>0?btn(_t('ws.spIssue'),'spIssue','small',p.id):''}${canManage(p.company_id)?btn(_t('ws.spReceive'),'spReceive','secondary small',p.id)+btn(_t('ws.spAdjust'),'spAdjust','secondary small',p.id)+(p.onHand>0?btn(_t('ws.spTransfer'),'spTransfer','secondary small',p.id):''):''}`}]})}</div>`;
  }
  function reorderTab(x){
    if (!x) return `<div class="panel empty">${_t('ws.spLoading')}</div>`;
    const groups=x.reorder.suppliers;
    if (!groups.length) return `<div class="panel empty">${_t('ws.spNothingToReorder')}</div>`;
    return `<p class="muted">${_t('ws.spReorderHelp')}</p>`+groups.map((g,i)=>`<div class="panel"><div class="spread"><h2>${esc(g.supplier||_t('ws.spNoSupplier'))}${multi()?` <span class="muted">· ${esc(g.companyName)}</span>`:''}</h2><span><b>${formatMoney(g.totalMinor,g.currency)}</b> ${canManage(g.companyId)?btn(_t('ws.spRecordOrdered'),'spOrderGroup','small',String(i)):''}</span></div>
      ${simpleTable([_t('ws.part'),_t('ws.spOnHand'),_t('ws.spOnOrder'),_t('ws.spReorderPoint'),_t('ws.spSuggested'),_t('ws.spUnitCost'),_t('ws.spLineCost'),_t('ws.spLeadTime')],g.lines.map(l=>`<tr><td><a data-action="spPart" data-id="${esc(l.partId)}"><b>${esc(l.partNumber)}</b></a><div class="muted">${esc(l.name)}</div></td><td>${qty(l.onHand,l.unit)}</td><td>${l.onOrder?qty(l.onOrder,l.unit):'—'}</td><td>${qty(l.reorderPoint,l.unit)}</td><td><b>${qty(l.suggestedQty,l.unit)}</b></td><td>${formatMoney(l.unitCostMinor,l.currency)}</td><td>${formatMoney(l.lineCostMinor,l.currency)}</td><td>${l.leadTimeDays?_t('ws.spDays',{n:l.leadTimeDays}):'—'}</td></tr>`))}</div>`).join('');
  }
  function pmTab(x){
    if (!x) return `<div class="panel empty">${_t('ws.spLoading')}</div>`;
    const status=s=>`<span class="pill ${{ok:'active',due_soon:'due-soon',due:'warning',overdue:'critical'}[s]||''}">${esc(_t('ws.pmStatus_'+s))}</span>`;
    return `<div class="panel"><p class="muted">${_t('ws.spPmHelp')}</p>${simpleTable([_t('ws.machine'),_t('ws.pmPlan'),_t('label.status'),_t('ws.spPartsNeeded'),_t('ws.spStock'),''],x.demand.map(d=>`<tr><td><a data-action="equipment" data-id="${esc(d.equipmentId)}">${esc(assetName(d.equipmentId))}</a></td><td>${esc(d.title)}</td><td>${status(d.status)}</td>
      <td>${d.parts.map(p=>`<div>${p.sufficient?'✓':'⚠'} <a data-action="spPart" data-id="${esc(p.partId)}">${esc(p.partNumber)}</a> × ${qty(p.quantity,p.unit)} <span class="muted">${_t('ws.spHave',{n:formatNumber(p.onHand,3)})}</span></div>`).join('')}</td>
      <td>${d.sufficient?`<span class="pill approved">✓ ${_t('ws.spSufficient')}</span>`:`<span class="pill critical">⚠ ${_t('ws.spShort')}</span>`}</td><td class="row">${d.openJobId&&d.sufficient&&canIssue(d.companyId)?btn(_t('ws.spIssueParts'),'spIssueJob','small',d.openJobId):''}</td></tr>`),_t('ws.spNoPmDemand'))}</div>`;
  }
  function ordersTab(x){
    if (!x) return `<div class="panel empty">${_t('ws.spLoading')}</div>`;
    return `<div class="panel">${simpleTable([_t('ws.spOrdered'),_t('ws.part'),_t('ws.plant'),_t('ws.spQuantity'),_t('ws.spReceived'),_t('ws.spSupplier'),_t('ws.spReference'),_t('ws.spExpected'),''],x.orders.map(o=>`<tr><td>${formatDate(o.created_at)}</td><td><a data-action="spPart" data-id="${esc(o.part_id)}"><b>${esc(o.part_number)}</b></a><div class="muted">${esc(o.name)}</div></td><td>${esc(o.plant_name)}</td><td>${qty(o.quantity,o.unit)}</td><td>${o.received_qty?qty(o.received_qty,o.unit):'—'}</td><td>${esc(o.supplier||'—')}</td><td>${esc(o.reference||'—')}</td><td>${o.expected_at?formatDate(o.expected_at):'—'}</td>
      <td class="row">${canManage(o.company_id)?btn(_t('ws.spReceive'),'spReceiveOrder','small',o.id)+btn(_t('ws.spCancelOrder'),'spCancelOrder','secondary small',o.id):''}</td></tr>`),_t('ws.spNoOrders'))}</div>`;
  }

  // ---------- Part detail ----------
  function detailView(p){
    const facts=[[_t('ws.spPartNumber'),`<b>${esc(p.part_number)}</b>`],[_t('ws.spName'),esc(p.name)],[_t('ws.spMaker'),esc(p.maker||'—')],[_t('ws.spUnit'),esc(p.unit)],[_t('ws.spCategory'),esc(p.category||'—')],
      [_t('ws.spFitsTypes'),p.fitsTypes.length?p.fitsTypes.map(x=>esc(label('machine',x))).join(', '):'—'],[_t('ws.spUnitCost'),formatMoney(p.unit_cost_minor,p.currency)],
      [_t('ws.spReorderPoint'),p.reorder_point?qty(p.reorder_point,p.unit):'—'],[_t('ws.spReorderQty'),p.reorder_qty?qty(p.reorder_qty,p.unit):'—'],[_t('ws.spLeadTime'),p.lead_time_days?_t('ws.spDays',{n:p.lead_time_days}):'—'],
      [_t('ws.spSupplier'),esc(p.supplier||'—')],[_t('ws.spBarcode'),esc(p.barcode||'—')],...(multi()?[[_t('ws.spCompany'),esc(p.companyName)]]:[]),...(p.notes?[[_t('ws.spNotes'),esc(p.notes)]]:[])];
    const kv=rows=>`<dl class="kv">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
    const forCell=m=>m.ticket_id?`<a data-action="ticket" data-id="${esc(m.ticket_id)}">${esc(m.ticket_title||_t('nav.tickets'))}</a>${m.asset_tag?` <span class="muted">${esc(m.asset_tag)}</span>`:''}`:m.pm_job_id?`${_t('ws.spPmJob')}${m.asset_tag?` <span class="muted">${esc(m.asset_tag)}</span>`:''}`:'';
    const returnable=p.whereUsed.tickets.filter(x=>x.qty>0&&x.status!=='completed');
    const actions=`${btn('← '+_t('nav.stock'),'spBack','secondary')}${canIssue(p.company_id)&&p.onHand>0?btn(_t('ws.spIssue'),'spIssue','primary',p.id):''}${canIssue(p.company_id)&&returnable.length?btn(_t('ws.spReturn'),'spReturn','secondary',p.id):''}${canManage(p.company_id)?btn(_t('ws.spReceive'),'spReceive','secondary',p.id)+btn(_t('ws.spAdjust'),'spAdjust','secondary',p.id)+(p.onHand>0?btn(_t('ws.spTransfer'),'spTransfer','secondary',p.id):'')+btn(_t('ws.spOrder'),'spOrder','secondary',p.id)+btn(_t('action.edit'),'spEdit','secondary',p.id):''}`;
    return header(_t('nav.stock'),`${p.part_number} · ${p.name}`)+`<div class="section-actions">${actions}</div><div class="detail"><div>
      <div class="panel"><div class="spread"><h2>${esc(p.part_number)} · ${esc(p.name)}</h2>${statusPill(p)}</div>${kv(facts)}</div>
      <div class="panel"><h2>${_t('ws.spStockByLocation')}</h2>${simpleTable([_t('ws.plant'),_t('ws.spBin'),_t('ws.spOnHand')],p.stock.map(s=>`<tr><td>${esc(s.plantName)}</td><td>${esc(s.bin||'—')}</td><td>${qty(s.onHand,p.unit)}</td></tr>`),_t('ws.spNoStock'))}
        <p class="muted">${_t('ws.spTotals',{onHand:qty(p.onHand,p.unit),onOrder:qty(p.onOrder,p.unit),value:formatMoney(p.valueMinor,p.currency)})}</p></div>
      <div class="panel"><h2>${_t('ws.spMovements')}</h2><p class="muted">${_t('ws.spLedgerHelp')}</p>${simpleTable([_t('ws.time'),_t('ws.spType'),_t('ws.spQuantity'),_t('ws.spBalance'),_t('ws.spLocation'),_t('ws.spFor'),_t('ws.by')],p.movements.map(m=>`<tr><td>${when(m.created_at)}</td><td>${moveType(m.type)}</td><td><b>${signed(m.quantity,p.unit)}</b></td><td>${formatNumber(m.balance_after,3)}</td><td>${esc(m.plant_name)}${m.bin?` · ${esc(m.bin)}`:''}</td><td>${forCell(m)}${m.reason?`<div class="muted">${esc(m.reason)}</div>`:''}${m.reference?`<div class="muted">${esc(m.reference)}</div>`:''}</td><td>${esc(m.user_name||'')}</td></tr>`),_t('ws.spNoMovements'))}</div>
    </div><div>
      <div class="panel qr-panel"><h2>${_t('ws.spLabel')}</h2><div class="qr-box">${qrSvg(p.qr_code,150)}</div><p class="mini"><code>${esc(p.qr_code)}</code></p><p class="muted">${_t('ws.spLabelHelp')}</p></div>
      <div class="panel"><h2>${_t('ws.spWhereUsed')}</h2><h3>${_t('ws.spMachines')}</h3>${p.whereUsed.machines.length?p.whereUsed.machines.map(m=>`<p class="mini"><a data-action="equipment" data-id="${esc(m.id)}">${esc(m.asset_tag||'')} ${esc(m.make)} ${esc(m.model)}</a> <span class="muted">${m.listed?_t('ws.spListed'):_t('ws.spByType')}</span></p>`).join(''):`<p class="muted">${_t('ws.spNoMachines')}</p>`}
        <h3>${_t('ws.pmPlans')}</h3>${p.whereUsed.pmPlans.length?p.whereUsed.pmPlans.map(x=>`<p class="mini">${esc(x.title)} · ${esc(assetName(x.equipment_id))} × ${qty(x.quantity,p.unit)}</p>`).join(''):`<p class="muted">${_t('dash.none')}</p>`}
        <h3>${_t('nav.tickets')}</h3>${p.whereUsed.tickets.length?p.whereUsed.tickets.map(x=>`<p class="mini"><a data-action="ticket" data-id="${esc(x.ticket_id)}">${esc(x.title)}</a> · ${qty(x.qty,p.unit)} · ${formatMoney(x.cost,p.currency)}</p>`).join(''):`<p class="muted">${_t('dash.none')}</p>`}</div>
      <div class="panel"><h2>${_t('ws.spTabOrders')}</h2>${p.orders.length?p.orders.map(o=>`<p class="mini">${formatDate(o.created_at)} · ${qty(o.quantity,p.unit)} · ${esc(o.plant_name)} · ${esc(_t('ws.spOrder_'+o.status))}${o.reference?` · ${esc(o.reference)}`:''}</p>`).join(''):`<p class="muted">${_t('dash.none')}</p>`}</div>
    </div></div>`;
  }

  // ---------- Dialogs ----------
  const plantSelect=(name,text,companyId,opts={})=>select(name,text,plantsOf(companyId).map(p=>[p.id,p.name]),{required:true,value:plantsOf(companyId).length===1?plantsOf(companyId)[0].id:'',...opts});
  const amount=v=>v===''||v==null?undefined:Number(v);
  function partForm(p){
    const companies=(state.data.companies||[]).filter(c=>canManage(c.id)), company0=p?.company_id||(companies.length===1?companies[0].id:'');
    const machines=(state.data.equipment||[]).filter(e=>e.status!=='decommissioned'&&(!company0||e.company_id===company0));
    const cats=[...new Set(parts().map(x=>x.category).filter(Boolean))].sort(), code=currencyOf(company0), digits=new Intl.NumberFormat('en',{style:'currency',currency:code}).resolvedOptions().maximumFractionDigits;
    const body=section(_t('ws.spIdentification'),`${!p&&companies.length>1?select('companyId',_t('ws.spCompany'),companies.map(c=>[c.id,c.name]),{required:true,wide:true}):''}${field('partNumber',_t('ws.spPartNumber'),{value:p?.part_number||'',required:true,maxlength:80,help:_t('ws.spPartNumberHelp')})}${field('name',_t('ws.spName'),{value:p?.name||'',required:true,maxlength:200})}${field('maker',_t('ws.spMaker'),{value:p?.maker||'',maxlength:80})}
        ${select('unit',_t('ws.spUnit'),(state.cat?.partUnits||['pcs']).map(u=>[u,u]),{value:p?.unit||'pcs',required:true,help:p?_t('ws.spUnitFixed'):''})}${field('category',_t('ws.spCategory'),{value:p?.category||'',maxlength:60,list:'sp-cats'})}<datalist id="sp-cats">${cats.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>${field('barcode',_t('ws.spBarcode'),{value:p?.barcode||'',maxlength:80,help:_t('ws.spBarcodeHelp')})}`)
      +section(_t('ws.spReordering'),`${field('unitCost',_t('ws.spUnitCost'),{type:'number',min:0,step:1/10**digits,unit:code,value:p?p.unit_cost_minor/10**digits:''})}${field('reorderPoint',_t('ws.spReorderPoint'),{type:'number',min:0,step:'any',value:p?.reorder_point??'',help:_t('ws.spReorderPointHelp')})}${field('reorderQty',_t('ws.spReorderQty'),{type:'number',min:0,step:'any',value:p?.reorder_qty??''})}${field('leadTimeDays',_t('ws.spLeadTime'),{type:'number',min:0,max:365,step:1,unit:_t('ws.spDaysUnit'),value:p?.lead_time_days??''})}${field('supplier',_t('ws.spSupplier'),{value:p?.supplier||'',maxlength:120,wide:true})}`)
      +section(_t('ws.spFits'),`${checkboxes('fitsTypes',_t('ws.spFitsTypes'),(state.cat?.machineTypes||[]).map(x=>[x,label('machine',x)]),{values:p?.fitsTypes||[]})}${machines.length?checkboxes('fitsEquipmentIds',_t('ws.spFitsMachines'),machines.map(e=>[e.id,assetName(e.id)]),{values:p?.fitsEquipmentIds||[]}):''}`)
      +(p?section(_t('ws.spOther'),`${field('notes',_t('ws.spNotes'),{type:'textarea',value:p.notes||'',wide:true})}<label class="check-opt wide"><input type="checkbox" name="active" ${p.active?'checked':''}> ${_t('ws.spActive')}</label>`)
        :section(_t('ws.spOpening'),`${company0?plantSelect('plantId',_t('ws.plant'),company0,{required:false}):''}${field('bin',_t('ws.spBin'),{maxlength:40,help:_t('ws.spBinHelp')})}${field('openingQty',_t('ws.spOpeningQty'),{type:'number',min:0,step:'any'})}${field('notes',_t('ws.spNotes'),{type:'textarea',wide:true})}`,_t('ws.spOpeningHelp')));
    openDialog(p?`${_t('action.edit')}: ${p.part_number}`:_t('ws.spAddPart'),body,{onSubmit:async fd=>{
      const v=Object.fromEntries(fd), companyId=p?.company_id||v.companyId||company0, cur=currencyOf(companyId);
      const b={partNumber:v.partNumber,name:v.name,maker:v.maker,unit:v.unit,category:v.category,barcode:v.barcode,supplier:v.supplier,notes:v.notes,
        unitCostMinor:v.unitCost===''?0:toMinorUnits(v.unitCost,cur),reorderPoint:amount(v.reorderPoint)??0,reorderQty:amount(v.reorderQty)??0,leadTimeDays:amount(v.leadTimeDays)??0,fitsTypes:fd.getAll('fitsTypes'),fitsEquipmentIds:fd.getAll('fitsEquipmentIds')};
      if (p) { if (v.unit===p.unit) delete b.unit; b.active=fd.has('active'); await api(`/spare-parts/${p.id}`,'PATCH',b); return done(_t('msg.saved')); }
      if (v.openingQty&&Number(v.openingQty)>0) { if (!v.plantId) throw Error(_t('ws.spChoosePlant')); b.initialStock={plantId:v.plantId,bin:v.bin,quantity:Number(v.openingQty)}; }
      const made=await api('/spare-parts','POST',{...b,companyId}); state.stockPartId=made.id; await done(_t('ws.spPartAdded'));
    }});
  }
  function receiveForm(p,order){
    const code=p.currency, digits=new Intl.NumberFormat('en',{style:'currency',currency:code}).resolvedOptions().maximumFractionDigits;
    const body=`<div class="form-grid">${order?`<p class="wide">${_t('ws.spReceivingOrder',{ref:esc(order.reference||'—'),qty:qty(order.quantity-order.received_qty,p.unit)})}</p>`:''}${plantSelect('plantId',_t('ws.plant'),p.company_id,{value:order?.plant_id||(p.stock[0]?.plantId)||(plantsOf(p.company_id).length===1?plantsOf(p.company_id)[0].id:'')})}${field('bin',_t('ws.spBin'),{list:'sp-bins',maxlength:40,value:p.stock[0]?.bin||''})}${binList('sp-bins',p)}
      ${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',unit:p.unit,value:order?order.quantity-order.received_qty:''})}${field('unitCost',_t('ws.spPurchasePrice'),{type:'number',min:0,step:1/10**digits,unit:code,help:_t('ws.spPurchasePriceHelp')})}${field('reference',_t('ws.spDeliveryNote'),{maxlength:200,wide:true,value:order?.reference||''})}</div>`;
    openDialog(`${_t('ws.spReceive')}: ${p.part_number}`,body,{submitLabel:_t('ws.spReceive'),onSubmit:async fd=>{ const v=Object.fromEntries(fd);
      await api(`/spare-parts/${p.id}/receive`,'POST',{plantId:v.plantId,bin:v.bin,quantity:Number(v.quantity),reference:v.reference,...(v.unitCost!==''?{unitCostMinor:toMinorUnits(v.unitCost,code)}:{}),...(order?{orderId:order.id}:{})}); await done(_t('ws.spReceived2')); }});
  }
  function issueForm(p){
    const tickets=(state.data.tickets||[]).filter(t=>t.company_id===p.company_id&&t.status!=='completed'), jobs=(state.data.pmJobs||[]).filter(j=>j.company_id===p.company_id&&j.status==='open');
    const targets=[...tickets.map(t=>[`ticket:${t.id}`,`${t.title} · ${assetName(t.equipment_id)}`]),...jobs.map(j=>[`job:${j.id}`,`${_t('ws.spPmJob')}: ${j.title} · ${assetName(j.equipment_id)}`])];
    const bins=p.stock.filter(s=>s.onHand>0).map(s=>[`${s.plantId}|${s.bin}`,`${s.plantName}${s.bin?` · ${s.bin}`:''} (${formatNumber(s.onHand,3)})`]);
    const body=`<div class="form-grid">${targets.length?select('target',_t('ws.spIssueTo'),targets,{required:true,wide:true,help:_t('ws.spIssueToHelp')}):`<p class="wide notice">${_t('ws.spNoOpenWork')}</p>`}${select('from',_t('ws.spTakeFrom'),bins,{placeholder:_t('ws.spTakeFromAuto'),wide:true,help:_t('ws.spTakeFromHelp')})}${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',unit:p.unit,value:1})}${field('note',_t('ws.spNote'),{maxlength:500,wide:true})}</div>`;
    openDialog(`${_t('ws.spIssue')}: ${p.part_number}`,body,{submitLabel:_t('ws.spIssue'),onSubmit:targets.length?async fd=>{ const v=Object.fromEntries(fd), [kind,tid]=String(v.target).split(':'), [plantId,bin]=v.from?String(v.from).split('|'):[];
      await api(`/spare-parts/${p.id}/issue`,'POST',{...(kind==='ticket'?{ticketId:tid}:{pmJobId:tid}),quantity:Number(v.quantity),note:v.note,...(plantId?{plantId,bin}:{})}); await done(_t('ws.spIssued')); }:undefined});
  }
  function returnForm(p){
    const rows=p.whereUsed.tickets.filter(x=>x.qty>0&&x.status!=='completed');
    const body=`<div class="form-grid">${select('ticketId',_t('nav.tickets'),rows.map(x=>[x.ticket_id,`${x.title} (${formatNumber(x.qty,3)} ${p.unit})`]),{required:true,wide:true})}${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',unit:p.unit,value:1})}${field('bin',_t('ws.spBin'),{list:'sp-bins',maxlength:40,help:_t('ws.spReturnBinHelp')})}${binList('sp-bins',p)}${field('reason',_t('ws.spReason'),{maxlength:500,wide:true,help:_t('ws.spReturnReasonHelp')})}</div>`;
    openDialog(`${_t('ws.spReturn')}: ${p.part_number}`,body,{submitLabel:_t('ws.spReturn'),onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(`/spare-parts/${p.id}/return`,'POST',{ticketId:v.ticketId,quantity:Number(v.quantity),bin:v.bin||undefined,reason:v.reason}); await done(_t('ws.spReturned')); }});
  }
  function adjustForm(p){
    const body=`<div class="form-grid">${plantSelect('plantId',_t('ws.plant'),p.company_id,{value:p.stock[0]?.plantId||''})}${field('bin',_t('ws.spBin'),{list:'sp-bins',maxlength:40,value:p.stock[0]?.bin||''})}${binList('sp-bins',p)}
      ${select('mode',_t('ws.spAdjustBy'),[['count',_t('ws.spAdjustCount')],['delta',_t('ws.spAdjustDelta')]],{required:true,value:'count'})}${field('value',_t('ws.spQuantity'),{type:'number',required:true,step:'any',unit:p.unit,help:_t('ws.spAdjustHelp')})}
      ${field('reason',_t('ws.spReason'),{type:'textarea',required:true,maxlength:500,wide:true,help:canGoNegative(p.company_id)?_t('ws.spReasonAdminHelp'):_t('ws.spReasonHelp')})}</div>`;
    openDialog(`${_t('ws.spAdjust')}: ${p.part_number}`,body,{onSubmit:async fd=>{ const v=Object.fromEntries(fd);
      await api(`/spare-parts/${p.id}/adjust`,'POST',{plantId:v.plantId,bin:v.bin,reason:v.reason,...(v.mode==='count'?{countedQuantity:Number(v.value)}:{delta:Number(v.value)})}); await done(_t('ws.spAdjusted')); }});
  }
  function transferForm(p){
    const from=p.stock.filter(s=>s.onHand>0).map(s=>[`${s.plantId}|${s.bin}`,`${s.plantName}${s.bin?` · ${s.bin}`:''} (${formatNumber(s.onHand,3)})`]);
    const body=`<div class="form-grid">${select('from',_t('ws.spFrom'),from,{required:true,wide:true,value:from.length===1?from[0][0]:''})}${plantSelect('toPlantId',_t('ws.spToPlant'),p.company_id)}${field('toBin',_t('ws.spToBin'),{list:'sp-bins',maxlength:40})}${binList('sp-bins',p)}${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',unit:p.unit})}${field('reference',_t('ws.spReference'),{maxlength:200,wide:true})}</div>`;
    openDialog(`${_t('ws.spTransfer')}: ${p.part_number}`,body,{submitLabel:_t('ws.spTransfer'),onSubmit:async fd=>{ const v=Object.fromEntries(fd), [fromPlantId,fromBin]=String(v.from).split('|');
      await api(`/spare-parts/${p.id}/transfer`,'POST',{fromPlantId,fromBin,toPlantId:v.toPlantId,toBin:v.toBin,quantity:Number(v.quantity),reference:v.reference}); await done(_t('ws.spTransferred')); }});
  }
  function orderForm(p){
    const body=`<div class="form-grid">${plantSelect('plantId',_t('ws.spDeliverTo'),p.company_id,{value:p.stock[0]?.plantId||''})}${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',unit:p.unit,value:p.suggestedQty||p.reorder_qty||''})}${field('supplier',_t('ws.spSupplier'),{value:p.supplier||'',maxlength:120})}${field('reference',_t('ws.spPoNumber'),{maxlength:200})}${field('expectedAt',_t('ws.spExpected'),{type:'date',value:new Date(Date.now()+(p.lead_time_days||0)*86400000).toISOString().slice(0,10)})}</div>`;
    openDialog(`${_t('ws.spOrder')}: ${p.part_number}`,body,{onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(`/spare-parts/${p.id}/orders`,'POST',{plantId:v.plantId,quantity:Number(v.quantity),supplier:v.supplier,reference:v.reference,expectedAt:v.expectedAt||undefined}); await done(_t('ws.spOrderRecorded')); }});
  }
  function orderGroupForm(g){
    const body=`<div class="form-grid"><p class="wide">${_t('ws.spOrderGroupHelp',{n:g.lines.length,supplier:esc(g.supplier||_t('ws.spNoSupplier'))})}</p>${field('reference',_t('ws.spPoNumber'),{maxlength:200,required:true})}${field('expectedAt',_t('ws.spExpected'),{type:'date'})}</div>`;
    openDialog(_t('ws.spRecordOrdered'),body,{onSubmit:async fd=>{ const v=Object.fromEntries(fd);
      for (const l of g.lines) { const plantId=l.plants[0]?.plantId||plantsOf(l.companyId)[0]?.id; await api(`/spare-parts/${l.partId}/orders`,'POST',{plantId,quantity:l.suggestedQty,supplier:g.supplier,reference:v.reference,expectedAt:v.expectedAt||undefined}); }
      await done(_t('ws.spOrderRecorded')); }});
  }
  // From a ticket: find the part by its label or by search, then issue it to the ticket (in-house engineers too).
  function ticketIssueForm(tk){
    let chosen=null;
    const body=`<div class="form-grid"><div class="fld wide"><label for="f-partCode">${_t('ws.spScanPart')}</label>${scanInput('partCode',{placeholder:_t('ws.spScanPlaceholder')})}<small class="scan-msg help" hidden></small></div>${field('q',_t('ws.spSearchParts'),{type:'search',wide:true,help:_t('ws.spSearchHelp')})}<div class="wide" id="sp-results"><p class="muted">${_t('ws.spLoading')}</p></div>${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',value:1})}${field('note',_t('ws.spNote'),{maxlength:500})}</div>`;
    const show=(d,list)=>{ const box=d.querySelector('#sp-results'); chosen=list.length===1?list[0]:chosen&&list.find(x=>x.id===chosen.id)||null;
      box.innerHTML=list.length?list.map(x=>`<label class="check-opt wide sp-pick"><input type="radio" name="partId" value="${esc(x.id)}" ${chosen?.id===x.id?'checked':''}> <b>${esc(x.partNumber)}</b> ${esc(x.name)} <span class="muted">· ${_t('ws.spAtPlant',{n:formatNumber(x.onHand,3),unit:esc(x.unit)})}${x.fitsThisMachine?` · ${_t('ws.spFitsThis')}`:''}${x.issuedToTicket?` · ${_t('ws.spAlreadyIssued',{n:formatNumber(x.issuedToTicket,3)})}`:''}</span></label>`).join(''):`<p class="muted">${_t('ws.spNoMatch')}</p>`;
      box.querySelectorAll('[name=partId]').forEach(r=>r.onchange=()=>{ chosen=list.find(x=>x.id===r.value); }); };
    const find=async (d,params)=>{ try { const list=await api(`/tickets/${tk.id}/spare-parts?${new URLSearchParams(params)}`); show(d,list); return list; } catch (e) { d.querySelector('#sp-results').innerHTML=`<p class="notice error">${esc(e.message)}</p>`; return []; } };
    openDialog(`${_t('ws.spIssueFromStock')}: ${tk.title}`,body,{submitLabel:_t('ws.spIssue'),onOpen:d=>{ find(d,{});
        bindScanInput(d,'partCode',async code=>{ const list=await find(d,{code}); if (!list.length) throw Error(_t('ws.spUnknownCode')); });
        let timer; d.querySelector('[name=q]').oninput=e=>{ clearTimeout(timer); timer=setTimeout(()=>find(d,e.target.value.trim()?{q:e.target.value.trim()}:{}),250); }; },
      onSubmit:async fd=>{ const id=fd.get('partId')||chosen?.id; if (!id) throw Error(_t('ws.spChoosePart'));
        await api(`/spare-parts/${id}/issue`,'POST',{ticketId:tk.id,quantity:Number(fd.get('quantity')),note:fd.get('note')}); await done(_t('ws.spIssued')); }});
  }
  function ticketReturnForm(tk){
    const lines=tk.stockUsed?.lines||[];
    const body=`<div class="form-grid">${select('partId',_t('ws.part'),lines.map(l=>[l.partId,`${l.partNumber} ${l.name} (${formatNumber(l.quantity,3)} ${l.unit})`]),{required:true,wide:true})}${field('quantity',_t('ws.spQuantity'),{type:'number',required:true,min:0,step:'any',value:1})}${field('reason',_t('ws.spReason'),{maxlength:500,wide:true,help:_t('ws.spReturnReasonHelp')})}</div>`;
    openDialog(_t('ws.spReturnToStock'),body,{submitLabel:_t('ws.spReturn'),onSubmit:async fd=>{ const v=Object.fromEntries(fd); await api(`/spare-parts/${v.partId}/return`,'POST',{ticketId:tk.id,quantity:Number(v.quantity),reason:v.reason}); await done(_t('ws.spReturned')); }});
  }
  // On the ticket: parts taken from stock and their cost.
  const ticketPanel=tk=>{ const s=tk.stockUsed; if (!s?.lines?.length) return '';
    return `<h3>${_t('ws.spFromStock')}</h3>${s.lines.map(l=>`<p>${qty(l.quantity,l.unit)} · <b>${esc(l.partNumber)}</b> ${esc(l.name)} <span class="muted">${formatMoney(l.costMinor,s.currency)}</span></p>`).join('')}<p class="muted">${_t('ws.spPartsCost',{value:formatMoney(s.totalMinor,s.currency)})}</p>`; };
  const canIssueTicket=tk=>canIssue(tk.company_id)||(is('engineer')&&tk.assigned_user_id===state.user.id);

  async function action(name,id){
    const p=id?partOf(id):null;
    if (name==='spPart'){ state.stockPartId=id; state.stockPart=null; state.page='stock'; state.detail=null; render(); window.scrollTo(0,0); return; }
    if (name==='spBack'){ state.stockPartId=null; state.stockPart=null; return render(); }
    if (name==='spNewPart') return partForm();
    if (name==='spEdit') return partForm(p);
    if (name==='spImport') return importDialog('spare-parts');
    if (name==='spReorderCsv') return downloadCsv();
    if (name==='spReceive') return receiveForm(p);
    if (name==='spIssue') return issueForm(p);
    if (name==='spReturn') return returnForm(state.stockPart);
    if (name==='spAdjust') return adjustForm(p);
    if (name==='spTransfer') return transferForm(p);
    if (name==='spOrder') return orderForm(p);
    if (name==='spOrderGroup') return orderGroupForm(state.stockExtra.reorder.suppliers[Number(id)]);
    if (name==='spReceiveOrder'){ const o=state.stockExtra.orders.find(x=>x.id===id); const part=partOf(o.part_id)||await api(`/spare-parts/${o.part_id}`); return receiveForm(part,o); }
    if (name==='spCancelOrder'){ if (!await confirmAction(_t('ws.spCancelOrderQ'),_t('ws.spCancelOrderMsg'),{confirmLabel:_t('ws.spCancelOrder')})) return; return api(`/spare-orders/${id}/cancel`,'POST',{}).then(()=>done(_t('ws.spOrderCancelled'))).catch(fail); }
    if (name==='spIssueJob'){ if (!await confirmAction(_t('ws.spIssuePartsQ'),_t('ws.spIssuePartsMsg'),{confirmLabel:_t('ws.spIssueParts'),danger:false})) return; return api(`/pm/jobs/${id}/issue-parts`,'POST',{}).then(()=>done(_t('ws.spIssued'))).catch(fail); }
    if (name==='spIssueRequest'){ const r=(state.data.parts||[]).find(x=>x.id===id); if (!await confirmAction(_t('ws.spIssueRequestQ'),_t('ws.spIssueRequestMsg',{qty:`${r.quantity} ${r.unit}`,part:r.stock.partNumber,n:formatNumber(r.stock.onHand,3)}),{confirmLabel:_t('ws.spIssue'),danger:false})) return;
      return api(`/parts/${id}/issue-from-stock`,'POST',{}).then(()=>done(_t('ws.spIssued'))).catch(fail); }
    if (name==='spTicketIssue') return ticketIssueForm(state.detail.value);
    if (name==='spTicketReturn') return ticketReturnForm(state.detail.value);
    return false;
  }
  function bind(){
    const box=document.querySelector('.stock-scan'); if (!box) return;
    bindScanInput(box,'spCode',async code=>{ const c=code.trim().toLowerCase(), hit=parts().find(p=>p.qr_code.toLowerCase()===c||(p.barcode||'').toLowerCase()===c||p.part_number.toLowerCase()===c); if (!hit) throw Error(_t('ws.spUnknownCode')); action('spPart',hit.id); });
  }
  const reset=()=>{ state.stockExtra=undefined; if (state.stockPart) state.stockPart=null; };
  return {views:{stock:stockView},action,bind,reset,ticketPanel,canIssueTicket,canIssue,
    ACTIONS:['spPart','spBack','spNewPart','spEdit','spImport','spReorderCsv','spReceive','spIssue','spReturn','spAdjust','spTransfer','spOrder','spOrderGroup','spReceiveOrder','spCancelOrder','spIssueJob','spIssueRequest','spTicketIssue','spTicketReturn']};
}
