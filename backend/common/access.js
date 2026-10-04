// Tenant-scoped data access and authorization helpers shared by route modules. Every lookup that takes an ID from a
// request goes through one of these, so a record from another tenant is refused before any handler logic runs.
import { id, now, one, all, run } from './db.js';
import { canCompany, canTicket, isCustomer, isPlatform, isProvider } from './security.js';
import { deny, missing } from './validate.js';

export const byId=(table,key)=>one(`SELECT * FROM ${table} WHERE id=?`,key);
export const audit=(u,action,type,entityId,companyId,detail={})=>run('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)',id(),u.id,companyId,action,type,entityId,JSON.stringify(detail),now());
export const ticketEvent=(ticketId,u,type,detail,at=now())=>run('INSERT INTO ticket_events VALUES (?,?,?,?,?,?)',id(),ticketId,u.id,type,detail,at);
export const isDispatch=u=>isPlatform(u)||u.role==='dispatcher';

export function getTicket(u,key) { const t=byId('tickets',key); if (!t) missing(); if (!canTicket(u,t)) deny(); return t; }
export function getEquipment(u,key) { const e=byId('equipment',key); if (!e) missing(); if (!canCompany(u,e.company_id)) deny(); return e; }
export function scope(u,table) {
  if (isDispatch(u)) return all(`SELECT * FROM ${table} ORDER BY created_at DESC`);
  if (isCustomer(u)) return all(`SELECT * FROM ${table} WHERE company_id=? ORDER BY created_at DESC`,u.company_id);
  return [];
}
export function visibleTickets(u) {
  if (isDispatch(u)) return all('SELECT * FROM tickets ORDER BY created_at DESC');
  if (isCustomer(u)) return all('SELECT * FROM tickets WHERE company_id=? ORDER BY created_at DESC',u.company_id);
  if (u.role==='engineer') return all('SELECT * FROM tickets WHERE assigned_user_id=? ORDER BY created_at DESC',u.id);
  if (isProvider(u)) return all('SELECT * FROM tickets WHERE assigned_provider_id=? ORDER BY created_at DESC',u.provider_id);
  return [];
}
export const isAssignee=(u,t)=>(u.role==='engineer'&&t.assigned_user_id===u.id)||(isProvider(u)&&t.assigned_provider_id===u.provider_id);
export const canService=(u,t)=>isDispatch(u)||isAssignee(u,t);
// Telemetry is visible to the owning company, or to an engineer/provider while they hold open work on that asset.
export function getAssetTelemetry(u,key) { const e=byId('equipment',key); if (!e) missing(); if (!canCompany(u,e.company_id)&&!visibleTickets(u).some(t=>t.equipment_id===e.id&&t.status!=='completed')) deny(); return e; }
