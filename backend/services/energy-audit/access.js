// Who may do what with energy audits. Everything is scoped to the audit's company.
//   read    platform admins, dispatchers (all companies) and the company's customer admin, plant manager, maintenance
//   write   platform admins and the company's customer admin, plant manager, maintenance (run audits, register meters)
//   manage  platform admins and the company's customer admin and plant manager (benchmark, factor and material tables)
import { byId } from '../../common/access.js';
import { canCompany, isPlatform } from '../../common/security.js';
import { deny, missing } from '../../common/validate.js';

export const canWrite=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager','maintenance'].includes(u.role)&&u.company_id===companyId);
export const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
export const canRead=(u,companyId)=>canCompany(u,companyId);
export async function auditFor(u,key,{write=false}={}) {
  const a=await byId('energy_audits',key); if (!a) missing();
  if (write?!canWrite(u,a.company_id):!canRead(u,a.company_id)) deny();
  return a;
}
export async function meterFor(u,key,{write=false}={}) {
  const m=await byId('energy_meters',key); if (!m) missing();
  if (write?!canWrite(u,m.company_id):!canRead(u,m.company_id)) deny();
  return m;
}
