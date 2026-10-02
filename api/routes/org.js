// Companies, plants, approved providers, and users, with their mandatory master data.
import { id, now, one, all, run } from '../db.js';
import { hashPassword, canManageCompany, isCustomer, isInternal, isPlatform, isProvider } from '../security.js';
import { audit, byId, scope } from '../access.js';
import { created } from '../http.js';
import { bad, deny, missing, required, choice, currency, timezone, email, stringArray, phone, country, optionalDate } from '../validate.js';
import { MACHINE_TYPES as TYPES, OPERATING_PATTERNS, FIELD_ROLES } from '../catalog.js';
import { LOCALES, clearFailures } from './auth.js';

export const MACHINE_TYPES=TYPES;
const ROLES=['customer_admin','plant_manager','maintenance','dispatcher','engineer','provider_admin','provider_engineer'];
const USER_COLUMNS='id,company_id,provider_id,name,email,role,active,service_areas,skills,must_change_password,phone,job_title';
const PROVIDER_COLUMNS='id,name,approved,service_areas,skills,contact_name,contact_email,contact_phone,country,insurance_expiry,certifications';
const localeOf=v=>{ if (!LOCALES.includes(v)) bad(`locale must be one of: ${LOCALES.join(', ')}`); return v; };
const keep=(body,key,current,check)=>body[key]==null?current:check(body[key]);
const optionalText=(v,max)=>v==null?'':String(v).trim().slice(0,max);
// Service area codes come from the managed list (Settings), so plants, engineers and providers always match.
export function serviceArea(v,name='serviceArea') { const code=required(v,name,20).toUpperCase(); if (!one('SELECT 1 FROM service_areas WHERE code=?',code)) bad(`Unknown service area "${code}". Add it in Settings → Service areas first.`); return code; }
const serviceAreas=(v,name)=>stringArray(v,name).map(x=>serviceArea(x,name));
// Missing mandatory data on records created before a field became mandatory: shown so it can be completed.
const companyGaps=c=>[...(!c.country?['Country']:[]),...(!c.contact_name?['Contact name']:[]),...(!c.contact_email?['Contact email']:[]),...(!c.contact_phone?['Contact phone']:[])];
const providerGaps=p=>[...(!p.contact_email?['Contact email']:[]),...(!p.contact_phone?['Contact phone']:[]),...(!p.insurance_expiry?['Insurance expiry']:[])];
// Approval needs reachable contacts and liability insurance valid today (standard supplier qualification).
function approvalBlockers(p) { const gaps=providerGaps(p); if (p.insurance_expiry&&p.insurance_expiry<now()) gaps.push('Insurance has expired'); return gaps; }
// Who may manage an existing user: platform admins anyone; customer admins their plant managers and maintenance
// staff; provider admins their own engineers. Nobody deactivates themselves.
function canManageUser(u,target) {
  if (isPlatform(u)) return true;
  if (u.role==='customer_admin') return target.company_id===u.company_id && ['plant_manager','maintenance'].includes(target.role);
  if (u.role==='provider_admin') return target.provider_id===u.provider_id && target.role==='provider_engineer';
  return false;
}

export function register(r) {
  r.get('/companies',({u})=>(isPlatform(u)||u.role==='dispatcher'?all('SELECT * FROM companies ORDER BY name'):isCustomer(u)?[byId('companies',u.company_id)]:[]).map(c=>({...c,missing:companyGaps(c)})));
  r.post('/companies',({u,body})=>{
    if (!isPlatform(u)) deny();
    const key=id(), locale=localeOf(body.locale??'en');
    run('INSERT INTO companies (id,name,timezone,currency,units,locale,created_at,country,contact_name,contact_email,contact_phone,tax_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,required(body.name,'name',160),timezone(body.timezone),currency(body.currency),choice(body.units,'units',['metric','imperial']),locale,now(),country(body.country),required(body.contactName,'contactName',120),email(body.contactEmail),phone(body.contactPhone,'contactPhone'),optionalText(body.taxId,40));
    audit(u,'company.create','company',key,key); return created(byId('companies',key));
  });
  // Settings apply from now on: stored times stay UTC and existing quotes keep the currency they were issued in.
  r.patch('/companies/:id',({u,body,params})=>{
    const c=byId('companies',params.id); if (!c) missing(); if (!canManageCompany(u,c.id)) deny();
    run('UPDATE companies SET name=?,timezone=?,currency=?,units=?,locale=?,country=?,contact_name=?,contact_email=?,contact_phone=?,tax_id=? WHERE id=?',keep(body,'name',c.name,v=>required(v,'name',160)),keep(body,'timezone',c.timezone,timezone),keep(body,'currency',c.currency,currency),keep(body,'units',c.units,v=>choice(v,'units',['metric','imperial'])),keep(body,'locale',c.locale,localeOf),keep(body,'country',c.country,country),keep(body,'contactName',c.contact_name,v=>required(v,'contactName',120)),keep(body,'contactEmail',c.contact_email,email),keep(body,'contactPhone',c.contact_phone,v=>phone(v,'contactPhone')),body.taxId==null?c.tax_id:optionalText(body.taxId,40),c.id);
    audit(u,'company.update','company',c.id,c.id,{fields:Object.keys(body)}); const updated=byId('companies',c.id); return {...updated,missing:companyGaps(updated)};
  });

  r.get('/providers',({u})=>(isInternal(u)?all(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY name`):isProvider(u)?[one(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id=?`,u.provider_id)]:[]).map(p=>({...p,missing:providerGaps(p),insuranceValid:!!p.insurance_expiry&&p.insurance_expiry>=now()})));
  r.post('/providers',({u,body})=>{
    if (!isPlatform(u)) deny();
    const key=id(); run('INSERT INTO providers (id,name,approved,service_areas,skills,created_at,contact_name,contact_email,contact_phone,country,insurance_expiry,certifications) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,required(body.name,'name',160),0,JSON.stringify(serviceAreas(body.serviceAreas,'serviceAreas')),JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)),now(),required(body.contactName,'contactName',120),email(body.contactEmail),phone(body.contactPhone,'contactPhone'),country(body.country),optionalDate(body.insuranceExpiry,'insuranceExpiry'),optionalText(body.certifications,300));
    audit(u,'provider.create','provider',key,null); return created(byId('providers',key));
  });
  r.patch('/providers/:id',({u,body,params})=>{
    if (!isPlatform(u)) deny(); const p=byId('providers',params.id); if (!p) missing();
    run('UPDATE providers SET name=?,service_areas=?,skills=?,contact_name=?,contact_email=?,contact_phone=?,country=?,insurance_expiry=?,certifications=? WHERE id=?',keep(body,'name',p.name,v=>required(v,'name',160)),body.serviceAreas==null?p.service_areas:JSON.stringify(serviceAreas(body.serviceAreas,'serviceAreas')),body.skills==null?p.skills:JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)),keep(body,'contactName',p.contact_name,v=>required(v,'contactName',120)),keep(body,'contactEmail',p.contact_email,email),keep(body,'contactPhone',p.contact_phone,v=>phone(v,'contactPhone')),keep(body,'country',p.country,country),body.insuranceExpiry===undefined?p.insurance_expiry:optionalDate(body.insuranceExpiry,'insuranceExpiry'),body.certifications==null?p.certifications:optionalText(body.certifications,300),p.id);
    audit(u,'provider.update','provider',p.id,null,{fields:Object.keys(body)}); return byId('providers',p.id);
  });
  r.patch('/providers/:id/approval',({u,body,params})=>{
    if (!isPlatform(u)) deny(); const p=byId('providers',params.id); if (!p) missing();
    if (body.approved===true) { const blockers=approvalBlockers(p); if (blockers.length) bad(`Cannot approve ${p.name} yet: ${blockers.join(', ')}`); }
    run('UPDATE providers SET approved=? WHERE id=?',body.approved===true?1:0,p.id); audit(u,'provider.approval','provider',p.id,null,{approved:body.approved===true});
    return byId('providers',p.id);
  });

  r.get('/users',({u})=>isPlatform(u)?all(`SELECT ${USER_COLUMNS} FROM users WHERE id<>'u-system' ORDER BY name`):u.role==='dispatcher'?all(`SELECT ${USER_COLUMNS} FROM users WHERE role IN ('dispatcher','engineer') ORDER BY name`):isCustomer(u)?all(`SELECT ${USER_COLUMNS} FROM users WHERE company_id=? ORDER BY name`,u.company_id):isProvider(u)?all(`SELECT ${USER_COLUMNS} FROM users WHERE provider_id=? ORDER BY name`,u.provider_id):[]);
  r.post('/users',({u,body})=>{
    const companyId=body.companyId||null,providerId=body.providerId||null,role=choice(body.role,'role',ROLES);
    if (!(isPlatform(u)||(u.role==='customer_admin'&&companyId===u.company_id&&['plant_manager','maintenance'].includes(role))||(u.role==='provider_admin'&&providerId===u.provider_id&&role==='provider_engineer'))) deny();
    if (companyId&&!byId('companies',companyId)) bad('Unknown company'); if (providerId&&!byId('providers',providerId)) bad('Unknown provider');
    if (role.startsWith('provider_')?!providerId||companyId:role==='dispatcher'||role==='engineer'?companyId||providerId:!companyId||providerId) bad('Role and organisation do not match');
    const key=id(),address=email(body.email),password=required(body.password,'password',200); if (password.length<12) bad('Password must have at least 12 characters');
    // Field engineers must be reachable by phone and carry the areas and skills used for assignment.
    const field=FIELD_ROLES.includes(role), contact=field?phone(body.phone):body.phone?phone(body.phone):'';
    const areas=field?serviceAreas(body.serviceAreas,'serviceAreas'):serviceAreas(body.serviceAreas||[],'serviceAreas'), skills=stringArray(field?body.skills:body.skills||[],'skills',MACHINE_TYPES);
    if (field&&(!areas.length||!skills.length)) bad('Field engineers need at least one service area and one machine skill');
    // New accounts get a temporary password and are asked to choose their own at first sign-in.
    run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at,must_change_password,phone,job_title) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)',key,companyId,providerId,required(body.name,'name',160),address,hashPassword(password),role,1,JSON.stringify(areas),JSON.stringify(skills),now(),contact,optionalText(body.jobTitle,80));
    audit(u,'user.create','user',key,companyId); return created({id:key,email:address,role});
  });
  r.patch('/users/:id',({u,body,params})=>{
    const target=byId('users',params.id); if (!target) missing(); if (!canManageUser(u,target)) deny();
    if (target.id===u.id && body.active===false) bad('You cannot deactivate your own account');
    const active=body.active==null?target.active:body.active===true?1:body.active===false?0:bad('active must be true or false');
    const fieldWork=['engineer','provider_engineer','provider_admin'].includes(target.role);
    const areas=body.serviceAreas==null?target.service_areas:fieldWork?JSON.stringify(serviceAreas(body.serviceAreas,'serviceAreas')):bad('Service areas apply to engineers only');
    const skills=body.skills==null?target.skills:fieldWork?JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)):bad('Skills apply to engineers only');
    const contact=body.phone==null?target.phone:FIELD_ROLES.includes(target.role)||body.phone?phone(body.phone):'';
    run('UPDATE users SET name=?,active=?,service_areas=?,skills=?,phone=?,job_title=? WHERE id=?',body.name==null?target.name:required(body.name,'name',160),active,areas,skills,contact,body.jobTitle==null?target.job_title:optionalText(body.jobTitle,80),target.id);
    audit(u,'user.update','user',target.id,target.company_id,{active:!!active});
    return one(`SELECT ${USER_COLUMNS} FROM users WHERE id=?`,target.id);
  });
  // Admin reset to a new temporary password: signs the user out everywhere, clears sign-in lockouts, and asks them to
  // choose their own password at next sign-in. Own password changes go through POST /me/password.
  r.post('/users/:id/password',({u,body,params})=>{
    const target=byId('users',params.id); if (!target) missing();
    if (target.id===u.id) bad('Use Account → Change password for your own account');
    if (!canManageUser(u,target)) deny();
    const password=required(body.newPassword,'newPassword',200); if (password.length<12) bad('Password must have at least 12 characters');
    run('UPDATE users SET password_hash=?,must_change_password=1,session_version=session_version+1 WHERE id=?',hashPassword(password),target.id);
    clearFailures(target.email);
    audit(u,'user.password_reset','user',target.id,target.company_id); return {ok:true};
  });

  r.get('/plants',({u})=>scope(u,'plants'));
  r.post('/plants',({u,body})=>{
    const companyId=required(body.companyId,'companyId'); if (!canManageCompany(u,companyId)) deny(); if (!byId('companies',companyId)) bad('Unknown company');
    const key=id(); run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at,operating_pattern) VALUES (?,?,?,?,?,?,?,?,?)',key,companyId,required(body.name,'name',160),required(body.address,'address',300),country(body.country),serviceArea(body.serviceArea),timezone(body.timezone),now(),choice(body.operatingPattern,'operatingPattern',OPERATING_PATTERNS));
    audit(u,'plant.create','plant',key,companyId); return created(byId('plants',key));
  });
  // A changed service area affects which engineers and providers are eligible for future assignments only.
  r.patch('/plants/:id',({u,body,params})=>{
    const p=byId('plants',params.id); if (!p) missing(); if (!canManageCompany(u,p.company_id)) deny();
    run('UPDATE plants SET name=?,address=?,country=?,service_area=?,timezone=?,operating_pattern=? WHERE id=?',keep(body,'name',p.name,v=>required(v,'name',160)),keep(body,'address',p.address,v=>required(v,'address',300)),keep(body,'country',p.country,country),keep(body,'serviceArea',p.service_area,serviceArea),keep(body,'timezone',p.timezone,timezone),keep(body,'operatingPattern',p.operating_pattern,v=>choice(v,'operatingPattern',OPERATING_PATTERNS)),p.id);
    audit(u,'plant.update','plant',p.id,p.company_id,{fields:Object.keys(body)}); return byId('plants',p.id);
  });

  r.get('/audit',({u})=>{
    if (!isPlatform(u)&&u.role!=='customer_admin') deny();
    return isPlatform(u)?all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200'):all('SELECT * FROM audit_events WHERE company_id=? ORDER BY created_at DESC LIMIT 200',u.company_id);
  });
}
