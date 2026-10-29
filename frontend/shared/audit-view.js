// Energy audit result blocks shared by the phone app (/audit/) and the desktop page "Energy audits": data-path advice,
// SEC, cycle map with chart, drive, upgrade proposal with its assumptions, and confidence. Returns HTML strings; every
// value from the API is escaped. Charts are inline SVG that take their colours from CSS variables (with fallbacks).
import { t, formatNumber as nf, formatDateTime } from './i18n.js';

export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n1=v=>nf(v,1), n2=v=>nf(v,2), n3=v=>nf(v,3), dash='—';
export const fmtMs=ms=>ms==null?dash:ms<1000?`${nf(ms,0)} ms`:ms<120000?`${nf(ms/1000,ms<10000?1:0)} s`:`${nf(ms/60000,0)} min`;
export const PUMP_TYPES=['fixed','variable','servo_hydraulic','all_electric','unknown'];
export const pumpLabel=v=>t('au.pump_'+(v||'unknown'));
export const clsLabel=c=>t('au.cls_'+(c||'unknown'));
export const money=(v,cur)=>{ if (v==null) return dash; try { return new Intl.NumberFormat(document.documentElement.lang||'en',{style:'currency',currency:cur,maximumFractionDigits:Math.abs(v)<100?2:0}).format(v); } catch { return nf(v,0); } };
const css=(name,fb)=>`var(${name},${fb})`;
const INK=css('--chart-ink','#142e3d'), INK2=css('--chart-ink-2','#52514e'), GRID=css('--chart-grid','#e1e0d9'), SERIES=css('--chart-series','#2a78d6'), WARN=css('--chart-bad','#d03b3b'), BRAND=css('--chart-brand','#007e85');

// ---------- Charts ----------
export function traceChart(trace,{fromMs,toMs}) {
  if (!trace||trace.length<2) return `<p class="muted">${esc(t('au.noTrace'))}</p>`;
  const W=640,H=170,L=38,R=8,T=10,B=24, mx=Math.max(1,...trace.map(p=>p[1]))*1.08, X=ms=>L+(ms-fromMs)/(toMs-fromMs)*(W-L-R), Y=v=>T+(1-v/mx)*(H-T-B);
  const pts=trace.map(p=>`${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const grid=[0,0.5,1].map(f=>`<line x1="${L}" x2="${W-R}" y1="${Y(mx*f/1.08)}" y2="${Y(mx*f/1.08)}" style="stroke:${GRID}"/><text x="${L-5}" y="${Y(mx*f/1.08)+3}" text-anchor="end" font-size="10" style="fill:${INK2}">${nf(mx*f/1.08,0)}</text>`).join('');
  const hrs=(toMs-fromMs)/3600000, ticks=[0,0.5,1].map(f=>`<text x="${X(fromMs+(toMs-fromMs)*f)}" y="${H-8}" font-size="10" text-anchor="${f===0?'start':f===1?'end':'middle'}" style="fill:${INK2}">${nf(hrs*f*60,0)} min</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="ac-chart" role="img" aria-label="${esc(t('au.traceTitle'))}">${grid}${ticks}<polyline points="${pts}" fill="none" style="stroke:${SERIES}" stroke-width="1.5"/><text x="2" y="9" font-size="10" style="fill:${INK2}">kW</text></svg>`;
}
export function profileChart(cycle,phases) {
  const pr=cycle?.profile; if (!pr) return '';
  const W=640,H=260,L=38,R=8,T=26,B=28, n=pr.mean.length, Tc=pr.K*pr.stepS, mx=Math.max(1,...pr.max)*1.08, X=s=>L+s/Tc*(W-L-R), Y=v=>T+(1-v/mx)*(H-T-B);
  const pts=a=>a.map((v,i)=>`${X(i/n*Tc).toFixed(1)},${Y(v).toFixed(1)}`);
  const shades=(phases||[]).map((x,i)=>`<rect x="${X(x.startS).toFixed(1)}" y="${T}" width="${Math.max(0.5,X(x.endS)-X(x.startS)).toFixed(1)}" height="${H-T-B}" style="fill:${x.waste?WARN:i%2?BRAND:INK2}" opacity="${x.waste?0.18:0.1}"/>`+
    `<text x="${(X(x.startS)+X(x.endS))/2}" y="${T-6 - (i%2?9:0)}" font-size="9" text-anchor="middle" style="fill:${INK2}">${esc((x.unassigned?'…':x.name).slice(0,10))}</text>`).join('');
  const grid=[0,0.5,1].map(f=>`<line x1="${L}" x2="${W-R}" y1="${Y(mx*f/1.08)}" y2="${Y(mx*f/1.08)}" style="stroke:${GRID}"/><text x="${L-5}" y="${Y(mx*f/1.08)+3}" text-anchor="end" font-size="10" style="fill:${INK2}">${nf(mx*f/1.08,0)}</text>`).join('');
  const step=Tc>90?20:Tc>40?10:5, xt=Array.from({length:Math.floor(Tc/step)+1},(_,i)=>i*step).map(s=>`<text x="${X(s)}" y="${H-10}" font-size="10" text-anchor="middle" style="fill:${INK2}">${s}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="ac-chart" role="img" aria-label="${esc(t('au.profileTitle'))}">${grid}${shades}<polygon points="${pts(pr.max).join(' ')} ${pts(pr.min).reverse().join(' ')}" style="fill:${SERIES}" opacity="0.15"/><polyline points="${pts(pr.mean).join(' ')}" fill="none" style="stroke:${SERIES}" stroke-width="2"/>${xt}<text x="2" y="${T-10}" font-size="10" style="fill:${INK2}">kW</text><text x="${W-R}" y="${H-1}" text-anchor="end" font-size="10" style="fill:${INK2}">s</text></svg>`;
}
export function savingsChart(opt,sec,cur) {
  if (!opt) return '';
  const rows=[[t('au.now'),sec,false],...opt.scenarios.map(s=>[t('au.'+s.scenario),s.secAfter,true])].filter(r=>r[1]!=null);
  if (rows.length<2) return '';
  const W=640,rh=30,H=rows.length*rh+8,L=92,R=70, mx=Math.max(...rows.map(r=>r[1]))||1;
  return `<svg viewBox="0 0 ${W} ${H}" class="ac-chart" role="img" aria-label="${esc(t('au.secAfter'))}">${rows.map((r,i)=>`<text x="${L-8}" y="${i*rh+22}" text-anchor="end" font-size="12" style="fill:${INK}">${esc(r[0])}</text><rect x="${L}" y="${i*rh+8}" width="${Math.max(2,r[1]/mx*(W-L-R))}" height="16" rx="3" style="fill:${r[2]?BRAND:SERIES}"/><text x="${L+r[1]/mx*(W-L-R)+6}" y="${i*rh+21}" font-size="12" style="fill:${INK}">${n2(r[1])}</text>`).join('')}</svg>`;
}

// ---------- Blocks ----------
const tile=(label,value,note='',cls='')=>`<div class="ac-tile ${cls}"><small>${esc(label)}</small><b>${value}</b>${note?`<span class="muted">${note}</span>`:''}</div>`;
const estPill=()=>`<span class="ac-est" title="${esc(t('au.estimatedTip'))}">${esc(t('au.estimated'))}</span>`;
export function adviceBox(adv) {
  if (!adv) return '';
  const every=fmtMs(adv.intervalMs), hz=adv.intervalMs?nf(1000/adv.intervalMs,adv.intervalMs<1000?0:2):dash;
  const line=t('au.advice_'+adv.cycleMap,{every,hz,edge:adv.phaseEdgesS!=null?n1(adv.phaseEdgesS):''});
  const power=adv.power==='estimated'?t('au.advicePowerEst'):t('au.advicePowerMeasured');
  return `<div class="ac-advice ${adv.cycleMap}" role="note"><b>${esc(adv.observed?t('au.adviceObserved'):t('au.adviceBefore'))}</b><p>${esc(line)}</p><p>${esc(power)}</p></div>`;
}
export function confidenceBlock(p) {
  const c=p.confidence; if (!c) return '';
  return `<div class="ac-conf ${c.level}"><b>${esc(t('au.confidence'))}: ${esc(t('au.conf_'+c.level))}</b>${c.reasons.length?`<ul>${c.reasons.map(r=>`<li>${esc(t('au.cr_'+r.code,r))}</li>`).join('')}</ul>`:`<p class="muted">${esc(t('au.confGood'))}</p>`}</div>`;
}
export function secBlock(p) {
  const an=p.analysis; if (!an) return `<p class="muted">${esc(t('au.noResultYet'))}</p>`;
  const e=an.energy, s=an.sec, d=an.data, est=d.power&&d.power!=='measured', b=p.benchmark;
  const bench=b?`<div class="ac-bench ${b.position}"><b>${esc(t('au.benchmark'))}</b>: ${n2(b.low)}–${n2(b.high)} kWh/kg (${esc(clsLabel(b.driveType==='servo_hydraulic'?'servo_hydraulic':b.driveType))}) → <b>${esc(t('au.pos_'+b.position))}</b><br><small class="muted">${esc(t('au.benchmarkIndicative'))}</small></div>`:`<p class="muted">${esc(t('au.noBenchmark'))}</p>`;
  const rows=[[t('au.energy'),`${n2(e.kwh)} kWh${est?' '+estPill():''}`],[t('au.goodKg'),an.output.goodKg!=null?`${n1(an.output.goodKg)} kg (${esc(t('au.basis_'+(an.output.basis||'none')))})`:dash],[t('au.goodParts'),an.output.goodParts!=null?nf(an.output.goodParts,0):dash],
    [t('au.kwhPerPart'),s.kwhPerPart!=null?n3(s.kwhPerPart):dash],[t('au.kwhPerShot'),s.kwhPerShot!=null?n3(s.kwhPerShot):dash],[t('au.avgKw'),`${n2(e.avgKw)} kW`],[t('au.peakKw'),`${n2(e.peakKw)} kW`],[t('au.pf'),e.pf!=null?n2(e.pf):dash],
    [t('au.peakKva'),e.peakKva!=null?`${n1(e.peakKva)} kVA`:dash],[t('au.maxDemand'),e.maxDemandKva?`${n1(e.maxDemandKva.kva)} kVA (${e.maxDemandKva.intervalMin} min${e.maxDemandKva.pfAssumed?', '+t('au.pfAssumed'):''})`:dash],
    [t('au.idleShare'),an.idle?`${n1(an.idle.sharePct)} % (${esc(t('au.idleBasis_'+an.idle.basis))})`:dash],[t('au.standbyKw'),e.standbyKw!=null?`${n2(e.standbyKw)} kW`:dash]];
  return `<div class="ac-tiles">${tile(t('au.sec'),s.kwhPerKg!=null?`${n2(s.kwhPerKg)} <small>kWh/kg</small>${est?' '+estPill():''}`:dash,s.kwhPerKg==null?esc(t('au.secNeedsMass')):'')}${tile(t('au.energy'),`${n1(e.kwh)} <small>kWh</small>`)}${tile(t('au.idleShare'),an.idle?`${n1(an.idle.sharePct)} %`:dash)}</div>
  ${est?`<p class="ac-warn">${esc(t('au.estimatedWarning'))}</p>`:''}${bench}<table class="ac-table"><tbody>${rows.map(r=>`<tr><th>${esc(r[0])}</th><td>${r[1]}</td></tr>`).join('')}</tbody></table>
  <p class="muted">${esc(t('au.dataLine',{src:t('au.src_'+d.source),cov:n1(d.coveragePct),gaps:n1(d.gapMin),step:fmtMs(d.medianStepMs)}))}</p>${traceChart(an.trace,{fromMs:an.window.fromMs,toMs:an.window.toMs})}`;
}
export function cycleBlock(p) {
  const an=p.analysis; if (!an) return `<p class="muted">${esc(t('au.noResultYet'))}</p>`;
  const c=an.cycle;
  if (!c) return `<div class="ac-advice no"><b>${esc(t('au.noCycleMap'))}</b><p>${esc(t('au.whyfail_'+(an.cycleFailure||(an.data.source==='readings'?'resolution':'data'))))}</p></div>`;
  const ph=an.phases?.rows;
  const tiles=`<div class="ac-tiles">${tile(t('au.cycleTime'),`${n1(c.cycleTimeS)} <small>s</small>`,c.vsIdealPct!=null?esc(t('au.vsIdeal',{ideal:n1(c.idealS),pct:(c.vsIdealPct>0?'+':'')+n1(c.vsIdealPct)})):'')}${tile(t('au.cyclesUsed'),`${c.count}`,esc(t('au.ofCandidates',{n:c.candidates})))}${tile(t('au.cycleEnergy'),`${nf(c.cycleKwh*1000,0)} <small>Wh</small>`,`${n1(c.avgCycleKw)} kW`)}</div>`;
  const rej=c.rejected?Object.entries(c.rejected).filter(([,v])=>v).map(([k,v])=>`${esc(t('au.rej_'+k))}: ${v}`).join(' · '):'';
  const table=ph?`<div class="ac-scroll"><table class="ac-table phases"><thead><tr><th>${esc(t('au.phase'))}</th><th>s</th><th>Wh</th><th>%</th><th>kW</th></tr></thead><tbody>${ph.map(x=>`<tr class="${x.waste?'waste':''}"><td>${esc(x.unassigned?t('au.unassigned'):x.name)}${x.waste?` <span class="ac-flag" title="${esc(t('au.waste_'+x.waste.reason))}">⚠</span>`:''}</td><td>${n1(x.seconds)}</td><td>${nf(x.kwh*1000,1)}</td><td>${n1(x.pct)}</td><td>${n1(x.avgKw)}</td></tr>`).join('')}
    <tr class="total"><td>${esc(t('au.total'))}</td><td>${n1(ph.reduce((s,x)=>s+x.seconds,0))}</td><td>${nf(an.phases.sumKwh*1000,1)}</td><td>100</td><td>${n1(c.avgCycleKw)}</td></tr></tbody></table></div>
    ${ph.some(x=>x.waste)?`<p class="ac-warn">${esc(t('au.wasteNote'))}</p>`:''}`:`<p class="muted">${esc(t('au.noTemplate'))}</p>`;
  return `${tiles}<p class="muted">${esc(t('au.cycMethod_'+c.method,{res:n2(c.resolutionS),period:n1(c.periodS)}))}${rej?`<br>${rej}`:''}${c.truncated?`<br>${esc(t('au.truncated'))}`:''}</p>${profileChart(c,ph)}<p class="muted">${esc(t('au.profileNote'))}</p>${table}`;
}
export function driveBlock(p,{editable=false,pumpOptions=true}={}) {
  const an=p.analysis, inf=p.drive?.inferred, eff=p.drive?.effective; if (!an) return '';
  const ev=inf?.evidence?.length?`<ul class="ac-ev">${inf.evidence.map(e=>`<li>${esc(t('au.ev_'+e.key))}: <b>${n2(e.value)}</b> → ${e.supports.length?esc(e.supports.map(clsLabel).join(' / ')):dash}</li>`).join('')}</ul>`:'';
  const infLine=!inf?`<p class="muted">${esc(t('au.driveNoProfile'))}</p>`:inf.class==='unknown'?`<p><b>${esc(t('au.cls_unknown'))}</b> — ${esc(t('au.unknown_'+(inf.reason||'not_separable'),{a:inf.ambiguous?clsLabel(inf.ambiguous[0]):'',b:inf.ambiguous?clsLabel(inf.ambiguous[1]):''}))}</p>${ev}`:
    `<p>${esc(t('au.inferred'))}: <b>${esc(clsLabel(inf.class))}</b> · ${esc(t('au.confidenceShort'))} ${esc(t('au.conf_'+inf.level))} (${n2(inf.confidence)})</p>${ev}<p class="muted">${esc(t('au.servoVsElectric'))}</p>`;
  const ine=an.inefficiency?`<div class="ac-ineff"><b>${esc(t('au.ineffScore'))}: ${n1(an.inefficiency.scorePct)} %</b><p class="muted">${esc(t('au.ineffText',{share:n0(an.inefficiency.lowWorkEnergySharePct),time:n0(an.inefficiency.lowWorkTimeSharePct),base:n1(an.inefficiency.baseKw)}))}</p></div>`:'';
  const mismatch=p.drive.mismatch?`<p class="ac-warn">${esc(t('au.driveMismatch',{cls:clsLabel(p.drive.mismatch),set:clsLabel(eff.class)}))}</p>`:'';
  const sel=editable?`<label class="ac-field">${esc(t('au.driveOverride'))}<select data-assume="driveOverride"><option value="">${esc(t('au.driveAuto'))}</option>${PUMP_TYPES.filter(x=>x!=='unknown').map(x=>`<option value="${x}" ${p.assumptions.driveOverride===x?'selected':''}>${esc(pumpLabel(x))}</option>`).join('')}</select></label>`:'';
  return `${infLine}${ine}<p>${esc(t('au.driveUsed'))}: <b>${esc(clsLabel(eff.class))}</b>${eff.source?` (${esc(t('au.dsrc_'+eff.source))})`:''}</p>${mismatch}${sel}`;
}
const n0=v=>nf(v,0);
export function proposalBlock(p,{editable=false}={}) {
  const pr=p.proposal; if (!pr) return `<p class="muted">${esc(t('au.noResultYet'))}</p>`;
  if (pr.status==='unknown_drive') return `<div class="ac-advice no"><b>${esc(t('au.cls_unknown'))}</b><p>${esc(t('au.proposalUnknown'))}</p></div>`;
  if (pr.status==='efficient') return `<div class="ac-advice yes"><b>${esc(t('au.noUpgradeCase'))}</b><p>${esc(t('au.noUpgradeText'))}</p></div><h4>${esc(t('au.remaining'))}</h4>${pr.remaining?.length?`<ul>${pr.remaining.map(x=>`<li>${esc(t('au.rem_'+x.code,{v:n1(x.value)}))}</li>`).join('')}</ul>`:`<p class="muted">${esc(t('au.remainingNone'))}</p>`}`;
  const cur=p.currency, A=pr.assumptions, target=p.assumptions.target||'servo', sel=pr.options.find(o=>o.target===target)||pr.options[0], sec=p.analysis?.sec?.kwhPerKg;
  const tabs=pr.options.length>1?`<div class="ac-seg" role="group">${pr.options.map(o=>`<button type="button" class="${o.target===sel.target?'on':''}" data-target="${o.target}" ${editable?'':'disabled'}>${esc(t('au.target_'+o.target))}</button>`).join('')}</div>`:'';
  const S=sel.scenarios, row=(label,f)=>`<tr><th>${esc(label)}</th>${S.map(s=>`<td>${f(s)}</td>`).join('')}</tr>`;
  const table=`<table class="ac-table ac-prop"><thead><tr><th></th>${S.map(s=>`<th>${esc(t('au.'+s.scenario))}</th>`).join('')}</tr></thead><tbody>
    ${row(t('au.savedPct'),s=>`${n0(s.fraction*100)} %`)}${row(t('au.kwhkgSaved'),s=>s.kwhPerKgSaved!=null?n3(s.kwhPerKgSaved):dash)}${row(t('au.secAfter'),s=>s.secAfter!=null?n2(s.secAfter):dash)}${row(t('au.annualKwh'),s=>n0(s.annualKwh))}
    ${row(t('au.annualMoney'),s=>money(s.annualMoney,cur))}${row(t('au.annualCo2'),s=>s.annualCo2Kg!=null?n0(s.annualCo2Kg):dash)}${row(t('au.payback'),s=>s.paybackYears!=null?`${n1(s.paybackYears)} ${esc(t('au.yearsShort'))}`:dash)}${row(t('au.netYears',{y:A.years}),s=>money(s.netYears,cur))}</tbody></table>`;
  const rate=p.price?.rate!=null?`${nf(p.price.rate,3)} ${esc(cur)}/kWh (${esc(t('au.price_'+p.price.source))})`:t('au.noPrice');
  const list=[t('au.as_from',{from:clsLabel(pr.startsFrom.class),src:t('au.dsrc_'+(pr.startsFrom.source||'inferred')),to:t('au.target_'+sel.target)}),t('au.as_hours',{v:n0(A.annualHours)}),t('au.as_rate',{v:rate}),t('au.as_co2',{v:n3(p.co2Factor)}),A.fixedLoadKw>0?t('au.as_fixed',{v:n1(A.fixedLoadKw)}):'',t('au.as_factors'),sel.mode==='whole'?t('au.as_whole'):'',A.retrofitCost==null?t('au.as_nocost'):t('au.as_cost',{v:money(A.retrofitCost,cur)}),t('au.as_demand'),t('au.as_nodisc')].filter(Boolean);
  const fac=sel.mode==='phase'?`<details class="ac-details"><summary>${esc(t('au.factorsShow'))}</summary><table class="ac-table"><thead><tr><th>${esc(t('au.category'))}</th><th>${esc(t('au.low'))}</th><th>${esc(t('au.typical'))}</th><th>${esc(t('au.high'))}</th></tr></thead><tbody>${Object.entries(sel.factors).map(([k,v])=>`<tr><td>${esc(t('au.cat_'+k))}</td>${v.map(x=>`<td>${n0(x*100)} %</td>`).join('')}</tr>`).join('')}</tbody></table></details>`:'';
  return `<p class="ac-warn">${esc(t('au.proposalAssumed'))}</p>${tabs}${table}${savingsChart(sel,sec,cur)}<h4>${esc(t('au.assumptions'))}</h4><ul class="ac-assume">${list.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>${fac}`;
}
export const statusLabel=s=>t('au.status_'+s);
export const when=iso=>iso?formatDateTime(iso,'UTC'):dash;
