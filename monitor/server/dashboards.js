// Custom dashboards: a person builds a page of widgets (charts, tiles, lists) without code.
//  - A dashboard has a name, a description, a 4-column grid layout and up to 24 widgets. Each widget has a type, a title,
//    a size (1-4 columns x 1-3 rows) and settings that are validated here against the machines, signals and people that
//    exist, so a saved widget can only point at things that are there.
//  - Personal by default. The owner can share a dashboard with everybody or with one role (viewer / engineer). Everyone
//    may build personal dashboards, viewers included; only the owner and the super user (administrator) change or delete
//    one. Anyone who can see a dashboard can duplicate it into their own copy.
//  - Landing page: a user's own default (or "Overview"), else the one the super user set for everybody, else Overview.
//  - Widgets show data through the same API as the rest of the dashboard (/overview, /findings, /tickets, series), so
//    they can never show more than the person could already open. Every machine and signal is readable by every
//    signed-in user in this product, so the checks here are about what exists, not about hiding.
//  - When a machine or signal is deleted the widgets that used it are kept and flagged ("problems") when the dashboard
//    is read; the page shows them as unavailable and the owner removes or re-points them. Saving a dashboard that still
//    holds such a widget is refused with the widget named, so stale references are never written back as valid.
import { id, one, all, run, transaction, audit, setting, saveSetting } from './db.js';
import { bad, deny, missing, text, choice, reply } from './http.js';
import { can } from './auth.js';
import { analysisOf } from './ml/analyze.js';

export const MAX_WIDGETS = 24, MAX_PER_USER = 50, COLUMNS = 4, MAX_ROWS = 3;
export const WIDGET_TYPES = {
  signal_chart: 'Signal chart', sparklines: 'Sparkline tiles', machine_health: 'Machine health', findings: 'Active findings',
  tickets: 'Tickets', kpi: 'KPI tile', note: 'Text note', machine_grid: 'Machine status grid',
};
export const KPI_METRICS = { open_findings: 'Open findings', machines_watch_risk: 'Machines in watch or at risk', tickets_awaiting_approval: 'Tickets awaiting approval', tickets_sent_mouldcare: 'Tickets sent to MouldCare' };
const SHARE_ROLES = ['viewer', 'engineer'];
const DEFAULT_SIZE = { signal_chart: [2, 2], sparklines: [2, 2], machine_health: [2, 2], findings: [2, 2], tickets: [2, 2], kpi: [1, 1], note: [2, 1], machine_grid: [4, 2] };

const machineExists = mid => !!one('SELECT 1 FROM machines WHERE id=?', mid);
const signalExists = (mid, key) => !!one('SELECT 1 FROM signals WHERE machine_id=? AND key=?', mid, key);
const str = (v, name) => typeof v === 'string' && v ? v : bad(`${name} is required`);
const int = (v, name, lo, hi, fallback) => { if (v == null && fallback != null) return fallback; if (!Number.isInteger(v) || v < lo || v > hi) bad(`${name} must be a whole number from ${lo} to ${hi}`); return v; };
const obj = (v, name) => v && typeof v === 'object' && !Array.isArray(v) ? v : bad(`${name} must be an object`);

function machineIdsOf(v, name = 'machineIds') {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 50) bad(`${name} must be a list of up to 50 machines`);
  const ids = [...new Set(v.map(x => str(x, 'machine')))];
  for (const m of ids) if (!machineExists(m)) bad('Unknown machine in this widget');
  return ids;
}
function signalRef(v, name) {
  const x = obj(v, name), machineId = str(x.machineId, 'machineId'), signal = str(x.signal, 'signal');
  if (!machineExists(machineId)) bad('Unknown machine in this widget');
  if (!signalExists(machineId, signal)) bad(`Unknown signal ${signal} on that machine`);
  return { machineId, signal };
}
function assigneeOf(v) {
  if (v == null) return 'any';
  if (['any', 'me', 'none'].includes(v)) return v;
  const [kind, ...rest] = String(v).split(':'), key = rest.join(':');
  if (kind === 'user' && one('SELECT 1 FROM users WHERE id=?', key)) return v;
  if (kind === 'provider' && one('SELECT 1 FROM service_providers WHERE id=?', key)) return v;
  return bad('Unknown assignee in this widget');
}

// Settings per widget type: checked against what exists and cut down to the known keys.
const SETTINGS = {
  signal_chart: s => ({ ...signalRef(s, 'settings'), hours: s.hours == null ? 24 : [24, 168].includes(s.hours) ? s.hours : bad('hours must be 24 or 168'), showLimits: s.showLimits !== false }),
  sparklines: s => {
    if (!Array.isArray(s.items) || !s.items.length || s.items.length > 12) bad('Choose 1 to 12 signals for the sparkline tiles');
    const seen = new Set(); return { items: s.items.map(i => signalRef(i, 'item')).filter(i => !seen.has(i.machineId + '|' + i.signal) && seen.add(i.machineId + '|' + i.signal)) };
  },
  machine_health: s => ({ machineIds: machineIdsOf(s.machineIds) }),
  findings: s => ({ machineId: s.machineId ? (machineExists(s.machineId) ? s.machineId : bad('Unknown machine in this widget')) : null, severity: s.severity == null ? 'all' : choice(s.severity, 'severity', ['all', 'critical', 'warning']), limit: int(s.limit, 'limit', 1, 20, 5) }),
  tickets: s => ({ status: s.status == null ? 'open' : choice(s.status, 'status', ['open', 'draft', 'approved']), assignee: assigneeOf(s.assignee), limit: int(s.limit, 'limit', 1, 20, 5) }),
  kpi: s => ({ metric: choice(s.metric, 'metric', Object.keys(KPI_METRICS)) }),
  note: s => ({ text: text(s.text, 'The note text', 2000) }),
  machine_grid: s => ({ machineIds: machineIdsOf(s.machineIds) }),
};
const TITLES = { signal_chart: 'Signal chart', sparklines: 'Signals', machine_health: 'Machine health', findings: 'Active findings', tickets: 'Tickets', kpi: 'KPI', note: 'Note', machine_grid: 'Machine status' };

export function cleanWidgets(list) {
  if (!Array.isArray(list)) bad('widgets must be a list');
  if (list.length > MAX_WIDGETS) bad(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
  const ids = new Set();
  return list.map((raw, n) => {
    const w = obj(raw, `Widget ${n + 1}`), type = choice(w.type, 'Widget type', Object.keys(WIDGET_TYPES));
    const wid = typeof w.id === 'string' && /^[\w-]{1,64}$/.test(w.id) && !ids.has(w.id) ? w.id : id(); ids.add(wid);
    const [dw, dh] = DEFAULT_SIZE[type], size = obj(w.size ?? { w: dw, h: dh }, 'size');
    const title = w.title == null || w.title === '' ? (type === 'kpi' && w.settings?.metric in KPI_METRICS ? KPI_METRICS[w.settings.metric] : TITLES[type]) : text(w.title, 'The widget title', 80);
    try { return { id: wid, type, title, size: { w: int(size.w, 'Width', 1, COLUMNS), h: int(size.h, 'Height', 1, MAX_ROWS) }, settings: SETTINGS[type](obj(w.settings ?? {}, 'settings')) }; }
    catch (e) { e.message = `Widget “${typeof w.title === 'string' && w.title ? w.title : TITLES[type]}”: ${e.message}`; throw e; }
  });
}

// What a stored widget points at that is no longer there.
function problemsOf(w) {
  const out = [], s = w.settings ?? {};
  const mach = mid => { if (!machineExists(mid)) { out.push('A machine in this widget was deleted'); return false; } return true; };
  const sig = r => { if (mach(r.machineId) && !signalExists(r.machineId, r.signal)) out.push(`The signal ${r.signal} was deleted`); };
  if (w.type === 'signal_chart') sig(s);
  else if (w.type === 'sparklines') (s.items ?? []).forEach(sig);
  else if (['machine_health', 'machine_grid'].includes(w.type)) (s.machineIds ?? []).forEach(mach);
  else if (w.type === 'findings' && s.machineId) mach(s.machineId);
  else if (w.type === 'tickets' && /^(user|provider):/.test(s.assignee ?? '')) {
    const [kind, ...r] = s.assignee.split(':'); if (!one(`SELECT 1 FROM ${kind === 'user' ? 'users' : 'service_providers'} WHERE id=?`, r.join(':'))) out.push('The assignee was deleted');
  }
  return [...new Set(out)];
}

// ---- Who sees and changes what ----
const isAdmin = u => can(u, 'admin');
const visible = (u, d) => d.owner_id === u.id || d.share === 'all' || (d.share === 'role' && d.share_role === u.role) || (isAdmin(u) && d.share !== 'private');
const editable = (u, d) => d.owner_id === u.id || isAdmin(u);
const globalDefault = () => setting('default_dashboard', null);
const dashboardOr404 = (u, did) => { const d = one('SELECT * FROM dashboards WHERE id=?', did); return d && visible(u, d) ? d : missing('Dashboard not found'); };
const editableOr403 = (u, did) => { const d = dashboardOr404(u, did); if (!editable(u, d)) deny('Only the owner or the super user can change this dashboard'); return d; };

function resolveDefault(u) {
  const pref = one('SELECT dashboard_id FROM dashboard_prefs WHERE user_id=?', u.id);
  if (pref && !pref.dashboard_id) return { source: 'user', dashboardId: null };
  if (pref) { const d = one('SELECT * FROM dashboards WHERE id=?', pref.dashboard_id); if (d && visible(u, d)) return { source: 'user', dashboardId: d.id }; }
  const gid = globalDefault(), g = gid && one('SELECT * FROM dashboards WHERE id=?', gid);
  if (g && visible(u, g)) return { source: 'everyone', dashboardId: g.id };
  return { source: null, dashboardId: null };
}

function dashboardOut(u, d, { widgets = true, def = resolveDefault(u) } = {}) {
  const owner = one('SELECT name FROM users WHERE id=?', d.owner_id), list = JSON.parse(d.widgets_json);
  const pref = one('SELECT dashboard_id FROM dashboard_prefs WHERE user_id=?', u.id);
  return { id: d.id, name: d.name, description: d.description, layout: JSON.parse(d.layout_json), share: d.share, shareRole: d.share_role,
    ownerId: d.owner_id, ownerName: owner?.name ?? null, mine: d.owner_id === u.id, canEdit: editable(u, d), widgetCount: list.length,
    isMyDefault: pref?.dashboard_id === d.id, isEveryoneDefault: globalDefault() === d.id, isLanding: def.dashboardId === d.id, createdAt: d.created_at, updatedAt: d.updated_at,
    ...(widgets ? { widgets: list.map(w => ({ ...w, problems: problemsOf(w) })) } : {}) };
}

// ---- Templates ----
const wd = (type, title, w, h, settings = {}) => ({ type, title, size: { w, h }, settings });
const kpis = metrics => metrics.map(m => wd('kpi', KPI_METRICS[m], 1, 1, { metric: m }));
export const TEMPLATES = {
  'plant-overview': { name: 'Plant overview', description: 'Every machine at a glance: key numbers, the status grid, what needs attention and the work waiting.',
    build: () => [...kpis(['open_findings', 'machines_watch_risk', 'tickets_awaiting_approval', 'tickets_sent_mouldcare']), wd('machine_grid', 'Machine status', 4, 2), wd('findings', 'Active findings', 2, 2, { limit: 6 }), wd('machine_health', 'Machine health', 2, 2)] },
  'machine-deep-dive': { name: 'Machine deep-dive', description: 'One machine: its health, every signal, the two charts that matter most and its findings.', needsMachine: true,
    build: mid => {
      const sigs = all('SELECT key,label FROM signals WHERE machine_id=? ORDER BY rowid', mid), m = one('SELECT tag FROM machines WHERE id=?', mid);
      return [wd('machine_health', `${m.tag} health`, 2, 1, { machineIds: [mid] }), wd('findings', `${m.tag} findings`, 2, 2, { machineId: mid, limit: 8 }),
        ...(sigs.length ? [wd('sparklines', 'All signals, last 24 hours', 4, 2, { items: sigs.slice(0, 12).map(s => ({ machineId: mid, signal: s.key })) })] : []),
        ...sigs.slice(0, 2).map((s, i) => wd('signal_chart', s.label, 2, 2, { machineId: mid, signal: s.key, hours: i ? 168 : 24, showLimits: true }))];
    } },
  'maintenance-desk': { name: 'Maintenance desk', description: 'Tickets and who has them: drafts to approve, approved work, what is assigned to you and the critical findings behind it.',
    build: () => [...kpis(['tickets_awaiting_approval', 'tickets_sent_mouldcare', 'open_findings', 'machines_watch_risk']), wd('tickets', 'Drafts waiting for approval', 2, 3, { status: 'draft', limit: 8 }),
      wd('tickets', 'Approved tickets', 2, 3, { status: 'approved', limit: 8 }), wd('tickets', 'Assigned to me', 2, 2, { status: 'open', assignee: 'me', limit: 6 }), wd('findings', 'Critical findings', 2, 2, { severity: 'critical', limit: 6 })] },
};

// Counts for the KPI tiles, exact (the list endpoints are capped).
function kpiValues() {
  const n = sql => one(sql).n, health = { watch: 0, at_risk: 0 };
  for (const m of all('SELECT * FROM machines')) { const s = analysisOf(m).health.status; if (s in health) health[s]++; }
  return { open_findings: n("SELECT COUNT(*) n FROM findings WHERE status IN ('open','acknowledged','confirmed')"), machines_watch_risk: health.watch + health.at_risk,
    tickets_awaiting_approval: n("SELECT COUNT(*) n FROM ticket_drafts WHERE status='draft'"), tickets_sent_mouldcare: n("SELECT COUNT(*) n FROM ticket_drafts WHERE mouldcare_status='sent'"), at: Date.now() };
}

const nameOf = (v, fallback) => v == null && fallback != null ? fallback : text(v, 'The dashboard name', 80);
const describe = v => v == null ? '' : typeof v === 'string' ? (v.length > 500 ? bad('The description is too long (max 500)') : v.trim()) : bad('The description must be text');
const shareOf = body => {
  const share = choice(body.share, 'share', ['private', 'all', 'role']);
  return { share, role: share === 'role' ? choice(body.shareRole, 'shareRole', SHARE_ROLES) : null };
};
const countMine = u => one('SELECT COUNT(*) n FROM dashboards WHERE owner_id=?', u.id).n;
const insert = (u, { name, description, widgets, layout = { columns: COLUMNS } }) => {
  if (countMine(u) >= MAX_PER_USER) bad(`You can keep at most ${MAX_PER_USER} dashboards. Delete one you no longer use.`);
  const did = id(), now = Date.now();
  run('INSERT INTO dashboards (id,owner_id,name,description,layout_json,widgets_json,share,share_role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', did, u.id, name, description, JSON.stringify(layout), JSON.stringify(widgets), 'private', null, now, now);
  return did;
};

export function registerDashboards(r) {
  r.get('/dashboards', ({ user }) => {
    const def = resolveDefault(user);
    const rows = all('SELECT * FROM dashboards ORDER BY name COLLATE NOCASE').filter(d => visible(user, d));
    return { dashboards: rows.map(d => dashboardOut(user, d, { widgets: false, def })), landing: def };
  });
  r.get('/dashboards/catalog', () => ({ widgetTypes: WIDGET_TYPES, kpiMetrics: KPI_METRICS, columns: COLUMNS, maxRows: MAX_ROWS, maxWidgets: MAX_WIDGETS, defaultSizes: DEFAULT_SIZE,
    templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, description: t.description, needsMachine: !!t.needsMachine })),
    people: [...all('SELECT id,name FROM users WHERE active=1 ORDER BY name').map(u => ({ id: `user:${u.id}`, name: u.name, kind: 'user' })), ...all('SELECT id,name FROM service_providers WHERE active=1 ORDER BY name').map(p => ({ id: `provider:${p.id}`, name: p.name, kind: 'provider' }))] }));
  r.get('/dashboards/kpis', () => kpiValues());
  r.get('/dashboards/default', ({ user }) => { const def = resolveDefault(user); return { ...def, dashboard: def.dashboardId ? dashboardOut(user, one('SELECT * FROM dashboards WHERE id=?', def.dashboardId), { widgets: false, def }) : null }; });

  // Body: { scope: 'me' | 'everyone', dashboardId: <id> | 'overview' (me only) | null (clear) }.
  r.put('/dashboards/default', ({ user, body }) => {
    const scope = choice(body.scope, 'scope', ['me', 'everyone']), did = body.dashboardId ?? null;
    if (scope === 'everyone') {
      if (!isAdmin(user)) deny('Only the super user can set the default dashboard for everyone');
      if (did == null) { saveSetting('default_dashboard', null); audit(user.id, 'dashboard.default', 'dashboard', null, { scope, cleared: true }); }
      else {
        const d = dashboardOr404(user, did);
        // Everyone must be able to open it, so it is shared with all users when it is made the default.
        run("UPDATE dashboards SET share='all',share_role=NULL WHERE id=?", d.id); saveSetting('default_dashboard', d.id); audit(user.id, 'dashboard.default', 'dashboard', d.id, { scope });
      }
    } else if (did == null) run('DELETE FROM dashboard_prefs WHERE user_id=?', user.id);
    else {
      const target = did === 'overview' ? null : dashboardOr404(user, did).id;
      run('INSERT INTO dashboard_prefs (user_id,dashboard_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET dashboard_id=excluded.dashboard_id', user.id, target);
    }
    return resolveDefault(user);
  });

  // Create empty, from a template (body.template, plus machineId for the deep-dive) or with widgets given.
  r.post('/dashboards', ({ user, body }) => {
    let name, description = describe(body.description), widgets;
    if (body.template != null) {
      const t = TEMPLATES[body.template] ?? bad('Unknown template');
      let mid = null;
      if (t.needsMachine) { mid = body.machineId ?? one('SELECT id FROM machines ORDER BY tag')?.id ?? bad('Add a machine first: this template shows one machine'); if (!machineExists(mid)) bad('Unknown machine'); }
      widgets = cleanWidgets(t.build(mid)); name = nameOf(body.name, t.name); description ||= t.description;
    } else { name = nameOf(body.name); widgets = cleanWidgets(body.widgets ?? []); }
    const did = transaction(() => insert(user, { name, description, widgets }));
    audit(user.id, 'dashboard.create', 'dashboard', did, { name, template: body.template ?? null });
    return reply(201, dashboardOut(user, one('SELECT * FROM dashboards WHERE id=?', did)));
  });
  r.get('/dashboards/:id', ({ user, params }) => dashboardOut(user, dashboardOr404(user, params.id)));
  // Save: any of name, description, widgets (the whole list), share + shareRole.
  r.put('/dashboards/:id', ({ user, params, body }) => {
    const d = editableOr403(user, params.id), has = k => body[k] !== undefined;
    const name = has('name') ? nameOf(body.name) : d.name, description = has('description') ? describe(body.description) : d.description;
    const widgets = has('widgets') ? cleanWidgets(body.widgets) : JSON.parse(d.widgets_json);
    const { share, role } = has('share') ? shareOf(body) : { share: d.share, role: d.share_role };
    run('UPDATE dashboards SET name=?,description=?,widgets_json=?,share=?,share_role=?,updated_at=? WHERE id=?', name, description, JSON.stringify(widgets), share, role, Date.now(), d.id);
    // A default for everybody has to stay open to everybody.
    if (share !== 'all' && globalDefault() === d.id) saveSetting('default_dashboard', null);
    audit(user.id, 'dashboard.update', 'dashboard', d.id, { ...(has('share') ? { share, role } : {}), ...(has('widgets') ? { widgets: widgets.length } : {}) });
    return dashboardOut(user, one('SELECT * FROM dashboards WHERE id=?', d.id));
  });
  r.delete('/dashboards/:id', ({ user, params }) => {
    const d = editableOr403(user, params.id);
    transaction(() => { if (globalDefault() === d.id) saveSetting('default_dashboard', null); run('DELETE FROM dashboards WHERE id=?', d.id); });
    audit(user.id, 'dashboard.delete', 'dashboard', d.id, { name: d.name });
    return { deleted: d.name };
  });
  // Anyone who can see a dashboard can copy it: the copy is theirs and private.
  r.post('/dashboards/:id/duplicate', ({ user, params, body }) => {
    const d = dashboardOr404(user, params.id), name = body.name != null ? nameOf(body.name) : `Copy of ${d.name}`.slice(0, 80);
    const did = transaction(() => insert(user, { name, description: d.description, widgets: JSON.parse(d.widgets_json).map(w => ({ ...w, id: id() })), layout: JSON.parse(d.layout_json) }));
    audit(user.id, 'dashboard.duplicate', 'dashboard', did, { from: d.id });
    return reply(201, dashboardOut(user, one('SELECT * FROM dashboards WHERE id=?', did)));
  });
}
