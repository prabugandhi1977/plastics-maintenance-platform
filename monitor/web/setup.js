// Machine and signal set-up, under Settings and for the super user (administrator) only: add, edit and delete
// machines and signals, with their parameters, sensor details, photos and documents. Everyone else sees a
// read-only details card on each machine's page, with the photo and documents to download.
import { icon, tile, heading } from '/icons.js';
let ctx; // { api, esc, state, render }
export const initSetup = c => { ctx = c; };
const esc = v => ctx.esc(v);
const isAdmin = () => ctx.state.user?.role === 'admin';
let catalog = null;
const cat = async () => catalog ??= await ctx.api('/catalog');
const size = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;
const num = v => v == null || v === '' ? '—' : String(v);
export const btn = (act, label, ico, { cls = 'sm', data = {} } = {}) => `<button class="btn ${cls}" type="button" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')}>${icon(ico, 'bi')}<span>${label}</span></button>`;
const TYPE_ICON = { injection: 'machine', extrusion: 'machine', blow: 'machine', chiller: 'sensor', dryer: 'sensor', compressor: 'sensor' };

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
const photo = (id, alt, cls = 'photo') => id ? `<img class="${cls}" data-file="${esc(id)}" alt="${esc(alt)}">` : `<div class="${cls} photo-none" aria-hidden="true">${icon('image')}<span>No photo</span></div>`;
const docList = (docs, empty = 'No documents yet.') => docs.length ? `<ul class="docs">${docs.map(d => `<li>${icon('file', 'i doc-i')}<a href="#" data-act="file-get" data-id="${esc(d.id)}" data-name="${esc(d.filename)}">${esc(d.title || d.filename)}</a> <span class="small muted">${esc(d.title ? d.filename + ' · ' : '')}${size(d.size)} · ${new Date(d.uploadedAt).toLocaleDateString()}${d.uploadedBy ? ' · ' + esc(d.uploadedBy) : ''}</span>
  <span class="row">${btn('file-get', 'Download', 'download', { data: { id: d.id, name: d.filename } })}${isAdmin() ? btn('file-del', 'Remove', 'trash', { cls: 'sm danger', data: { id: d.id, name: d.filename } }) : ''}</span></li>`).join('')}</ul>` : `<p class="small muted">${empty}</p>`;
const factsOf = m => [['Type', m.typeLabel], ['Make / model', `${m.make} ${m.model}`.trim() || '—'], ['Serial number', m.serialNumber || '—'], ['Year built', num(m.yearBuilt)], ['Line / location', m.line || '—'],
  ['Device ID', `<code>${esc(m.deviceId)}</code>`, true], ...m.specList.map(p => [p.label, `${typeof p.value === 'number' ? p.value.toLocaleString() : p.value}${p.unit ? ' ' + p.unit : ''}`])];
const detailsBody = (m, edit) => `<div class="details"><figure>${photo(m.photoId, `${m.tag} ${m.name}`)}${edit ? btn('upload', m.photoId ? 'Replace photo' : 'Add photo', 'image', { data: { kind: 'photo', id: m.id } }) : ''}</figure>
  <div class="grid"><dl class="facts">${factsOf(m).map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>${m.notes ? `<p class="small">${esc(m.notes)}</p>` : ''}
  <div><div class="row">${heading('file', 'Documents', 3)}${edit ? btn('upload', 'Add document', 'upload', { data: { kind: 'document', id: m.id } }) : ''}</div>${docList(m.documents, 'No manuals, drawings or certificates yet.')}</div></div></div>`;

// ---- Machine page: read-only details for everyone ----
export async function machineInfo(mid) {
  const m = await ctx.api(`/machines/${mid}/setup`);
  return `<section class="card"><div class="row">${heading('machine', 'Machine details')}${isAdmin() ? `<a class="btn sm" href="#/settings/machine/${esc(m.id)}">${icon('settings', 'bi')}<span>Set up</span></a>` : ''}</div>${detailsBody(m, false)}</section>`;
}

// ---- Settings › Machines ----
export async function machinesTab() {
  const list = await ctx.api('/machines');
  return `<section class="card"><div class="row">${heading('machine', `Machines <span class="count-chip">${list.length}</span>`)}${btn('machine-new', 'Add machine', 'plus', { cls: 'sm primary' })}</div>
    <p class="small muted">Add a machine, then connect its gateway with the device ID. Open a machine to edit it, add its photo and documents, and set up its signals.</p>
    ${list.length ? `<div class="grid machines">${list.map(m => `<a class="card machine-tile" href="#/settings/machine/${esc(m.id)}">${photo(m.photoId, `${m.tag} ${m.name}`, 'thumb')}
      <div><div class="row"><b class="grow"><span class="tag">${esc(m.tag)}</span> <span class="sub">${esc(m.name)}</span></b>${icon('chevron', 'i muted')}</div>
      <div class="sub">${icon(TYPE_ICON[m.type], 'i xs')} ${esc(m.typeLabel)}${m.make || m.model ? ` · ${esc(m.make)} ${esc(m.model)}` : ''}${m.line ? ` · ${esc(m.line)}` : ''}</div>
      <div class="small muted meta">${icon('signal', 'i xs')} ${m.signalCount} signal${m.signalCount === 1 ? '' : 's'} ${icon('file', 'i xs')} ${m.documents.length} document${m.documents.length === 1 ? '' : 's'} ${icon('plug', 'i xs')} <code>${esc(m.deviceId)}</code></div></div></a>`).join('')}</div>`
      : '<div class="empty">No machines yet. Choose “Add machine” to start.</div>'}</section>`;
}
export async function machineSetup(mid) {
  const m = await ctx.api(`/machines/${mid}/setup`);
  return `<p><a href="#/settings/machines">${icon('back', 'i xs')} All machines</a></p>
    <section class="card"><div class="row">${heading('machine', `${esc(m.tag)} · ${esc(m.name)}`)}<a class="btn sm" href="#/machine/${esc(m.id)}">${icon('signal', 'bi')}<span>Monitoring</span></a>
      ${btn('machine-edit', 'Edit', 'edit', { data: { id: m.id } })}${btn('machine-del', 'Delete machine', 'trash', { cls: 'sm danger', data: { id: m.id, tag: m.tag } })}</div>${detailsBody(m, true)}</section>
    ${signalTable(m)}`;
}

// ---- Settings › Signals ----
export async function signalsTab(mid) {
  const list = await ctx.api('/machines');
  if (!list.length) return '<section class="card empty">Add a machine first, under Machines.</section>';
  const current = list.find(m => m.id === mid) ?? list[0], m = await ctx.api(`/machines/${current.id}/setup`);
  return `<section class="card"><div class="row">${heading('signal', 'Choose a machine')}</div>
    <div class="pickers">${list.map(x => `<a class="pick ${x.id === m.id ? 'on' : ''}" href="#/settings/signals/${esc(x.id)}" ${x.id === m.id ? 'aria-current="page"' : ''}>${icon(TYPE_ICON[x.type], 'i xs')}<b>${esc(x.tag)}</b><span class="muted">${x.signalCount}</span></a>`).join('')}</div></section>
    ${signalTable(m)}`;
}
function signalTable(m) {
  const lim = s => [s.crit_low, s.warn_low, s.warn_high, s.crit_high].map(num).join(' / ');
  return `<section class="card"><div class="row">${heading('signal', `Signal set-up · ${esc(m.tag)} <span class="count-chip">${m.signals.length}</span>`)}${btn('signal-new', 'Add signal', 'plus', { cls: 'sm primary', data: { id: m.id } })}</div>
    <p class="small muted">What each sensor measures and where its value comes from. Gateways send values under the signal key with device ID <code>${esc(m.deviceId)}</code>.</p>
    ${m.signals.length ? `<div class="table-wrap"><table><thead><tr><th>Signal</th><th>Key</th><th>Sensor</th><th>Range</th><th>Source</th><th>Limits <span class="muted">crit / warn low · warn / crit high</span></th><th>Files</th><th></th></tr></thead><tbody>
    ${m.signals.map(s => `<tr><td><b>${esc(s.label)}</b> <span class="muted">${esc(s.unit)}</span>${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ''}</td><td><code>${esc(s.key)}</code></td>
      <td>${s.sensorTypeLabel ? `${icon('sensor', 'i xs')} ${esc(s.sensorTypeLabel)}` : '—'}${s.sensorMake ? `<div class="small muted">${esc(s.sensorMake)}</div>` : ''}</td><td class="num">${s.rangeMin != null || s.rangeMax != null ? `${num(s.rangeMin)} – ${num(s.rangeMax)} ${esc(s.unit)}` : '—'}</td>
      <td>${s.sourceAddress ? `<code class="small">${esc(s.sourceAddress)}</code>` : '—'}</td><td class="num small">${lim(s)}</td>
      <td>${btn('signal-files', `${s.photoId ? 'Photo' : ''}${s.photoId && s.documents.length ? ' + ' : ''}${s.documents.length ? `${s.documents.length} doc${s.documents.length > 1 ? 's' : ''}` : s.photoId ? '' : 'Add'}`, s.photoId ? 'image' : 'file', { data: { id: m.id, key: s.key } })}</td>
      <td><span class="row nowrap">${btn('signal-edit', 'Edit', 'edit', { data: { id: m.id, key: s.key } })}${btn('signal-del', 'Delete', 'trash', { cls: 'sm danger', data: { id: m.id, key: s.key, label: s.label } })}</span></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No signals yet. Choose “Add signal”.</p>'}</section>`;
}

// ---- Dialogs ----
export function dialog(title, body, { submit = 'Save', onSubmit, onOpen, wide = false, dlgIcon = 'settings', submitIcon = 'check' } = {}) {
  document.getElementById('dlg')?.remove();
  const d = document.createElement('dialog'); d.id = 'dlg'; d.className = `dlg${wide ? ' wide' : ''}`;
  d.innerHTML = `<form method="dialog" class="grid"><div class="row">${heading(dlgIcon, esc(title))}<button class="btn sm icon-only" type="button" data-close aria-label="Close">${icon('x', 'bi')}</button></div>
    <div class="grid">${body}</div><div class="error" hidden></div>
    <div class="row"><span class="grow"></span><button class="btn" type="button" data-close>${onSubmit ? 'Cancel' : 'Close'}</button>${onSubmit ? `<button class="btn primary">${icon(submitIcon, 'bi')}<span>${esc(submit)}</span></button>` : ''}</div></form>`;
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
export const field = (name, label, { value = '', type = 'text', required = false, help = '', ...rest } = {}) =>
  `<label><span>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span><input type="${type}" name="${name}" value="${esc(value ?? '')}" ${required ? 'required' : ''} ${Object.entries(rest).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}>${help ? `<small class="muted">${esc(help)}</small>` : ''}</label>`;
export const select = (name, label, options, { value = '', required = false, blank = '—' } = {}) =>
  `<label><span>${esc(label)}${required ? ' <span class="req">*</span>' : ''}</span><select name="${name}" ${required ? 'required' : ''}>${required ? '' : `<option value="">${esc(blank)}</option>`}${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
export const textarea = (name, label, value = '') => `<label class="span">${esc(label)}<textarea name="${name}" rows="2" maxlength="2000">${esc(value ?? '')}</textarea></label>`;

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
  dialog(m ? `Edit ${m.tag}` : 'Add machine', body, { wide: true, submit: m ? 'Save' : 'Add machine', dlgIcon: 'machine', submitIcon: m ? 'check' : 'plus',
    onOpen: d => d.querySelector('[name=type]')?.addEventListener('change', e => { d.querySelector('#spec-fields').innerHTML = specFields(c, e.target.value); }),
    onSubmit: async fd => {
      const v = Object.fromEntries(fd), out = { tag: v.tag, name: v.name, deviceId: v.deviceId, make: v.make, model: v.model, serialNumber: v.serialNumber, line: v.line, notes: v.notes, yearBuilt: v.yearBuilt === '' ? null : Number(v.yearBuilt), specs: specsFrom(fd) };
      if (m) await ctx.api(`/machines/${m.id}`, 'PATCH', out);
      else { const r = await ctx.api('/machines', 'POST', { ...out, type: v.type, standardSignals: fd.has('standardSignals') }); location.hash = `#/settings/machine/${r.id}`; }
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
  dialog(s ? `Edit ${s.label}` : `Add signal to ${m.tag}`, body, { wide: true, submit: s ? 'Save' : 'Add signal', dlgIcon: 'signal', submitIcon: s ? 'check' : 'plus',
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
    ${kind === 'document' ? field('title', 'Title', { maxlength: 200, help: 'e.g. Operating manual, Calibration certificate 2026' }) : ''}`, { submit: 'Upload', dlgIcon: kind === 'photo' ? 'image' : 'file', submitIcon: 'upload',
    onSubmit: async fd => {
      const f = fd.get('file'); if (!f?.size) throw new Error('Choose a file');
      if (f.size > c.limits[kind]) throw new Error(`The file is ${size(f.size)}; the limit is ${max} MB`);
      const q = new URLSearchParams({ kind, name: f.name, ...(signalKey ? { signal: signalKey } : {}), ...(fd.get('title') ? { title: fd.get('title') } : {}) });
      const r = await fetch(`/api/machines/${mid}/files?${q}`, { method: 'POST', headers: { authorization: `Bearer ${ctx.state.token}`, 'content-type': f.type || 'application/octet-stream' }, body: f });
      const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || `Upload failed (${r.status})`);
    } });
}

function signalFiles(m, s) {
  dialog(`${s.label}: photo and documents`, `<div class="details small-photo"><figure>${photo(s.photoId, s.label)}${btn('upload', s.photoId ? 'Replace photo' : 'Add photo', 'image', { data: { kind: 'photo', id: m.id, key: s.key } })}</figure>
    <div><div class="row">${heading('file', 'Documents', 3)}${btn('upload', 'Add document', 'upload', { data: { kind: 'document', id: m.id, key: s.key } })}</div>${docList(s.documents, 'No data sheets or calibration certificates yet.')}</div></div>`,
    { dlgIcon: 'sensor', onOpen: d => { loadImages(); bind(d); } });
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
    const r = await ctx.api(`/machines/${id}?confirm=${encodeURIComponent(typed)}`, 'DELETE'); alert(`${r.deleted} deleted, with ${r.readings.toLocaleString()} readings.`); location.hash = '#/settings/machines'; return;
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
