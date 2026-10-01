// Creates the first platform admin from MOULDCARE_ADMIN_EMAIL / MOULDCARE_ADMIN_PASSWORD, so a fresh deployment can be
// set up without the demo seed (whose shared password must never be exposed publicly). Safe to run on every start:
// it does nothing when the variables are unset or the account already exists.
import { id, now, one, run } from './db.js';
import { hashPassword } from './security.js';

const email=(process.env.MOULDCARE_ADMIN_EMAIL||'').trim().toLowerCase(), password=process.env.MOULDCARE_ADMIN_PASSWORD||'';
if (!email) process.exit(0);
if (one('SELECT 1 FROM users WHERE email=?',email)) { console.log(`Platform admin ${email} already exists`); process.exit(0); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('MOULDCARE_ADMIN_EMAIL is not a valid email address');
if (password.length<12) throw new Error('MOULDCARE_ADMIN_PASSWORD must have at least 12 characters');
run('INSERT INTO users (id,company_id,provider_id,name,email,password_hash,role,active,service_areas,skills,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id(),null,null,'Platform Admin',email,hashPassword(password),'platform_admin',1,'[]','[]',now());
console.log(`Created platform admin ${email}. Change the password after first sign-in.`);
