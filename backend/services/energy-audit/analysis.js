// Energy audit maths. Pure functions: no database, no clock, no randomness, so every result is reproducible from its input.
//
//   Power      measured (kW, or V·I·PF, from the meter) or ESTIMATED from current only: kW = √3 · V_LL · I · PF with a
//              configured line voltage and an assumed power factor. Everything derived from an estimate is flagged.
//   SEC        kWh per kg of good product over the test window (idle and standby included).
//   Cycles     from a machine cycle signal (a counter in the samples) when there is one, otherwise from the power trace:
//              the period from the autocorrelation, the anchor from the steepest rise of the folded profile, each start
//              then tracked cycle to cycle by the strongest rising edge near where it is due. Cycles of odd length, with
//              holes, outside "running", or with a shape unlike the average are left out and counted.
//   Phases     the engineer's HMI template (names and seconds) laid on the average profile from the cycle start:
//              energy per phase = ∫P dt. Phases sum exactly to the cycle energy (a rest phase takes what the template leaves).
//   Drive      inferred from the profile (hold / cool / standby power relative to peak, power factor, harmonics), as a class
//              with confidence and evidence. Always overridable; "unknown" when the evidence does not separate the classes.
//   Savings    per-phase saving factors for the target drive (low / typical / high), editable, ASSUMPTIONS to be validated.
const SQRT3=Math.sqrt(3), H=3600000;
export const r=(n,d=3)=>n==null||!Number.isFinite(n)?null:Math.round(n*10**d)/10**d;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
export const median=a=>{ if (!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
export const percentile=(a,p)=>{ if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[clamp(Math.round(p*(s.length-1)),0,s.length-1)]; };

export const PUMP_TYPES=['fixed','variable','servo_hydraulic','all_electric','unknown'];
export const CATEGORIES=['close','lockup','injection','holding','charge','cooling','open','eject','other'];
// Phase names as they appear on a machine HMI (English and German) → category used for the saving factors.
export function guessCategory(name) {
  const n=String(name||'').toLowerCase();
  if (/lock[\s-]*up|zuhalt|verriegel|clamp(?!\s*open)|schließkraft|schliesskraft/.test(n)) return 'lockup';
  if (/unlock|entriegel|open|öffn|oeffn|offen/.test(n)) return 'open';
  if (/clos|schlie|zufahr/.test(n)) return 'close';
  if (/fill|inject|einspritz|füll|fuell/.test(n)) return 'injection';
  if (/hold|nachdruck|pack/.test(n)) return 'holding';
  if (/charg|dos|plast|screw|schnecke/.test(n)) return 'charge';
  if (/cool|kühl|kuehl/.test(n)) return 'cooling';
  if (/eject|auswerf|demould|entform/.test(n)) return 'eject';
  return 'other';
}

// ---------- Editable defaults (shown as indicative; companies replace them) ----------
export const DEFAULT_MATERIALS=['PP','PE-HD','PE-LD','PS','ABS','PC','PC/ABS','PA6','PA66','PET','PBT','POM','PMMA','PVC','TPE','SAN'];
// Indicative whole-machine SEC ranges in kWh per kg. NOT measured facts: general orders of magnitude for a machine of
// moderate size on a typical part, to be replaced with the company's own history or confirmed with the supplier.
export const DEFAULT_BENCHMARKS=[
  {driveType:'fixed',material:'',low:0.9,high:1.8,note:''},
  {driveType:'variable',material:'',low:0.7,high:1.3,note:''},
  {driveType:'servo_hydraulic',material:'',low:0.5,high:1.0,note:''},
  {driveType:'all_electric',material:'',low:0.4,high:0.8,note:''}];
// Share of a phase's measured energy saved by the target drive: [low, typical, high]. ASSUMPTIONS. They follow the shape of
// the three-drive comparison (the differences sit in holding and cooling, where a fixed pump keeps delivering at pressure
// while little flow is needed) and the retrofit savings suppliers commonly quote (roughly 20–60 % for a servo pump on a
// fixed-pump machine). They are not measurements and must be validated with the supplier before an investment decision.
const F=(close,lockup,injection,holding,charge,cooling,open,eject,other)=>({close,lockup,injection,holding,charge,cooling,open,eject,other});
export const DEFAULT_FACTORS={
  'fixed>servo':F([.20,.35,.50],[.15,.30,.45],[.10,.20,.30],[.40,.60,.75],[.15,.30,.45],[.45,.65,.80],[.20,.35,.50],[.15,.30,.45],[.20,.35,.50]),
  'fixed>variable':F([.10,.20,.30],[.10,.15,.25],[.05,.10,.20],[.25,.40,.55],[.10,.20,.30],[.30,.45,.60],[.10,.20,.30],[.10,.15,.25],[.10,.20,.30]),
  'variable>servo':F([.05,.15,.25],[.05,.10,.20],[.05,.10,.15],[.15,.30,.45],[.05,.15,.25],[.20,.35,.50],[.05,.15,.25],[.05,.10,.20],[.05,.15,.25])};
// Whole-machine fallback when there is no cycle map (interval data only): [low, typical, high] of the running energy.
export const DEFAULT_OVERALL={'fixed>servo':[.20,.35,.50],'fixed>variable':[.10,.20,.30],'variable>servo':[.10,.20,.30]};
export const TRANSITIONS={fixed:['variable','servo'],variable:['servo']};
export function checkTriple(v) { return Array.isArray(v)&&v.length===3&&v.every(x=>typeof x==='number'&&x>=0&&x<=0.95)&&v[0]<=v[1]&&v[1]<=v[2]; }

// ---------- Power ----------
export function sampleKw(s,meter={}) {
  if (s.kw!=null) return {kw:s.kw,est:false};
  if (s.amps!=null) {
    const v=s.volts??meter.voltage, pf=s.pf??meter.assumedPf;
    if (!(v>0)||!(pf>0)) return null;
    const kw=((meter.voltageBasis||'ll')==='ll'?SQRT3:3)*v*s.amps*pf/1000;
    return {kw,est:s.volts==null||s.pf==null};
  }
  return null;
}
// Rows (ts ascending) → series [{ts,kw,est,pf,kva,thd,cyc}]. Meters that only report a cumulative kWh counter give the
// interval average between two reports (a counter reset is skipped).
export function resolveSeries(rows,meter={}) {
  const out=[]; let prev=null;
  for (const s of rows) {
    let p=sampleKw(s,meter);
    if (!p&&s.kwh_total!=null&&prev&&s.ts>prev.ts&&s.kwh_total>=prev.kwh_total) p={kw:(s.kwh_total-prev.kwh_total)/((s.ts-prev.ts)/H),est:false};
    if (s.kwh_total!=null) prev={ts:s.ts,kwh_total:s.kwh_total};
    if (!p) continue;
    out.push({ts:s.ts,kw:p.kw,est:p.est,pf:s.pf??(s.kva>0?clamp(p.kw/s.kva,0,1):null),kva:s.kva??null,thd:s.thd??null,cyc:s.cyc??null});
  }
  return out;
}
export function medianDt(series) { const d=[]; for (let i=1;i<series.length;i++) { const x=series[i].ts-series[i-1].ts; if (x>0&&x<6*H) d.push(x); } return median(d); }

// ---------- Energy over a window ----------
// Dense series (median step ≤ 10 s) are integrated by the trapezoid rule; sparse ones (LoRaWAN reports) by holding each
// report over the interval before it. Intervals longer than 3 median steps (at least 5 s) are gaps and not counted.
export function segmentsOf(series,from,to,dt=medianDt(series)) {
  const mode=dt!=null&&dt<=10000?'trapezoid':'hold', maxGap=Math.max(5000,3*(dt||0)), segs=[]; let gapMs=0;
  for (let i=1;i<series.length;i++) {
    const p=series[i-1], q=series[i], d=q.ts-p.ts; if (d<=0) continue;
    const a=Math.max(p.ts,from), b=Math.min(q.ts,to); if (b<=a) continue;
    if (d>maxGap) { gapMs+=b-a; continue; }
    const f=x=>p.kw+(q.kw-p.kw)*(x-p.ts)/d, k0=mode==='hold'?q.kw:f(a), k1=mode==='hold'?q.kw:f(b);
    segs.push({a,b,k0,k1,est:p.est||q.est,pf:q.pf??p.pf??null,kva:q.kva??null,kwh:(k0+k1)/2*(b-a)/H});
  }
  return {segs,gapMs,mode};
}
// Energy of segments that falls inside the intervals [{a,b}] (pro rata by overlap).
export function energyInIntervals(segs,intervals) {
  let sum=0;
  for (const s of segs) { const len=s.b-s.a; if (len<=0) continue; let ov=0; for (const v of intervals) ov+=Math.max(0,Math.min(s.b,v.b)-Math.max(s.a,v.a)); sum+=s.kwh*Math.min(1,ov/len); }
  return sum;
}
export function summarize(series,from,to) {
  const dt=medianDt(series), {segs,gapMs,mode}=segmentsOf(series,from,to,dt);
  const kwh=segs.reduce((n,s)=>n+s.kwh,0), covered=segs.reduce((n,s)=>n+(s.b-s.a),0), estKwh=segs.filter(s=>s.est).reduce((n,s)=>n+s.kwh,0);
  const inWin=series.filter(s=>s.ts>=from&&s.ts<=to);
  let kvah=0, pfKwh=0; for (const s of segs) if (s.pf>0) { pfKwh+=s.kwh; kvah+=s.kwh/s.pf; }
  return {segs,mode,dt,kwh,coveredMs:covered,gapMs,coveragePct:to>from?covered/(to-from)*100:null,avgKw:covered?kwh/(covered/H):null,peakKw:inWin.length?Math.max(...inWin.map(s=>s.kw)):null,
    estimatedSharePct:kwh>0?estKwh/kwh*100:0,pf:kvah>0?pfKwh/kvah:null,pfCoveragePct:kwh>0?pfKwh/kwh*100:0,
    peakKva:(()=>{ const k=inWin.map(s=>s.kva??(s.pf>0?s.kw/s.pf:null)).filter(x=>x!=null); return k.length?Math.max(...k):null; })(),count:inWin.length};
}
// Highest average kVA over clock-aligned demand intervals (needs kVA or PF; else unity PF is assumed and flagged).
export function maxDemandKva(segs,intervalMin=15) {
  const len=intervalMin*60000, blocks=new Map(); let assumed=false;
  for (const s of segs) {
    const kvaFactor=s.pf>0?1/s.pf:(assumed=true,1), d=s.b-s.a; if (d<=0) continue;
    for (let b=Math.floor(s.a/len)*len; b<s.b; b+=len) { const o=Math.min(s.b,b+len)-Math.max(s.a,b); if (o>0) blocks.set(b,(blocks.get(b)||0)+s.kwh*kvaFactor*o/d); }
  }
  let best=null; for (const [b,kvah] of blocks) { const kva=kvah/(intervalMin/60); if (!best||kva>best.kva) best={kva,at:b}; }
  return best&&{kva:best.kva,atMs:best.at,pfAssumed:assumed};
}

// ---------- Cycle detection ----------
export function gridOf(series,from,to,g) {
  const gm=g*1000, n=Math.max(0,Math.floor((to-from)/gm)), sum=new Float64Array(n), cnt=new Uint16Array(n);
  for (const s of series) { if (s.ts<from) continue; const i=Math.floor((s.ts-from)/gm); if (i>=n) break; sum[i]+=s.kw; if (cnt[i]<65535) cnt[i]++; }
  const v=new Float64Array(n); for (let i=0;i<n;i++) v[i]=cnt[i]?sum[i]/cnt[i]:NaN;
  const maxFill=Math.max(3,Math.round(0.5/g));
  for (let i=0;i<n;) { if (!Number.isNaN(v[i])) { i++; continue; } let j=i; while (j<n&&Number.isNaN(v[j])) j++; if (j-i<=maxFill&&i>0&&j<n) for (let k=i;k<j;k++) v[k]=v[i-1]+(v[j]-v[i-1])*(k-i+1)/(j-i+1); i=j; }
  return {v,n,g,from};
}
function smooth(v,w) {
  if (w<=1) return Float64Array.from(v);
  const n=v.length, out=new Float64Array(n), h=w>>1;
  for (let i=0;i<n;i++) { let s=0,c=0; for (let k=Math.max(0,i-h);k<=Math.min(n-1,i+h);k++) if (!Number.isNaN(v[k])) { s+=v[k]; c++; } out[i]=c?s/c:NaN; }
  return out;
}
// e[i] = mean(x[i..i+m)) − mean(x[i−m..i)): the rise at i.
function edges(x,m) {
  const n=x.length, ps=new Float64Array(n+1), pc=new Int32Array(n+1);
  for (let i=0;i<n;i++) { const ok=!Number.isNaN(x[i]); ps[i+1]=ps[i]+(ok?x[i]:0); pc[i+1]=pc[i]+(ok?1:0); }
  const mean=(a,b)=>{ const c=pc[b]-pc[a]; return c?(ps[b]-ps[a])/c:NaN; }, e=new Float64Array(n);
  for (let i=m;i<n-m;i++) { const a=mean(i,i+m), b=mean(i-m,i); e[i]=Number.isNaN(a)||Number.isNaN(b)?0:a-b; }
  return e;
}
// Dominant period (seconds) of the trace, or null. Works on a coarse copy so a 10 Hz trace stays cheap.
export function findPeriod(grid,{minS=4,maxS=300}={}) {
  const f=Math.max(1,Math.round(0.5/grid.g)), cg=grid.g*f, cn=Math.min(40000,Math.floor(grid.n/f)), x=new Float64Array(cn);
  let mean=0, c=0;
  for (let i=0;i<cn;i++) { let s=0,k=0; for (let j=0;j<f;j++) { const y=grid.v[i*f+j]; if (!Number.isNaN(y)) { s+=y; k++; } } x[i]=k?s/k:NaN; if (k) { mean+=x[i]; c++; } }
  if (!c) return null; mean/=c; let e0=0; for (let i=0;i<cn;i++) { x[i]=Number.isNaN(x[i])?0:x[i]-mean; e0+=x[i]*x[i]; }
  if (e0<=1e-9) return null;
  const minL=Math.max(2,Math.ceil(minS/cg)), maxL=Math.min(Math.floor(maxS/cg),Math.floor(cn/3)); if (maxL<=minL+2) return null;
  const rr=new Float64Array(maxL+2);
  for (let L=minL-1;L<=maxL+1;L++) { let s=0; for (let i=0;i+L<cn;i++) s+=x[i]*x[i+L]; rr[L]=s/(cn-L)/(e0/cn); }
  const peaks=[]; for (let L=minL;L<=maxL;L++) if (rr[L]>rr[L-1]&&rr[L]>=rr[L+1]) peaks.push(L);
  if (!peaks.length) return null;
  const best=Math.max(...peaks.map(L=>rr[L])); if (best<0.25) return {periodS:null,strength:best};
  const L=peaks.find(l=>rr[l]>=0.85*best), den=rr[L-1]-2*rr[L]+rr[L+1], frac=den<0?clamp(0.5*(rr[L-1]-rr[L+1])/den,-1,1):0;
  return {periodS:(L+frac)*cg,strength:rr[L]};
}
const corr=(a,b,n)=>{ let sa=0,sb=0; for (let i=0;i<n;i++) { sa+=a[i]; sb+=b[i]; } sa/=n; sb/=n; let sab=0,saa=0,sbb=0; for (let i=0;i<n;i++) { const x=a[i]-sa,y=b[i]-sb; sab+=x*y; saa+=x*x; sbb+=y*y; } return saa>0&&sbb>0?sab/Math.sqrt(saa*sbb):0; };

// Cycle starts (grid indexes) tracked through the trace.
function trackStarts(grid,period) {
  const g=grid.g, sw=Math.max(1,Math.round(0.3/g))|1, x=smooth(grid.v,sw), m=Math.max(2,Math.round(0.5/g)), e=edges(x,m), n=grid.n, Tb=period/g, w=Math.round(0.25*Tb);
  // First anchor: fold the coarse trace over the period; the steepest rise is the anchor.
  const f=Math.max(1,Math.round(0.5/g)), cg=g*f, Tc=period/cg, B=Math.max(8,Math.round(Tc)), sum=new Float64Array(B), cnt=new Int32Array(B);
  for (let i=0;i<Math.floor(n/f);i++) { let s=0,k=0; for (let j=0;j<f;j++) { const y=x[i*f+j]; if (!Number.isNaN(y)) { s+=y; k++; } } if (!k) continue; const ph=i-Math.floor(i/Tc)*Tc, b=Math.min(B-1,Math.floor(ph/Tc*B)); sum[b]+=s/k; cnt[b]++; }
  const fold=Array.from(sum,(s,i)=>cnt[i]?s/cnt[i]:0); let bestB=0,bestE=-Infinity;
  for (let b=0;b<B;b++) { const nx=(fold[(b+1)%B]+fold[(b+2)%B])/2, pv=(fold[(b-1+B)%B]+fold[(b-2+B)%B])/2; if (nx-pv>bestE) { bestE=nx-pv; bestB=b; } }
  const first=Math.round(bestB*(period/B)/g);
  const peakIn=(lo,hi)=>{ lo=Math.max(m,Math.round(lo)); hi=Math.min(n-m-1,Math.round(hi)); let bi=-1,bv=-Infinity; for (let i=lo;i<=hi;i++) if (e[i]>bv) { bv=e[i]; bi=i; } return bi<0?null:bi; };
  const maxes=[]; for (let k=0;first+k*Tb<n-Tb;k++) { const j=peakIn(first+k*Tb-w,first+k*Tb+w); if (j!=null) maxes.push(e[j]); }
  const ref=median(maxes); if (!(ref>0)) return {starts:[],edgeRef:0};
  const thr=0.4*ref;
  const scan=from=>{ for (let j=Math.max(m+1,Math.round(from));j<n-m-1;j++) if (e[j]>=0.7*ref&&e[j]>=e[j-1]&&e[j]>=e[j+1]) { const k=peakIn(j,j+Math.round(1/g)); return k; } return null; };
  const starts=[]; let cur=null; { const j=peakIn(first-w,first+w); cur=j!=null&&e[j]>=thr?j:scan(first); }
  while (cur!=null&&cur<n-m-1) {
    starts.push(cur); const exp=cur+Tb, j=peakIn(exp-w,exp+w);
    if (j!=null&&e[j]>=thr&&j>cur+0.5*Tb) cur=j; else { cur=scan(exp+w); if (cur!=null&&cur<=starts[starts.length-1]) break; }
  }
  return {starts,edgeRef:ref};
}

function buildProfile(grid,cycles,Tmed) {
  const g=grid.g, K=Math.max(2,Math.round(Tmed/g)), sum=new Float64Array(K), cnt=new Int32Array(K), mn=new Float64Array(K).fill(Infinity), mx=new Float64Array(K).fill(-Infinity);
  for (const c of cycles) for (let k=0;k<K&&c.a+k<c.b;k++) { const y=grid.v[c.a+k]; if (Number.isNaN(y)) continue; sum[k]+=y; cnt[k]++; if (y<mn[k]) mn[k]=y; if (y>mx[k]) mx[k]=y; }
  const mean=Float64Array.from(sum,(s,i)=>cnt[i]?s/cnt[i]:0);
  return {g,K,mean,min:Float64Array.from(mn,(x,i)=>cnt[i]?x:0),max:Float64Array.from(mx,(x,i)=>cnt[i]?x:0),cycleKwh:mean.reduce((n,x)=>n+x,0)*g/3600};
}
const cycleKwhOf=(grid,c)=>{ let s=0,k=0; for (let i=c.a;i<c.b;i++) { const y=grid.v[i]; if (!Number.isNaN(y)) { s+=y; k++; } } return k?s*(c.b-c.a)/k*grid.g/3600:0; };

// series: [{ts,kw,cyc?}] for the window. opts: idealS, running (intervals [{a,b}] ms or null), offsetS, maxBins
export function detectCycles(series,from,to,opts={}) {
  const dt=medianDt(series); if (dt==null||dt>5000) return {ok:false,reason:'resolution',medianDtMs:dt};
  const g=clamp(Math.round(dt/100)/10,0.1,2);
  const span=Math.min(to-from,Math.floor((opts.maxBins||200000)*g*1000)); const grid=gridOf(series,from,from+span,g);
  const valid=grid.v.filter(x=>!Number.isNaN(x)).length; if (valid<grid.n*0.3||grid.n<40) return {ok:false,reason:'data',medianDtMs:dt};
  // Signal path: a cycle counter in at least 80 % of the samples that increments at least 3 times.
  const withCyc=series.filter(s=>s.cyc!=null);
  let method='trace', period=null, strength=null, startsIdx=null;
  if (withCyc.length>=0.8*series.length) {
    const idx=[]; for (let i=1;i<withCyc.length;i++) if (withCyc[i].cyc>withCyc[i-1].cyc&&withCyc[i].ts>=from&&withCyc[i].ts<from+span) idx.push(Math.floor((withCyc[i].ts-from)/(g*1000)));
    if (idx.length>=4) { method='signal'; startsIdx=idx; period=median(idx.slice(1).map((x,i)=>(x-idx[i])*g)); }
  }
  if (method==='trace') {
    const sm=smooth(grid.v,Math.max(1,Math.round(1/g))|1), tmp={...grid,v:sm};
    const lo=opts.idealS?Math.max(2,0.5*opts.idealS):4, hi=opts.idealS?Math.min(300,2*opts.idealS):300;
    let p=findPeriod(tmp,{minS:lo,maxS:hi}); if ((!p||!p.periodS)&&opts.idealS) p=findPeriod(tmp,{minS:4,maxS:300});
    if (!p||!p.periodS) return {ok:false,reason:'no_cycle',medianDtMs:dt,strength:p?.strength??null};
    period=p.periodS; strength=p.strength;
    const tr=trackStarts(grid,period); if (tr.starts.length<3) return {ok:false,reason:'no_cycle',medianDtMs:dt,strength};
    startsIdx=tr.starts;
  }
  const off=Math.round((opts.offsetS||0)/g); if (off) startsIdx=startsIdx.map(i=>i+off).filter(i=>i>=0&&i<grid.n);
  // Candidate cycles between consecutive starts; the typical length is the median of those near the first estimate.
  const raw=[]; for (let i=0;i+1<startsIdx.length;i++) raw.push({a:startsIdx[i],b:startsIdx[i+1]});
  const near=raw.filter(c=>(c.b-c.a)*g>=0.6*period&&(c.b-c.a)*g<=1.4*period).map(c=>(c.b-c.a)*g);
  const Tmed=median(near)||period, lowF=method==='signal'?0.5:0.8, highF=method==='signal'?1.5:1.2, rejected={length:0,holes:0,notRunning:0,shape:0};
  let acc=[];
  for (const c of raw) {
    const d=(c.b-c.a)*g; if (d<lowF*Tmed||d>highF*Tmed) { rejected.length++; continue; }
    let nan=0; for (let i=c.a;i<c.b;i++) if (Number.isNaN(grid.v[i])) nan++; if (nan>0.05*(c.b-c.a)) { rejected.holes++; continue; }
    if (opts.running) { const a=from+c.a*g*1000, b=from+c.b*g*1000; if (!opts.running.some(v=>v.a<=a+g*1000&&v.b>=b-g*1000)) { rejected.notRunning++; continue; } }
    acc.push(c);
  }
  if (acc.length>=6) {
    const prof=buildProfile(grid,acc,Tmed), keep=acc.filter(c=>{ const len=Math.min(prof.K,c.b-c.a), tmp=new Float64Array(len); for (let i=0;i<len;i++) tmp[i]=Number.isNaN(grid.v[c.a+i])?prof.mean[i]:grid.v[c.a+i]; return corr(tmp,prof.mean,len)>=0.5; });
    rejected.shape=acc.length-keep.length; if (keep.length>=3) acc=keep;
  }
  if (acc.length<3) return {ok:false,reason:'no_cycle',medianDtMs:dt,strength,accepted:acc.length};
  const durations=acc.map(c=>(c.b-c.a)*g), T=median(durations), prof=buildProfile(grid,acc,T);
  const cycles=acc.map(c=>({a:c.a,b:c.b,startMs:from+c.a*g*1000,durationS:(c.b-c.a)*g,kwh:cycleKwhOf(grid,c)}));
  const meanD=durations.reduce((n,x)=>n+x,0)/durations.length, sd=Math.sqrt(durations.reduce((n,x)=>n+(x-meanD)**2,0)/durations.length);
  return {ok:true,method,stepS:g,medianDtMs:dt,periodS:r(period,2),acfStrength:r(strength,2),cycleTimeS:r(T,2),meanS:r(meanD,2),cv:r(sd/meanD,4),count:cycles.length,candidates:raw.length,rejected,
    truncated:span<to-from,cycles,profile:prof,grid,resolutionS:g};
}

// ---------- Phases ----------
const binIntegral=(arr,g,a,b)=>{ let s=0; const k0=Math.floor(a/g), k1=Math.min(arr.length-1,Math.ceil(b/g)-1); for (let k=Math.max(0,k0);k<=k1;k++) { const o=Math.min(b,(k+1)*g)-Math.max(a,k*g); if (o>0) s+=arr[k]*o; } return s/3600; };
export function normalizePhases(phases,Tcyc) {
  const out=[]; let t=0, truncated=false;
  for (const p of phases||[]) {
    const a=t, b=Math.min(t+p.seconds,Tcyc); t+=p.seconds;
    if (a>=Tcyc-1e-9) { truncated=true; continue; } if (b<t-1e-9) truncated=true;
    out.push({name:p.name,category:p.category||guessCategory(p.name),startS:a,endS:b,seconds:p.seconds});
  }
  if (Tcyc-Math.min(t,Tcyc)>1e-6) out.push({name:'',category:'other',startS:Math.min(t,Tcyc),endS:Tcyc,seconds:Tcyc-Math.min(t,Tcyc),unassigned:true});
  return {phases:out,truncated};
}
const WASTE_CATS=['holding','cooling'];
export function phaseBreakdown(det,phases,drive) {
  const {profile:prof,grid,cycles}=det, g=prof.g, Tcyc=prof.K*g, norm=normalizePhases(phases,Tcyc);
  const total=prof.cycleKwh, peak=percentile(Array.from(prof.mean),0.95)||0;
  const out=norm.phases.map(p=>{
    const kwh=binIntegral(prof.mean,g,p.startS,p.endS), per=cycles.map(c=>{ let s=0; for (let k=Math.floor(p.startS/g);k<Math.ceil(p.endS/g)&&c.a+k<c.b;k++) { const y=grid.v[c.a+k]; if (!Number.isNaN(y)) s+=y*(Math.min(p.endS,(k+1)*g)-Math.max(p.startS,k*g)); } return s/3600; });
    const dur=p.endS-p.startS, avgKw=dur>0?kwh*3600/dur:0; let pk=0; for (let k=Math.floor(p.startS/g);k<Math.ceil(p.endS/g)&&k<prof.K;k++) pk=Math.max(pk,prof.mean[k]);
    const plateau=peak>0?avgKw/peak:0;
    return {name:p.name,category:p.category,unassigned:!!p.unassigned,startS:r(p.startS,2),endS:r(p.endS,2),seconds:r(dur,2),kwh:kwh,pct:total>0?kwh/total*100:0,avgKw:avgKw,peakKw:pk,kwhMin:Math.min(...per),kwhMax:Math.max(...per),plateauRatio:r(plateau,3),
      waste:null};
  });
  return {phases:out,truncated:norm.truncated,sumKwh:out.reduce((n,p)=>n+p.kwh,0),cycleKwh:total};
}

// ---------- Drive inference and inefficiency ----------
const trap=(x,a,b,c,d)=>x<=a||x>=d?0:x>=b&&x<=c?1:x<b?(x-a)/(b-a):(d-x)/(d-c);
// Expected relative levels per class (power relative to the cycle's 95th-percentile peak). Qualitative ASSUMPTIONS taken from the
// shape of the three-drive comparison, not fitted to data.
export const REFERENCE_SHAPES={
  hold:{fixed:[0.5,0.65,1.1,1.5],variable:[0.25,0.35,0.6,0.75],efficient:[-1,0,0.35,0.5]},
  cool:{fixed:[0.3,0.4,0.9,1.2],variable:[0.15,0.25,0.4,0.5],efficient:[-1,0,0.2,0.3]},
  floor:{fixed:[0.25,0.35,0.9,1.2],variable:[0.12,0.2,0.4,0.5],efficient:[-1,0,0.15,0.25]},
  standby:{fixed:[0.2,0.3,0.9,1.2],variable:[0.08,0.15,0.35,0.45],efficient:[-1,0,0.1,0.2]},
  pf:{fixed:[0,0,0.75,0.85],variable:[0.6,0.7,0.85,0.92],efficient:[0.8,0.9,1,1.05]},
  thd:{fixed:[-1,0,15,30],variable:[-1,0,15,30],efficient:[20,35,200,300]}};
const wavg=(ph,cat,key)=>{ const l=ph.filter(p=>p.category===cat&&!p.unassigned); const t=l.reduce((n,p)=>n+p.seconds,0); return t>0?l.reduce((n,p)=>n+p[key]*p.seconds,0)/t:null; };
export function inferDrive({profile,phases,standbyKw,pfLow,thd}) {
  const peak=percentile(Array.from(profile.mean),0.95), floor=percentile(Array.from(profile.mean),0.05);
  if (!(peak>0)) return {class:'unknown',level:'none',confidence:0,evidence:[],reason:'no_profile'};
  const hold=phases?wavg(phases,'holding','avgKw'):null, cool=phases?wavg(phases,'cooling','avgKw'):null;
  const feats=[['hold',hold==null?null:hold/peak,2],['cool',cool==null?null:cool/peak,2],['floor',floor/peak,1],['standby',standbyKw==null?null:standbyKw/peak,1],['pf',pfLow??null,1],['thd',thd??null,0.5]].filter(f=>f[1]!=null);
  const classes=['fixed','variable','efficient'], score=Object.fromEntries(classes.map(c=>[c,0])), wsum=feats.reduce((n,f)=>n+f[2],0);
  for (const [k,v,w] of feats) for (const c of classes) score[c]+=w*trap(v,...REFERENCE_SHAPES[k][c])/wsum;
  const ranked=classes.slice().sort((a,b)=>score[b]-score[a]), s1=score[ranked[0]], s2=score[ranked[1]];
  const evidence=feats.map(([k,v])=>({key:k,value:r(v,3),supports:classes.filter(c=>trap(v,...REFERENCE_SHAPES[k][c])>0.5)}));
  const strongFeatures=feats.filter(f=>['hold','cool'].includes(f[0])).length;
  let cls=ranked[0], conf=clamp((s1-s2)/0.4,0,1)*Math.min(1,s1/0.6);
  if (wsum<2||s1<0.4||s1-s2<0.08) cls='unknown';
  const level=cls==='unknown'?'none':conf>=0.5&&strongFeatures>=2?'high':conf>=0.25?'medium':'low';
  return {class:cls,level,confidence:r(conf,2),scores:Object.fromEntries(classes.map(c=>[c,r(score[c],2)])),evidence,peakKw:r(peak,2),floorKw:r(floor,2),
    ambiguous:cls==='unknown'&&s1>=0.3?ranked.slice(0,2):null,reason:cls==='unknown'?(wsum<2?'little_evidence':'not_separable'):null};
}
// How much of the cycle energy is spent above the standby level in phases where little work is done (holding, cooling, dwell).
// Independent of any drive label. Without a phase template the part of the cycle after the power peak stands in for it.
export function inefficiency({profile,phases,standbyKw}) {
  const base=standbyKw??percentile(Array.from(profile.mean),0.05)??0, total=profile.cycleKwh*3600;
  if (!(total>0)) return null;
  let excess=0, share=0, time=0, Tc=profile.K*profile.g;
  if (phases) for (const p of phases) { if (!['holding','cooling','other'].includes(p.category)) continue; share+=p.kwh; time+=p.seconds; excess+=Math.max(0,p.avgKw-base)*p.seconds; }
  else { let pk=0; for (let k=1;k<profile.K;k++) if (profile.mean[k]>profile.mean[pk]) pk=k; for (let k=pk;k<profile.K;k++) { share+=profile.mean[k]*profile.g/3600; excess+=Math.max(0,profile.mean[k]-base)*profile.g; } time=(profile.K-pk)*profile.g; }
  return {scorePct:r(excess/total*100,1),lowWorkEnergySharePct:r(share/profile.cycleKwh*100,1),lowWorkTimeSharePct:r(time/Tc*100,1),baseKw:r(base,2),basis:phases?'phases':'tail'};
}

// ---------- Savings and payback ----------
export function startingDrive({override,nameplatePump,inferred}) {
  const cls=p=>p==='fixed'?'fixed':p==='variable'?'variable':['servo_hydraulic','all_electric','efficient'].includes(p)?'efficient':null;
  if (cls(override)) return {class:cls(override),source:'override'};
  if (cls(nameplatePump)) return {class:cls(nameplatePump),source:'nameplate'};
  if (inferred&&inferred.class!=='unknown'&&inferred.level!=='low') return {class:inferred.class,source:'inferred'};
  return {class:'unknown',source:null};
}
const scen=['low','typical','high'];
function costs({annualKwh,rate,co2,cost,years}) {
  const money=rate!=null?annualKwh*rate:null;
  return {annualKwh,annualMoney:money,annualCo2Kg:co2!=null?annualKwh*co2:null,paybackYears:cost>0&&money>0?cost/money:null,netYears:cost!=null&&money!=null?money*years-cost:null};
}
// phases: from phaseBreakdown (or null → whole mode); returns options per applicable target.
export function proposal({drive,phases,cycleKwh,cycleTimeS,kgPerCycle,sec,wholeKwhPerHour,assumptions={},factors=DEFAULT_FACTORS,overall=DEFAULT_OVERALL,price={},inefficiencyPct}) {
  const A={annualHours:assumptions.annualHours??4000,fixedLoadKw:assumptions.fixedLoadKw??0,retrofitCost:assumptions.retrofitCost??null,years:assumptions.years??5};
  if (drive.class==='unknown') return {status:'unknown_drive',assumptions:A};
  if (drive.class==='efficient') return {status:'efficient',startsFrom:drive,assumptions:A,remaining:null};
  const targets=TRANSITIONS[drive.class], options=[];
  for (const target of targets) {
    const key=`${drive.class}>${target}`, f=factors[key]||DEFAULT_FACTORS[key], mode=phases&&cycleKwh>0&&cycleTimeS>0?'phase':'whole', rows=[];
    for (let i=0;i<3;i++) {
      let fraction, savedPerCycle=null, annualKwh;
      if (mode==='phase') {
        savedPerCycle=phases.reduce((n,p)=>n+(f[p.category]||f.other)[i]*Math.max(0,p.kwh-A.fixedLoadKw*p.seconds/3600),0);
        fraction=savedPerCycle/cycleKwh; annualKwh=savedPerCycle*A.annualHours*3600/cycleTimeS;
      } else { fraction=(overall[key]||DEFAULT_OVERALL[key])[i]; annualKwh=(wholeKwhPerHour||0)*A.annualHours*fraction; }
      const kwhPerKgSaved=mode==='phase'&&kgPerCycle>0?savedPerCycle/kgPerCycle:sec!=null?fraction*sec:null;
      rows.push({scenario:scen[i],fraction,savedPerCycleKwh:savedPerCycle,kwhPerKgSaved,secAfter:sec!=null&&kwhPerKgSaved!=null?Math.max(0,sec-kwhPerKgSaved):null,...costs({annualKwh,rate:price.rate,co2:price.co2,cost:A.retrofitCost,years:A.years})});
    }
    options.push({target,key,mode,factors:f,scenarios:rows});
  }
  return {status:'ok',startsFrom:drive,assumptions:A,options,notes:{demandChargeNotIncluded:true,noDiscounting:true,fixedLoadExcluded:A.fixedLoadKw>0},inefficiencyPct};
}
// What is left to gain when the drive is already efficient.
export function remainingOpportunities({phases,idle,pf,cycleTimeS,idealS,standbyKw}) {
  const out=[];
  if (idle&&idle.sharePct>=10) out.push({code:'standby',value:r(idle.sharePct,1)});
  if (standbyKw!=null&&idle) out.push({code:'standby_power',value:r(standbyKw,2)});
  const cool=phases&&phases.filter(p=>p.category==='cooling').reduce((n,p)=>n+p.seconds,0);
  if (cool&&cycleTimeS&&cool/cycleTimeS>0.45) out.push({code:'long_cooling',value:r(cool/cycleTimeS*100,0)});
  if (pf!=null&&pf<0.9) out.push({code:'low_pf',value:r(pf,2)});
  if (idealS&&cycleTimeS&&cycleTimeS>idealS*1.05) out.push({code:'slow_cycle',value:r((cycleTimeS/idealS-1)*100,1)});
  return out;
}

// ---------- Benchmark, advice, confidence ----------
export function benchmarkPosition(sec,driveClass,material,table=DEFAULT_BENCHMARKS) {
  if (sec==null) return null;
  const type=driveClass==='efficient'?'servo_hydraulic':driveClass==='unknown'?null:driveClass; if (!type) return null;
  const row=table.find(b=>b.driveType===type&&b.material&&b.material===material)||table.find(b=>b.driveType===type&&!b.material); if (!row) return null;
  const position=sec<row.low?'below':sec>row.high?'above':'within';
  return {driveType:row.driveType,material:row.material||null,low:row.low,high:row.high,position,rangePct:r((sec-row.low)/(row.high-row.low)*100,0),indicative:true};
}
export function pathAdvice({measures,intervalMs,observedMs=null,transport=null}) {
  const ms=observedMs??intervalMs, resolution=ms<=250?'fine':ms<=2000?'good':ms<=5000?'coarse':'interval';
  return {measures,intervalMs:r(ms,0),resolution,sec:true,cycleMap:resolution==='fine'||resolution==='good'?'yes':resolution==='coarse'?'limited':'no',power:measures==='current'?'estimated':'measured',phaseEdgesS:ms<=2000?r(Math.max(ms*2,200)/1000,1):null,transport,observed:observedMs!=null};
}
export function confidence({cycle,power,coveragePct,hours,templateOk,mode,drive}) {
  const why=[]; let pts=6;
  const hit=(cond,cost,code,params={})=>{ if (cond) { pts-=cost; why.push({code,...params}); } };
  hit(!cycle,3,'no_cycle_map'); hit(cycle&&cycle.resolutionS>0.5,1,'coarse_resolution',{s:cycle?.resolutionS}); hit(cycle&&cycle.resolutionS>2,1,'coarse_resolution_2');
  hit(power==='estimated',1,'estimated_power'); hit(power==='mixed',0.5,'mixed_power');
  hit(cycle&&cycle.count<10,2,'few_cycles',{n:cycle?.count}); hit(cycle&&cycle.count>=10&&cycle.count<30,1,'some_cycles',{n:cycle?.count});
  hit(hours!=null&&hours<0.5,1,'short_test',{h:hours}); hit(coveragePct!=null&&coveragePct<90,1,'gaps',{pct:r(coveragePct,0)});
  hit(cycle&&cycle.cv>0.1,1,'irregular_cycles'); hit(cycle&&!templateOk,1,'no_template'); hit(drive&&(drive.class==='unknown'),1,'drive_unknown');
  return {level:pts>=5?'high':pts>=3?'medium':'low',points:r(pts,1),reasons:why};
}
export const trimTrace=(series,from,to,max=480)=>{
  const s=series.filter(x=>x.ts>=from&&x.ts<=to); if (s.length<=max) return s.map(x=>[x.ts,r(x.kw,2)]);
  const step=(to-from)/max, out=[]; let i=0;
  for (let b=0;b<max;b++) { const lo=from+b*step, hi=lo+step; let sum=0,c=0; while (i<s.length&&s[i].ts<hi) { sum+=s[i].kw; c++; i++; } if (c) out.push([Math.round(lo+step/2),r(sum/c,2)]); }
  return out;
};
export const decimate=(arr,max=600)=>{ if (arr.length<=max) return Array.from(arr,x=>r(x,2)); const f=Math.ceil(arr.length/max), out=[]; for (let i=0;i<arr.length;i+=f) { let s=0,c=0; for (let j=i;j<Math.min(arr.length,i+f);j++) { s+=arr[j]; c++; } out.push(r(s/c,2)); } return out; };

// Standby power between runs: the median of flat, low stretches at least 0.8 cycle times (and 20 s) long. Null when the trace has none.
export function findStandby(grid,periodS,peakKw) {
  const g=grid.g, minBins=Math.ceil(Math.max(20,0.8*periodS)/g), x=smooth(grid.v,Math.max(1,Math.round(1/g))|1), vals=[];
  for (let i=0;i<x.length;) {
    if (Number.isNaN(x[i])||x[i]>0.4*peakKw) { i++; continue; }
    let j=i+1; const ref=x[i]; while (j<x.length&&!Number.isNaN(x[j])&&Math.abs(x[j]-ref)<=0.2*Math.max(ref,1)) j++;
    if (j-i>=minBins) for (let k=i;k<j;k++) vals.push(x[k]); i=j;
  }
  return vals.length>=minBins?median(vals):null;
}
const pfIn=(segs,iv)=>{ let k=0,v=0; for (const s of segs) { if (!(s.pf>0)) continue; const len=s.b-s.a; let ov=0; for (const x of iv) ov+=Math.max(0,Math.min(s.b,x.b)-Math.max(s.a,x.a)); const e=s.kwh*Math.min(1,ov/len); k+=e; v+=e/s.pf; } return v>0?k/v:null; };
// Waste flags depend on the drive in effect (override, nameplate or inferred), so they are set when a result is presented.
export function markWaste(rows,driveClass) {
  const peak=Math.max(0,...rows.map(p=>p.peakKw||0));
  return rows.map(p=>({...p,waste:['holding','cooling'].includes(p.category)&&['fixed','variable'].includes(driveClass)&&p.plateauRatio>=(p.category==='holding'?0.5:0.35)?{reason:p.category==='holding'?'hold':'cool',drive:driveClass}:null}));
}
// ---------- Orchestrator ----------
// input: {fromMs,toMs, series (resolved samples, may extend beyond the window) | readings, states, output, product, phases, nameplate, assumptions, idealS, standbyOverride}
export function analyseWindow(input) {
  const {fromMs:from,toMs:to}=input, hours=(to-from)/H;
  let sum, series=null, source;
  if (input.series) { series=input.series; sum=summarize(series,from,to); source=input.source||'samples'; }
  else {
    const segs=(input.readings||[]).map(x=>{ const a=Date.parse(x.period_start), b=a+x.period_minutes*60000, o=Math.min(b,to)-Math.max(a,from); if (o<=0) return null; const kw=x.kwh/(x.period_minutes/60); return {a:Math.max(a,from),b:Math.min(b,to),k0:kw,k1:kw,est:false,pf:x.pf??null,kva:x.kva??null,kwh:x.kwh*o/(b-a)}; }).filter(Boolean);
    const kwh=segs.reduce((n,s)=>n+s.kwh,0), cov=segs.reduce((n,s)=>n+s.b-s.a,0), peaks=(input.readings||[]).map(x=>x.peak_kw).filter(x=>x!=null);
    let kvah=0, pfk=0; for (const s of segs) if (s.pf>0) { pfk+=s.kwh; kvah+=s.kwh/s.pf; }
    sum={segs,mode:'hold',dt:median((input.readings||[]).map(x=>x.period_minutes*60000)),kwh,coveredMs:cov,gapMs:0,coveragePct:cov/(to-from)*100,avgKw:cov?kwh/(cov/H):null,peakKw:peaks.length?Math.max(...peaks):(segs.length?Math.max(...segs.map(s=>s.k0)):null),estimatedSharePct:0,pf:kvah>0?pfk/kvah:null,peakKva:null,count:segs.length};
    source='readings';
  }
  const res={window:{fromMs:from,toMs:to,hours:r(hours,3)},data:{source,samples:sum.count,medianStepMs:sum.dt,coveragePct:r(sum.coveragePct,1),gapMin:r(sum.gapMs/60000,1),integration:sum.mode,
    power:sum.kwh>0?(sum.estimatedSharePct>=99?'estimated':sum.estimatedSharePct>1?'mixed':'measured'):null,estimatedSharePct:r(sum.estimatedSharePct,1)}};
  res.energy={kwh:r(sum.kwh,4),avgKw:r(sum.avgKw,3),peakKw:r(sum.peakKw,3),pf:r(sum.pf,3),pfCoveragePct:r(sum.pfCoveragePct,0),peakKva:r(sum.peakKva,3)};
  const dem=maxDemandKva(sum.segs,input.demandIntervalMin||15); res.energy.maxDemandKva=dem?{kva:r(dem.kva,2),atMs:dem.atMs,pfAssumed:dem.pfAssumed,intervalMin:input.demandIntervalMin||15}:null;
  // Output and SEC
  const out=input.output||{}; res.output={goodKg:r(out.goodKg,3),goodParts:out.goodParts??null,shots:out.shots??null,basis:out.basis||null};
  res.sec={kwhPerKg:out.goodKg>0&&sum.kwh>0?r(sum.kwh/out.goodKg,4):null,kwhPerPart:out.goodParts>0&&sum.kwh>0?r(sum.kwh/out.goodParts,5):null,kwhPerShot:out.shots>0&&sum.kwh>0?r(sum.kwh/out.shots,5):null};
  // Idle / standby
  const states=input.states; let idle=null, idleIv=null;
  if (states&&states.length) {
    const covered=states.reduce((n,s)=>n+Math.max(0,Math.min(s.b,to)-Math.max(s.a,from)),0);
    if (covered>=0.9*(to-from)) { idleIv=states.filter(s=>s.state!=='running').map(s=>({a:Math.max(s.a,from),b:Math.min(s.b,to)})).filter(v=>v.b>v.a); const k=energyInIntervals(sum.segs,idleIv), ms=idleIv.reduce((n,v)=>n+v.b-v.a,0); idle={kwh:r(k,4),sharePct:sum.kwh>0?r(k/sum.kwh*100,1):null,basis:'states',hours:r(ms/H,3),kw:ms>20000?r(k/(ms/H),3):null}; }
  }
  // Cycles
  let det=null, cycleOut=null, phases=null, drive=null, ineff=null;
  const running=states&&states.length?states.filter(s=>s.state==='running').map(s=>({a:s.a,b:s.b})):null;
  if (series&&series.length>20) det=detectCycles(series.filter(s=>s.ts>=from-5000&&s.ts<=to+5000),from,to,{idealS:input.idealS,running:running&&idle?running:null,offsetS:input.assumptions?.cycleOffsetS});
  if (det&&det.ok) {
    const spans=det.cycles.map(c=>({a:c.startMs,b:c.startMs+c.durationS*1000}));
    if (!idle) { const k=Math.max(0,sum.kwh-energyInIntervals(sum.segs,spans)), ms=Math.max(0,(to-from)-spans.reduce((n,v)=>n+v.b-v.a,0)); idle={kwh:r(k,4),sharePct:sum.kwh>0?r(k/sum.kwh*100,1):null,basis:'trace',hours:r(ms/H,3),kw:ms>20000?r(k/(ms/H),3):null}; }
    const prof=det.profile, tmplOk=!!(input.phases&&input.phases.length);
    if (idle&&idle.basis==='trace') idle.kw=r(findStandby(det.grid,det.cycleTimeS,percentile(Array.from(prof.mean),0.95)),3);
    const standby=idle?.kw??null;
    phases=tmplOk?phaseBreakdown(det,input.phases,null):null;
    let pfLow=null;
    if (phases) { const iv=[]; for (const c of det.cycles) for (const p of phases.phases) if (p.category==='cooling') iv.push({a:c.startMs+p.startS*1000,b:c.startMs+p.endS*1000}); pfLow=pfIn(sum.segs,iv); }
    drive=inferDrive({profile:prof,phases:phases?.phases,standbyKw:standby,pfLow,thd:input.thd??null});
    ineff=inefficiency({profile:prof,phases:phases?.phases,standbyKw:standby});
    cycleOut={method:det.method,resolutionS:det.resolutionS,stepS:det.stepS,periodS:det.periodS,acfStrength:det.acfStrength,cycleTimeS:det.cycleTimeS,meanS:det.meanS,cv:det.cv,count:det.count,candidates:det.candidates,rejected:det.rejected,truncated:det.truncated,
      idealS:input.idealS??null,vsIdealPct:input.idealS?r((det.cycleTimeS/input.idealS-1)*100,1):null,cycleKwh:r(prof.cycleKwh,5),avgCycleKw:r(prof.cycleKwh*3600/(prof.K*prof.g),3),
      cycleKwhMin:r(Math.min(...det.cycles.map(c=>c.kwh)),5),cycleKwhMax:r(Math.max(...det.cycles.map(c=>c.kwh)),5),
      profile:{stepS:prof.g,decimated:prof.K>600,mean:decimate(prof.mean),min:decimate(prof.min),max:decimate(prof.max),points:Math.min(prof.K,600),K:prof.K},
      starts:det.cycles.slice(0,400).map(c=>[c.startMs,r(c.durationS,2),r(c.kwh,5)]),pfCooling:r(pfLow,3)};
    res.drive=drive; res.inefficiency=ineff;
    if (phases) res.phases={rows:phases.phases.map(p=>({...p,kwh:r(p.kwh,5),pct:r(p.pct,2),avgKw:r(p.avgKw,3),peakKw:r(p.peakKw,3),kwhMin:r(p.kwhMin,5),kwhMax:r(p.kwhMax,5)})),truncated:phases.truncated,sumKwh:r(phases.sumKwh,5)};
  } else if (det) res.cycleFailure=det.reason;
  res.idle=idle; res.energy.standbyKw=idle?.kw??null;
  res.cycle=cycleOut; res.trace=series?trimTrace(series,from,to):[];
  return res;
}
