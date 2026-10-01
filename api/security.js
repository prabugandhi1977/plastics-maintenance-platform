import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one } from './db.js';

const configuredSecret = process.env.MOULDCARE_SECRET;
if (process.env.NODE_ENV === 'production' && (!configuredSecret || configuredSecret.length < 32)) throw new Error('MOULDCARE_SECRET must be at least 32 characters in production');
const secret = configuredSecret || 'local-demo-secret-change-before-deployment';
export function hashPassword(password, salt=randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
export function verifyPassword(password, hash) { const [salt, hex]=hash.split(':'); return timingSafeEqual(Buffer.from(hex,'hex'),scryptSync(password,salt,64)); }
const sign = data => createHmac('sha256',secret).update(data).digest('base64url');
// Tokens carry the user's session version; changing or resetting a password bumps it, which signs out every
// existing session for that user even though tokens are otherwise stateless.
export function tokenFor(user) { const payload=Buffer.from(JSON.stringify({sub:user.id,sv:user.session_version??0,exp:Date.now()+8*60*60*1000})).toString('base64url'); return `${payload}.${sign(payload)}`; }
export function authenticate(req) {
  const token=(req.headers.authorization || '').replace(/^Bearer /,''); const [payload,signature]=token.split('.');
  if (!payload || !signature) return null;
  const expected=Buffer.from(sign(payload)),received=Buffer.from(signature);
  if (expected.length!==received.length || !timingSafeEqual(expected,received)) return null;
  try {
    const claims=JSON.parse(Buffer.from(payload,'base64url').toString()); if (claims.exp<Date.now()) return null;
    const user=one('SELECT id,name,email,role,company_id,provider_id,service_areas,skills,locale,session_version FROM users WHERE id=? AND active=1',claims.sub);
    return user && claims.sv===user.session_version ? user : null;
  } catch { return null; }
}
export const isPlatform = u => u.role === 'platform_admin';
export const isInternal = u => ['platform_admin','dispatcher','engineer'].includes(u.role);
export const isCustomer = u => ['customer_admin','plant_manager','maintenance'].includes(u.role);
export const isProvider = u => ['provider_admin','provider_engineer'].includes(u.role);
export function canCompany(u,companyId) { return isPlatform(u) || u.role==='dispatcher' || (isCustomer(u) && u.company_id===companyId); }
export function canTicket(u,ticket) { return canCompany(u,ticket.company_id) || (u.role==='engineer' && ticket.assigned_user_id===u.id) || (isProvider(u) && ticket.assigned_provider_id===u.provider_id); }
export function canManageCompany(u,companyId) { return isPlatform(u) || (u.role==='customer_admin' && u.company_id===companyId); }
