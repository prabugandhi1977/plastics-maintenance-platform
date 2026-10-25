// Shared by the operator tablet, the andon board, the desktop Andon page and the field app: labels for machine states,
// downtime and scrap reasons and andon call types, and the running timers shown beside open calls and stops.
import { t } from './i18n.js';

export const ANDON_TYPES=['maintenance','quality','material','supervisor','safety'];
export const ANDON_ICONS={maintenance:'🔧',quality:'🔍',material:'📦',supervisor:'👤',safety:'⛑'};
export const STATES=['running','idle','setup','down','planned_stop','offline'];
const key=(k,fallback)=>{ const s=t(k); return s===k?fallback:s; };
const humanise=v=>{ const s=String(v??'').replaceAll('_',' '); return s.charAt(0).toUpperCase()+s.slice(1); };
export const stateLabel=s=>key(`andon.state.${s}`,humanise(s));
export const reasonLabel=r=>r?key(`reason.${r}`,humanise(r)):'';
export const typeLabel=x=>key(`andon.type.${x}`,humanise(x));
export const callStatusLabel=s=>key(`andon.status.${s}`,humanise(s));
// Elapsed time since an ISO instant: m:ss under an hour, then h:mm.
export function elapsed(iso,at=Date.now()) {
  if (!iso) return '—';
  const s=Math.max(0,Math.floor((at-Date.parse(iso))/1000)), h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return h?`${h}:${String(m).padStart(2,'0')} h`:`${m}:${String(sec).padStart(2,'0')}`;
}
// Elements with data-since="<iso>" show the running time; call once per second.
export function tickTimers(root=document) { const at=Date.now(); root.querySelectorAll('[data-since]').forEach(el=>{ el.textContent=elapsed(el.dataset.since,at); }); }
export const minutes=v=>v==null?'—':`${Math.round(v*10)/10} min`;
