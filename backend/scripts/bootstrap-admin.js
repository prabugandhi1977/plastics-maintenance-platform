// Creates the first platform admin from MOULDCARE_ADMIN_EMAIL / MOULDCARE_ADMIN_PASSWORD, so a fresh deployment can be
// set up without the demo seed (whose shared password must never be exposed publicly). Safe to run on every start:
// it does nothing when the variables are unset or the account already exists.
//
// Recovery: with MOULDCARE_ADMIN_RESET_PASSWORD=true, an existing admin with that email gets the configured password
// again (re-activated, signed out everywhere, asked to choose a new password at sign-in). Remove the flag afterwards.
import { id, now, one, run } from '../common/db.js';
import { hashPassword } from '../common/security.js';

const email=(process.env.MOULDCARE_ADMIN_EMAIL||'').trim().toLowerCase(), password=(process.env.MOULDCARE_ADMIN_PASSWORD||'').trim();
const resetRequested=process.env.MOULDCARE_ADMIN_RESET_PASSWORD==='true';
if (!email) process.exit(0);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('MOULDCARE_ADMIN_EMAIL is not a valid email address');
const existing=await one('SELECT id,role FROM users WHERE email=?',email);
if (existing && !resetRequested) { console.log(`Platform admin ${email} already exists`); process.exit(0); }
if (password.length<12) throw new Error('MOULDCARE_ADMIN_PASSWORD must have at least 12 characters');
if (existing) {
  if (existing.role!=='platform_admin') throw new Error(`${email} is not a platform admin; refusing to reset it from the environment`);
  await run('UPDATE users SET password_hash=?,active=1,must_change_password=1,session_version=session_version+1 WHERE id=?',hashPassword(password),existing.id);
  console.log(`Reset password for platform admin ${email}. Sign in, choose a new password, then remove MOULDCARE_ADMIN_RESET_PASSWORD.`);
  process.exit(0);
}
await run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at,must_change_password) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)',id(),null,null,'Platform Admin',email,hashPassword(password),'platform_admin',1,'[]','[]',now());
console.log(`Created platform admin ${email}. Change the password after first sign-in.`);
