// Companies, plants, approved providers, and users, with their mandatory master data.
import { id, now, one, all, run, mapSeq } from '../../../common/db.js';
import { hashPassword, canManageCompany, isCustomer, isInternal, isPlatform, isProvider } from '../../../common/security.js';
import { audit, byId, scope } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { bad, deny, missing, required, choice, currency, timezone, email, stringArray, phone, country, optionalDate } from '../../../common/validate.js';
import { MACHINE_TYPES as TYPES, OPERATING_PATTERNS, FIELD_ROLES } from '../../../common/catalog.js';
import { LOCALES, clearFailures } from './auth.js';

export const MACHINE_TYPES=TYPES;
const ROLES=['customer_admin','plant_manager','maintenance','dispatcher','engineer','provider_admin','provider_engineer'];
const USER_COLUMNS='id,company_id,provider_id,name,email,role,active,service_areas,skills,must_change_password,phone,job_title,vision_duties';
// Vision duties (EHS officer, security & facility admin, QA lead) apply to customer staff and platform staff.
const VISION_DUTIES=['ehs','security','qa'];
const duties=v=>JSON.stringify([...new Set(stringArray(v,'visionDuties',VISION_DUTIES))]);
const PROVIDER_COLUMNS='id,name,approved,service_areas,skills,contact_name,contact_email,contact_phone,country,insurance_expiry,certifications';
const localeOf=v=>{ if (!LOCALES.includes(v)) bad(`locale must be one of: ${LOCALES.join(', ')}`); return v; };
const keep=async(body,key,current,check)=>body[key]==null?current:await check(body[key]);
const optionalText=(v,max)=>v==null?'':String(v).trim().slice(0,max);
// Service area codes come from the managed list (Settings), so plants, engineers and providers always match.
export async function serviceArea(v,name='serviceArea') { const code=required(v,name,20).toUpperCase(); if (!await one('SELECT 1 FROM service_areas WHERE code=?',code)) bad(`Unknown service area "${code}". Add it in Settings → Service areas first.`); return code; }
const serviceAreas=async (v,name)=>(await mapSeq(stringArray(v,name), async x=>await serviceArea(x,name)));
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
  r.get('/companies',async ({u})=>(isPlatform(u)||u.role==='dispatcher'?await all('SELECT * FROM companies ORDER BY name'):isCustomer(u)?[await byId('companies',u.company_id)]:[]).map(c=>({...c,missing:companyGaps(c)})));
  r.post('/companies',async ({u,body})=>{
    if (!isPlatform(u)) deny();
    const key=id(), locale=localeOf(body.locale??'en');
    await run('INSERT INTO companies (id,name,timezone,currency,units,locale,created_at,country,contact_name,contact_email,contact_phone,tax_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,required(body.name,'name',160),timezone(body.timezone),currency(body.currency),choice(body.units,'units',['metric','imperial']),locale,now(),country(body.country),required(body.contactName,'contactName',120),email(body.contactEmail),phone(body.contactPhone,'contactPhone'),optionalText(body.taxId,40));
    await audit(u,'company.create','company',key,key); return created(await byId('companies',key));
  });
  // Settings apply from now on: stored times stay UTC and existing quotes keep the currency they were issued in.
  r.patch('/companies/:id',async ({u,body,params})=>{
    const c=await byId('companies',params.id); if (!c) missing(); if (!canManageCompany(u,c.id)) deny();
    const energyNum=(v,n,max)=>{ if (v===null||v==='') return null; const x=typeof v==='string'?Number(v):v; if (!Number.isFinite(x)||x<0||x>max) bad(`${n} must be a number from 0 to ${max}`); return x; };
    await run('UPDATE companies SET energy_price_per_kwh=?,grid_co2_kg_per_kwh=? WHERE id=?',body.energyPricePerKwh===undefined?c.energy_price_per_kwh:energyNum(body.energyPricePerKwh,'energyPricePerKwh',1000),body.gridCo2KgPerKwh===undefined?c.grid_co2_kg_per_kwh:energyNum(body.gridCo2KgPerKwh,'gridCo2KgPerKwh',2),c.id);
    await run('UPDATE companies SET name=?,timezone=?,currency=?,units=?,locale=?,country=?,contact_name=?,contact_email=?,contact_phone=?,tax_id=? WHERE id=?',await keep(body,'name',c.name,v=>required(v,'name',160)),await keep(body,'timezone',c.timezone,timezone),await keep(body,'currency',c.currency,currency),await keep(body,'units',c.units,v=>choice(v,'units',['metric','imperial'])),await keep(body,'locale',c.locale,localeOf),await keep(body,'country',c.country,country),await keep(body,'contactName',c.contact_name,v=>required(v,'contactName',120)),await keep(body,'contactEmail',c.contact_email,email),await keep(body,'contactPhone',c.contact_phone,v=>phone(v,'contactPhone')),body.taxId==null?c.tax_id:optionalText(body.taxId,40),c.id);
    await audit(u,'company.update','company',c.id,c.id,{fields:Object.keys(body)}); const updated=await byId('companies',c.id); return {...updated,missing:companyGaps(updated)};
  });

  r.get('/providers',async ({u})=>(isInternal(u)?await all(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY name`):isProvider(u)?[await one(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id=?`,u.provider_id)]:[]).map(p=>({...p,missing:providerGaps(p),insuranceValid:!!p.insurance_expiry&&p.insurance_expiry>=now()})));
  r.post('/providers',async ({u,body})=>{
    if (!isPlatform(u)) deny();
    const key=id(); await run('INSERT INTO providers (id,name,approved,service_areas,skills,created_at,contact_name,contact_email,contact_phone,country,insurance_expiry,certifications) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,required(body.name,'name',160),0,JSON.stringify(await serviceAreas(body.serviceAreas,'serviceAreas')),JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)),now(),required(body.contactName,'contactName',120),email(body.contactEmail),phone(body.contactPhone,'contactPhone'),country(body.country),optionalDate(body.insuranceExpiry,'insuranceExpiry'),optionalText(body.certifications,300));
    await audit(u,'provider.create','provider',key,null); return created(await byId('providers',key));
  });
  r.patch('/providers/:id',async ({u,body,params})=>{
    if (!isPlatform(u)) deny(); const p=await byId('providers',params.id); if (!p) missing();
    await run('UPDATE providers SET name=?,service_areas=?,skills=?,contact_name=?,contact_email=?,contact_phone=?,country=?,insurance_expiry=?,certifications=? WHERE id=?',await keep(body,'name',p.name,v=>required(v,'name',160)),body.serviceAreas==null?p.service_areas:JSON.stringify(await serviceAreas(body.serviceAreas,'serviceAreas')),body.skills==null?p.skills:JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)),await keep(body,'contactName',p.contact_name,v=>required(v,'contactName',120)),await keep(body,'contactEmail',p.contact_email,email),await keep(body,'contactPhone',p.contact_phone,v=>phone(v,'contactPhone')),await keep(body,'country',p.country,country),body.insuranceExpiry===undefined?p.insurance_expiry:optionalDate(body.insuranceExpiry,'insuranceExpiry'),body.certifications==null?p.certifications:optionalText(body.certifications,300),p.id);
    await audit(u,'provider.update','provider',p.id,null,{fields:Object.keys(body)}); return await byId('providers',p.id);
  });
  r.patch('/providers/:id/approval',async ({u,body,params})=>{
    if (!isPlatform(u)) deny(); const p=await byId('providers',params.id); if (!p) missing();
    if (body.approved===true) { const blockers=approvalBlockers(p); if (blockers.length) bad(`Cannot approve ${p.name} yet: ${blockers.join(', ')}`); }
    await run('UPDATE providers SET approved=? WHERE id=?',body.approved===true?1:0,p.id); await audit(u,'provider.approval','provider',p.id,null,{approved:body.approved===true});
    return await byId('providers',p.id);
  });

  r.get('/users',async ({u})=>isPlatform(u)?await all(`SELECT ${USER_COLUMNS} FROM users WHERE id<>'u-system' ORDER BY name`):u.role==='dispatcher'?await all(`SELECT ${USER_COLUMNS} FROM users WHERE role IN ('dispatcher','engineer') ORDER BY name`):isCustomer(u)?await all(`SELECT ${USER_COLUMNS} FROM users WHERE company_id=? ORDER BY name`,u.company_id):isProvider(u)?await all(`SELECT ${USER_COLUMNS} FROM users WHERE provider_id=? ORDER BY name`,u.provider_id):[]);
  r.post('/users',async ({u,body})=>{
    const companyId=body.companyId||null,providerId=body.providerId||null,role=choice(body.role,'role',ROLES);
    if (!(isPlatform(u)||(u.role==='customer_admin'&&companyId===u.company_id&&['plant_manager','maintenance'].includes(role))||(u.role==='provider_admin'&&providerId===u.provider_id&&role==='provider_engineer'))) deny();
    if (companyId&&!await byId('companies',companyId)) bad('Unknown company'); if (providerId&&!await byId('providers',providerId)) bad('Unknown provider');
    if (role.startsWith('provider_')?!providerId||companyId:role==='dispatcher'||role==='engineer'?companyId||providerId:!companyId||providerId) bad('Role and organisation do not match');
    const key=id(),address=email(body.email),password=required(body.password,'password',200); if (password.length<12) bad('Password must have at least 12 characters');
    // Field engineers must be reachable by phone and carry the areas and skills used for assignment.
    const field=FIELD_ROLES.includes(role), contact=field?phone(body.phone):body.phone?phone(body.phone):'';
    const areas=field?await serviceAreas(body.serviceAreas,'serviceAreas'):await serviceAreas(body.serviceAreas||[],'serviceAreas'), skills=stringArray(field?body.skills:body.skills||[],'skills',MACHINE_TYPES);
    if (field&&(!areas.length||!skills.length)) bad('Field engineers need at least one service area and one machine skill');
    // New accounts get a temporary password and are asked to choose their own at first sign-in.
    await run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at,must_change_password,phone,job_title,vision_duties) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)',key,companyId,providerId,required(body.name,'name',160),address,hashPassword(password),role,1,JSON.stringify(areas),JSON.stringify(skills),now(),contact,optionalText(body.jobTitle,80),body.visionDuties==null?'[]':duties(body.visionDuties));
    await audit(u,'user.create','user',key,companyId); return created({id:key,email:address,role});
  });
  r.patch('/users/:id',async ({u,body,params})=>{
    const target=await byId('users',params.id); if (!target) missing(); if (!canManageUser(u,target)) deny();
    if (target.id===u.id && body.active===false) bad('You cannot deactivate your own account');
    const active=body.active==null?target.active:body.active===true?1:body.active===false?0:bad('active must be true or false');
    const fieldWork=['engineer','provider_engineer','provider_admin'].includes(target.role);
    const areas=body.serviceAreas==null?target.service_areas:fieldWork?JSON.stringify(await serviceAreas(body.serviceAreas,'serviceAreas')):bad('Service areas apply to engineers only');
    const skills=body.skills==null?target.skills:fieldWork?JSON.stringify(stringArray(body.skills,'skills',MACHINE_TYPES)):bad('Skills apply to engineers only');
    const contact=body.phone==null?target.phone:FIELD_ROLES.includes(target.role)||body.phone?phone(body.phone):'';
    await run('UPDATE users SET name=?,active=?,service_areas=?,skills=?,phone=?,job_title=?,vision_duties=? WHERE id=?',body.name==null?target.name:required(body.name,'name',160),active,areas,skills,contact,body.jobTitle==null?target.job_title:optionalText(body.jobTitle,80),body.visionDuties==null?target.vision_duties:duties(body.visionDuties),target.id);
    await audit(u,'user.update','user',target.id,target.company_id,{active:!!active});
    return await one(`SELECT ${USER_COLUMNS} FROM users WHERE id=?`,target.id);
  });
  // Admin reset to a new temporary password: signs the user out everywhere, clears sign-in lockouts, and asks them to
  // choose their own password at next sign-in. Own password changes go through POST /me/password.
  r.post('/users/:id/password',async ({u,body,params})=>{
    const target=await byId('users',params.id); if (!target) missing();
    if (target.id===u.id) bad('Use Account → Change password for your own account');
    if (!canManageUser(u,target)) deny();
    const password=required(body.newPassword,'newPassword',200); if (password.length<12) bad('Password must have at least 12 characters');
    await run('UPDATE users SET password_hash=?,must_change_password=1,session_version=session_version+1 WHERE id=?',hashPassword(password),target.id);
    clearFailures(target.email);
    await audit(u,'user.password_reset','user',target.id,target.company_id); return {ok:true};
  });

  r.get('/plants',async ({u})=>await scope(u,'plants'));
  r.post('/plants',async ({u,body})=>{
    const companyId=required(body.companyId,'companyId'); if (!canManageCompany(u,companyId)) deny(); if (!await byId('companies',companyId)) bad('Unknown company');
    const key=id(); await run('INSERT INTO plants (id,company_id,name,address,country,service_area,timezone,created_at,operating_pattern) VALUES (?,?,?,?,?,?,?,?,?)',key,companyId,required(body.name,'name',160),required(body.address,'address',300),country(body.country),await serviceArea(body.serviceArea),timezone(body.timezone),now(),choice(body.operatingPattern,'operatingPattern',OPERATING_PATTERNS));
    await audit(u,'plant.create','plant',key,companyId); return created(await byId('plants',key));
  });
  // A changed service area affects which engineers and providers are eligible for future assignments only.
  r.patch('/plants/:id',async ({u,body,params})=>{
    const p=await byId('plants',params.id); if (!p) missing(); if (!canManageCompany(u,p.company_id)) deny();
    await run('UPDATE plants SET name=?,address=?,country=?,service_area=?,timezone=?,operating_pattern=? WHERE id=?',await keep(body,'name',p.name,v=>required(v,'name',160)),await keep(body,'address',p.address,v=>required(v,'address',300)),await keep(body,'country',p.country,country),await keep(body,'serviceArea',p.service_area,serviceArea),await keep(body,'timezone',p.timezone,timezone),await keep(body,'operatingPattern',p.operating_pattern,v=>choice(v,'operatingPattern',OPERATING_PATTERNS)),p.id);
    await audit(u,'plant.update','plant',p.id,p.company_id,{fields:Object.keys(body)}); return await byId('plants',p.id);
  });

  r.get('/audit',async ({u})=>{
    if (!isPlatform(u)&&u.role!=='customer_admin') deny();
    return isPlatform(u)?await all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200'):await all('SELECT * FROM audit_events WHERE company_id=? ORDER BY created_at DESC LIMIT 200',u.company_id);
  });
}
