// Statistics for the mould process fingerprint. Pure functions, no database.
//
// Drift score: the standardised (Mahalanobis) distance of the recent operating point from the fingerprint's centre.
// Each setting is first expressed in "good-run standard deviations" (z = (recent median - good-run mean) / good-run sd,
// with a floor on the sd so a very steady setting does not alarm on a tiny change). The distance then also uses the
// correlations between settings learned from good runs, so a move that follows the usual coupling (for example melt
// temperature and injection pressure rising together) counts for less than the same move against it. The correlation
// matrix is shrunk 10 % towards the identity so it stays invertible with limited data.
// D = sqrt(z' R^-1 z). Each setting's contribution is z_i (R^-1 z)_i / D^2, and the contributions add up to 1.
import { median } from './stats.js';

export const round=(x,d=2)=>x==null||!Number.isFinite(x)?null:Math.round(x*10**d)/10**d;

export function quantile(sorted,q) {
  if (!sorted.length) return null;
  const pos=(sorted.length-1)*q, lo=Math.floor(pos), hi=Math.ceil(pos);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(pos-lo);
}
// Level and spread of a list of numbers.
export function summarise(values) {
  const n=values.length; if (!n) return null;
  const sorted=[...values].sort((a,b)=>a-b), mean=values.reduce((s,x)=>s+x,0)/n, sd=n>1?Math.sqrt(values.reduce((s,x)=>s+(x-mean)**2,0)/(n-1)):0;
  return {n,mean,sd,median:median(values),p05:quantile(sorted,0.05),p95:quantile(sorted,0.95),min:sorted[0],max:sorted[n-1]};
}
// Smallest spread used to standardise a setting: its good-run sd, but never less than 0.5 % of its level.
export const scaleOf=p=>Math.max(p.sd||0,0.005*Math.abs(p.mean||0),1e-6);
// Width of the good-run range of a setting (5th to 95th percentile); the unit for step sizes.
export const rangeOf=p=>{ const w=(p.p95??0)-(p.p05??0); return w>0?w:4*scaleOf(p); };

export function pearson(xs,ys) {
  const n=xs.length; if (n<8) return null;
  const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n; let sxx=0,syy=0,sxy=0;
  for (let i=0;i<n;i++) { sxx+=(xs[i]-mx)**2; syy+=(ys[i]-my)**2; sxy+=(xs[i]-mx)*(ys[i]-my); }
  return sxx>0&&syy>0?sxy/Math.sqrt(sxx*syy):0;
}

// Inverse of a small square matrix (Gauss-Jordan with partial pivoting); null when singular.
export function invert(M) {
  const n=M.length, A=M.map((row,i)=>[...row,...Array.from({length:n},(_,j)=>i===j?1:0)]);
  for (let c=0;c<n;c++) {
    let p=c; for (let r=c+1;r<n;r++) if (Math.abs(A[r][c])>Math.abs(A[p][c])) p=r;
    if (Math.abs(A[p][c])<1e-10) return null;
    [A[c],A[p]]=[A[p],A[c]];
    const d=A[c][c]; for (let j=0;j<2*n;j++) A[c][j]/=d;
    for (let r=0;r<n;r++) if (r!==c) { const f=A[r][c]; if (f) for (let j=0;j<2*n;j++) A[r][j]-=f*A[c][j]; }
  }
  return A.map(row=>row.slice(n));
}
// Correlation matrix of the given settings from the stored pairs, shrunk towards the identity.
export function correlationMatrix(keys,pairs,shrink=0.1) {
  const r=(a,b)=>a===b?1:(pairs.find(p=>(p.a===a&&p.b===b)||(p.a===b&&p.b===a))?.r??0);
  return keys.map(a=>keys.map(b=>a===b?1:(1-shrink)*r(a,b)));
}

export const LEVELS={warning:2,critical:4,resolveBelow:1.5};
export const levelOf=(score,th=LEVELS)=>score>=th.critical?'critical':score>=th.warning?'warning':'ok';

// Drift of a recent operating point. recent: {parameter: median value}. Returns null when fewer than one setting can be judged.
export function driftOf(fp,recent) {
  const keys=Object.keys(recent).filter(k=>fp.params[k]&&Number.isFinite(recent[k]));
  if (!keys.length) return null;
  const z=keys.map(k=>(recent[k]-fp.params[k].mean)/scaleOf(fp.params[k]));
  const inv=invert(correlationMatrix(keys,fp.correlations||[]));
  const w=inv?inv.map(row=>row.reduce((s,x,j)=>s+x*z[j],0)):z;
  const d2=Math.max(0,z.reduce((s,x,i)=>s+x*w[i],0)), score=Math.sqrt(d2);
  const rows=keys.map((k,i)=>{ const p=fp.params[k], delta=recent[k]-p.mean;
    return {parameter:k,recent:round(recent[k],3),centre:round(p.mean,3),sd:round(p.sd,3),delta:round(delta,3),z:round(z[i],2),pctOfRange:round(delta/rangeOf(p)*100,1),
      contribution:d2>1e-12?round(z[i]*w[i]/d2,3):0,low:round(p.p05,3),high:round(p.p95,3),outsideRange:recent[k]<p.p05||recent[k]>p.p95,moved:Math.abs(z[i])>=1}; })
    .sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution)||Math.abs(b.z)-Math.abs(a.z));
  return {score:round(score,2),parameters:rows};
}
