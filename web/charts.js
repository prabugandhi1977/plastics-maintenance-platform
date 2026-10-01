// Dashboard charts, built to the data-visualisation method: single-series forms in the validated series colour
// (slot 1 blue, checked against the white panel surface), thin marks with 4px rounded data-ends and square baselines,
// solid hairline grid, selective direct labels, hover/focus tooltips with hit areas larger than the marks, and a
// table view for every chart. Text uses ink tokens, never the series colour.
import { esc } from './ui.js';

const INK={primary:'#142e3d',secondary:'#52514e',muted:'#898781',grid:'#e1e0d9',axis:'#c3c2b7'};
const SERIES='#2a78d6';
// 4px rounded data-end, square at the baseline.
const columnPath=(x,y,w,h,r=4)=>{ r=Math.min(r,h,w/2); return `M${x},${y+h}V${y+r}Q${x},${y} ${x+r},${y}H${x+w-r}Q${x+w},${y} ${x+w},${y+r}V${y+h}Z`; };
const barPath=(x,y,w,h,r=4)=>{ r=Math.min(r,w,h/2); return `M${x},${y}H${x+w-r}Q${x+w},${y} ${x+w},${y+r}V${y+h-r}Q${x+w},${y+h} ${x+w-r},${y+h}H${x}Z`; };
// Clean axis maximum and whole-number ticks (counts never show fractions).
function niceScale(max) { if (max<=4) return {top:Math.max(max,1),step:1}; const raw=max/4, mag=10**Math.floor(Math.log10(raw)), step=[1,2,5,10].map(m=>m*mag).find(s=>s>=raw); return {top:Math.ceil(max/step)*step,step}; }
const fmt=n=>new Intl.NumberFormat().format(n);
const tableView=(id,headers,rows)=>`<div class="chart-table" id="${id}-table" hidden><table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const frame=(id,title,subtitle,svg,table)=>`<figure class="chart" id="${id}"><figcaption><div><h2>${esc(title)}</h2>${subtitle?`<p class="muted">${esc(subtitle)}</p>`:''}</div><button type="button" class="link-btn" data-chart-toggle="${id}">Table view</button></figcaption><div class="chart-plot" id="${id}-plot">${svg}</div>${table}</figure>`;

// Column chart for change over time: one series, label only the latest value and the peak.
export function columnChart(id,{title,subtitle,points,valueLabel,formatValue=fmt,xLabel=p=>p.label}) {
  const W=640,H=220,L=36,R=12,T=16,B=28,pw=W-L-R,ph=H-T-B, max=Math.max(0,...points.map(p=>p.value)), {top,step}=niceScale(max);
  const band=pw/points.length, bw=Math.min(24,band*0.6), y=v=>T+ph-(v/top)*ph;
  const peak=points.reduce((m,p,i)=>p.value>points[m].value?i:m,0), last=points.length-1;
  const grid=Array.from({length:Math.round(top/step)+1},(_,i)=>i*step).map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="${v===0?INK.axis:INK.grid}" stroke-width="1"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end" class="tick">${fmt(v)}</text>`).join('');
  const marks=points.map((p,i)=>{
    const cx=L+band*i+band/2, h=Math.max(0,(p.value/top)*ph), showLabel=p.value>0&&(i===last||i===peak);
    const tick=i%2===0||i===last?`<text x="${cx}" y="${H-8}" text-anchor="middle" class="tick">${esc(xLabel(p))}</text>`:'';
    return `<g class="mark" tabindex="0" role="img" aria-label="${esc(`${p.tip}: ${formatValue(p.value)} ${valueLabel}`)}" data-tip-value="${esc(formatValue(p.value))}" data-tip-label="${esc(`${valueLabel} · ${p.tip}`)}"><rect class="hit" x="${L+band*i}" y="${T}" width="${band}" height="${ph}" fill="transparent"/>${h>0?`<path d="${columnPath(cx-bw/2,y(p.value),bw,h)}" fill="${SERIES}"/>`:''}${showLabel?`<text x="${cx}" y="${y(p.value)-6}" text-anchor="middle" class="value">${esc(formatValue(p.value))}</text>`:''}${tick}</g>`;
  }).join('');
  const svg=`<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="group" aria-label="${esc(title)}">${grid}${marks}</svg>`;
  return frame(id,title,subtitle,svg,tableView(id,['Period',valueLabel],points.map(p=>[p.tip,formatValue(p.value)])));
}

// Horizontal bars for comparing magnitude across named items (long labels stay readable); value at the bar tip.
export function barChart(id,{title,subtitle,rows,valueLabel,formatValue=fmt,empty='No data in this period.'}) {
  if (!rows.length) return `<figure class="chart" id="${id}"><figcaption><div><h2>${esc(title)}</h2>${subtitle?`<p class="muted">${esc(subtitle)}</p>`:''}</div></figcaption><p class="muted">${esc(empty)}</p></figure>`;
  const W=640,L=200,R=72,row=36,bh=18,H=rows.length*row+8, max=Math.max(...rows.map(r=>r.value)), x=v=>(v/max)*(W-L-R);
  const marks=rows.map((r,i)=>{ const y=4+i*row, w=Math.max(2,x(r.value)), name=r.label.length>28?r.label.slice(0,27)+'…':r.label;
    return `<g class="mark" tabindex="0" role="img" aria-label="${esc(`${r.label}: ${formatValue(r.value)}`)}" data-tip-value="${esc(formatValue(r.value))}" data-tip-label="${esc(`${valueLabel} · ${r.label}`)}"><rect class="hit" x="0" y="${y}" width="${W}" height="${row}" fill="transparent"/><text x="${L-10}" y="${y+row/2+4}" text-anchor="end" class="label">${esc(name)}</text><path d="${barPath(L,y+(row-bh)/2,w,bh)}" fill="${SERIES}"/><text x="${L+w+8}" y="${y+row/2+4}" class="value">${esc(formatValue(r.value))}</text></g>`; }).join('');
  const svg=`<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="group" aria-label="${esc(title)}"><line x1="${L}" x2="${L}" y1="0" y2="${H}" stroke="${INK.axis}" stroke-width="1"/>${marks}</svg>`;
  return frame(id,title,subtitle,svg,tableView(id,['Item',valueLabel],rows.map(r=>[r.label,formatValue(r.value)])));
}

// Stat tile: label (sentence case), value, optional note; tone only via icon + words, never colour alone.
export const statTile=(labelText,value,{note='',status=''}={})=>`<div class="stat"><small>${esc(labelText)}</small><strong>${esc(value)}</strong>${status?`<span class="status ${status}">${status==='critical'?'⚠':status==='warning'?'●':'✓'} ${esc(note)}</span>`:note?`<span class="muted">${esc(note)}</span>`:''}</div>`;

// One tooltip element shared by all charts; values lead, labels follow; inserted with textContent only.
export function bindCharts() {
  let tip=document.getElementById('chart-tip');
  if (!tip) { tip=document.createElement('div'); tip.id='chart-tip'; tip.setAttribute('role','tooltip'); tip.innerHTML='<strong></strong><span></span>'; document.body.append(tip); }
  tip.classList.remove('on');
  const show=(el,x,y)=>{ tip.querySelector('strong').textContent=el.dataset.tipValue; tip.querySelector('span').textContent=el.dataset.tipLabel; tip.style.left=`${Math.min(x+14,window.innerWidth-220)}px`; tip.style.top=`${y+14}px`; tip.classList.add('on'); el.classList.add('lift'); };
  const hide=el=>{ tip.classList.remove('on'); el?.classList.remove('lift'); };
  document.querySelectorAll('.chart .mark').forEach(el=>{
    el.addEventListener('pointermove',e=>show(el,e.clientX,e.clientY)); el.addEventListener('pointerleave',()=>hide(el));
    el.addEventListener('focus',()=>{ const r=el.getBoundingClientRect(); show(el,r.left+r.width/2,r.top); }); el.addEventListener('blur',()=>hide(el));
  });
  document.querySelectorAll('[data-chart-toggle]').forEach(b=>b.onclick=()=>{ const id=b.dataset.chartToggle, table=document.getElementById(`${id}-table`), plot=document.getElementById(`${id}-plot`), showTable=table.hidden; table.hidden=!showTable; plot.hidden=showTable; b.textContent=showTable?'Chart view':'Table view'; });
}
