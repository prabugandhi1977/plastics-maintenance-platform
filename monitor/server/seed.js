// Demo plant: six machines with their signals and three demo accounts. Safe to repeat: existing rows are kept.
import { one, run, id, transaction } from './db.js';
import { hashPassword } from './auth.js';
import { signalsFor } from './catalog.js';

export const DEMO_PASSWORD = 'MonitorDemo123!';
export const DEMO_MACHINES = [
  { tag: 'IMM-01', name: 'Engel victory 200', type: 'injection', make: 'Engel', model: 'victory 200', line: 'Hall A · Bay 1', device_id: 'plc-imm-01' },
  { tag: 'IMM-02', name: 'Arburg Allrounder 570', type: 'injection', make: 'Arburg', model: 'Allrounder 570 C', line: 'Hall A · Bay 2', device_id: 'plc-imm-02' },
  { tag: 'EXT-01', name: 'Coperion ZSK 58', type: 'extrusion', make: 'Coperion', model: 'ZSK 58', line: 'Hall B · Line 1', device_id: 'plc-ext-01' },
  { tag: 'BM-01', name: 'Kautex KBS 2-20', type: 'blow', make: 'Kautex', model: 'KBS 2-20', line: 'Hall B · Line 2', device_id: 'plc-bm-01' },
  { tag: 'CH-01', name: 'Frigel Microgel 80', type: 'chiller', make: 'Frigel', model: 'Microgel RSY 80', line: 'Utilities', device_id: 'plc-ch-01' },
  { tag: 'DRY-01', name: 'Motan Luxor CA 120', type: 'dryer', make: 'Motan', model: 'Luxor CA 120', line: 'Hall A · Mezzanine', device_id: 'plc-dry-01' },
];
export const DEMO_USERS = [
  { email: 'admin@monitor.test', name: 'Priya Admin', role: 'admin' },
  { email: 'engineer@monitor.test', name: 'Ravi Engineer', role: 'engineer' },
  { email: 'viewer@monitor.test', name: 'Meera Viewer', role: 'viewer' },
];

export function addMachine(m) {
  const machineId = id();
  run('INSERT INTO machines (id,tag,name,type,make,model,line,device_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)', machineId, m.tag, m.name, m.type, m.make, m.model, m.line, m.device_id, new Date().toISOString());
  for (const s of signalsFor(m.type)) run('INSERT INTO signals (machine_id,key,label,unit,warn_low,warn_high,crit_low,crit_high) VALUES (?,?,?,?,?,?,?,?)', machineId, s.key, s.label, s.unit, s.warn_low ?? null, s.warn_high ?? null, s.crit_low ?? null, s.crit_high ?? null);
  return machineId;
}
export function addUser(u, password) {
  run('INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)', id(), u.email, u.name, u.role, hashPassword(password), new Date().toISOString());
}

// The demo accounts share one published password, so a public site can take the demo machines without them.
export function seedDemo({ accounts = true } = {}) {
  return transaction(() => {
    let added = 0;
    for (const m of DEMO_MACHINES) if (!one('SELECT 1 FROM machines WHERE tag=?', m.tag)) { addMachine(m); added++; }
    if (accounts) for (const u of DEMO_USERS) if (!one('SELECT 1 FROM users WHERE email=?', u.email)) { addUser(u, DEMO_PASSWORD); added++; }
    return added;
  });
}

// First real admin from the environment, for deployments without demo data.
export function bootstrapAdmin() {
  const email = process.env.MONITOR_ADMIN_EMAIL, password = process.env.MONITOR_ADMIN_PASSWORD;
  if (!email || !password || one('SELECT 1 FROM users WHERE email=?', email)) return false;
  if (password.length < 12) throw new Error('MONITOR_ADMIN_PASSWORD must be at least 12 characters');
  addUser({ email, name: 'Administrator', role: 'admin' }, password); return true;
}

if (process.argv[1]?.endsWith('seed.js')) console.log(`Seed: ${seedDemo()} records added. Demo password: ${DEMO_PASSWORD}`);
