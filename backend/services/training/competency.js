// Competency standing: whether a technician holds a current completion of each training a machine type requires.
// A completion counts until its expiry. Within WARN_DAYS of expiry it still counts but is reported as expiring.
// Missing or expired is a blocking reason where the requirement says "block", and a warning where it says "flag".
import { all, one } from '../../common/db.js';

export const WARN_DAYS=30;
const DAY=86400000;
const J=(v,d)=>{ try { return JSON.parse(v); } catch { return d; } };

// Expiry of a completion: the LMS's own date when it sends one, else completed_at plus the requirement's validity.
export function expiryOf(comp,completedAt,explicit=null) {
  if (explicit) return explicit;
  if (!comp.validity_months) return null;
  const d=new Date(completedAt); d.setUTCMonth(d.getUTCMonth()+Number(comp.validity_months));
  return d.toISOString();
}
export function statusOf(rec,at=Date.now()) {
  if (!rec) return 'missing';
  if (!rec.expires_at) return 'valid';
  const t=Date.parse(rec.expires_at);
  return t<=at?'expired':t-at<=WARN_DAYS*DAY?'expiring':'valid';
}
export const requires=(comp,machineType)=>{ const types=J(comp.machine_types,[]); return Boolean(comp.active)&&types.includes(machineType); };

// The newest completion of each competency for each of the given users: Map(userId -> Map(competencyId -> row)).
// "Newest" is the one that runs longest (no expiry beats any expiry), so a renewal replaces an older certificate.
export async function latestFor(userIds) {
  const out=new Map(userIds.map(u=>[u,new Map()]));
  if (!userIds.length) return out;
  const rows=await all(`SELECT * FROM user_competencies WHERE user_id IN (${userIds.map(()=>'?').join(',')})`,...userIds);
  const reach=r=>r.expires_at?Date.parse(r.expires_at):Infinity;
  for (const r of rows) { const m=out.get(r.user_id), cur=m.get(r.competency_id); if (!cur||reach(r)>reach(cur)||(reach(r)===reach(cur)&&r.completed_at>cur.completed_at)) m.set(r.competency_id,r); }
  return out;
}

// What stands between each user and work on a machine type: {blocking:[text], warnings:[text]} by user id.
export async function gapsFor(userIds,machineType,at=Date.now()) {
  const comps=(await all('SELECT * FROM competencies WHERE active=1 ORDER BY name')).filter(c=>requires(c,machineType));
  const latest=await latestFor(userIds), out=new Map();
  for (const u of userIds) {
    const blocking=[], warnings=[];
    for (const c of comps) {
      const rec=latest.get(u).get(c.id), s=statusOf(rec,at);
      if (s==='valid') continue;
      const text=s==='missing'?`${c.name} not on record`:s==='expired'?`${c.name} expired on ${rec.expires_at.slice(0,10)}`:`${c.name} expires on ${rec.expires_at.slice(0,10)}`;
      (s==='expiring'||c.enforcement==='flag'?warnings:blocking).push(text);
    }
    out.set(u,{blocking,warnings});
  }
  return out;
}

export const competencyByCode=async code=>await one('SELECT * FROM competencies WHERE code=?',String(code).trim().toUpperCase());
