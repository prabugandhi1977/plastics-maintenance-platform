// Custom dashboards: the list (#/dashboards), one dashboard (#/dashboards/<id>) with its edit mode, and the TV view
// (?tv=1, or #/dashboards/<id>?tv=1): full screen, dark, read-only, refreshed every 30 seconds, with no navigation.
// Widgets read the same API as the rest of the app, so a dashboard never shows more than the person could already open.
import { signalChart, sparkline } from '/charts.js';
import { icon, tile, heading } from '/icons.js';
import { btn, dialog, field, select, textarea } from '/setup.js';
let ctx; // { api, esc, state, render }
export const initDashboards = c => { ctx = c; };
const esc = v => ctx.esc(v);
const api = (...a) => ctx.api(...a);
const ib = (name, label) => `${icon(name, 'bi')}<span>${label}</span>`;
const chip = (cls, label) => `<span class="chip ${esc(cls)}">${esc(label)}</span>`;
const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const HEALTH = { good: 'Good', watch: 'Watch', at_risk: 'At risk' };
const WICON = { signal_chart: 'signal', sparklines: 'trend', machine_health: 'health', findings: 'findings', tickets: 'tickets', kpi: 'overview', note: 'file', machine_grid: 'machine' };
const WHAT = { signal_chart: 'One signal over 24 hours or 7 days, with its limits', sparklines: 'Several signals as small trend tiles', machine_health: 'Health score and state of chosen machines', findings: 'Active findings, by machine or severity',
  tickets: 'Open ticket drafts and approved tickets, by assignee', kpi: 'One number: findings, machines at risk or tickets', note: 'Your own text, such as a handover note', machine_grid: 'A grid of machines coloured by health' };
const newId = () => globalThis.crypto?.randomUUID?.() ?? `w${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

// ---- TV mode and the landing page ----
const hashParts = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
const hashQuery = () => new URLSearchParams(location.hash.split('?')[1] || '');
export const tvActive = () => { const [page, id] = hashParts(); return page === 'dashboards' && !!id && (new URLSearchParams(location.search).get('tv') === '1' || hashQuery().get('tv') === '1'); };
// TV is always dark; leaving it puts the saved theme back.
export function applyTv() {
  const root = document.documentElement, tv = tvActive(), theme = root.dataset.theme || 'auto';
  root.classList.toggle('tv-mode', tv);
  root.classList.toggle('dark', tv || theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
}
// Where to land when the address has no page: the person's own default, else the super user's default for everyone.
export async function landingHash() { const d = await api('/dashboards/default').catch(() => null); return d?.dashboardId ? `#/dashboards/${d.dashboardId}` : null; }
const tvLink = id => `${location.origin}/?tv=1#/dashboards/${id}`;

// ---- Catalog and machines for the pickers ----
let catalogP = null, machinesP = null; const signalsOf = new Map();
const catalog = () => catalogP ??= api('/dashboards/catalog').catch(e => { catalogP = null; throw e; });
const machines = () => machinesP ??= api('/machines').catch(e => { machinesP = null; throw e; });
const signals = async mid => { if (!signalsOf.has(mid)) signalsOf.set(mid, (await api(`/machines/${mid}/setup`)).signals.map(s => ({ key: s.key, label: s.label, unit: s.unit }))); return signalsOf.get(mid); };

// ---- Data the widgets show (the app's own endpoints), fetched once per paint ----
let cache = new Map();
const FETCH = { overview: () => api('/overview'), findings: () => api('/findings?status=active'), tickets: () => api('/tickets'), kpis: () => api('/dashboards/kpis') };
function needs(widgets) {
  const want = new Set(widgets.length ? ['overview'] : []);
  for (const w of widgets) {
    if (w.problems?.length) continue;
    const s = w.settings;
    if (w.type === 'signal_chart') want.add(`series|${s.machineId}|${s.signal}|${s.hours}`);
    else if (w.type === 'sparklines') s.items.forEach(i => want.add(`series|${i.machineId}|${i.signal}|24`));
    else if (w.type === 'findings') want.add('findings');
    else if (w.type === 'tickets') want.add('tickets');
    else if (w.type === 'kpi') want.add('kpis');
  }
  return [...want];
}
async function load(widgets) {
  const res = new Map();
  await Promise.all(needs(widgets).map(async key => {
    if (!cache.has(key)) cache.set(key, (key.startsWith('series|') ? (([, m, s, h]) => api(`/machines/${m}/series?signal=${encodeURIComponent(s)}&hours=${h}`))(key.split('|')) : FETCH[key]()).then(v => ({ v }), e => ({ error: e.message })));
    res.set(key, await cache.get(key));
  }));
  return res;
}

// ---- Widgets ----
const val = (res, key) => { const r = res.get(key); if (!r) throw new Error('No data'); if (r.error) throw new Error(r.error); return r.v; };
const machineLink = (m, tv, label = m.tag) => tv ? `<b>${esc(label)}</b>` : `<a href="#/machine/${esc(m.id)}">${esc(label)}</a>`;
const downsample = (pts, n = 96) => pts.length <= n ? pts : pts.filter((_, i) => i % Math.ceil(pts.length / n) === 0);
const empty = text => `<p class="small muted">${esc(text)}</p>`;
const overviewMachines = (res, ids) => { const all = val(res, 'overview').machines; return ids?.length ? ids.map(i => all.find(m => m.id === i)).filter(Boolean) : all; };
const healthRow = (m, tv) => `<li class="dw-row">${machineLink(m, tv)} <span class="sub grow">${esc(m.name)}</span><span class="dot ${esc(m.state)}" title="${esc(m.state)}"></span>${chip(m.health.status, `${HEALTH[m.health.status]} · ${m.health.score}`)}</li>`;
const KPI_LINK = { open_findings: '#/findings', machines_watch_risk: '#/overview', tickets_awaiting_approval: '#/tickets', tickets_sent_mouldcare: '#/tickets' };
const KPI_TONE = { open_findings: v => v ? 'watch' : 'good', machines_watch_risk: v => v ? 'watch' : 'good', tickets_awaiting_approval: v => v ? 'watch' : 'good', tickets_sent_mouldcare: () => '' };

const BODY = {
  signal_chart(w, res, tv) {
    const s = w.settings, ser = val(res, `series|${s.machineId}|${s.signal}|${s.hours}`), m = val(res, 'overview').machines.find(x => x.id === s.machineId);
    return `<div class="row small"><span class="grow muted">${m ? machineLink(m, tv) + ' · ' : ''}${esc(ser.signal.label)} · ${s.hours === 168 ? '7 days' : '24 hours'}</span><b class="num">${ser.latest ?? '—'} ${esc(ser.signal.unit)}</b></div>${signalChart({ ...ser, unit: ser.signal.unit, limits: s.showLimits ? ser.limits : {} })}`;
  },
  sparklines(w, res, tv) {
    const ms = val(res, 'overview').machines;
    return `<div class="spks">${w.settings.items.map(i => {
      const ser = res.get(`series|${i.machineId}|${i.signal}|24`), m = ms.find(x => x.id === i.machineId);
      if (!ser || ser.error) return `<div class="spk"><span class="small muted">${esc(i.signal)}</span><span class="small">Not available</span></div>`;
      const v = ser.v;
      return `<div class="spk"><div class="small muted">${m ? machineLink(m, tv) + ' · ' : ''}${esc(v.signal.label)}</div><b class="num">${v.latest ?? '—'} <span class="small muted">${esc(v.signal.unit)}</span></b>${sparkline(downsample(v.points), v.assessment?.status)}</div>`;
    }).join('')}</div>`;
  },
  machine_health(w, res, tv) { const list = overviewMachines(res, w.settings.machineIds); return list.length ? `<ul class="dw-list">${list.map(m => healthRow(m, tv)).join('')}</ul>` : empty('No machines yet.'); },
  findings(w, res, tv) {
    const s = w.settings, all = val(res, 'findings').filter(f => (!s.machineId || f.machineId === s.machineId) && (s.severity === 'all' || f.severity === s.severity)), list = all.slice(0, s.limit);
    return list.length ? `<ul class="dw-list">${list.map(f => `<li class="dw-row">${chip(f.severity, f.severity)} <span class="grow">${machineLink({ id: f.machineId, tag: f.machineTag }, tv)} · ${esc(f.title)}<span class="small muted"> · ${ago(f.firstSeen)}</span></span></li>`).join('')}</ul>${all.length > list.length ? `<p class="small muted">${all.length - list.length} more${tv ? '' : ' · <a href="#/findings">All findings</a>'}</p>` : ''}` : empty('No active findings match.');
  },
  tickets(w, res, tv) {
    const s = w.settings, me = ctx.state.user?.id, a = s.assignee;
    const all = val(res, 'tickets').filter(t => (s.status === 'open' ? ['draft', 'approved'].includes(t.status) : t.status === s.status)
      && (a === 'any' || (a === 'me' ? t.assignee?.kind === 'user' && t.assignee.id === me : a === 'none' ? !t.assignee : `${t.assignee?.kind}:${t.assignee?.id}` === a))), list = all.slice(0, s.limit);
    return list.length ? `<ul class="dw-list">${list.map(t => `<li class="dw-row"><span class="grow"><b>${esc(t.draft.title)}</b><span class="small muted"> · ${esc(t.draft.machineTag)} · ${t.assignee ? esc(t.assignee.name) : 'Not assigned'}</span></span>${chip(t.draft.priority === 'critical' || t.draft.priority === 'high' ? 'critical' : 'warning', t.draft.priority)}${chip(t.status, t.status)}</li>`).join('')}</ul>${all.length > list.length ? `<p class="small muted">${all.length - list.length} more${tv ? '' : ' · <a href="#/tickets">All tickets</a>'}</p>` : ''}` : empty('No tickets match.');
  },
  kpi(w, res, tv) {
    const k = val(res, 'kpis'), v = k[w.settings.metric], tone = KPI_TONE[w.settings.metric](v);
    const body = `<div class="kpi-big ${tone}"><div class="v num">${v ?? '—'}</div></div>`;
    return tv ? body : `<a class="kpi-link" href="${KPI_LINK[w.settings.metric]}">${body}</a>`;
  },
  note: w => `<p class="note">${esc(w.settings.text)}</p>`,
  machine_grid(w, res, tv) {
    const list = overviewMachines(res, w.settings.machineIds);
    return list.length ? `<div class="mgrid">${list.map(m => { const t = `<span class="mg-tag">${esc(m.tag)}</span><span class="small">${esc(m.name)}</span><span class="small"><span class="dot ${esc(m.state)}"></span> ${esc(m.state)} · ${m.health.score}</span>`;
      return tv ? `<div class="mg ${m.health.status}">${t}</div>` : `<a class="mg ${m.health.status}" href="#/machine/${esc(m.id)}">${t}</a>`; }).join('')}</div>` : empty('No machines yet.');
  },
};

function widgetCard(w, res, { tv, edit, i, n }) {
  let body;
  if (w.problems?.length) body = `<div class="dw-problem">${icon('findings', 'i xs')} <div><b>Not available</b><br><span class="small">${esc(w.problems.join('. '))}.${edit ? ' Configure it to pick another, or remove it.' : ''}</span></div></div>`;
  else try { body = BODY[w.type](w, res, tv); } catch (e) { body = `<div class="error small">${esc(e.message)}</div>`; }
  const kpi = w.type === 'kpi';
  const tools = edit ? `<div class="dw-tools row">
      <button class="btn sm icon-only dw-handle" type="button" data-handle title="Drag to move" aria-label="Drag ${esc(w.title)} to move it. The up and down buttons do the same from the keyboard.">${icon('grip', 'bi')}</button>
      <button class="btn sm icon-only" type="button" data-act="dash-up" data-wid="${esc(w.id)}" aria-label="Move ${esc(w.title)} up" ${i === 0 ? 'disabled' : ''}>${icon('up', 'bi')}</button>
      <button class="btn sm icon-only" type="button" data-act="dash-down" data-wid="${esc(w.id)}" aria-label="Move ${esc(w.title)} down" ${i === n - 1 ? 'disabled' : ''}>${icon('down', 'bi')}</button>
      <label class="dw-size"><span class="sr-only">Width of ${esc(w.title)}</span><select data-dw="w" data-wid="${esc(w.id)}">${[1, 2, 3, 4].map(x => `<option value="${x}" ${w.size.w === x ? 'selected' : ''}>${x} col</option>`).join('')}</select></label>
      <label class="dw-size"><span class="sr-only">Height of ${esc(w.title)}</span><select data-dw="h" data-wid="${esc(w.id)}">${[1, 2, 3].map(x => `<option value="${x}" ${w.size.h === x ? 'selected' : ''}>${x} row${x > 1 ? 's' : ''}</option>`).join('')}</select></label>
      ${btn('dash-config', 'Configure', 'settings', { data: { wid: w.id } })}${btn('dash-remove', 'Remove', 'trash', { cls: 'sm danger', data: { wid: w.id } })}</div>` : '';
  return `<section class="card dw dw-${w.type}${edit ? ' edit' : ''}${w.problems?.length ? ' bad' : ''}" style="--w:${w.size.w};--h:${w.size.h}" data-w="${w.size.w}" data-wid="${esc(w.id)}" aria-label="${esc(w.title)}">
    <div class="dw-head"><h3 class="grow ${kpi ? 'small muted kpi-title' : ''}">${kpi ? esc(w.title) : `${icon(WICON[w.type], 'i xs')} ${esc(w.title)}`}</h3></div>${tools}<div class="dw-body">${body}</div></section>`;
}

// ---- Edit mode: a draft with an undo history, kept across repaints; the dashboard is only changed on Save ----
let ed = null, focusAfter = null;
const snap = () => JSON.stringify({ name: ed.name, description: ed.description, widgets: ed.widgets });
const dirty = () => snap() !== ed.base;
function commit(fn) { ed.history.push(snap()); if (ed.history.length > 50) ed.history.shift(); fn(); ed.error = ''; }
const startEdit = d => { ed = { id: d.id, name: d.name, description: d.description, widgets: d.widgets.map(w => JSON.parse(JSON.stringify(w))), history: [], error: '' }; ed.base = snap(); };
export const editing = () => !!ed;

// ---- Pages ----
export async function dashboardsPage(arg) {
  const tv = tvActive();
  if (!arg) { ed = null; return listPage(); }
  if (ed && ed.id !== arg) ed = null;
  if (!ed) cache = new Map();
  const d = await api(`/dashboards/${arg}`), edit = !!ed && d.canEdit;
  if (ed && !d.canEdit) ed = null;
  const widgets = edit ? ed.widgets : d.widgets, res = await load(widgets);
  const grid = `<div class="dgrid${edit ? ' editing' : ''}">${widgets.map((w, i) => widgetCard(w, res, { tv, edit, i, n: widgets.length })).join('') || `<div class="card empty dgrid-empty">${edit ? 'No widgets yet. Choose “Add widget”.' : d.canEdit ? 'This dashboard is empty. Choose Edit, then “Add widget”.' : 'This dashboard is empty.'}</div>`}</div>`;
  if (tv) return `<div class="tv"><header class="tv-bar"><h1>${esc(d.name)}</h1><span class="small muted grow">Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · refreshes every 30 seconds</span><a class="btn sm" href="/#/dashboards/${esc(d.id)}">${ib('x', 'Exit TV mode')}</a></header>${grid}</div>`;
  const actions = edit ? '' : `<div class="row">${d.canEdit ? btn('dash-edit', 'Edit', 'edit', { cls: 'sm primary' }) : ''}${btn('dash-dup', 'Duplicate', 'copy', { data: { id: d.id } })}
      <a class="btn sm" href="/?tv=1#/dashboards/${esc(d.id)}">${ib('tv', 'TV mode')}</a>${btn('dash-tv-link', 'Copy TV link', 'link', { data: { id: d.id } })}</div>`;
  const head = `<div class="head">${tile('dashboards')}<div class="grow"><h1>${esc(d.name)}</h1>${d.description ? `<p>${esc(d.description)}</p>` : ''}<div class="meta">${shareChip(d)}${d.isLanding ? chip('good', 'Your landing page') : ''}<span class="small muted">${d.mine ? 'Yours' : `By ${esc(d.ownerName)}`} · ${d.widgetCount} widget${d.widgetCount === 1 ? '' : 's'}</span></div></div>${actions}</div>`;
  return `<p><a href="#/dashboards">${icon('back', 'i xs')} All dashboards</a></p>${head}${edit ? editBar() : ''}${grid}`;
}
function editBar() {
  return `<section class="card dedit" aria-label="Edit dashboard"><div class="form-grid"><label><span>Name</span><input type="text" id="dash-name" data-dash-field="name" value="${esc(ed.name)}" maxlength="80" required></label>
    <label><span>Description</span><input type="text" id="dash-desc" data-dash-field="description" value="${esc(ed.description)}" maxlength="500"></label></div>
    <div class="row">${btn('dash-add', 'Add widget', 'plus', { cls: 'sm primary' })}${btn('dash-undo', 'Undo', 'undo', { cls: 'sm' }).replace('<button', `<button ${ed.history.length ? '' : 'disabled'}`)}
      <span class="grow small muted">${dirty() ? 'Unsaved changes' : 'No changes yet'} · drag a widget by its handle, or use the arrows</span>${btn('dash-cancel', 'Cancel', 'x', { cls: 'sm' })}${btn('dash-save', 'Save', 'check', { cls: 'sm primary' })}</div>
    ${ed.error ? `<div class="error" role="alert">${esc(ed.error)}</div>` : ''}</section>`;
}
const shareChip = d => d.share === 'all' ? chip('ai', 'Shared with all users') : d.share === 'role' ? chip('ai', `Shared with ${d.shareRole}s`) : chip('', 'Private');

async function listPage() {
  const [{ dashboards, landing }, cat] = await Promise.all([api('/dashboards'), catalog()]), admin = ctx.state.user.role === 'admin';
  const row = d => `<article class="card drow"><div class="row"><h3 class="grow ih">${tile('dashboards')}<span><a href="#/dashboards/${esc(d.id)}">${esc(d.name)}</a></span></h3>${shareChip(d)}${d.isLanding ? chip('good', 'Your landing page') : ''}${d.isEveryoneDefault ? chip('watch', 'Default for everyone') : ''}</div>
    ${d.description ? `<p class="small">${esc(d.description)}</p>` : ''}<div class="small muted">${d.mine ? 'Yours' : `By ${esc(d.ownerName)}`} · ${d.widgetCount} widget${d.widgetCount === 1 ? '' : 's'} · updated ${ago(d.updatedAt)}</div>
    <div class="row"><a class="btn sm primary" href="#/dashboards/${esc(d.id)}">${ib('watch', 'Open')}</a>${btn('dash-dup', 'Duplicate', 'copy', { data: { id: d.id } })}
      ${d.canEdit ? `${btn('dash-rename', 'Rename', 'edit', { data: { id: d.id } })}${btn('dash-share', 'Share', 'share', { data: { id: d.id } })}${btn('dash-del', 'Delete', 'trash', { cls: 'sm danger', data: { id: d.id, name: d.name } })}` : ''}
      ${d.isMyDefault ? btn('dash-default-me', 'Not my landing page', 'star', { data: { id: '' } }) : btn('dash-default-me', 'Make my landing page', 'star', { data: { id: d.id } })}
      ${admin ? (d.isEveryoneDefault ? btn('dash-default-all', 'Remove default for everyone', 'x', { data: { id: '' } }) : d.share !== 'private' || d.mine ? btn('dash-default-all', 'Default for everyone', 'users', { data: { id: d.id } }) : '') : ''}</div></article>`;
  const mine = dashboards.filter(d => d.mine), others = dashboards.filter(d => !d.mine);
  return `<div class="head">${tile('dashboards')}<div class="grow"><h1>Dashboards</h1><p>Build pages of charts, tiles and lists for your own job, share them with the team, or put one on a shop-floor screen.</p></div>${btn('dash-new', 'New dashboard', 'plus', { cls: 'primary' })}</div>
    <section class="card"><div class="row">${heading('overview', 'Overview <span class="small muted">built in</span>')}${landing.dashboardId ? '' : chip('good', 'Your landing page')}<a class="btn sm" href="#/overview">${ib('watch', 'Open')}</a>${landing.dashboardId ? btn('dash-default-me', 'Use Overview as my landing page', 'star', { data: { id: 'overview' } }) : ''}</div>
      <p class="small muted">Every machine's health and focus signal. Until you or the super user choose a landing dashboard, this is the first page you see.</p></section>
    <section class="grid"><div class="row">${heading('dashboards', `Your dashboards <span class="count-chip">${mine.length}</span>`)}</div>${mine.length ? mine.map(row).join('') : '<div class="card empty">You have no dashboards yet. Start from a template below, or choose “New dashboard”.</div>'}</section>
    ${others.length ? `<section class="grid"><div class="row">${heading('users', `Shared with you <span class="count-chip">${others.length}</span>`)}</div>${others.map(row).join('')}</section>` : ''}
    <section class="grid"><div class="row">${heading('copy', 'Templates')}</div><div class="grid templates">${cat.templates.map(t => `<article class="card"><h3 class="ih">${tile('dashboards', 'ai')}<span>${esc(t.name)}</span></h3><p class="small">${esc(t.description)}</p>${btn('dash-new', 'Use this template', 'copy', { data: { template: t.key } })}</article>`).join('')}</div></section>`;
}

// ---- Dialogs ----
function newDialog(template = '') {
  return Promise.all([catalog(), machines()]).then(([cat, ms]) => dialog('New dashboard', `<div class="form-grid">${field('name', 'Name', { required: true, maxlength: 80, value: cat.templates.find(t => t.key === template)?.name ?? '' })}
    ${select('template', 'Start from', cat.templates.map(t => [t.key, `Template: ${t.name}`]), { value: template, blank: 'An empty dashboard' })}
    <div class="span" data-for="machine" hidden>${select('machineId', 'Machine to show', ms.map(m => [m.id, `${m.tag} · ${m.name}`]), { blank: 'The first machine' })}</div>${textarea('description', 'Description (optional)')}</div>`,
  { dlgIcon: 'dashboards', submit: 'Create', submitIcon: 'plus', onOpen: d => {
    const t = d.querySelector('[name=template]'), m = d.querySelector('[data-for=machine]'), n = d.querySelector('[name=name]'), sync = () => { m.hidden = !cat.templates.find(x => x.key === t.value)?.needsMachine; };
    t.addEventListener('change', () => { sync(); const tpl = cat.templates.find(x => x.key === t.value); if (tpl && (!n.value || cat.templates.some(x => x.name === n.value))) n.value = tpl.name; }); sync(); },
  onSubmit: async fd => {
    const template = fd.get('template') || undefined, body = { name: fd.get('name'), description: fd.get('description') || undefined, ...(template ? { template, machineId: (cat.templates.find(t => t.key === template)?.needsMachine && fd.get('machineId')) || undefined } : {}) };
    const d = await api('/dashboards', 'POST', body); location.hash = `#/dashboards/${d.id}`;
  } }));
}
const SHARES = [['private', 'Only me'], ['all', 'All users'], ['role:viewer', 'Everyone with the Viewer role'], ['role:engineer', 'Everyone with the Engineer role']];
async function shareDialog(id) {
  const d = await api(`/dashboards/${id}`), cur = d.share === 'role' ? `role:${d.shareRole}` : d.share;
  dialog(`Share “${d.name}”`, `<p class="small muted span">Anyone who can see a dashboard can read it and make their own copy. Only you and the super user can change it. Everyone sees the same live data they already can.</p>${select('audience', 'Who can see it', SHARES, { value: cur, required: true })}`,
    { dlgIcon: 'share', submit: 'Save', onSubmit: async fd => { const [share, role] = String(fd.get('audience')).split(':'); await api(`/dashboards/${id}`, 'PUT', { share, ...(role ? { shareRole: role } : {}) }); } });
}

// The widget dialog: one form whose settings section follows the chosen type.
const optionsOf = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
async function settingsHtml(type, s, ms, cat) {
  const machineOpts = ms.map(m => [m.id, `${m.tag} · ${m.name}`]);
  if (type === 'signal_chart') {
    const mid = s.machineId && ms.some(m => m.id === s.machineId) ? s.machineId : ms[0]?.id, sigs = mid ? await signals(mid) : [];
    return `<div class="form-grid"><label><span>Machine</span><select name="machineId" data-machine required>${optionsOf(machineOpts, mid)}</select></label>
      <label><span>Signal</span><select name="signal" data-signals required>${optionsOf(sigs.map(x => [x.key, `${x.label} (${x.unit})`]), s.signal)}</select></label>
      <label><span>Period</span><select name="hours">${optionsOf([[24, 'Last 24 hours'], [168, 'Last 7 days']], s.hours ?? 24)}</select></label>
      <label class="check"><input type="checkbox" name="showLimits" ${s.showLimits === false ? '' : 'checked'}> Show warning and critical limits</label></div>`;
  }
  if (type === 'sparklines') {
    const chosen = new Set((s.items ?? []).map(i => `${i.machineId}|${i.signal}`)), per = await Promise.all(ms.map(async m => [m, await signals(m.id)]));
    return `<fieldset><legend>Signals (up to 12)</legend>${per.map(([m, sigs], n) => `<details ${sigs.some(x => chosen.has(`${m.id}|${x.key}`)) || (!chosen.size && !n) ? 'open' : ''}><summary class="small"><b>${esc(m.tag)}</b> ${esc(m.name)}</summary><div class="checks">${sigs.map(x => `<label class="check"><input type="checkbox" name="item" value="${esc(m.id)}|${esc(x.key)}" ${chosen.has(`${m.id}|${x.key}`) ? 'checked' : ''}> ${esc(x.label)}</label>`).join('')}</div></details>`).join('')}</fieldset>`;
  }
  if (type === 'machine_health' || type === 'machine_grid') {
    const chosen = new Set(s.machineIds ?? []);
    return `<fieldset><legend>Machines (none ticked = all machines)</legend><div class="checks">${ms.map(m => `<label class="check"><input type="checkbox" name="m" value="${esc(m.id)}" ${chosen.has(m.id) ? 'checked' : ''}> ${esc(m.tag)}</label>`).join('')}</div></fieldset>`;
  }
  if (type === 'findings') return `<div class="form-grid"><label><span>Machine</span><select name="machineId"><option value="">All machines</option>${optionsOf(machineOpts, s.machineId)}</select></label>
    <label><span>Severity</span><select name="severity">${optionsOf([['all', 'All'], ['critical', 'Critical only'], ['warning', 'Warnings only']], s.severity ?? 'all')}</select></label>${field('limit', 'Rows to show', { type: 'number', value: s.limit ?? 5, min: 1, max: 20 })}</div>`;
  if (type === 'tickets') return `<div class="form-grid"><label><span>Tickets</span><select name="status">${optionsOf([['open', 'Open: drafts and approved'], ['draft', 'Drafts waiting for approval'], ['approved', 'Approved']], s.status ?? 'open')}</select></label>
    <label><span>Assigned to</span><select name="assignee">${optionsOf([['any', 'Anyone'], ['me', 'Me'], ['none', 'Not assigned'], ...cat.people.map(p => [p.id, `${p.name}${p.kind === 'provider' ? ' (service provider)' : ''}`])], s.assignee ?? 'any')}</select></label>${field('limit', 'Rows to show', { type: 'number', value: s.limit ?? 5, min: 1, max: 20 })}</div>`;
  if (type === 'kpi') return select('metric', 'Number to show', Object.entries(cat.kpiMetrics), { value: s.metric, required: true });
  return `<label class="span">Text<textarea name="text" rows="5" maxlength="2000" required>${esc(s.text ?? '')}</textarea></label>`;
}
const READ = {
  signal_chart: fd => { if (!fd.get('signal')) throw new Error('Choose a machine with a signal'); return { machineId: fd.get('machineId'), signal: fd.get('signal'), hours: Number(fd.get('hours')), showLimits: fd.get('showLimits') === 'on' }; },
  sparklines: fd => { const items = fd.getAll('item').map(v => { const [machineId, signal] = v.split('|'); return { machineId, signal }; }); if (!items.length) throw new Error('Tick at least one signal'); if (items.length > 12) throw new Error('Choose at most 12 signals'); return { items }; },
  machine_health: fd => ({ machineIds: fd.getAll('m') }), machine_grid: fd => ({ machineIds: fd.getAll('m') }),
  findings: fd => ({ machineId: fd.get('machineId') || null, severity: fd.get('severity'), limit: Number(fd.get('limit')) }),
  tickets: fd => ({ status: fd.get('status'), assignee: fd.get('assignee'), limit: Number(fd.get('limit')) }),
  kpi: fd => ({ metric: fd.get('metric') }), note: fd => ({ text: String(fd.get('text') || '').trim() }),
};
async function widgetDialog(w) {
  const [cat, ms] = await Promise.all([catalog(), machines()]), types = Object.entries(cat.widgetTypes);
  if (!ms.length && w == null) throw new Error('Add a machine under Settings first: widgets show machine data.');
  const sizes = (name, label, max, unit, v) => `<label><span>${label}</span><select name="${name}">${[...Array(max)].map((_, i) => `<option value="${i + 1}" ${v === i + 1 ? 'selected' : ''}>${i + 1} ${unit}${i ? 's' : ''}</option>`).join('')}</select></label>`;
  const def = type => cat.defaultSizes[type];
  dialog(w ? `Configure “${w.title}”` : 'Add widget', `<div class="form-grid">${w ? `<input type="hidden" name="type" value="${esc(w.type)}"><label><span>Type</span><input type="text" value="${esc(cat.widgetTypes[w.type])}" disabled></label>`
      : select('type', 'Widget type', types, { value: 'signal_chart', required: true })}${field('title', 'Title', { value: w?.title ?? '', maxlength: 80, help: 'Leave empty for the default' })}${sizes('w', 'Width', 4, 'column', w?.size.w ?? 2)}${sizes('h', 'Height', 3, 'row', w?.size.h ?? 2)}
    <p class="small muted span" id="wwhat"></p><div class="span grid" id="wset"></div></div>`,
  { dlgIcon: w ? 'settings' : 'plus', submit: w ? 'Apply' : 'Add widget', submitIcon: 'check', wide: true,
    onOpen: d => {
      const type = d.querySelector('[name=type]'), box = d.querySelector('#wset'), what = d.querySelector('#wwhat');
      const fill = async (settings, resize) => {
        what.textContent = WHAT[type.value]; box.innerHTML = '<p class="small muted">Loading…</p>';
        if (resize && def(type.value)) { d.querySelector('[name=w]').value = def(type.value)[0]; d.querySelector('[name=h]').value = def(type.value)[1]; }
        box.innerHTML = await settingsHtml(type.value, settings, ms, cat);
        box.querySelector('[data-machine]')?.addEventListener('change', async e => { const sel = box.querySelector('[data-signals]'); sel.innerHTML = '<option>Loading…</option>'; sel.innerHTML = optionsOf((await signals(e.target.value)).map(x => [x.key, `${x.label} (${x.unit})`])); });
      };
      type.addEventListener('change', () => fill({}, true)); fill(w?.settings ?? {}, false);
    },
    onSubmit: async fd => {
      const type = fd.get('type'), settings = READ[type](fd), title = String(fd.get('title') || '').trim() || (type === 'kpi' ? cat.kpiMetrics[settings.metric] : cat.widgetTypes[type]);
      const next = { id: w?.id ?? newId(), type, title, size: { w: Number(fd.get('w')), h: Number(fd.get('h')) }, settings, problems: [] };
      commit(() => { if (w) ed.widgets = ed.widgets.map(x => x.id === w.id ? next : x); else ed.widgets.push(next); });
    } });
}

// ---- Actions ----
export const ACTIONS = ['dash-new', 'dash-dup', 'dash-rename', 'dash-share', 'dash-del', 'dash-default-me', 'dash-default-all', 'dash-edit', 'dash-cancel', 'dash-save', 'dash-undo', 'dash-add', 'dash-config', 'dash-remove', 'dash-up', 'dash-down', 'dash-tv-link'];
const widgetOf = el => ed.widgets.find(w => w.id === el.dataset.wid);
const move = (from, to) => commit(() => { const [x] = ed.widgets.splice(from, 1); ed.widgets.splice(to, 0, x); });
export async function action(act, el) {
  const { id } = el.dataset;
  if (act === 'dash-new') return newDialog(el.dataset.template || '');
  if (act === 'dash-dup') { const d = await api(`/dashboards/${id}/duplicate`, 'POST', {}); location.hash = `#/dashboards/${d.id}`; return; }
  if (act === 'dash-rename') { const d = await api(`/dashboards/${id}`); return dialog('Rename dashboard', `${field('name', 'Name', { value: d.name, required: true, maxlength: 80 })}${textarea('description', 'Description', d.description)}`, { dlgIcon: 'edit', onSubmit: async fd => { await api(`/dashboards/${id}`, 'PUT', { name: fd.get('name'), description: fd.get('description') || '' }); } }); }
  if (act === 'dash-share') return shareDialog(id);
  if (act === 'dash-del') { if (!confirm(`Delete “${el.dataset.name}”? Its widgets are removed for everyone it is shared with. Machine data is not touched.`)) return; await api(`/dashboards/${id}`, 'DELETE'); location.hash = '#/dashboards'; return ctx.render(); }
  if (act === 'dash-default-me') { await api('/dashboards/default', 'PUT', { scope: 'me', dashboardId: id || null }); return ctx.render(); }
  if (act === 'dash-default-all') { await api('/dashboards/default', 'PUT', { scope: 'everyone', dashboardId: id || null }); return ctx.render(); }
  if (act === 'dash-tv-link') {
    const link = tvLink(id);
    try { await navigator.clipboard.writeText(link); el.querySelector('span').textContent = 'Link copied'; return; } catch { /* the dialog below lets them copy by hand */ }
    return dialog('TV mode link', `<p class="small muted span">Open this on a shop-floor screen. The screen needs to be signed in to Monitor; the link does not sign anyone in.</p><label class="span"><span>Link</span><input type="text" readonly value="${esc(link)}" onfocus="this.select()"></label>`, { dlgIcon: 'tv' });
  }
  if (act === 'dash-edit') { startEdit(await api(`/dashboards/${route().id}`)); return ctx.render(); }
  if (!ed) return;
  if (act === 'dash-cancel') { if (dirty() && !confirm('Discard your changes to this dashboard?')) return; ed = null; return ctx.render(); }
  if (act === 'dash-undo') { const s = ed.history.pop(); if (s) { Object.assign(ed, JSON.parse(s)); ed.error = ''; } return ctx.render(); }
  if (act === 'dash-add') return widgetDialog(null);
  if (act === 'dash-config') return widgetDialog(widgetOf(el));
  if (act === 'dash-remove') { commit(() => { ed.widgets = ed.widgets.filter(w => w.id !== el.dataset.wid); }); return ctx.render(); }
  if (act === 'dash-up' || act === 'dash-down') { const i = ed.widgets.findIndex(w => w.id === el.dataset.wid), j = act === 'dash-up' ? i - 1 : i + 1; if (j < 0 || j >= ed.widgets.length) return; move(i, j); focusAfter = [act, act === 'dash-up' ? 'dash-down' : 'dash-up'].map(x => `[data-act=${x}][data-wid="${el.dataset.wid}"]`); return ctx.render(); }
  if (act === 'dash-save') {
    ed.name = document.getElementById('dash-name')?.value ?? ed.name; ed.description = document.getElementById('dash-desc')?.value ?? ed.description;
    try { await api(`/dashboards/${ed.id}`, 'PUT', { name: ed.name, description: ed.description, widgets: ed.widgets.map(({ problems, ...w }) => w) }); ed = null; cache = new Map(); }
    catch (e) { ed.error = e.message; }
    return ctx.render();
  }
}
const route = () => ({ id: hashParts()[1] });

// After each paint: edit-mode fields, size selects, drag and drop, and the focus kept on a button that moved.
export function bindDashboards() {
  if (!ed) return;
  document.querySelectorAll('[data-dash-field]').forEach(i => i.addEventListener('change', () => { if (ed[i.dataset.dashField] !== i.value) commit(() => { ed[i.dataset.dashField] = i.value; }); }));
  document.querySelectorAll('select[data-dw]').forEach(s => s.addEventListener('change', () => { commit(() => { const w = ed.widgets.find(x => x.id === s.dataset.wid); w.size = { ...w.size, [s.dataset.dw]: Number(s.value) }; }); ctx.render(); }));
  const cards = [...document.querySelectorAll('.dgrid.editing .dw')];
  cards.forEach(card => {
    card.querySelector('[data-handle]')?.addEventListener('pointerdown', () => { card.draggable = true; });
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', card.dataset.wid); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.draggable = false; card.classList.remove('dragging'); cards.forEach(c => c.classList.remove('over')); });
    card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; card.classList.add('over'); });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', e => { e.preventDefault(); const from = ed.widgets.findIndex(w => w.id === e.dataTransfer.getData('text/plain')), to = ed.widgets.findIndex(w => w.id === card.dataset.wid); if (from >= 0 && to >= 0 && from !== to) { move(from, to); ctx.render(); } });
  });
  if (focusAfter) { (focusAfter.map(q => document.querySelector(q)).find(b => b && !b.disabled))?.focus(); focusAfter = null; }
}
