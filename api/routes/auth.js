import { now, one, run } from '../db.js';
import { hashPassword, verifyPassword, tokenFor, isCustomer } from '../security.js';
import { audit, byId } from '../access.js';
import { HttpError, bad, email, required } from '../validate.js';

export const LOCALES=['en','de'];
// Failed sign-ins are counted per account (email). Behind a hosting proxy every request arrives from a changing set of
// proxy addresses, so counting per address made the pause unpredictable. In memory: it resets on restart and is per
// instance; a shared store (e.g. Redis) replaces it when the API runs on more than one instance.
const failures=new Map(), WINDOW_MS=15*60*1000, MAX_FAILURES=5;
const DUMMY_HASH=hashPassword('timing-equaliser-not-a-password');
const minutesLeft=f=>Math.max(1,Math.ceil((f.first+WINDOW_MS-Date.now())/60000));
function throttle(address) {
  const f=failures.get(address);
  if (f && Date.now()-f.first>WINDOW_MS) failures.delete(address);
  else if (f && f.count>=MAX_FAILURES) throw Object.assign(new HttpError(429,`Too many wrong passwords for this account. Try again in ${minutesLeft(f)} minute${minutesLeft(f)===1?'':'s'}, or ask an administrator to reset your password.`),{headers:{'retry-after':String(Math.ceil((f.first+WINDOW_MS-Date.now())/1000))}});
}
// After an admin resets a password, the user should not stay paused by earlier failed attempts.
export function clearFailures(address) { failures.delete(address); }
function fail(address) {
  if (failures.size>10000) for (const [k,f] of failures) if (Date.now()-f.first>WINDOW_MS) failures.delete(k);
  const f=failures.get(address), next=f?{...f,count:f.count+1}:{first:Date.now(),count:1}; failures.set(address,next);
  const left=MAX_FAILURES-next.count;
  throw new HttpError(401,left>0&&left<=2?`Email or password is incorrect. ${left} attempt${left===1?'':'s'} left before sign-in is paused for 15 minutes.`:left<=0?'Email or password is incorrect. Sign-in for this account is now paused for 15 minutes.':'Email or password is incorrect.');
}
// Passwords set through the app are stored trimmed; one pasted into a hosting dashboard may carry stray spaces.
// Accept either form so a copy-paste difference never locks someone out.
const passwordMatches=(raw,hash)=>verifyPassword(raw.trim(),hash)||(raw!==raw.trim()&&verifyPassword(raw,hash));
export function preferences(u) {
  const c=u.company_id?byId('companies',u.company_id):null;
  return {locale:u.locale||c?.locale||'en',timezone:c?.timezone||'UTC',currency:c?.currency||'USD',units:c?.units||'metric'};
}
const profile=u=>({id:u.id,name:u.name,email:u.email,role:u.role,companyId:u.company_id,providerId:u.provider_id,mustChangePassword:!!u.must_change_password,preferences:preferences(u)});

export function register(r) {
  r.get('/health',()=>({ok:true,time:now()}),{public:true});
  // What the sign-in page needs before anyone is signed in: whether demo accounts exist (demo copies only).
  r.get('/config',()=>({demoAccounts:!!one("SELECT 1 FROM users WHERE email='admin@demo.test' AND active=1")}),{public:true});
  r.post('/auth/login',({body})=>{
    const address=email(body.email); if (typeof body.password!=='string'||!body.password||body.password.length>200) bad('Enter your password');
    throttle(address);
    const u=one('SELECT * FROM users WHERE email=? AND active=1',address);
    const ok=passwordMatches(body.password,u?.password_hash??DUMMY_HASH);
    if (!ok||!u) fail(address);
    failures.delete(address);
    return {token:tokenFor(u),user:profile(u)};
  },{public:true});
  r.get('/me',({u})=>profile(one('SELECT * FROM users WHERE id=?',u.id)));
  r.patch('/me',({u,body})=>{
    if (body.locale!==undefined && body.locale!==null && !LOCALES.includes(body.locale)) bad(`locale must be one of: ${LOCALES.join(', ')}`);
    run('UPDATE users SET locale=? WHERE id=?',body.locale??null,u.id);
    return profile(one('SELECT * FROM users WHERE id=?',u.id));
  });
  r.post('/me/password',({u,body})=>{
    const current=one('SELECT password_hash FROM users WHERE id=?',u.id), next=required(body.newPassword,'newPassword',200);
    if (typeof body.currentPassword!=='string'||!passwordMatches(body.currentPassword,current.password_hash)) throw new HttpError(403,'Current password is incorrect');
    if (next.length<12) bad('Password must have at least 12 characters');
    // Signs out all other sessions; the caller gets a fresh token so this one continues.
    run('UPDATE users SET password_hash=?,must_change_password=0,session_version=session_version+1 WHERE id=?',hashPassword(next),u.id);
    audit(u,'user.password_change','user',u.id,isCustomer(u)?u.company_id:null);
    const updated=one('SELECT * FROM users WHERE id=?',u.id);
    return {ok:true,token:tokenFor(updated),user:profile(updated)};
  });
}
