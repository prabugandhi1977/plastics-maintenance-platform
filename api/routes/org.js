// Companies, plants, approved providers, and users.
import { id, now, one, all, run } from '../db.js';
import { hashPassword, canManageCompany, isCustomer, isInternal, isPlatform, isProvider } from '../security.js';
import { audit, byId, scope } from '../access.js';
import { created } from '../http.js';
import { bad, deny, missing, required, choice, currency, timezone, email, stringArray } from '../validate.js';
import { LOCALES } from './auth.js';

export const MACHINE_TYPES=['injection','blow','extrusion','mould','auxiliary'];
const ROLES=['customer_admin','plant_manager','maintenance','dispatcher','engineer','provider_admin','provider_engineer'];
const USER_COLUMNS='id,company_id,provider_id,name,email,role,active,service_areas,skills';
// Who may manage an existing user: platform admins anyone; customer admins their plant managers and maintenance
// staff; provider admins their own engineers. Nobody deactivates themselves.
function canManageUser(u,target) {
  if (isPlatform(u)) return true;
  if (u.role==='customer_admin') return target.company_id===u.company_id && ['plant_manager','maintenance'].includes(target.role);
  if (u.role==='provider_admin') return target.provider_id===u.provider_id && target.role==='provider_engineer';
  return false;
}

export function register(r) {
  r.get('/companies',({u})=>isPlatform(u)||u.role==='dispatcher'?all('SELECT * FROM companies'):isCustomer(u)?[byId('companies',u.company_id)]:[]);
  r.post('/companies',({u,body})=>{
    if (!isPlatform(u)) deny();
    const key=id(), locale=body.locale??'en'; if (!LOCALES.includes(locale)) bad(`locale must be one of: ${LOCALES.join(', ')}`);
    run('INSERT INTO companies (id,name,timezone,currency,units,locale,created_at) VALUES (?,?,?,?,?,?,?)',key,required(body.name,'name',160),timezone(body.timezone),currency(body.currency),choice(body.units,'units',['metric','imperial']),locale,now());
    audit(u,'company.create','company',key,key); return created(byId('companies',key));
  });

  r.get('/providers',({u})=>isInternal(u)?all('SELECT id,name,approved,service_areas,skills FROM providers'):isProvider(u)?[one('SELECT id,name,approved,service_areas,skills FROM providers WHERE id=?',u.provider_id)]:[]);
  r.post('/providers',({u,body})=>{
    if (!isPlatform(u)) deny();
    const key=id(); run('INSERT INTO providers (id,name,approved,service_areas,skills,created_at) VALUES (?,?,?,?,?,?)',key,required(body.name,'name',160),0,JSON.stringify(stringArray(body.serviceAreas,'serviceAreas')),JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)),now());
    audit(u,'provider.create','provider',key,null); return created(byId('providers',key));
  });
  r.patch('/providers/:id/approval',({u,body,params})=>{
    if (!isPlatform(u)) deny(); const p=byId('providers',params.id); if (!p) missing();
    run('UPDATE providers SET approved=? WHERE id=?',body.approved===true?1:0,p.id); audit(u,'provider.approval','provider',p.id,null,{approved:body.approved===true});
    return byId('providers',p.id);
  });

  r.get('/users',({u})=>isPlatform(u)?all(`SELECT ${USER_COLUMNS} FROM users`):u.role==='dispatcher'?all(`SELECT ${USER_COLUMNS} FROM users WHERE role IN ('dispatcher','engineer')`):isCustomer(u)?all(`SELECT ${USER_COLUMNS} FROM users WHERE company_id=?`,u.company_id):isProvider(u)?all(`SELECT ${USER_COLUMNS} FROM users WHERE provider_id=?`,u.provider_id):[]);
  r.post('/users',({u,body})=>{
    const companyId=body.companyId||null,providerId=body.providerId||null,role=choice(body.role,'role',ROLES);
    if (!(isPlatform(u)||(u.role==='customer_admin'&&companyId===u.company_id&&['plant_manager','maintenance'].includes(role))||(u.role==='provider_admin'&&providerId===u.provider_id&&role==='provider_engineer'))) deny();
    if (companyId&&!byId('companies',companyId)) bad('Unknown company'); if (providerId&&!byId('providers',providerId)) bad('Unknown provider');
    if (role.startsWith('provider_')?!providerId||companyId:role==='dispatcher'||role==='engineer'?companyId||providerId:!companyId||providerId) bad('Role and organisation do not match');
    const key=id(),address=email(body.email),password=required(body.password,'password',200); if (password.length<12) bad('Password must have at least 12 characters');
    const areas=stringArray(body.serviceAreas||[],'serviceAreas'),skills=stringArray(body.skills||[],'skills',MACHINE_TYPES);
    run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,companyId,providerId,required(body.name,'name',160),address,hashPassword(password),role,1,JSON.stringify(areas),JSON.stringify(skills),now());
    audit(u,'user.create','user',key,companyId); return created({id:key,email:address,role});
  });
  r.patch('/users/:id',({u,body,params})=>{
    const target=byId('users',params.id); if (!target) missing(); if (!canManageUser(u,target)) deny();
    if (target.id===u.id && body.active===false) bad('You cannot deactivate your own account');
    const active=body.active==null?target.active:body.active===true?1:body.active===false?0:bad('active must be true or false');
    const fieldWork=['engineer','provider_engineer','provider_admin'].includes(target.role);
    const areas=body.serviceAreas==null?target.service_areas:fieldWork?JSON.stringify(stringArray(body.serviceAreas,'serviceAreas')):bad('Service areas apply to engineers only');
    const skills=body.skills==null?target.skills:fieldWork?JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)):bad('Skills apply to engineers only');
    run('UPDATE users SET name=?,active=?,service_areas=?,skills=? WHERE id=?',body.name==null?target.name:required(body.name,'name',160),active,areas,skills,target.id);
    audit(u,'user.update','user',target.id,target.company_id,{active:!!active});
    return one(`SELECT ${USER_COLUMNS} FROM users WHERE id=?`,target.id);
  });

  r.get('/plants',({u})=>scope(u,'plants'));
  r.post('/plants',({u,body})=>{
    const companyId=required(body.companyId,'companyId'); if (!canManageCompany(u,companyId)) deny(); if (!byId('companies',companyId)) bad('Unknown company');
    const country=required(body.country,'country',2).toUpperCase(); if (!/^[A-Z]{2}$/.test(country)) bad('country must be an ISO 3166 alpha-2 code');
    const key=id(); run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at) VALUES (?,?,?,?,?,?,?,?)',key,companyId,required(body.name,'name',160),String(body.address||'').slice(0,300),country,required(body.serviceArea,'serviceArea',80),timezone(body.timezone),now());
    audit(u,'plant.create','plant',key,companyId); return created(byId('plants',key));
  });

  r.get('/audit',({u})=>{
    if (!isPlatform(u)&&u.role!=='customer_admin') deny();
    return isPlatform(u)?all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100'):all('SELECT * FROM audit_events WHERE company_id=? ORDER BY created_at DESC LIMIT 100',u.company_id);
  });
}
