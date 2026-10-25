import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one } from './db.js';
import { HttpError } from './http.js';

const configured = process.env.MONITOR_SECRET;
if (process.env.NODE_ENV === 'production' && (!configured || configured.length < 32)) throw new Error('MONITOR_SECRET must be at least 32 characters in production');
const secret = configured || 'local-monitor-secret-change-before-deployment';

export const hashPassword = (pw, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
export function verifyPassword(pw, hash) { const [salt, hex] = hash.split(':'); return timingSafeEqual(Buffer.from(hex, 'hex'), scryptSync(pw, salt, 64)); }
// A key for one purpose (e.g. encrypting stored credentials), derived from MONITOR_SECRET.
export const keyFor = purpose => scryptSync(secret, `mouldcare-monitor:${purpose}`, 32);
const sign = data => createHmac('sha256', secret).update(data).digest('base64url');
const TOKEN_HOURS = 12;
export function tokenFor(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, sv: user.session_version, exp: Date.now() + TOKEN_HOURS * 3600000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function authenticate(req) {
  const [payload, signature] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload)), got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (c.exp < Date.now()) return null;
    const u = one('SELECT id,email,name,role,session_version,active FROM users WHERE id=?', c.sub);
    if (!u || u.session_version !== c.sv || !u.active) return null;
    delete u.active; return u;
  } catch { return null; }
}

// Sign-in lockout: 5 failures per email within 15 minutes locks that email for the rest of the window.
const failures = new Map();
export function checkLockout(email) {
  const f = failures.get(email); const now = Date.now();
  if (f && now - f.first > 15 * 60000) { failures.delete(email); return; }
  if (f && f.count >= 5) throw new HttpError(429, 'Too many failed sign-ins. Try again in 15 minutes.');
}
export function recordFailure(email) { const f = failures.get(email); if (!f) failures.set(email, { first: Date.now(), count: 1 }); else f.count++; }
export const clearFailures = email => failures.delete(email);

// Gateways send readings with the ingest key; compared in constant time.
export function ingestKeyOk(req) {
  const expected = process.env.MONITOR_INGEST_KEY; const got = req.headers['x-ingest-key'];
  if (!expected || typeof got !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const can = (u, ...roles) => roles.includes(u.role);
