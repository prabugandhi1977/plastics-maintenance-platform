// Statistics for machine-learning insights. Pure functions, no database: robust baselines (median and MAD, so a few
// outliers do not distort "normal") and linear trends for remaining-time estimates. Every result carries the
// numbers behind it so a person can see why a machine was flagged.
export const median=xs=>{ if (!xs.length) return null; const s=[...xs].sort((a,b)=>a-b), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
// Median absolute deviation scaled to match a standard deviation for normally distributed data.
export const mad=(xs,med=median(xs))=>xs.length?1.4826*median(xs.map(x=>Math.abs(x-med))):null;
// Least-squares line through (x,y): slope per x unit, and R² (how well a straight line explains the points).
export function linearFit(points) {
  const n=points.length; if (n<3) return null;
  const mx=points.reduce((a,p)=>a+p.x,0)/n, my=points.reduce((a,p)=>a+p.y,0)/n;
  let sxx=0,sxy=0,syy=0; for (const p of points) { sxx+=(p.x-mx)**2; sxy+=(p.x-mx)*(p.y-my); syy+=(p.y-my)**2; }
  if (!sxx) return null;
  const slope=sxy/sxx; return {slope,intercept:my-slope*mx,r2:syy?sxy*sxy/(sxx*syy):0,at:x=>my+slope*(x-mx)};
}
const HOUR=3600000;

// Judge one signal. `points` are [{t (ms), v}] taken while the machine was running, oldest first.
// Baseline = the older part of the window; recent = the last `recentHours`. Unusual when the recent median sits far
// outside the baseline's normal spread. The noise floor stops a very steady signal from alarming on a tiny change.
export function assessSignal(points,{limit=null,recentHours=12,minBaseline=40,minRecent=8,threshold=4,now=Date.now()}={}) {
  const cut=now-recentHours*HOUR, base=points.filter(p=>p.t<cut).map(p=>p.v), recent=points.filter(p=>p.t>=cut).map(p=>p.v);
  if (base.length<minBaseline||recent.length<minRecent) return {status:'learning',baselinePoints:base.length,recentPoints:recent.length};
  const bm=median(base), rm=median(recent), spread=Math.max(mad(base,bm),0.02*Math.abs(bm),1e-6), score=(rm-bm)/spread;
  const out={status:Math.abs(score)>=threshold?'unusual':'normal',score:Math.round(score*10)/10,baseline:Math.round(bm*100)/100,recent:Math.round(rm*100)/100,spread:Math.round(spread*100)/100,direction:score>0?'up':'down'};
  // Trend over the last 48 h from hourly medians; only trusted when a line really fits.
  const buckets=new Map(); for (const p of points) if (p.t>=now-48*HOUR) { const k=Math.floor(p.t/HOUR); (buckets.get(k)||buckets.set(k,[]).get(k)).push(p.v); }
  const fit=linearFit([...buckets].map(([k,vs])=>({x:k,y:median(vs)})));
  if (fit&&buckets.size>=12&&fit.r2>=0.5&&Math.abs(fit.slope)*24>=spread*0.5) {
    out.slopePerDay=Math.round(fit.slope*24*100)/100; out.trendFit=Math.round(fit.r2*100)/100;
    const nowFit=fit.at(Math.floor(now/HOUR));
    const hoursTo=bound=>bound==null||(fit.slope>0)!==(bound>nowFit)?null:Math.max(0,Math.round((bound-nowFit)/fit.slope));
    if (limit) { const warn=fit.slope>0?limit.warn_high:limit.warn_low, crit=fit.slope>0?limit.crit_high:limit.crit_low; out.hoursToWarning=hoursTo(warn); out.hoursToCritical=hoursTo(crit); }
    if (out.hoursToCritical!=null&&out.hoursToCritical<=7*24) out.status='degrading';
  }
  return out;
}

// Judge a daily series (e.g. OEE) against its own history: the latest value versus the earlier days.
export function assessDaily(values,{minDays=6,threshold=3}={}) {
  if (values.length<minDays+1) return {status:'learning',days:values.length};
  const last=values.at(-1), base=values.slice(0,-1), bm=median(base), spread=Math.max(mad(base,bm),0.02,1e-6), score=(last-bm)/spread;
  return {status:score<=-threshold?'dropped':score>=threshold?'improved':'normal',score:Math.round(score*10)/10,baseline:bm,latest:last};
}
