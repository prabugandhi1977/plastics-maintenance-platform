import { now, one, run } from '../db.js';
import { hashPassword, verifyPassword, tokenFor, isCustomer } from '../security.js';
import { audit, byId } from '../access.js';
import { HttpError, bad, email, required } from '../validate.js';

export const LOCALES=['en','de'];
// Failed logins per email + client address. In memory, so it resets on restart and is per instance; a shared store
// (e.g. Redis) replaces it when the API runs on more than one instance.
const failures=new Map(), WINDOW_MS=15*60*1000, MAX_FAILURES=5;
const DUMMY_HASH=hashPassword('timing-equaliser-not-a-password');
function throttle(key) {
  const f=failures.get(key);
  if (f && Date.now()-f.first>WINDOW_MS) failures.delete(key);
  else if (f && f.count>=MAX_FAILURES) throw Object.assign(new HttpError(429,'Too many failed sign-in attempts. Try again in 15 minutes.'),{headers:{'retry-after':String(Math.ceil((f.first+WINDOW_MS-Date.now())/1000))}});
}
function fail(key) {
  if (failures.size>10000) for (const [k,f] of failures) if (Date.now()-f.first>WINDOW_MS) failures.delete(k);
  const f=failures.get(key); failures.set(key,f?{...f,count:f.count+1}:{first:Date.now(),count:1});
  throw new HttpError(401,'Invalid credentials');
}
export function preferences(u) {
  const c=u.company_id?byId('companies',u.company_id):null;
  return {locale:u.locale||c?.locale||'en',timezone:c?.timezone||'UTC',currency:c?.currency||'USD',units:c?.units||'metric'};
}
const profile=u=>({id:u.id,name:u.name,email:u.email,role:u.role,companyId:u.company_id,providerId:u.provider_id,preferences:preferences(u)});

export function register(r) {
  r.get('/health',()=>({ok:true,time:now()}),{public:true});
  r.post('/auth/login',({body,req})=>{
    const address=email(body.email), password=required(body.password,'password',200), key=`${address}|${req.socket.remoteAddress}`;
    throttle(key);
    const u=one('SELECT * FROM users WHERE email=? AND active=1',address);
    if (!verifyPassword(password,u?.password_hash??DUMMY_HASH) || !u) fail(key);
    failures.delete(key);
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
    if (!verifyPassword(required(body.currentPassword,'currentPassword',200),current.password_hash)) throw new HttpError(403,'Current password is incorrect');
    if (next.length<12) bad('Password must have at least 12 characters');
    run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(next),u.id);
    audit(u,'user.password_change','user',u.id,isCustomer(u)?u.company_id:null);
    return {ok:true};
  });
}
