// Competencies and training completions. The platform administrator and dispatchers define the requirements and can
// record a completion by hand; a learning management system sends completions to /integrations/lms/completions with the
// server-wide integration key. A provider administrator sees the standing of the provider's own engineers, and an
// engineer or provider engineer sees their own. Assignment uses these rules through candidatesFor (tickets.js).
import { id, now, one, all, run } from '../../../common/db.js';
import { isProvider } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { created } from '../../../common/http.js';
import { HttpError, array, bad, choice, deny, instant, integer, missing, required } from '../../../common/validate.js';
import { MACHINE_TYPES, FIELD_ROLES } from '../../../common/catalog.js';
import { requireIntegrationKey } from '../../iot/routes/iot.js';
import { competencyByCode, expiryOf, latestFor, statusOf } from '../competency.js';

const SYSTEM={id:'u-system'};
const J=(v,d)=>{ try { return JSON.parse(v); } catch { return d; } };
const out=c=>({id:c.id,code:c.code,name:c.name,machineTypes:J(c.machine_types,[]),validityMonths:c.validity_months,enforcement:c.enforcement,active:!!c.active,createdAt:c.created_at});
const canView=u=>isDispatch(u)||isProvider(u)||u.role==='engineer';
const CODE=/^[A-Z0-9][A-Z0-9._-]{1,39}$/;

function fields(body,base={}) {
  const code=body.code===undefined&&base.code?base.code:required(body.code,'code',40).trim().toUpperCase();
  if (!CODE.test(code)) bad('code must be 2-40 letters, digits, dots, dashes or underscores, as the learning system sends it');
  const types=body.machineTypes===undefined&&base.machine_types?J(base.machine_types,[]):array(body.machineTypes,'machineTypes');
  if (types.some(t=>!MACHINE_TYPES.includes(t))) bad(`machineTypes must be from: ${MACHINE_TYPES.join(', ')}`);
  const months=body.validityMonths===undefined?(base.validity_months??null):body.validityMonths===null?null:integer(body.validityMonths,'validityMonths',1,120);
  return {code,name:body.name===undefined&&base.name?base.name:required(body.name,'name',120),types:[...new Set(types)],months,
    enforcement:body.enforcement===undefined&&base.enforcement?base.enforcement:choice(body.enforcement,'enforcement',['flag','block']),
    active:body.active===undefined?(base.active??1):body.active?1:0};
}

// People whose standing the caller may see: everyone in the field for dispatch, the provider's engineers for a provider
// administrator, the caller for an engineer or provider engineer.
async function people(u) {
  const base=`SELECT id,name,email,role,provider_id,active FROM users WHERE role IN ('engineer','provider_engineer')`;
  if (isDispatch(u)) return await all(`${base} ORDER BY name`);
  if (u.role==='provider_admin') return await all(`${base} AND provider_id=? ORDER BY name`,u.provider_id);
  if (u.role==='engineer'||u.role==='provider_engineer') return await all(`${base} AND id=?`,u.id);
  deny();
}

export function register(r) {
  r.get('/competencies',async ({u})=>{ if (!canView(u)) deny(); return (await all('SELECT * FROM competencies ORDER BY name')).map(out); });
  r.post('/competencies',async ({u,body})=>{
    if (!isDispatch(u)) deny(); const f=fields(body);
    if (await one('SELECT 1 FROM competencies WHERE code=?',f.code)) bad(`A competency with code ${f.code} already exists`);
    const key=id(); await run('INSERT INTO competencies (id,code,name,machine_types,validity_months,enforcement,active,created_at) VALUES (?,?,?,?,?,?,?,?)',key,f.code,f.name,JSON.stringify(f.types),f.months,f.enforcement,f.active,now());
    await audit(u,'competency.create','competency',key,null,{code:f.code,machineTypes:f.types,enforcement:f.enforcement,validityMonths:f.months});
    return created(out(await byId('competencies',key)));
  });
  // The standing of each person against each competency: valid, expiring, expired or missing.
  r.get('/competencies/matrix',async ({u,query})=>{
    if (!canView(u)) deny(); const type=query.get('machineType');
    if (type&&!MACHINE_TYPES.includes(type)) bad(`machineType must be one of: ${MACHINE_TYPES.join(', ')}`);
    const comps=(await all('SELECT * FROM competencies WHERE active=1 ORDER BY name')).filter(c=>!type||J(c.machine_types,[]).includes(type));
    const list=await people(u), latest=await latestFor(list.map(p=>p.id)), at=Date.now();
    return {competencies:comps.map(out),people:list.map(p=>({userId:p.id,name:p.name,email:p.email,role:p.role,providerId:p.provider_id,active:!!p.active,
      standing:Object.fromEntries(comps.map(c=>{ const rec=latest.get(p.id).get(c.id); return [c.code,{status:statusOf(rec,at),completedAt:rec?.completed_at??null,expiresAt:rec?.expires_at??null,source:rec?.source??null}]; }))}))};
  });
  r.patch('/competencies/:id',async ({u,body,params})=>{
    if (!isDispatch(u)) deny(); const c=await byId('competencies',params.id); if (!c) missing();
    const f=fields(body,c);
    if (f.code!==c.code&&await one('SELECT 1 FROM competencies WHERE code=?',f.code)) bad(`A competency with code ${f.code} already exists`);
    await run('UPDATE competencies SET code=?,name=?,machine_types=?,validity_months=?,enforcement=?,active=? WHERE id=?',f.code,f.name,JSON.stringify(f.types),f.months,f.enforcement,f.active,c.id);
    await audit(u,'competency.update','competency',c.id,null,{code:f.code,machineTypes:f.types,enforcement:f.enforcement,validityMonths:f.months,active:!!f.active});
    return out(await byId('competencies',c.id));
  });
  // A completion recorded by hand (a certificate from a course given on site, or while the LMS is not connected).
  r.post('/competencies/records',async ({u,body})=>{
    if (!isDispatch(u)) deny();
    const person=await byId('users',required(body.userId,'userId',80)); if (!person||!FIELD_ROLES.includes(person.role)) bad('userId must be an engineer or provider engineer');
    const comp=await competencyByCode(required(body.code,'code',40)); if (!comp) bad(`Unknown competency ${String(body.code).trim().toUpperCase()}`);
    const completedAt=instant(body.completedAt,'completedAt'), expires=body.expiresAt==null?null:instant(body.expiresAt,'expiresAt');
    if (completedAt>new Date(Date.now()+5*60000).toISOString()) bad('completedAt cannot be in the future');
    const expiresAt=expiryOf(comp,completedAt,expires); if (expiresAt&&expiresAt<=completedAt) bad('expiresAt must be after completedAt');
    const key=id(), note=body.note==null||body.note===''?'':required(body.note,'note',500);
    if (!(await run('INSERT INTO user_competencies (id,user_id,competency_id,completed_at,expires_at,source,recorded_by,note,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',key,person.id,comp.id,completedAt,expiresAt,'manual',u.id,note,now())).changes) bad('That completion is already on record');
    await audit(u,'competency.record','user',person.id,person.company_id,{code:comp.code,completedAt,expiresAt,note});
    return created({id:key,userId:person.id,code:comp.code,completedAt,expiresAt,source:'manual'});
  });

  // From a learning management system. Body: {completions:[{email, courseCode, completedAt, passed?, score?, expiresAt?,
  // externalId?}]}, up to 200. Each is answered on its own, so a bad row does not hold back the others, and sending the
  // same completion again changes nothing. courseCode is the competency code; passed:false is not recorded.
  r.post('/integrations/lms/completions',async ({req,body})=>{
    requireIntegrationKey(req);
    const list=array(body.completions,'completions'); if (!list.length||list.length>200) bad('completions must hold 1 to 200 entries');
    const results=[];
    for (const c of list) {
      const email=typeof c?.email==='string'?c.email.trim().toLowerCase():'', result=status=>results.push({email:email||null,courseCode:c?.courseCode??null,...status});
      try {
        if (!c||typeof c!=='object') { result({status:'rejected',reason:'Each completion must be an object'}); continue; }
        if (c.passed===false) { result({status:'not_passed'}); continue; }
        const person=email?await one("SELECT * FROM users WHERE lower(email)=? AND role IN ('engineer','provider_engineer') AND active=1",email):null;
        if (!person) { result({status:'unknown_user',reason:'No active engineer or provider engineer with this email'}); continue; }
        const comp=typeof c.courseCode==='string'?await competencyByCode(c.courseCode):null;
        if (!comp) { result({status:'unknown_course',reason:'No competency with this code; create it first'}); continue; }
        const completedAt=instant(c.completedAt,'completedAt'), explicit=c.expiresAt==null?null:instant(c.expiresAt,'expiresAt');
        if (completedAt>new Date(Date.now()+5*60000).toISOString()) throw new HttpError(400,'completedAt cannot be in the future');
        const expiresAt=expiryOf(comp,completedAt,explicit); if (expiresAt&&expiresAt<=completedAt) throw new HttpError(400,'expiresAt must be after completedAt');
        const score=c.score==null?null:typeof c.score==='number'&&Number.isFinite(c.score)?c.score:bad('score must be a number');
        const ext=c.externalId==null?'':required(String(c.externalId),'externalId',120);
        const added=(await run('INSERT INTO user_competencies (id,user_id,competency_id,completed_at,expires_at,score,source,external_id,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',id(),person.id,comp.id,completedAt,expiresAt,score,'lms',ext,SYSTEM.id,now())).changes;
        if (added) await audit(SYSTEM,'competency.lms_completion','user',person.id,person.company_id,{code:comp.code,completedAt,expiresAt,externalId:ext||null});
        result({status:added?'recorded':'duplicate',expiresAt});
      } catch (e) { if (e instanceof HttpError&&e.status<500) result({status:'rejected',reason:e.message}); else throw e; }
    }
    return {results,recorded:results.filter(x=>x.status==='recorded').length};
  },{public:true});
}
