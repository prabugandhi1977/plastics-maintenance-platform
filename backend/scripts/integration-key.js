// Creates a company integration key for a trusted system, e.g. MouldCare Monitor sending tickets:
//   npm run integration:key -- "Acme Plastics" "MouldCare Monitor"   (company name or id, then a name for the key)
// The key is printed once; only its hash is stored. Keys are also managed through /api/integration-keys.
import { db, id, now, one, run } from '../common/db.js';
import { newKey } from '../services/core/routes/intake.js';

const [company,name='MouldCare Monitor']=process.argv.slice(2);
if (!company) { console.error('Usage: npm run integration:key -- "<company name or id>" "<key name>"'); process.exit(1); }
const c=await one('SELECT id,name FROM companies WHERE id=? OR lower(name)=lower(?)',company,company);
if (!c) { console.error(`No company ${company}`); await db.close(); process.exit(1); }
const k=newKey(), key=id();
await run('INSERT INTO integration_keys (id,company_id,name,key_hash,key_hint,created_by,created_at) VALUES (?,?,?,?,?,?,?)',key,c.id,name.slice(0,80),k.hash,k.hint,'u-system',now());
await run('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?)',id(),'u-system',c.id,'integration_key.create','integration_key',key,JSON.stringify({via:'script'}),now());
console.log(`Integration key "${name}" for ${c.name} (shown once, keep it secret):\n${k.key}`);
await db.close();
