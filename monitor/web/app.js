// MouldCare Monitor dashboard: plain modules, no build step. Routes live in the URL hash (#/machine/<id>), the
// sign-in token in session storage, and every page refreshes itself every 30 seconds while open.
import { signalChart, sparkline } from '/charts.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const store = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} } };
const state = { token: store.get('monitor-token'), user: JSON.parse(store.get('monitor-user') || 'null'), config: null, timer: null, busy: new Set(), openExplain: new Set(), hours: {} };

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token) { signOut(); throw new Error('Your session ended. Sign in again.'); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
const canWrite = () => ['admin', 'engineer'].includes(state.user?.role);
const time = t => t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const HEALTH = { good: 'Good', watch: 'Watch', at_risk: 'At risk' };
const KIND = { limit: 'Limit', unusual: 'Unusual', degrading: 'Degrading', pattern: 'Pattern' };
const STATUS = { open: 'Open', acknowledged: 'Acknowledged', confirmed: 'Confirmed', false_alarm: 'False alarm', resolved: 'Resolved' };
const URGENCY = { stop_now: 'Stop the machine now', this_shift: 'Act this shift', this_week: 'Plan this week', monitor: 'Keep monitoring' };
const chip = (cls, label) => `<span class="chip ${esc(cls)}">${esc(label)}</span>`;

const ICONS = {
  overview: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  findings: '<path d="M12 3 2 21h20L12 3zm0 6v5m0 3v.5"/>',
  tickets: '<path d="M4 5h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/>',
  reports: '<path d="M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-5v3m0 12v3m9-9h-3M6 12H3m15.4-6.4-2.1 2.1M7.7 16.3l-2.1 2.1m12.8 0-2.1-2.1M7.7 7.7 5.6 5.6"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

function signOut() { store.set('monitor-token', null); store.set('monitor-user', null); state.token = null; state.user = null; render(); }
function setTheme(choice) {
  try { localStorage.setItem('monitor-theme', choice); } catch {}
  document.documentElement.dataset.theme = choice;
  document.documentElement.classList.toggle('dark', choice === 'dark' || (choice === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches));
  render();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (document.documentElement.dataset.theme === 'auto') setTheme('auto'); });

function route() { const [page, arg] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/'); return { page: page || 'overview', arg }; }
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

let openFindings = 0;
function layout(inner) {
  const { page } = route(), theme = document.documentElement.dataset.theme || 'auto';
  const links = [['overview', 'Overview'], ['findings', 'Findings'], ['tickets', 'Ticket drafts'], ['reports', 'Reports'], ['chat', 'Ask AI'], ...(state.user.role === 'admin' ? [['settings', 'Settings']] : [])];
  return `<div class="shell"><aside class="side"><div class="brand"><b>Mould<span>Care</span> Monitor</b><small>Machine &amp; condition monitoring</small></div>
    <nav class="nav" aria-label="Main">${links.map(([id, label]) => `<a href="#/${id}" class="${page === id || (id === 'overview' && page === 'machine') ? 'active' : ''}">${icon(id)}<span class="label">${label}</span>${id === 'findings' && openFindings ? `<span class="count">${openFindings}</span>` : ''}</a>`).join('')}</nav></aside>
    <div class="main"><header class="topbar">${state.config?.simulator ? '<span class="pill-env" title="Readings come from the built-in simulator, not real machines">Simulated data</span>' : ''}<span class="grow"></span>
      <div class="seg" role="group" aria-label="Theme">${['light', 'dark', 'auto'].map(t => `<button type="button" data-theme="${t}" class="${theme === t ? 'on' : ''}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <span class="small"><b>${esc(state.user.name)}</b> <span class="muted">${esc(state.user.role)}</span></span><button class="btn sm" id="signout" type="button">Sign out</button></header>
    <main class="content" id="main">${inner}</main></div></div>`;
}

let generation = 0;
async function render() {
  clearInterval(state.timer);
  const gen = ++generation;
  if (!state.config) state.config = await api('/config').catch(() => ({}));
  if (!state.token) return renderLogin();
  const { page, arg } = route();
  const pages = { overview: pageOverview, machine: () => pageMachine(arg), findings: pageFindings, tickets: pageTickets, reports: pageReports, chat: pageChat, settings: pageSettings };
  const draw = async () => {
    // A slower, older page must never paint over the page the person has since moved to.
    try { const html = await (pages[page] || pageOverview)(); if (gen === generation) paint(layout(html)); }
    catch (e) { if (gen === generation) paint(layout(`<div class="error">${esc(e.message)}</div>`)); }
  };
  await draw();
  if (gen === generation && ['overview', 'machine', 'findings'].includes(page)) state.timer = setInterval(() => { if (!document.hidden && !state.busy.size && !document.activeElement?.matches('input,textarea,select')) draw(); }, 30000);
}
function paint(html) {
  const y = window.scrollY; $('#app').innerHTML = html; window.scrollTo(0, y);
  $('#signout')?.addEventListener('click', signOut);
  document.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.theme)));
  bindActions();
}

function renderLogin(error = '') {
  $('#app').innerHTML = `<main class="login card"><div class="brand"><b>Mould<span>Care</span> Monitor</b><small>Machine &amp; condition monitoring</small></div>
    <form id="login" class="grid"><label>Email<input type="email" name="email" autocomplete="username" required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}<button class="btn primary">Sign in</button></form>
    ${state.config?.demo ? '<p class="small muted">Demo: engineer@monitor.test, admin@monitor.test or viewer@monitor.test, password MonitorDemo123!</p>' : ''}</main>`;
  $('#login').addEventListener('submit', async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try { const r = await api('/auth/login', 'POST', f); state.token = r.token; state.user = r.user; store.set('monitor-token', r.token); store.set('monitor-user', JSON.stringify(r.user)); render(); }
    catch (err) { renderLogin(err.message); }
  });
}

// ---- Overview ----
async function pageOverview() {
  const o = await api('/overview'); openFindings = o.counts.critical + o.counts.warning;
  const k = (cls, v, l) => `<div class="card kpi ${cls}"><div class="v num">${v}</div><div class="l">${l}</div></div>`;
  return `<div class="head"><div class="grow"><h1>Machine health</h1><p>Every machine judged against its limits, its own learned normal, its trends and its usual pattern. Updated ${time(o.at)}.</p></div></div>
    <section class="grid kpis">${k('good', o.counts.good, 'Machines in good health')}${k('watch', o.counts.watch, 'To watch')}${k('risk', o.counts.atRisk, 'At risk')}${k(o.counts.critical ? 'risk' : '', o.counts.critical, 'Critical findings')}${k(o.counts.warning ? 'watch' : '', o.counts.warning, 'Warnings')}</section>
    <section class="grid machines">${o.machines.map(machineCard).join('') || '<div class="empty card">No machines yet. Run the seed or add machines to start monitoring.</div>'}</section>`;
}
function machineCard(m) {
  const f = m.topFinding, s = m.focus;
  return `<a class="card machine ${m.health.status}" href="#/machine/${m.id}">
    <div class="row"><span class="grow"><span class="tag">${esc(m.tag)}</span> <span class="sub">${esc(m.name)}</span></span>${chip(m.health.status, HEALTH[m.health.status])}</div>
    <div class="sub"><span class="dot ${m.state}"></span> ${esc(m.state)} · ${esc(m.typeLabel)} · ${esc(m.line)}</div>
    <div class="health"><span class="small num">${m.health.score}</span><span class="bar ${m.health.status}"><i style="width:${m.health.score}%"></i></span></div>
    ${f ? `<div class="issue ${f.severity}"><b>${esc(f.title)}</b><div class="small muted">${esc(KIND[f.kind])} · ${esc(f.severity)}${m.activeFindings > 1 ? ` · ${m.activeFindings - 1} more` : ''}</div></div>` : `<div class="issue small muted">${m.hasData ? 'No findings. Running within its normal.' : `No data ${m.lastData ? 'since ' + ago(m.lastData) : 'yet'}.`}</div>`}
    ${s ? `<div><div class="row small"><span class="grow muted">${esc(s.label)}</span><b class="num">${s.latest ?? '—'} ${esc(s.unit)}</b></div>${sparkline(s.spark, s.status)}</div>` : ''}
  </a>`;
}

// ---- Machine ----
async function pageMachine(mid) {
  const d = await api(`/machines/${mid}`), m = d.machine, a = d.analysis, hours = state.hours[mid] || 24;
  const series = await Promise.all(a.signals.map(s => api(`/machines/${mid}/series?signal=${encodeURIComponent(s.key)}&hours=${hours}`)));
  const active = d.findings.filter(f => ['open', 'acknowledged', 'confirmed'].includes(f.status)), closed = d.findings.filter(f => !active.includes(f));
  const model = a.model;
  return `<div class="head"><div class="grow"><p><a href="#/overview">← All machines</a></p><h1>${esc(m.tag)} · ${esc(m.name)}</h1><p>${esc(m.typeLabel)} · ${esc(m.make)} ${esc(m.model)} · ${esc(m.line)}</p></div>
      <div class="row">${chip(a.state, a.state)}${chip(a.health.status, `${HEALTH[a.health.status]} · ${a.health.score}`)}</div></div>
    <section class="card"><div class="row"><h2 class="grow">Findings</h2><span class="small muted">Last data ${ago(a.lastData)}</span></div>
      ${active.length ? active.map(findingCard).join('') : '<p class="muted">Nothing open on this machine.</p>'}
      ${closed.length ? `<details><summary class="small muted">${closed.length} closed in the last 14 days</summary><div class="grid" style="margin-top:10px">${closed.map(findingCard).join('')}</div></details>` : ''}</section>
    <div class="row"><h2 class="grow">Signals</h2><div class="seg" role="group" aria-label="Period"><button type="button" data-act="hours" data-id="${mid}" data-hours="24" class="${hours === 24 ? 'on' : ''}">24 hours</button><button type="button" data-act="hours" data-id="${mid}" data-hours="168" class="${hours === 168 ? 'on' : ''}">7 days</button></div></div>
    <div class="legend"><span><i style="background:var(--chart-line)"></i>Readings</span><span><i style="background:var(--chart-band);height:9px"></i>Learned normal (±3 spreads)</span><span><i style="background:var(--chart-warn)"></i>Warning limit</span><span><i style="background:var(--chart-crit)"></i>Critical limit / trend</span></div>
    <section class="grid signals">${a.signals.map((s, i) => signalCard(s, series[i])).join('')}</section>
    <section class="card"><h2>Pattern model</h2>
      ${model.trainedAt ? `<p class="small">Two models learn this machine's own running history (all signals together, in fifteen-minute windows), retrained every 6 hours. The <b>relationship distance</b> rises when signals that normally move together stop doing so, such as motor current climbing while pressure falls. The <b>isolation forest</b> rises when the machine runs in a state it has never shown before. Either can flag a problem while every signal alone still looks normal.</p>
        <dl class="facts"><dt>Trained</dt><dd>${time(model.trainedAt)} on ${model.rows} windows</dd>
        <dt>Relationship distance</dt><dd class="num">${model.pattern?.distance ?? '—'} <span class="muted">(alarm above ${model.distanceThreshold})</span></dd>
        <dt>Isolation forest</dt><dd class="num">${model.pattern?.score ?? '—'} <span class="muted">(alarm above ${model.threshold}; ordinary ≈ 0.5)</span></dd>
        ${model.pattern ? `<dt>Driving the distance</dt><dd>${model.pattern.contributors.map(c => `${esc(c.key)} ${c.value} <span class="muted">(normal ${c.normal}, ${Math.round(c.share * 100)}%)</span>`).join('<br>')}${model.pattern.explainedBy ? `<br><span class="small muted">Mostly ${esc(model.pattern.explainedBy)}, which already has its own finding.</span>` : ''}</dd>` : ''}</dl>`: `<p class="muted">${esc(model.note || 'Not trained yet.')}</p>`}</section>`;
}
function signalCard(s, ser) {
  const x = s.assessment, status = s.limitStatus?.severity ?? x.status;
  const line = x.status === 'learning' ? 'Still learning this signal\'s normal.' : `Normal ${x.baseline} ± ${x.spread} ${esc(s.unit)} · recent ${x.recent} (${x.score} spreads)${x.slopePerDay != null ? ` · trend ${x.slopePerDay > 0 ? '+' : ''}${x.slopePerDay}/day${x.hoursToCritical != null ? `, critical in ~${x.hoursToCritical} h` : ''}` : ''}${x.shape === 'step' ? ' · changed suddenly' : ''}`;
  return `<article class="card"><div class="row"><h3 class="grow">${esc(s.label)}</h3><b class="num">${s.latest ?? '—'} ${esc(s.unit)}</b>${chip(status, status)}</div>
    <p class="small muted">${line}</p>${signalChart({ ...ser, unit: s.unit })}</article>`;
}
function findingCard(f) {
  const isActive = ['open', 'acknowledged', 'confirmed'].includes(f.status), d = f.detail, e = f.explanation, show = state.openExplain.has(f.id);
  const facts = f.kind === 'limit' ? `${d.latest} ${esc(f.unit)} against the ${d.severity} limit ${d.limit}` : f.kind === 'degrading' ? `${d.slopePerDay > 0 ? '+' : ''}${d.slopePerDay} ${esc(f.unit)}/day · critical limit in ~${d.hoursToCritical} h` : f.kind === 'unusual' ? `normal ${d.baseline} → now ${d.recent} ${esc(f.unit)} (${d.score} spreads)` : `${d.method === 'new_state' ? `new operating state, score ${d.score} (alarm above ${d.threshold})` : `signals out of step, distance ${d.distance} (alarm above ${d.distanceThreshold})`} · ${d.contributors.map(c => esc(c.key)).join(', ')}`;
  return `<div class="card finding ${f.severity} ${isActive ? '' : 'closed'}">
    <div class="row"><b class="grow">${route().page === 'machine' ? '' : `<a href="#/machine/${f.machineId}">${esc(f.machineTag)}</a> · `}${esc(f.title)}</b>${chip(f.severity, f.severity)}${chip(f.status, STATUS[f.status])}</div>
    <div class="small muted">${esc(KIND[f.kind])} · ${facts} · since ${time(f.firstSeen)}${isActive ? '' : ` · closed ${time(f.resolvedAt || f.lastSeen)}`}${f.note ? ` · note: “${esc(f.note)}”` : ''}</div>
    <div class="row">
      <button class="btn sm" data-act="explain" data-id="${f.id}" type="button">${show ? 'Hide explanation' : state.config?.ai ? 'Explain with AI' : 'Explain'}</button>
      ${canWrite() && isActive ? `${f.status === 'open' ? `<button class="btn sm" data-act="status" data-status="acknowledged" data-id="${f.id}" type="button">Acknowledge</button>` : ''}
        ${f.status !== 'confirmed' ? `<button class="btn sm" data-act="status" data-status="confirmed" data-id="${f.id}" type="button">Confirm real</button>` : ''}
        <button class="btn sm" data-act="status" data-status="false_alarm" data-id="${f.id}" type="button">False alarm</button>
        <button class="btn sm" data-act="status" data-status="resolved" data-id="${f.id}" type="button">Mark fixed</button>
        <button class="btn sm primary" data-act="ticket" data-id="${f.id}" type="button">Draft ticket</button>` : ''}
    </div>
    ${show ? (e ? explanationView(e) : '<div class="explain muted">Working out the explanation…</div>') : ''}</div>`;
}
function explanationView(e) {
  return `<div class="explain"><div class="row"><b class="grow">${esc(URGENCY[e.urgency] || '')}</b>${e.source === 'ai' ? chip('ai', 'AI') : chip('', 'Standard')}</div>
    <p style="margin:0">${esc(e.summary)}</p>
    <div><b class="small">Likely causes</b><ul>${e.likelyCauses.map(c => `<li><b>${esc(c.cause)}</b> <span class="chip">${esc(c.likelihood)}</span><br><span class="small muted">${esc(c.evidence)}</span></li>`).join('')}</ul></div>
    <div><b class="small">Check first</b><ol>${e.checkFirst.map(c => `<li>${esc(c)}</li>`).join('')}</ol></div>
    ${e.safety?.length ? `<div><b class="small">Safety</b><ul>${e.safety.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
    ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</div>`;
}

// ---- Findings ----
async function pageFindings() {
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || 'active';
  const list = await api(`/findings?status=${status}`);
  if (status === 'active') openFindings = list.length;
  const tabs = [['active', 'Active'], ['all', 'All'], ['false_alarm', 'False alarms'], ['resolved', 'Resolved']];
  return `<div class="head"><div class="grow"><h1>Findings</h1><p>What the analysis found. Confirm the real ones and mark false alarms: a false alarm stays quiet for 24 hours, and your decisions are kept with each finding.</p></div>
    <div class="seg" role="group" aria-label="Filter">${tabs.map(([k, l]) => `<button type="button" data-act="filter" data-status="${k}" class="${status === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    ${list.length ? `<div class="grid">${list.map(findingCard).join('')}</div>` : '<div class="card empty">Nothing here.</div>'}`;
}

// ---- Tickets ----
const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
async function pageTickets() {
  const list = await api('/tickets');
  return `<div class="head"><div class="grow"><h1>Ticket drafts</h1><p>Drafted from findings for a planner to check. Approve a draft, then copy it into MouldCare as a breakdown ticket.</p></div></div>
    ${list.length ? `<div class="grid">${list.map(t => { const d = t.draft; return `<article class="card grid">
      <div class="row"><h2 class="grow">${esc(d.title)}</h2>${t.source === 'ai' ? chip('ai', 'AI draft') : chip('', 'Standard draft')}${chip(t.status, t.status)}${chip(d.priority === 'critical' || d.priority === 'high' ? 'critical' : 'warning', PRIORITY[d.priority] + ' priority')}</div>
      <dl class="facts"><dt>Machine</dt><dd><a href="#/machine/${t.machineId}">${esc(d.machineTag)}</a> ${esc(d.machineName)}</dd><dt>Category</dt><dd>${esc(d.failureCategory)}</dd><dt>Machine state</dt><dd>${esc(String(d.machineState).replace('_', ' '))}</dd><dt>Symptoms</dt><dd>${esc(d.symptoms)}</dd>
      <dt>Actions</dt><dd><ol style="margin:0;padding-left:18px">${d.suggestedActions.map(a => `<li>${esc(a)}</li>`).join('')}</ol></dd>${d.partsToCheck?.length ? `<dt>Parts to check</dt><dd>${d.partsToCheck.map(esc).join(', ')}</dd>` : ''}
      <dt>Drafted</dt><dd>${time(t.createdAt)} by ${esc(t.createdBy)}</dd></dl>
      <div class="row"><button class="btn sm" data-act="copy" data-id="${t.id}" type="button">Copy text</button>${canWrite() && t.status === 'draft' ? `<button class="btn sm primary" data-act="ticket-status" data-status="approved" data-id="${t.id}" type="button">Approve</button><button class="btn sm danger" data-act="ticket-status" data-status="discarded" data-id="${t.id}" type="button">Discard</button>` : ''}</div>
      <textarea class="sr-only" id="copy-${t.id}" readonly>${esc(ticketText(t))}</textarea></article>`; }).join('')}</div>` : '<div class="card empty">No drafts yet. Open a finding and choose “Draft ticket”.</div>'}`;
}
const ticketText = t => { const d = t.draft; return `${d.title}\nMachine: ${d.machineTag} ${d.machineName}\nPriority: ${d.priority}\nFailure category: ${d.failureCategory}\nMachine state: ${d.machineState}\n\nSymptoms:\n${d.symptoms}\n\nSuggested actions:\n${d.suggestedActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}${d.partsToCheck?.length ? `\n\nParts to check: ${d.partsToCheck.join(', ')}` : ''}`; };

// ---- Reports ----
function markdown(src) {
  const lines = esc(src).split('\n'), out = []; let list = null;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const l of lines) {
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) { close(); out.push(`<h${Math.min(3, m[1].length + 1)}>${inline(m[2])}</h${Math.min(3, m[1].length + 1)}>`); }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (l.trim()) { close(); out.push(`<p>${inline(l)}</p>`); } else close();
  }
  close(); return out.join('');
}
async function pageReports() {
  const list = await api('/reports'), busy = state.busy.has('report');
  return `<div class="head"><div class="grow"><h1>Health reports</h1><p>A written summary of machine health, trends and what to do next${state.config?.ai ? ', written by AI from the monitoring data' : ''}.</p></div>
    ${canWrite() ? `<div class="row"><button class="btn" data-act="report" data-period="shift" type="button" ${busy ? 'disabled' : ''}>Shift report</button><button class="btn primary" data-act="report" data-period="week" type="button" ${busy ? 'disabled' : ''}>Weekly report</button></div>` : ''}</div>
    ${busy ? '<div class="notice">Writing the report…</div>' : ''}
    ${list.length ? list.map(r => `<article class="card"><div class="row"><h2 class="grow">${r.period === 'week' ? 'Weekly' : 'Shift'} report · ${time(r.to)}</h2>${r.source === 'ai' ? chip('ai', 'AI') : chip('', 'Standard')}<span class="small muted">by ${esc(r.author)}</span></div><div class="md">${markdown(r.body)}</div></article>`).join('') : '<div class="card empty">No reports yet.</div>'}`;
}

// ---- Chat ----
const SUGGESTIONS = ['Which machine needs attention first, and why?', 'Why is IMM-02\'s hydraulic oil getting hotter?', 'Has BM-01\'s vibration changed this week?', 'Summarise the chiller\'s last 24 hours.'];
async function pageChat() {
  const c = await api('/chat'), busy = state.busy.has('chat');
  if (!c.enabled) return `<div class="head"><div class="grow"><h1>Ask AI</h1></div></div><div class="card"><p>The AI assistant is off. An administrator switches it on by setting <code>ANTHROPIC_API_KEY</code> on the server and restarting it.</p><p class="muted">Explanations, ticket drafts and reports still work without it, using the built-in knowledge.</p></div>`;
  return `<div class="head"><div class="grow"><h1>Ask AI</h1><p>Ask about your machines in plain language. The assistant looks up live and historical data before answering and shows what it looked at.</p></div>
    ${c.messages.length && canWrite() ? '<button class="btn" data-act="chat-new" type="button">New conversation</button>' : ''}</div>
    <section class="card chat"><div class="msgs" id="msgs">${c.messages.length ? c.messages.map(m => `<div class="msg ${m.role}">${esc(m.text)}${m.lookups?.length ? `<div class="lookups">Looked at: ${m.lookups.map(esc).join(' · ')}</div>` : ''}</div>`).join('') : `<div class="suggest">${SUGGESTIONS.map(s => `<button class="btn sm" data-act="suggest" type="button">${esc(s)}</button>`).join('')}</div>`}
      ${busy ? '<div class="msg muted">Looking at the data…</div>' : ''}${state.chatNotice ? `<div class="notice">${esc(state.chatNotice)}</div>` : ''}</div>
      ${canWrite() ? (c.isFull ? '<div class="composer"><p class="muted">This conversation is full. Start a new one to keep asking.</p></div>' : `<form class="composer" id="ask"><label class="sr-only" for="q">Question</label><textarea id="q" name="q" placeholder="e.g. Which machines could fail this week?" ${busy ? 'disabled' : ''}></textarea><button class="btn primary" ${busy ? 'disabled' : ''}>Ask</button></form>`) : '<div class="composer"><p class="muted">Your role can read but not ask.</p></div>'}</section>`;
}
async function ask(text) {
  if (!text.trim()) return;
  state.busy.add('chat'); state.chatNotice = ''; await render();
  try { const r = await api('/chat', 'POST', { text }); state.chatNotice = r.notice || ''; }
  catch (e) { state.chatNotice = e.message; }
  state.busy.delete('chat'); await render(); const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight;
}

// ---- Settings ----
async function pageSettings() {
  const s = await api('/settings');
  const v = x => x == null ? '' : x;
  return `<div class="head"><div class="grow"><h1>Settings</h1><p>Limits, connections and the models.</p></div><button class="btn" data-act="retrain" type="button">Retrain models now</button></div>
    <section class="card"><h2>Connections</h2><dl class="facts"><dt>AI assistant</dt><dd>${s.ai ? `On (${esc(s.aiModel)})` : 'Off: set ANTHROPIC_API_KEY on the server'}</dd>
      <dt>Gateway intake</dt><dd>${s.ingestKeySet ? 'On' : 'Off: set MONITOR_INGEST_KEY on the server'} · <code>POST /api/ingest</code> with header <code>X-Ingest-Key</code></dd>
      <dt>Simulator</dt><dd>${s.simulator ? 'On (demo data)' : 'Off'}</dd></dl>
      ${s.faults.length ? `<p class="small muted">Simulated developing faults: ${s.faults.map(f => `<b>${esc(f.tag)}</b> ${esc(f.story)}`).join('; ')}.</p>` : ''}
      <details><summary class="small">Example gateway request</summary><pre class="small" style="overflow-x:auto">curl -X POST $HOST/api/ingest -H "X-Ingest-Key: $KEY" -H "content-type: application/json" \\
  -d '{"readings":[{"device":"${esc(s.machines[0]?.deviceId || 'plc-imm-01')}","at":"2026-10-19T08:15:00Z","state":"running","values":{"hydraulic_oil_temp":47.2}}]}'</pre></details></section>
    ${s.machines.map(m => `<section class="card"><div class="row"><h2 class="grow">${esc(m.tag)} · ${esc(m.name)}</h2><span class="small muted">Device ID <code>${esc(m.deviceId)}</code></span></div>
      <form data-limits="${m.id}"><div class="table-wrap"><table><thead><tr><th>Signal</th><th>Crit low</th><th>Warn low</th><th>Warn high</th><th>Crit high</th></tr></thead><tbody>
      ${m.signals.map(sg => `<tr><td>${esc(sg.label)} <span class="muted">${esc(sg.unit)}</span></td>${['crit_low', 'warn_low', 'warn_high', 'crit_high'].map(k => `<td><input type="number" step="any" name="${sg.key}:${k}" value="${v(sg[k])}" aria-label="${esc(sg.label)} ${k.replace('_', ' ')}"></td>`).join('')}</tr>`).join('')}
      </tbody></table></div><div class="row" style="margin-top:10px"><button class="btn primary sm">Save limits</button><span class="small muted" data-saved="${m.id}"></span></div></form></section>`).join('')}`;
}

// ---- Actions ----
function bindActions() {
  document.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', async () => {
    const { act, id } = el.dataset;
    try {
      if (act === 'hours') { state.hours[id] = Number(el.dataset.hours); return render(); }
      if (act === 'filter') { location.hash = `#/findings?status=${el.dataset.status}`; return; }
      if (act === 'explain') {
        if (state.openExplain.has(id)) { state.openExplain.delete(id); return render(); }
        state.openExplain.add(id); state.busy.add(id); await render();
        try { await api(`/findings/${id}/explain`, 'POST', {}); } finally { state.busy.delete(id); }
        return render();
      }
      if (act === 'status') {
        const status = el.dataset.status, note = status === 'false_alarm' || status === 'resolved' ? prompt(status === 'false_alarm' ? 'Why is it a false alarm? (optional)' : 'What was fixed? (optional)') : null;
        await api(`/findings/${id}`, 'PATCH', { status, ...(note ? { note } : {}) }); return render();
      }
      if (act === 'ticket') { el.disabled = true; el.textContent = 'Drafting…'; await api(`/findings/${id}/ticket`, 'POST', {}); location.hash = '#/tickets'; return; }
      if (act === 'ticket-status') { await api(`/tickets/${id}`, 'PATCH', { status: el.dataset.status }); return render(); }
      if (act === 'copy') { const t = $(`#copy-${id}`).value; try { await navigator.clipboard.writeText(t); el.textContent = 'Copied'; } catch { const ta = $(`#copy-${id}`); ta.classList.remove('sr-only'); ta.select(); } return; }
      if (act === 'report') { state.busy.add('report'); await render(); try { await api('/reports', 'POST', { period: el.dataset.period }); } finally { state.busy.delete('report'); } return render(); }
      if (act === 'suggest') return ask(el.textContent);
      if (act === 'chat-new') { await api('/chat', 'DELETE'); state.chatNotice = ''; return render(); }
      if (act === 'retrain') { el.disabled = true; el.textContent = 'Retraining…'; await api('/models/retrain', 'POST', {}); el.textContent = 'Retrained'; return; }
    } catch (e) { alert(e.message); render(); }
  }));
  $('#ask')?.addEventListener('submit', e => { e.preventDefault(); ask(e.target.q.value); });
  $('#q')?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(e.target.value); } });
  document.querySelectorAll('form[data-limits]').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault(); const mid = f.dataset.limits, byKey = {};
    for (const [name, value] of new FormData(f)) { const [key, k] = name.split(':'); (byKey[key] ||= { key })[k] = value === '' ? null : Number(value); }
    const out = document.querySelector(`[data-saved="${mid}"]`);
    try { await api(`/machines/${mid}/limits`, 'PUT', { limits: Object.values(byKey) }); out.textContent = 'Saved. The analysis now uses the new limits.'; }
    catch (err) { out.textContent = err.message; }
  }));
}

render();
