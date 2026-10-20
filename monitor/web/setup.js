// Machine and signal set-up: the Machines page, and on each machine's page its details, photo, documents and the
// signals with their sensor details. Administrators add, edit and delete machines and signals; engineers add and
// remove photos and documents; everyone can view and download.
let ctx; // { api, esc, state, render }
export const initSetup = c => { ctx = c; };
const esc = v => ctx.esc(v);
const isAdmin = () => ctx.state.user?.role === 'admin';
const canFiles = () => ['admin', 'engineer'].includes(ctx.state.user?.role);
let catalog = null;
const cat = async () => catalog ??= await ctx.api('/catalog');
const size = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;
const num = v => v == null || v === '' ? '—' : String(v);

// ---- Pictures and downloads (the API needs the sign-in token, so files are fetched, not linked) ----
const blobs = new Map();
async function fileBlob(id) {
  if (!blobs.has(id)) blobs.set(id, fetch(`/api/files/${id}`, { headers: { authorization: `Bearer ${ctx.state.token}` } }).then(r => { if (!r.ok) throw new Error('Could not load the file'); return r.blob(); }).catch(e => { blobs.delete(id); throw e; }));
  return blobs.get(id);
}
export function loadImages() {
  document.querySelectorAll('img[data-file]:not([src])').forEach(img => fileBlob(img.dataset.file).then(b => { img.src = URL.createObjectURL(b); }).catch(() => img.replaceWith(Object.assign(document.createElement('span'), { className: 'photo-none', textContent: 'Photo unavailable' }))));
}
async function download(id, name) {
  const url = URL.createObjectURL(await fileBlob(id)), a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const photo = (id, alt, cls = 'photo') => id ? `<img class="${cls}" data-file="${esc(id)}" alt="${esc(alt)}">` : `<div class="${cls} photo-none" aria-hidden="true">No photo</div>`;
const docList = (docs, empty = 'No documents yet.') => docs.length ? `<ul class="docs">${docs.map(d => `<li><a href="#" data-act="file-get" data-id="${esc(d.id)}" data-name="${esc(d.filename)}">${esc(d.title || d.filename)}</a> <span class="small muted">${esc(d.title ? d.filename + ' · ' : '')}${size(d.size)} · ${new Date(d.uploadedAt).toLocaleDateString()}${d.uploadedBy ? ' · ' + esc(d.uploadedBy) : ''}</span>${canFiles() ? ` <button class="btn sm danger" type="button" data-act="file-del" data-id="${esc(d.id)}" data-name="${esc(d.filename)}">Remove</button>` : ''}</li>`).join('')}</ul>` : `<p class="small muted">${empty}</p>`;

// ---- Machines page ----
export async function pageMachines() {
  const list = await ctx.api('/machines');
  return `<div class="head"><div class="grow"><h1>Machines</h1><p>Every monitored machine with its basic data, photo, documents and signals.${isAdmin() ? ' Add a machine here, then connect its gateway with the device ID.' : ''}</p></div>
      ${isAdmin() ? '<button class="btn primary" type="button" data-act="machine-new">Add machine</button>' : ''}</div>
    ${list.length ? `<section class="grid machines">${list.map(m => `<a class="card machine-tile" href="#/machine/${esc(m.id)}">${photo(m.photoId, `${m.tag} ${m.name}`, 'thumb')}
      <div><div class="row"><b class="grow"><span class="tag">${esc(m.tag)}</span> <span class="sub">${esc(m.name)}</span></b></div>
      <div class="sub">${esc(m.typeLabel)}${m.make || m.model ? ` · ${esc(m.make)} ${esc(m.model)}` : ''}${m.line ? ` · ${esc(m.line)}` : ''}</div>
      <div class="small muted">${m.signalCount} signal${m.signalCount === 1 ? '' : 's'} · ${m.documents.length} document${m.documents.length === 1 ? '' : 's'} · device <code>${esc(m.deviceId)}</code></div></div></a>`).join('')}</section>`
      : `<div class="card empty">No machines yet.${isAdmin() ? ' Choose “Add machine” to start.' : ''}</div>`}`;
}

// ---- On the machine page ----
export async function machineSections(mid) {
  const m = await ctx.api(`/machines/${mid}/setup`);
  const facts = [['Type', m.typeLabel], ['Make / model', `${m.make} ${m.model}`.trim() || '—'], ['Serial number', m.serialNumber || '—'], ['Year built', num(m.yearBuilt)], ['Line / location', m.line || '—'],
    ['Device ID', `<code>${esc(m.deviceId)}</code>`, true], ...m.specList.map(p => [p.label, `${typeof p.value === 'number' ? p.value.toLocaleString() : p.value}${p.unit ? ' ' + p.unit : ''}`])];
  const details = `<section class="card"><div class="row"><h2 class="grow">Machine details</h2>${isAdmin() ? `<button class="btn sm" type="button" data-act="machine-edit" data-id="${esc(m.id)}">Edit</button><button class="btn sm danger" type="button" data-act="machine-del" data-id="${esc(m.id)}" data-tag="${esc(m.tag)}">Delete machine</button>` : ''}</div>
    <div class="details"><figure>${photo(m.photoId, `${m.tag} ${m.name}`)}${canFiles() ? `<button class="btn sm" type="button" data-act="upload" data-kind="photo" data-id="${esc(m.id)}">${m.photoId ? 'Replace photo' : 'Add photo'}</button>` : ''}</figure>
      <div class="grid"><dl class="facts">${facts.map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>${m.notes ? `<p class="small">${esc(m.notes)}</p>` : ''}
      <div><div class="row"><h3 class="grow">Documents</h3>${canFiles() ? `<button class="btn sm" type="button" data-act="upload" data-kind="document" data-id="${esc(m.id)}">Add document</button>` : ''}</div>${docList(m.documents, 'No manuals, drawings or certificates yet.')}</div></div></div></section>`;
  const lim = s => [s.crit_low, s.warn_low, s.warn_high, s.crit_high].map(num).join(' / ');
  const signals = `<section class="card"><div class="row"><h2 class="grow">Signal set-up</h2>${isAdmin() ? `<button class="btn sm primary" type="button" data-act="signal-new" data-id="${esc(m.id)}">Add signal</button>` : ''}</div>
    <p class="small muted">What each sensor measures and where its value comes from. Gateways send values under the signal key with device ID <code>${esc(m.deviceId)}</code>.</p>
    ${m.signals.length ? `<div class="table-wrap"><table><thead><tr><th>Signal</th><th>Key</th><th>Sensor</th><th>Range</th><th>Source</th><th>Limits <span class="muted">crit / warn low · warn / crit high</span></th><th>Files</th><th></th></tr></thead><tbody>
    ${m.signals.map(s => `<tr><td><b>${esc(s.label)}</b> <span class="muted">${esc(s.unit)}</span>${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ''}</td><td><code>${esc(s.key)}</code></td>
      <td>${esc(s.sensorTypeLabel || '—')}${s.sensorMake ? `<div class="small muted">${esc(s.sensorMake)}</div>` : ''}</td><td class="num">${s.rangeMin != null || s.rangeMax != null ? `${num(s.rangeMin)} – ${num(s.rangeMax)} ${esc(s.unit)}` : '—'}</td>
      <td>${s.sourceAddress ? `<code class="small">${esc(s.sourceAddress)}</code>` : '—'}</td><td class="num small">${lim(s)}</td>
      <td><button class="btn sm" type="button" data-act="signal-files" data-id="${esc(m.id)}" data-key="${esc(s.key)}">${s.photoId ? 'Photo' : ''}${s.photoId && s.documents.length ? ' + ' : ''}${s.documents.length ? `${s.documents.length} doc${s.documents.length > 1 ? 's' : ''}` : s.photoId ? '' : 'None'}</button></td>
      <td class="row">${isAdmin() ? `<button class="btn sm" type="button" data-act="signal-edit" data-id="${esc(m.id)}" data-key="${esc(s.key)}">Edit</button><button class="btn sm danger" type="button" data-act="signal-del" data-id="${esc(m.id)}" data-key="${esc(s.key)}" data-label="${esc(s.label)}">Delete</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No signals yet.</p>'}</section>`;
  return { machine: m, details, signals };
}

// ---- Dialogs ----
function dialog(title, body, { submit = 'Save', onSubmit, onOpen, wide = false } = {}) {
  document.getElementById('dlg')?.remove();
  const d = document.createElement('dialog'); d.id = 'dlg'; d.className = `dlg${wide ? ' wide' : ''}`;
  d.innerHTML = `<form method="dialog" class="grid"><div class="row"><h2 class="grow">${esc(title)}</h2><button class="btn sm" type="button" data-close aria-label="Close">✕</button></div>
    <div class="grid">${body}</div><div class="error" hidden></div>
    <div class="row"><span class="grow"></span><button class="btn" type="button" data-close>${onSubmit ? 'Cancel' : 'Close'}</button>${onSubmit ? `<button class="btn primary">${esc(submit)}</button>` : ''}</div></form>`;
  document.body.append(d);
  d.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => d.close()));
  d.addEventListener('close', () => d.remove());
  const form = d.querySelector('form'), err = d.querySelector('.error');
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (!onSubmit) return d.close();
    const btn = form.querySelector('button.primary'); btn.disabled = true; err.hidden = true;
    try { await onSubmit(new FormData(form), form); d.close(); ctx.render(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; }
  });
  d.showModal(); onOpen?.(d); return d;
}
const field = (name, label, { value = '', type = 'text', required = false, help = '', ...rest } = {}) =>
  `<label><span>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span><input type="${type}" name="${name}" value="${esc(value ?? '')}" ${required ? 'required' : ''} ${Object.entries(rest).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}>${help ? `<small class="muted">${esc(help)}</small>` : ''}</label>`;
const select = (name, label, options, { value = '', required = false, blank = '—' } = {}) =>
  `<label><span>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span><select name="${name}" ${required ? 'required' : ''}>${required ? '' : `<option value="">${esc(blank)}</option>`}${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const textarea = (name, label, value = '') => `<label class="span">${esc(label)}<textarea name="${name}" rows="2" maxlength="2000">${esc(value ?? '')}</textarea></label>`;

function specFields(c, type, values = {}) {
  const ps = c.specs[type] || [];
  return ps.length ? `<fieldset class="form-grid span"><legend>Parameters for this ${esc(c.types[type].toLowerCase())}</legend>${ps.map(p => p.options
    ? select(`spec.${p.key}`, p.label, p.options.map(o => [o, o]), { value: values[p.key], required: p.required })
    : field(`spec.${p.key}`, `${p.label}${p.unit ? ` (${p.unit})` : ''}`, { value: values[p.key], type: p.text ? 'text' : 'number', required: p.required, ...(p.text ? { maxlength: 100 } : { step: 'any', min: p.min, max: p.max }) })).join('')}</fieldset>` : '';
}
const specsFrom = fd => Object.fromEntries([...fd].filter(([k, v]) => k.startsWith('spec.') && v !== '').map(([k, v]) => [k.slice(5), v]));

export async function machineForm(m) {
  const c = await cat(), type = m?.type ?? 'injection';
  const body = `<div class="form-grid">${field('tag', 'Tag', { value: m?.tag, required: true, maxlength: 32, help: 'Short unique name, e.g. IMM-07' })}${field('name', 'Name', { value: m?.name, required: true, maxlength: 100 })}
    ${m ? `<label>Type<input type="text" value="${esc(m.typeLabel)}" disabled><small class="muted">Fixed once added</small></label>` : select('type', 'Type', Object.entries(c.types), { value: type, required: true })}
    ${field('deviceId', 'Device ID', { value: m?.deviceId, required: true, maxlength: 100, help: 'What the gateway sends as “device”' })}
    ${field('make', 'Make', { value: m?.make, maxlength: 100 })}${field('model', 'Model', { value: m?.model, maxlength: 100 })}${field('serialNumber', 'Serial number', { value: m?.serialNumber, maxlength: 100 })}
    ${field('yearBuilt', 'Year built', { value: m?.yearBuilt, type: 'number', min: 1950, max: new Date().getFullYear() + 1 })}${field('line', 'Line / location', { value: m?.line, maxlength: 100 })}
    <div class="span" id="spec-fields">${specFields(c, type, m?.specs)}</div>${textarea('notes', 'Notes', m?.notes)}
    ${m ? '' : `<label class="check span"><input type="checkbox" name="standardSignals" checked> Add the standard signals for this type, with recommended limits</label>`}</div>`;
  dialog(m ? `Edit ${m.tag}` : 'Add machine', body, { wide: true, submit: m ? 'Save' : 'Add machine',
    onOpen: d => d.querySelector('[name=type]')?.addEventListener('change', e => { d.querySelector('#spec-fields').innerHTML = specFields(c, e.target.value); }),
    onSubmit: async fd => {
      const v = Object.fromEntries(fd), out = { tag: v.tag, name: v.name, deviceId: v.deviceId, make: v.make, model: v.model, serialNumber: v.serialNumber, line: v.line, notes: v.notes, yearBuilt: v.yearBuilt === '' ? null : Number(v.yearBuilt), specs: specsFrom(fd) };
      if (m) await ctx.api(`/machines/${m.id}`, 'PATCH', out);
      else { const r = await ctx.api('/machines', 'POST', { ...out, type: v.type, standardSignals: fd.has('standardSignals') }); location.hash = `#/machine/${r.id}`; }
    } });
}

export async function signalForm(m, s) {
  const c = await cat(), have = new Set(m.signals.map(x => x.key)), suggestions = (c.signals[m.type] || []).filter(x => !have.has(x.key));
  const body = `${!s && suggestions.length ? `<label>Start from a standard signal<select id="sig-pick"><option value="">— custom signal —</option>${suggestions.map(x => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('')}</select></label>` : ''}
    <div class="form-grid">${s ? `<label>Key<input type="text" value="${esc(s.key)}" disabled><small class="muted">Fixed: gateways send it</small></label>` : field('key', 'Key', { required: true, maxlength: 50, pattern: '[a-z][a-z0-9_]*', help: 'What the gateway sends, e.g. mould_temp_fixed' })}
    ${field('label', 'Name', { value: s?.label, required: true, maxlength: 100 })}${field('unit', 'Unit', { value: s?.unit, maxlength: 20, help: 'e.g. °C, bar, mm/s, A' })}
    ${select('sensorType', 'Sensor type', Object.entries(c.sensorTypes), { value: s?.sensorType })}${field('sensorMake', 'Sensor make / model', { value: s?.sensorMake, maxlength: 100 })}
    ${field('sourceAddress', 'Source address', { value: s?.sourceAddress, maxlength: 200, help: 'PLC tag, OPC UA node ID or MQTT topic' })}
    ${field('rangeMin', 'Measuring range from', { value: s?.rangeMin, type: 'number', step: 'any' })}${field('rangeMax', 'Measuring range to', { value: s?.rangeMax, type: 'number', step: 'any' })}
    <fieldset class="form-grid span"><legend>Limits (any may be empty)</legend>${field('crit_low', 'Critical low', { value: s?.crit_low, type: 'number', step: 'any' })}${field('warn_low', 'Warning low', { value: s?.warn_low, type: 'number', step: 'any' })}
    ${field('warn_high', 'Warning high', { value: s?.warn_high, type: 'number', step: 'any' })}${field('crit_high', 'Critical high', { value: s?.crit_high, type: 'number', step: 'any' })}</fieldset>${textarea('notes', 'Notes', s?.notes)}</div>`;
  dialog(s ? `Edit ${s.label}` : `Add signal to ${m.tag}`, body, { wide: true, submit: s ? 'Save' : 'Add signal',
    onOpen: d => d.querySelector('#sig-pick')?.addEventListener('change', e => {
      const x = suggestions.find(y => y.key === e.target.value); if (!x) return;
      for (const k of ['key', 'label', 'unit', 'warn_low', 'warn_high', 'crit_low', 'crit_high']) d.querySelector(`[name=${k}]`).value = x[k] ?? '';
    }),
    onSubmit: async fd => {
      const v = Object.fromEntries(fd), n = k => v[k] === '' ? null : Number(v[k]);
      const out = { label: v.label, unit: v.unit, sensorType: v.sensorType, sensorMake: v.sensorMake, sourceAddress: v.sourceAddress, notes: v.notes, rangeMin: n('rangeMin'), rangeMax: n('rangeMax'),
        warn_low: n('warn_low'), warn_high: n('warn_high'), crit_low: n('crit_low'), crit_high: n('crit_high') };
      if (s) await ctx.api(`/machines/${m.id}/signals/${encodeURIComponent(s.key)}`, 'PATCH', out);
      else await ctx.api(`/machines/${m.id}/signals`, 'POST', { ...out, key: v.key });
    } });
}

export async function uploadForm(mid, kind, signalKey, label) {
  const c = await cat(), max = c.limits[kind] / 1048576;
  const accept = kind === 'photo' ? 'image/jpeg,image/png,image/webp' : '.pdf,.docx,.xlsx,.txt,.csv,image/jpeg,image/png,image/webp';
  dialog(`${kind === 'photo' ? 'Photo' : 'Document'} for ${label}`, `<label><span>File <span class="req">*</span></span><input type="file" name="file" accept="${accept}" required><small class="muted">${kind === 'photo' ? 'JPEG, PNG or WebP' : 'PDF, Word, Excel, text, CSV or an image'}, up to ${max} MB${kind === 'photo' ? '. Replaces the current photo.' : ''}</small></label>
    ${kind === 'document' ? field('title', 'Title', { maxlength: 200, help: 'e.g. Operating manual, Calibration certificate 2026' }) : ''}`, { submit: 'Upload',
    onSubmit: async fd => {
      const f = fd.get('file'); if (!f?.size) throw new Error('Choose a file');
      if (f.size > c.limits[kind]) throw new Error(`The file is ${size(f.size)}; the limit is ${max} MB`);
      const q = new URLSearchParams({ kind, name: f.name, ...(signalKey ? { signal: signalKey } : {}), ...(fd.get('title') ? { title: fd.get('title') } : {}) });
      const r = await fetch(`/api/machines/${mid}/files?${q}`, { method: 'POST', headers: { authorization: `Bearer ${ctx.state.token}`, 'content-type': f.type || 'application/octet-stream' }, body: f });
      const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || `Upload failed (${r.status})`);
    } });
}

function signalFiles(m, s) {
  dialog(`${s.label}: photo and documents`, `<div class="details small-photo"><figure>${photo(s.photoId, s.label)}${canFiles() ? `<button class="btn sm" type="button" data-act="upload" data-kind="photo" data-id="${esc(m.id)}" data-key="${esc(s.key)}">${s.photoId ? 'Replace photo' : 'Add photo'}</button>` : ''}</figure>
    <div><div class="row"><h3 class="grow">Documents</h3>${canFiles() ? `<button class="btn sm" type="button" data-act="upload" data-kind="document" data-id="${esc(m.id)}" data-key="${esc(s.key)}">Add document</button>` : ''}</div>${docList(s.documents, 'No data sheets or calibration certificates yet.')}</div></div>`,
    { onOpen: d => { loadImages(); bind(d); } });
}

// ---- Actions ----
const machineCache = new Map();
async function setupOf(mid) { const m = await ctx.api(`/machines/${mid}/setup`); machineCache.set(mid, m); return m; }
export const ACTIONS = ['machine-new', 'machine-edit', 'machine-del', 'signal-new', 'signal-edit', 'signal-del', 'signal-files', 'upload', 'file-get', 'file-del'];
export async function action(act, el) {
  const { id, key } = el.dataset;
  if (act === 'machine-new') return machineForm();
  if (act === 'machine-edit') return machineForm(await setupOf(id));
  if (act === 'machine-del') {
    const typed = prompt(`Delete ${el.dataset.tag} with all its readings, findings, signals, photos and documents? This cannot be undone.\n\nType the tag ${el.dataset.tag} to confirm.`);
    if (typed == null) return;
    const r = await ctx.api(`/machines/${id}?confirm=${encodeURIComponent(typed)}`, 'DELETE'); alert(`${r.deleted} deleted, with ${r.readings.toLocaleString()} readings.`); location.hash = '#/machines'; return;
  }
  if (act === 'signal-new') return signalForm(await setupOf(id));
  if (act === 'signal-edit') { const m = await setupOf(id); return signalForm(m, m.signals.find(s => s.key === key)); }
  if (act === 'signal-del') {
    if (!confirm(`Delete the signal “${el.dataset.label}”? Its readings, findings, photo and documents are deleted too, and the pattern model retrains without it.`)) return;
    await ctx.api(`/machines/${id}/signals/${encodeURIComponent(key)}`, 'DELETE'); return ctx.render();
  }
  if (act === 'signal-files') { const m = await setupOf(id); return signalFiles(m, m.signals.find(s => s.key === key)); }
  if (act === 'upload') { const m = machineCache.get(id) ?? await setupOf(id); return uploadForm(id, el.dataset.kind, key || null, key ? m.signals.find(s => s.key === key)?.label ?? key : m.tag); }
  if (act === 'file-get') return download(id, el.dataset.name);
  if (act === 'file-del') { if (!confirm(`Remove ${el.dataset.name}?`)) return; await ctx.api(`/files/${id}`, 'DELETE'); blobs.delete(id); document.getElementById('dlg')?.close(); return ctx.render(); }
}
// Buttons inside a dialog (which is outside the page the main binder covers).
function bind(root) {
  root.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', async e => { e.preventDefault(); try { await action(el.dataset.act, el); } catch (x) { alert(x.message); } }));
}
