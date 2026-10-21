// Machine and signal set-up: add, edit and delete machines and their signals, with basic parameters, sensor details,
// a photo and documents for each. Only the super user (the administrator role) changes any of it; everyone signed in
// can read it and download the files.
import { id, one, all, run, transaction, audit } from './db.js';
import { HttpError, bad, deny, missing, text, choice, optNumber, reply } from './http.js';
import { can } from './auth.js';
import { MACHINE_TYPES, signalsFor, specsFor, MACHINE_SPECS, SENSOR_TYPES, sensorFor } from './catalog.js';
import { forgetAnalysis } from './ml/analyze.js';

const admin = u => { if (!can(u, 'admin')) deny('Only a super user (administrator) can change machine and signal set-up'); };
const machineOr404 = mid => one('SELECT * FROM machines WHERE id=?', mid) ?? missing('Machine not found');
const signalOr404 = (mid, key) => one('SELECT * FROM signals WHERE machine_id=? AND key=?', mid, key) ?? missing('Signal not found');
const opt = (v, name, max) => v == null ? '' : typeof v === 'string' ? (v.length > max ? bad(`${name} is too long (max ${max})`) : v.trim()) : bad(`${name} must be text`);

export const MB = 1024 * 1024;
export const LIMITS = { photo: 5 * MB, document: 15 * MB };

// ---- Validation ----
const tagOf = v => { const t = text(v, 'tag', 32).toUpperCase(); if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(t)) bad('tag may use letters, digits, dot, dash and underscore, e.g. IMM-07'); return t; };
const deviceOf = v => { const d = text(v, 'deviceId', 100); if (!/^[\w.:/@-]+$/.test(d)) bad('deviceId may use letters, digits and . : / @ - _ (no spaces)'); return d; };
const keyOf = v => { const k = text(v, 'key', 50); if (!/^[a-z][a-z0-9_]*$/.test(k)) bad('key must start with a letter and use lower-case letters, digits and underscores, e.g. hydraulic_oil_temp'); return k; };
function yearOf(v) {
  if (v == null || v === '') return null;
  const y = Number(v); if (!Number.isInteger(y) || y < 1950 || y > new Date().getFullYear() + 1) bad(`yearBuilt must be a year from 1950 to ${new Date().getFullYear() + 1}`);
  return y;
}
// Type parameters: each field of the machine type, checked against its range or options. Unknown keys are dropped.
export function specsOf(type, input = {}) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) bad('specs must be an object');
  const out = {};
  for (const p of specsFor(type)) {
    const raw = input[p.key];
    if (raw == null || raw === '') { if (p.required) bad(`${p.label} is required for a ${MACHINE_TYPES[type].toLowerCase()}`); continue; }
    if (p.options) out[p.key] = choice(raw, p.label, p.options);
    else if (p.text) out[p.key] = opt(raw, p.label, 100);
    else { const n = Number(raw); if (!Number.isFinite(n) || n < p.min || n > p.max) bad(`${p.label} must be a number from ${p.min} to ${p.max}${p.unit ? ' ' + p.unit : ''}`); out[p.key] = n; }
  }
  return out;
}
// Warning and critical limits on each side; any may be empty.
export function limitsOf(l, key) {
  const v = Object.fromEntries(['warn_low', 'warn_high', 'crit_low', 'crit_high'].map(k => [k, optNumber(typeof l[k] === 'string' && l[k] !== '' ? Number(l[k]) : l[k], k)]));
  if (v.warn_high != null && v.crit_high != null && v.crit_high < v.warn_high) bad(`${key}: the critical high limit must be at or above the warning high limit`);
  if (v.warn_low != null && v.crit_low != null && v.crit_low > v.warn_low) bad(`${key}: the critical low limit must be at or below the warning low limit`);
  if (v.warn_low != null && v.warn_high != null && v.warn_low >= v.warn_high) bad(`${key}: the low warning must be below the high warning`);
  return v;
}
function sensorOf(b, current = {}) {
  const has = k => b[k] !== undefined;
  const range = { min: has('rangeMin') ? optNumber(b.rangeMin === '' ? null : typeof b.rangeMin === 'string' ? Number(b.rangeMin) : b.rangeMin, 'rangeMin') : current.range_min ?? null,
    max: has('rangeMax') ? optNumber(b.rangeMax === '' ? null : typeof b.rangeMax === 'string' ? Number(b.rangeMax) : b.rangeMax, 'rangeMax') : current.range_max ?? null };
  if (range.min != null && range.max != null && range.min >= range.max) bad('The measuring range minimum must be below its maximum');
  return { sensor_type: has('sensorType') ? (b.sensorType === '' || b.sensorType == null ? '' : choice(b.sensorType, 'sensorType', Object.keys(SENSOR_TYPES))) : current.sensor_type ?? '',
    sensor_make: has('sensorMake') ? opt(b.sensorMake, 'sensorMake', 100) : current.sensor_make ?? '', source_address: has('sourceAddress') ? opt(b.sourceAddress, 'sourceAddress', 200) : current.source_address ?? '',
    notes: has('notes') ? opt(b.notes, 'notes', 2000) : current.notes ?? '', range_min: range.min, range_max: range.max };
}

// ---- Output ----
const fileOut = f => ({ id: f.id, kind: f.kind, signalKey: f.signal_key, filename: f.filename, title: f.title, mime: f.mime, size: f.size, uploadedAt: f.uploaded_at, uploadedBy: f.uploaded_by ? one('SELECT name FROM users WHERE id=?', f.uploaded_by)?.name ?? null : null });
const filesOf = (mid, key) => all(`SELECT id,kind,signal_key,filename,title,mime,size,uploaded_at,uploaded_by FROM files WHERE machine_id=? AND ${key === undefined ? '1' : key === null ? 'signal_key IS NULL' : 'signal_key=?'} ORDER BY kind DESC,uploaded_at DESC`, mid, ...(key ? [key] : [])).map(fileOut);
export const signalOut = (s, files = filesOf(s.machine_id, s.key)) => ({ key: s.key, label: s.label, unit: s.unit, warn_low: s.warn_low, warn_high: s.warn_high, crit_low: s.crit_low, crit_high: s.crit_high,
  sensorType: s.sensor_type, sensorTypeLabel: SENSOR_TYPES[s.sensor_type] ?? '', sensorMake: s.sensor_make, rangeMin: s.range_min, rangeMax: s.range_max, sourceAddress: s.source_address, notes: s.notes,
  photoId: files.find(f => f.kind === 'photo')?.id ?? null, documents: files.filter(f => f.kind === 'document') });
export function machineOut(m) {
  const files = filesOf(m.id), specs = JSON.parse(m.specs || '{}');
  return { id: m.id, tag: m.tag, name: m.name, type: m.type, typeLabel: MACHINE_TYPES[m.type], make: m.make, model: m.model, line: m.line, deviceId: m.device_id, serialNumber: m.serial_number, yearBuilt: m.year_built, notes: m.notes,
    specs, specList: specsFor(m.type).filter(p => specs[p.key] != null).map(p => ({ key: p.key, label: p.label, unit: p.unit, value: specs[p.key] })), createdAt: m.created_at,
    photoId: files.find(f => f.kind === 'photo' && !f.signalKey)?.id ?? null, documents: files.filter(f => f.kind === 'document' && !f.signalKey),
    signals: all('SELECT * FROM signals WHERE machine_id=? ORDER BY rowid', m.id).map(s => signalOut(s, files.filter(f => f.signalKey === s.key))) };
}

// A changed set of signals makes the machine's pattern model stale: drop it so the next analysis retrains.
const invalidate = mid => { run('DELETE FROM models WHERE machine_id=?', mid); forgetAnalysis(mid); };
function insertSignal(mid, s) {
  run('INSERT INTO signals (machine_id,key,label,unit,warn_low,warn_high,crit_low,crit_high,sensor_type,sensor_make,range_min,range_max,source_address,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    mid, s.key, s.label, s.unit, s.warn_low ?? null, s.warn_high ?? null, s.crit_low ?? null, s.crit_high ?? null, s.sensor_type ?? '', s.sensor_make ?? '', s.range_min ?? null, s.range_max ?? null, s.source_address ?? '', s.notes ?? '');
}

// ---- Files ----
// The type is read from the bytes, never taken from the browser: photos are JPEG, PNG or WebP; documents may also be
// PDF, Word or Excel (OOXML), or plain text / CSV.
function sniff(buf) {
  const head = buf.subarray(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (!buf.includes(0) && buf.length) return 'text';
  return null;
}
const OOXML = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export function fileType(buf, filename, kind) {
  const found = sniff(buf), ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (kind === 'photo') { if (!found?.startsWith('image/')) bad('A photo must be a JPEG, PNG or WebP image'); return found; }
  if (found === 'zip') { if (!OOXML[ext]) bad('Only Word (.docx) and Excel (.xlsx) files are accepted from Office'); return OOXML[ext]; }
  if (found === 'text') { if (!['txt', 'csv'].includes(ext)) bad('Text files must end in .txt or .csv'); return ext === 'csv' ? 'text/csv' : 'text/plain'; }
  if (!found) bad('Documents may be PDF, Word (.docx), Excel (.xlsx), text, CSV or images');
  return found;
}
const safeName = n => n.replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

export function registerSetup(r) {
  r.get('/catalog', () => ({ types: MACHINE_TYPES, specs: MACHINE_SPECS, sensorTypes: SENSOR_TYPES, signals: Object.fromEntries(Object.keys(MACHINE_TYPES).map(t => [t, signalsFor(t)])), limits: LIMITS }));
  r.get('/machines', () => all('SELECT * FROM machines ORDER BY tag').map(m => { const x = machineOut(m); return { ...x, signalCount: x.signals.length, signals: undefined }; }));
  r.get('/machines/:id/setup', ({ params }) => machineOut(machineOr404(params.id)));

  r.post('/machines', ({ user, body }) => {
    admin(user);
    const type = choice(body.type, 'type', Object.keys(MACHINE_TYPES)), tag = tagOf(body.tag), deviceId = deviceOf(body.deviceId);
    if (one('SELECT 1 FROM machines WHERE tag=?', tag)) throw new HttpError(409, `Tag ${tag} is already used`);
    if (one('SELECT 1 FROM machines WHERE device_id=?', deviceId)) throw new HttpError(409, `Device ID ${deviceId} is already used by another machine`);
    const m = { id: id(), tag, type, deviceId, name: text(body.name, 'name', 100), make: opt(body.make, 'make', 100), model: opt(body.model, 'model', 100), line: opt(body.line, 'line', 100),
      serial: opt(body.serialNumber, 'serialNumber', 100), year: yearOf(body.yearBuilt), specs: specsOf(type, body.specs ?? {}), notes: opt(body.notes, 'notes', 2000) };
    transaction(() => {
      run('INSERT INTO machines (id,tag,name,type,make,model,line,device_id,created_at,serial_number,year_built,specs,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', m.id, tag, m.name, type, m.make, m.model, m.line, deviceId, new Date().toISOString(), m.serial, m.year, JSON.stringify(m.specs), m.notes);
      // The standard signals for the type, with recommended limits, unless asked for an empty machine.
      if (body.standardSignals !== false) for (const s of signalsFor(type)) insertSignal(m.id, { ...s, sensor_type: sensorFor(s.key) });
    });
    audit(user.id, 'machine.create', 'machine', m.id, { tag, type, deviceId });
    return reply(201, machineOut(machineOr404(m.id)));
  });
  r.patch('/machines/:id', ({ user, params, body }) => {
    admin(user); const m = machineOr404(params.id), has = k => body[k] !== undefined;
    const tag = has('tag') ? tagOf(body.tag) : m.tag, deviceId = has('deviceId') ? deviceOf(body.deviceId) : m.device_id;
    if (body.type !== undefined && body.type !== m.type) bad('The machine type cannot be changed. Add a new machine instead.');
    if (one('SELECT 1 FROM machines WHERE tag=? AND id<>?', tag, m.id)) throw new HttpError(409, `Tag ${tag} is already used`);
    if (one('SELECT 1 FROM machines WHERE device_id=? AND id<>?', deviceId, m.id)) throw new HttpError(409, `Device ID ${deviceId} is already used by another machine`);
    const next = { name: has('name') ? text(body.name, 'name', 100) : m.name, make: has('make') ? opt(body.make, 'make', 100) : m.make, model: has('model') ? opt(body.model, 'model', 100) : m.model,
      line: has('line') ? opt(body.line, 'line', 100) : m.line, serial: has('serialNumber') ? opt(body.serialNumber, 'serialNumber', 100) : m.serial_number, year: has('yearBuilt') ? yearOf(body.yearBuilt) : m.year_built,
      specs: has('specs') ? specsOf(m.type, body.specs) : JSON.parse(m.specs || '{}'), notes: has('notes') ? opt(body.notes, 'notes', 2000) : m.notes };
    run('UPDATE machines SET tag=?,device_id=?,name=?,make=?,model=?,line=?,serial_number=?,year_built=?,specs=?,notes=? WHERE id=?', tag, deviceId, next.name, next.make, next.model, next.line, next.serial, next.year, JSON.stringify(next.specs), next.notes, m.id);
    audit(user.id, 'machine.update', 'machine', m.id, { tag, deviceId }); forgetAnalysis(m.id);
    return machineOut(machineOr404(m.id));
  });
  // Deleting removes the machine with all its readings, findings, models, drafts and files. The tag must be repeated
  // (?confirm=TAG) so a stray request cannot remove a machine.
  r.delete('/machines/:id', ({ user, params, query }) => {
    admin(user); const m = machineOr404(params.id);
    if ((query.get('confirm') || '').toUpperCase() !== m.tag) bad(`To delete this machine, confirm with its tag (${m.tag})`);
    const readings = one('SELECT COUNT(*) n FROM readings WHERE machine_id=?', m.id).n;
    transaction(() => {
      run('DELETE FROM readings WHERE machine_id=?', m.id); run('DELETE FROM states WHERE machine_id=?', m.id);
      run('UPDATE ticket_drafts SET finding_id=NULL WHERE machine_id=?', m.id);
      run('DELETE FROM machines WHERE id=?', m.id);
    });
    audit(user.id, 'machine.delete', 'machine', m.id, { tag: m.tag, name: m.name, readings }); forgetAnalysis(m.id);
    return { deleted: m.tag, readings };
  });

  r.post('/machines/:id/signals', ({ user, params, body }) => {
    admin(user); const m = machineOr404(params.id), key = keyOf(body.key);
    if (one('SELECT 1 FROM signals WHERE machine_id=? AND key=?', m.id, key)) throw new HttpError(409, `${m.tag} already has a signal called ${key}`);
    if (one('SELECT COUNT(*) n FROM signals WHERE machine_id=?', m.id).n >= 40) bad('A machine can have at most 40 signals');
    insertSignal(m.id, { key, label: text(body.label, 'label', 100), unit: opt(body.unit, 'unit', 20), ...limitsOf(body, key), ...sensorOf(body) });
    audit(user.id, 'signal.create', 'machine', m.id, { key }); invalidate(m.id);
    return reply(201, signalOut(signalOr404(m.id, key)));
  });
  r.patch('/machines/:id/signals/:key', ({ user, params, body }) => {
    admin(user); const m = machineOr404(params.id), s = signalOr404(m.id, params.key);
    if (body.key !== undefined && body.key !== s.key) bad('A signal key cannot be changed: gateways send it. Add a new signal instead.');
    const lim = limitsOf({ ...s, ...Object.fromEntries(['warn_low', 'warn_high', 'crit_low', 'crit_high'].filter(k => body[k] !== undefined).map(k => [k, body[k]])) }, s.key), sen = sensorOf(body, s);
    run('UPDATE signals SET label=?,unit=?,warn_low=?,warn_high=?,crit_low=?,crit_high=?,sensor_type=?,sensor_make=?,range_min=?,range_max=?,source_address=?,notes=? WHERE machine_id=? AND key=?',
      body.label !== undefined ? text(body.label, 'label', 100) : s.label, body.unit !== undefined ? opt(body.unit, 'unit', 20) : s.unit, lim.warn_low, lim.warn_high, lim.crit_low, lim.crit_high,
      sen.sensor_type, sen.sensor_make, sen.range_min, sen.range_max, sen.source_address, sen.notes, m.id, s.key);
    audit(user.id, 'signal.update', 'machine', m.id, { key: s.key }); forgetAnalysis(m.id);
    return signalOut(signalOr404(m.id, s.key));
  });
  r.delete('/machines/:id/signals/:key', ({ user, params }) => {
    admin(user); const m = machineOr404(params.id), s = signalOr404(m.id, params.key);
    transaction(() => {
      run('DELETE FROM readings WHERE machine_id=? AND key=?', m.id, s.key);
      run('UPDATE ticket_drafts SET finding_id=NULL WHERE finding_id IN (SELECT id FROM findings WHERE machine_id=? AND signal_key=?)', m.id, s.key);
      run('DELETE FROM findings WHERE machine_id=? AND signal_key=?', m.id, s.key);
      run('DELETE FROM files WHERE machine_id=? AND signal_key=?', m.id, s.key);
      run('DELETE FROM signals WHERE machine_id=? AND key=?', m.id, s.key);
    });
    audit(user.id, 'signal.delete', 'machine', m.id, { key: s.key }); invalidate(m.id);
    return { deleted: s.key };
  });

  // Upload: the file itself is the request body (no base64); name, kind, signal and title come in the query.
  r.post('/machines/:id/files', ({ user, params, query, body }) => {
    admin(user); const m = machineOr404(params.id);
    const kind = choice(query.get('kind'), 'kind', ['photo', 'document']), key = query.get('signal') || null;
    if (key) signalOr404(m.id, key);
    if (!Buffer.isBuffer(body) || !body.length) bad('Send the file as the request body');
    if (body.length > LIMITS[kind]) throw new HttpError(413, `A ${kind} can be at most ${LIMITS[kind] / MB} MB`);
    const filename = safeName(text(query.get('name'), 'name', 200)), mime = fileType(body, filename, kind), fid = id();
    transaction(() => {
      if (kind === 'photo') run(`DELETE FROM files WHERE machine_id=? AND kind='photo' AND ${key ? 'signal_key=?' : 'signal_key IS NULL'}`, m.id, ...(key ? [key] : []));
      run('INSERT INTO files (id,machine_id,signal_key,kind,filename,mime,size,data,title,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', fid, m.id, key, kind, filename, mime, body.length, body, opt(query.get('title') ?? '', 'title', 200), user.id, Date.now());
    });
    audit(user.id, `file.${kind}`, 'machine', m.id, { file: fid, signal: key, filename, size: body.length });
    return reply(201, fileOut(one('SELECT * FROM files WHERE id=?', fid)));
  }, { raw: LIMITS.document });
  // Photos are shown inline, documents downloaded; either is served under a sandbox so a file can never run script.
  r.get('/files/:id', ({ params, res }) => {
    const f = one('SELECT * FROM files WHERE id=?', params.id) ?? missing('File not found');
    const inline = f.kind === 'photo' || f.mime.startsWith('image/') || f.mime === 'application/pdf';
    res.writeHead(200, { 'content-type': f.mime, 'content-length': f.size, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/"/g, '')}"` });
    res.end(Buffer.from(f.data));
  });
  r.delete('/files/:id', ({ user, params }) => {
    admin(user); const f = one('SELECT id,machine_id,kind,filename FROM files WHERE id=?', params.id) ?? missing('File not found');
    run('DELETE FROM files WHERE id=?', f.id); audit(user.id, 'file.delete', 'machine', f.machine_id, { file: f.id, filename: f.filename });
    return { deleted: f.id };
  });
}
