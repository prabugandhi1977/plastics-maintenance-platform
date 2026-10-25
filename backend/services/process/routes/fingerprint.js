// Mould process fingerprint and process-advice routes. Factory viewers (customer staff, dispatchers) see; customer admins,
// plant managers and the platform administrator build, rebaseline, reset and ask for advice. Everything is scoped to the
// mould's company; another company's mould answers 403.
import { id, now, one, all, run } from '../../../common/db.js';
import { isCustomer, isPlatform } from '../../../common/security.js';
import { audit, byId, isDispatch } from '../../../common/access.js';
import { created, reply } from '../../../common/http.js';
import { HttpError, bad, choice, deny, integer, missing, required } from '../../../common/validate.js';
import { aiEnabled } from '../../assistant/assistant.js';
import { aiHttpError } from '../../ml/explain.js';
import * as F from '../fingerprint.js';
import * as A from '../advice.js';

const canView=u=>isCustomer(u)||isDispatch(u);
const canManage=(u,companyId)=>isPlatform(u)||(['customer_admin','plant_manager'].includes(u.role)&&u.company_id===companyId);
const view=u=>{ if (!canView(u)) deny(); };
const J=(s,d)=>{ try { return JSON.parse(s||''); } catch { return d; } };

async function mouldFor(u,key) {
  view(u); const m=await byId('equipment',key); if (!m||m.machine_type!=='mould') missing();
  if (!(isDispatch(u)||(isCustomer(u)&&u.company_id===m.company_id))) deny();
  return m;
}
// The mould + machine + product named by a request, all in the mould's company.
async function scopeFor(mould,src) {
  const equipmentId=required(src.equipmentId,'equipmentId',80), productId=required(src.productId,'productId',80);
  const machine=await byId('equipment',equipmentId), product=await byId('products',productId);
  if (!machine||machine.company_id!==mould.company_id||machine.machine_type==='mould'||machine.machine_type==='auxiliary') bad('equipmentId must be a machine of the same company');
  if (!product||product.company_id!==mould.company_id) bad('productId must be a product of the same company');
  return {companyId:mould.company_id,mouldId:mould.id,equipmentId,productId};
}
// Too little good data is a refusal with its reasons, not a server error; nothing was written.
const refused=(what,out)=>reply(422,{error:`${what}: ${out.reasons.map(x=>x.message).join(' ')}`,reasons:out.reasons});
const adviceRow=async r=>{
  const who=await one('SELECT name FROM users WHERE id=?',r.asked_by), by=r.outcome_by?await one('SELECT name FROM users WHERE id=?',r.outcome_by):null;
  return {id:r.id,askedAt:r.asked_at,askedBy:who?.name||null,askedById:r.asked_by,question:r.question,source:r.source,model:r.model,fingerprintVersion:r.fingerprint_version,driftScore:r.drift_score,driftLevel:r.drift_level,maxStepPct:r.max_step_pct,
    advice:J(r.advice,{}),sources:J(r.sources,[]),outcome:r.outcome,outcomeNote:r.outcome_note,outcomeBy:by?.name||null,outcomeAt:r.outcome_at,equipmentId:r.equipment_id,productId:r.product_id};
};

export function register(r) {
  // ---------- Fingerprints ----------
  r.get('/moulds/:id/fingerprint',async ({u,params})=>{
    const m=await mouldFor(u,params.id), scopes=[];
    for (const s of await F.scopesOf(m)) scopes.push(await F.scopeView(s));
    return {mould:{id:m.id,assetTag:m.asset_tag,name:`${m.make} ${m.model}`.trim()},scopes,canManage:canManage(u,m.company_id),aiEnabled:aiEnabled(),stepLimit:A.stepLimits()};
  });
  // The same panel for the process-control screen: every mould that made this product.
  r.get('/process/fingerprints',async ({u,query})=>{
    view(u); const p=await byId('products',query.get('productId')); if (!p) missing();
    if (!(isDispatch(u)||u.company_id===p.company_id)) deny();
    const moulds=await all("SELECT m.* FROM equipment m WHERE m.company_id=? AND m.machine_type='mould' AND (m.id IN (SELECT mould_id FROM batches WHERE product_id=? AND mould_id IS NOT NULL) OR m.id IN (SELECT mould_id FROM mould_fingerprints WHERE product_id=?)) ORDER BY m.asset_tag",p.company_id,p.id,p.id), scopes=[];
    for (const m of moulds) for (const s of await F.scopesOf(m)) if (s.productId===p.id) scopes.push(await F.scopeView(s));
    return {product:{id:p.id,partNumber:p.part_number,name:p.name},scopes,canManage:canManage(u,p.company_id),aiEnabled:aiEnabled(),stepLimit:A.stepLimits()};
  });
  r.post('/moulds/:id/fingerprint/build',async ({u,body,params})=>{
    const m=await mouldFor(u,params.id); if (!canManage(u,m.company_id)) deny();
    const s=await scopeFor(m,body), days=body.days==null?undefined:integer(Number(body.days),'days',1,365);
    const out=await F.buildAndSave(u,s,{days,origin:'manual',reason:body.reason?String(body.reason):''});
    if (!out.built) return refused('The fingerprint was not built',out);
    await F.checkMould(m);
    return created({...out,scope:await F.scopeView(s)});
  });
  // "Accept the new normal": a new version learned from the last days of good production. Needs a reason; audited.
  r.post('/moulds/:id/fingerprint/rebaseline',async ({u,body,params})=>{
    const m=await mouldFor(u,params.id); if (!canManage(u,m.company_id)) deny();
    const s=await scopeFor(m,body), why=required(body.reason,'reason',500), days=body.days==null?7:integer(Number(body.days),'days',1,90);
    const out=await F.rebaseline(u,s,{days,reason:why});
    if (!out.rebaselined) return refused('The new normal was not accepted',out);
    return {...out,scope:await F.scopeView(s)};
  });
  r.post('/moulds/:id/fingerprint/reset',async ({u,body,params})=>{
    const m=await mouldFor(u,params.id); if (!canManage(u,m.company_id)) deny();
    const s=await scopeFor(m,body), out=await F.resetFingerprint(u,s,{reason:required(body.reason,'reason',500)});
    return {...out,scope:await F.scopeView(s)};
  });
  // Judge the recent run now (the background scan does this every ten minutes): raises, escalates or resolves the one alert.
  r.post('/moulds/:id/fingerprint/check',async ({u,params})=>{ const m=await mouldFor(u,params.id); if (!canManage(u,m.company_id)) deny(); return await F.checkMould(m); });

  // ---------- Advice ----------
  r.post('/moulds/:id/process-advice',async ({u,body,params})=>{
    const m=await mouldFor(u,params.id); if (!canManage(u,m.company_id)) deny();
    const scope=await scopeFor(m,body), limits=A.stepLimits(), confirmed=body.confirmLargerStep===true;
    let maxPct=limits.defaultPct;
    if (confirmed) { const asked=body.maxStepPct==null?limits.confirmedMaxPct:Number(body.maxStepPct); if (!Number.isFinite(asked)||asked<=0) bad('maxStepPct must be a positive number'); maxPct=Math.min(Math.max(asked,limits.defaultPct),limits.confirmedMaxPct); }
    const question=body.question==null||body.question===''?'':required(body.question,'question',500), v=await F.scopeView(scope), why=A.thinReasons(v);
    if (why.length) throw new HttpError(422,`No advice can be given: ${why.join(' ')}`);
    const locale=String(u.locale||'en').slice(0,2), ctx=await A.adviceContext(scope,v);
    let made; try { made=await A.produceAdvice({view:v,ctx,maxPct,question,locale}); } catch(e) { throw aiHttpError(e); }
    const fp=await F.activeFingerprint(scope), key=id();
    await run('INSERT INTO process_advice (id,company_id,mould_id,equipment_id,product_id,fingerprint_id,fingerprint_version,asked_by,asked_at,question,source,model,drift_score,drift_level,max_step_pct,sources,advice) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,m.company_id,m.id,scope.equipmentId,scope.productId,fp.id,fp.version,u.id,now(),question,made.source,made.model??null,v.drift.score,v.drift.level,maxPct,JSON.stringify(ctx.sources),JSON.stringify(made.advice));
    await audit(u,'process.advice','equipment',m.id,m.company_id,{adviceId:key,source:made.source,equipmentId:scope.equipmentId,productId:scope.productId,driftScore:v.drift.score,maxStepPct:maxPct});
    return created(await adviceRow(await byId('process_advice',key)));
  },{external:true});
  r.get('/moulds/:id/process-advice',async ({u,params,query})=>{
    const m=await mouldFor(u,params.id), eq=query.get('equipmentId'), pr=query.get('productId');
    const rows=await all(`SELECT * FROM process_advice WHERE company_id=? AND mould_id=?${eq?' AND equipment_id=?':''}${pr?' AND product_id=?':''} ORDER BY asked_at DESC LIMIT 20`,m.company_id,m.id,...(eq?[eq]:[]),...(pr?[pr]:[]));
    const out=[]; for (const x of rows) out.push(await adviceRow(x)); return out;
  });
  // The outcome is recorded for later; nothing learns from it yet. The person who asked, or a manager, records it.
  r.post('/process-advice/:id/outcome',async ({u,body,params})=>{
    view(u); const a=await byId('process_advice',params.id); if (!a) missing();
    if (!(isDispatch(u)||u.company_id===a.company_id)) deny();
    if (!(a.asked_by===u.id||canManage(u,a.company_id))) deny();
    const outcome=choice(body.outcome,'outcome',['helped','did_not_help','not_tried']), note=body.note==null?'':String(body.note).slice(0,500);
    await run('UPDATE process_advice SET outcome=?,outcome_note=?,outcome_by=?,outcome_at=? WHERE id=?',outcome,note,u.id,now(),a.id);
    await audit(u,'process.advice.outcome','equipment',a.mould_id,a.company_id,{adviceId:a.id,outcome});
    return await adviceRow(await byId('process_advice',a.id));
  });
}
