// People and ticket allocation in the dashboard: Settings › Users and Settings › Service providers for the super
// user, the allocation mode, and on each ticket draft who it is assigned to, with the dialogs to assign, reassign
// and approve-and-assign (from the ranked candidates, or Claude's pick).
import { icon, heading } from '/icons.js';
import { btn, dialog, field, select, textarea } from '/setup.js';
let ctx; // { api, esc, state, render }
export const initPeople = c => { ctx = c; };
const esc = v => ctx.esc(v);
let catalog = null;
const cat = async (fresh = false) => (fresh || !catalog) ? (catalog = await ctx.api('/people/catalog')) : catalog;
const ROLE = { admin: 'Super user', engineer: 'Engineer', viewer: 'Viewer' };
const MODE = { suggest: ['Suggest only', 'Drafting ranks the candidates and shows the best one; a planner assigns it.'],
  auto_rules: ['Assign automatically by the rules', 'The best-ranked candidate (skills, workload, history on the machine) gets the ticket as soon as it is drafted.'],
  auto_ai: ['Assign automatically with AI', 'Claude chooses among the ranked candidates and gives its reason; the rules decide when the AI is off or unsure.'] };
const SOURCE = { manual: 'Manual', rules: 'Rules', ai: 'AI' };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const skillChips = sk => [...sk.disciplines.map(d => `<span class="chip">${esc(cap(d))}</span>`), ...sk.machineTypes.map(m => `<span class="chip ai">${esc(catalog?.machineTypes?.[m] ?? m)}</span>`)].join(' ') || '<span class="muted">—</span>';
const checks = (name, options, values = []) => `<div class="checks">${options.map(([v, l]) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(v)}" ${values.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
const skillsFields = (c, sk = { machineTypes: [], disciplines: [] }) => `<fieldset class="span"><legend>Skills: disciplines</legend>${checks('disc', c.disciplines.map(d => [d, cap(d)]), sk.disciplines)}</fieldset>
  <fieldset class="span"><legend>Skills: machine types</legend>${checks('mt', Object.entries(c.machineTypes), sk.machineTypes)}</fieldset>`;
const skillsFrom = fd => ({ disciplines: fd.getAll('disc'), machineTypes: fd.getAll('mt') });

// ---- Settings › Users ----
export async function usersTab() {
  const [c, users] = await Promise.all([cat(true), ctx.api('/users')]);
  const me = ctx.state.user.id;
  return `<section class="card"><div class="row">${heading('assign', 'Ticket allocation', 2, 'ai')}</div>
      <p class="small muted">How a ticket draft gets its assignee when it is written. It can always be changed while approving it, or afterwards.</p>
      <form id="alloc-mode" class="modes">${c.modes.map(m => `<label class="mode ${c.mode === m ? 'on' : ''}"><input type="radio" name="mode" value="${m}" ${c.mode === m ? 'checked' : ''} ${m === 'auto_ai' && !c.ai ? 'disabled' : ''}>
        <span><b>${esc(MODE[m][0])}</b><br><span class="small muted">${esc(MODE[m][1])}${m === 'auto_ai' && !c.ai ? ' Needs ANTHROPIC_API_KEY on the server.' : ''}</span></span></label>`).join('')}</form></section>
    <section class="card"><div class="row">${heading('users', `Users <span class="count-chip">${users.length}</span>`)}${btn('user-new', 'Add user', 'plus', { cls: 'sm primary' })}</div>
      <p class="small muted">Engineers with skills are offered for tickets. Deactivated users cannot sign in and are not offered; users with history are deactivated rather than deleted.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Skills</th><th>Contact</th><th>Open tickets</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr class="${u.active ? '' : 'inactive'}"><td><b>${esc(u.name)}</b>${u.id === me ? ' <span class="muted">(you)</span>' : ''}<div class="small muted">${esc(u.jobTitle || '')}${u.providerName ? `${u.jobTitle ? ' · ' : ''}${icon('provider', 'i xs')} ${esc(u.providerName)}` : ''}</div></td>
        <td>${u.role === 'admin' ? `<span class="chip ai">${icon('shield', 'i xs')} ${ROLE.admin}</span>` : esc(ROLE[u.role])}</td><td>${skillChips(u.skills)}</td>
        <td class="small">${esc(u.email)}${u.phone ? `<br><span class="muted">${esc(u.phone)}</span>` : ''}</td><td class="num">${u.openWork}</td><td>${u.active ? '<span class="chip good">Active</span>' : '<span class="chip">Deactivated</span>'}</td>
        <td><span class="row acts">${btn('user-edit', 'Edit', 'edit', { data: { id: u.id } })}${u.id === me ? '' : `${btn('user-password', 'Password', 'key', { data: { id: u.id } })}${btn('user-active', u.active ? 'Deactivate' : 'Activate', 'power', { data: { id: u.id, active: u.active ? '0' : '1' } })}${btn('user-del', 'Delete', 'trash', { cls: 'sm danger', data: { id: u.id, name: u.name } })}`}</span></td></tr>`).join('')}
      </tbody></table></div></section>`;
}
export async function providersTab() {
  const [c, providers] = await Promise.all([cat(), ctx.api('/providers')]);
  return `<section class="card"><div class="row">${heading('provider', `Service providers <span class="count-chip">${providers.length}</span>`)}${btn('provider-new', 'Add provider', 'plus', { cls: 'sm primary' })}</div>
    <p class="small muted">Outside companies tickets can be given to. Their skills and response time count when candidates are ranked; a provider's own technicians are added as users and linked to it.</p>
    ${providers.length ? `<div class="table-wrap"><table><thead><tr><th>Provider</th><th>Skills</th><th>Contact</th><th>Response</th><th>Technicians</th><th>Open tickets</th><th>Status</th><th></th></tr></thead><tbody>
    ${providers.map(p => `<tr class="${p.active ? '' : 'inactive'}"><td><b>${esc(p.name)}</b>${p.notes ? `<div class="small muted">${esc(p.notes)}</div>` : ''}</td><td>${skillChips(p.skills)}</td>
      <td class="small">${esc(p.contactName || '—')}${p.email ? `<br>${esc(p.email)}` : ''}${p.phone ? `<br><span class="muted">${esc(p.phone)}</span>` : ''}</td><td class="num">${p.responseHours != null ? `${p.responseHours} h` : '—'}</td>
      <td class="small">${p.technicians.map(t => esc(t.name)).join(', ') || '—'}</td><td class="num">${p.openWork}</td><td>${p.active ? '<span class="chip good">Active</span>' : '<span class="chip">Deactivated</span>'}</td>
      <td><span class="row acts">${btn('provider-edit', 'Edit', 'edit', { data: { id: p.id } })}${btn('provider-active', p.active ? 'Deactivate' : 'Activate', 'power', { data: { id: p.id, active: p.active ? '0' : '1' } })}${btn('provider-del', 'Delete', 'trash', { cls: 'sm danger', data: { id: p.id, name: p.name } })}</span></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No service providers yet. Choose “Add provider”.</p>'}</section>`;
}

async function userForm(u) {
  const [c, providers] = await Promise.all([cat(), ctx.api('/providers')]);
  const body = `<div class="form-grid">${field('name', 'Name', { value: u?.name, required: true, maxlength: 100 })}${field('email', 'Email', { value: u?.email, type: 'email', required: true, maxlength: 200 })}
    ${select('role', 'Role', c.roles.map(r => [r, ROLE[r]]), { value: u?.role ?? 'engineer', required: true })}${u ? '' : field('password', 'First password', { type: 'password', required: true, minlength: 12, autocomplete: 'new-password', help: 'At least 12 characters; share it with them securely.' })}
    ${field('jobTitle', 'Job title', { value: u?.jobTitle, maxlength: 100 })}${field('phone', 'Phone', { value: u?.phone, maxlength: 30, help: 'e.g. +91 98765 43210' })}
    ${select('providerId', 'Works for', providers.map(p => [p.id, p.name]), { value: u?.providerId ?? '', blank: 'This plant' })}${skillsFields(c, u?.skills)}</div>`;
  dialog(u ? `Edit ${u.name}` : 'Add user', body, { wide: true, dlgIcon: 'users', submit: u ? 'Save' : 'Add user', submitIcon: u ? 'check' : 'plus', onSubmit: async fd => {
    const v = Object.fromEntries(fd), out = { name: v.name, email: v.email, role: v.role, jobTitle: v.jobTitle, phone: v.phone, providerId: v.providerId || null, skills: skillsFrom(fd) };
    if (u) await ctx.api(`/users/${u.id}`, 'PATCH', out); else await ctx.api('/users', 'POST', { ...out, password: v.password });
  } });
}
async function providerForm(p) {
  const c = await cat();
  const body = `<div class="form-grid">${field('name', 'Company name', { value: p?.name, required: true, maxlength: 100 })}${field('contactName', 'Contact person', { value: p?.contactName, maxlength: 100 })}
    ${field('email', 'Email', { value: p?.email, type: 'email', maxlength: 200 })}${field('phone', 'Phone', { value: p?.phone, maxlength: 30 })}
    ${field('responseHours', 'Response time (hours)', { value: p?.responseHours, type: 'number', min: 1, max: 720, step: 1, help: 'From call to technician on site, as contracted' })}${skillsFields(c, p?.skills)}${textarea('notes', 'Notes', p?.notes)}</div>`;
  dialog(p ? `Edit ${p.name}` : 'Add service provider', body, { wide: true, dlgIcon: 'provider', submit: p ? 'Save' : 'Add provider', submitIcon: p ? 'check' : 'plus', onSubmit: async fd => {
    const v = Object.fromEntries(fd), out = { name: v.name, contactName: v.contactName, email: v.email, phone: v.phone, responseHours: v.responseHours === '' ? null : Number(v.responseHours), notes: v.notes, skills: skillsFrom(fd) };
    if (p) await ctx.api(`/providers/${p.id}`, 'PATCH', out); else await ctx.api('/providers', 'POST', out);
  } });
}

// ---- On a ticket draft ----
export function assignmentHtml(t, canWrite) {
  const a = t.assignee, s = t.suggestion, open = t.status !== 'discarded';
  const who = x => `${icon(x.kind === 'provider' ? 'provider' : 'user', 'i xs')} <b>${esc(x.name)}</b>`;
  const line = a ? `<div class="assign-row">${who(a)} <span class="chip ${t.assignmentSource === 'ai' ? 'ai' : ''}">${esc(SOURCE[t.assignmentSource] ?? 'Manual')}</span>${t.assignmentReason ? ` <span class="small muted">${esc(t.assignmentReason)}</span>` : ''}<div class="small muted">Assigned ${t.assignedBy ? `by ${esc(t.assignedBy)} ` : ''}${new Date(t.assignedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>`
    : s && open ? `<div class="assign-row suggest">${icon('sparkles', 'i xs')} Suggested: ${who(s)} <span class="small muted">${esc(s.reason)}</span>${canWrite ? ` ${btn('accept-suggestion', 'Assign', 'check', { cls: 'sm', data: { id: t.id, kind: s.kind, who: s.id, src: s.source, reason: s.reason } })}` : ''}</div>`
    : `<div class="assign-row muted">${icon('assign', 'i xs')} Not assigned</div>`;
  return `<div class="assign"><span class="small muted assign-l">Assigned to</span>${line}${canWrite && open ? btn('assign', a ? 'Reassign' : 'Choose assignee', 'assign', { data: { id: t.id } }) : ''}</div>`;
}
// The assign dialog: ranked candidates with their reasons, Claude's pick on request. With approve, it approves too.
async function assignDialog(tid, { approve = false } = {}) {
  const { candidates, ai } = await ctx.api(`/tickets/${tid}/candidates`);
  const t = (await ctx.api('/tickets')).find(x => x.id === tid);
  // Preselect the current assignee, else the drafting suggestion (keeping its source and reason), else the top candidate.
  const fromSuggestion = !t?.assignee && t?.suggestion, pre = t?.assignee ?? t?.suggestion ?? candidates[0];
  const current = pre ? `${pre.kind}:${pre.id}` : '';
  const rows = candidates.map(c => `<label class="cand"><input type="radio" name="who" value="${c.kind}:${esc(c.id)}" ${`${c.kind}:${c.id}` === current ? 'checked' : ''}>
    <span>${icon(c.kind === 'provider' ? 'provider' : 'user', 'i xs')} <b>${esc(c.name)}</b> <span class="small muted">${esc(c.detail)}</span><br><span class="small muted">${esc(c.reasons.join(' · '))}</span></span><span class="score num">${c.score}</span></label>`).join('');
  const body = `<p class="small muted">${approve ? 'Approve the draft and hand it over in one step. ' : ''}Ranked by skills for this machine and fault, open tickets and history on the machine.</p>
    ${ai ? `<div class="row">${btn('ai-pick', 'Ask AI to choose', 'sparkles', { data: { id: tid } })}<span class="small muted" id="ai-note"></span></div>` : ''}
    <div class="cands">${rows || '<p class="muted">No active technicians or providers yet. The super user adds them in Settings.</p>'}${approve ? `<label class="cand"><input type="radio" name="who" value="" ${current ? '' : 'checked'}><span class="muted">Approve without an assignee</span></label>` : `<label class="cand"><input type="radio" name="who" value=""><span class="muted">No assignee (unassign)</span></label>`}</div>
    ${field('reason', 'Note for the assignee (optional)', { maxlength: 500, value: fromSuggestion ? t.suggestion.reason : '' })}<input type="hidden" name="src" value="${fromSuggestion ? esc(t.suggestion.source) : 'manual'}">`;
  dialog(approve ? 'Approve and assign' : 'Assign ticket', body, { wide: true, dlgIcon: 'assign', submit: approve ? 'Approve' : 'Assign', submitIcon: 'check',
    onOpen: d => {
      d.querySelectorAll('[name=who]').forEach(r => r.addEventListener('change', () => { d.querySelector('[name=src]').value = 'manual'; }));
      d.querySelector('[data-act=ai-pick]')?.addEventListener('click', async e => {
        const b = e.currentTarget, note = d.querySelector('#ai-note'); b.disabled = true; note.textContent = 'Asking…';
        try { const p = await ctx.api(`/tickets/${tid}/ai-pick`, 'POST', {}); const r = d.querySelector(`[name=who][value="${p.kind}:${p.id}"]`); if (r) r.checked = true;
          d.querySelector('[name=src]').value = 'ai'; d.querySelector('[name=reason]').value = p.reason; note.textContent = `AI chose ${p.name}.`; }
        catch (x) { note.textContent = x.message; } finally { b.disabled = false; }
      });
    },
    onSubmit: async fd => {
      const [kind, ...rest] = String(fd.get('who') || '').split(':'), assignee = kind ? { kind, id: rest.join(':') } : null, reason = fd.get('reason') || '', src = fd.get('src') || 'manual';
      if (approve) await ctx.api(`/tickets/${tid}`, 'PATCH', { status: 'approved', assignee, assignSource: assignee ? src : 'manual', assignReason: reason });
      else await ctx.api(`/tickets/${tid}/assign`, 'POST', { assignee, source: assignee ? src : 'manual', reason });
    } });
}

// ---- Actions ----
export const ACTIONS = ['user-new', 'user-edit', 'user-password', 'user-active', 'user-del', 'provider-new', 'provider-edit', 'provider-active', 'provider-del', 'assign', 'approve', 'accept-suggestion'];
export async function action(act, el) {
  const { id } = el.dataset;
  if (act === 'user-new') return userForm();
  if (act === 'user-edit') return userForm((await ctx.api('/users')).find(u => u.id === id));
  if (act === 'user-password') return dialog('Set a new password', `${field('password', 'New password', { type: 'password', required: true, minlength: 12, autocomplete: 'new-password', help: 'At least 12 characters. They are signed out everywhere.' })}`,
    { dlgIcon: 'key', submit: 'Set password', onSubmit: async fd => { await ctx.api(`/users/${id}/password`, 'POST', { password: fd.get('password') }); } });
  if (act === 'user-active') { await ctx.api(`/users/${id}`, 'PATCH', { active: el.dataset.active === '1' }); return ctx.render(); }
  if (act === 'user-del') { if (!confirm(`Delete ${el.dataset.name}? Accounts with history are kept; deactivate those instead.`)) return; await ctx.api(`/users/${id}`, 'DELETE'); return ctx.render(); }
  if (act === 'provider-new') return providerForm();
  if (act === 'provider-edit') return providerForm((await ctx.api('/providers')).find(p => p.id === id));
  if (act === 'provider-active') { await ctx.api(`/providers/${id}`, 'PATCH', { active: el.dataset.active === '1' }); return ctx.render(); }
  if (act === 'provider-del') { if (!confirm(`Delete ${el.dataset.name}? Providers that have been given tickets are kept; deactivate those instead.`)) return; await ctx.api(`/providers/${id}`, 'DELETE'); return ctx.render(); }
  if (act === 'assign') return assignDialog(id);
  if (act === 'approve') return assignDialog(id, { approve: true });
  if (act === 'accept-suggestion') { await ctx.api(`/tickets/${id}/assign`, 'POST', { assignee: { kind: el.dataset.kind, id: el.dataset.who }, source: el.dataset.src || 'rules', reason: el.dataset.reason || '' }); return ctx.render(); }
}
// The allocation mode saves as soon as it is chosen.
export function bindPeople() {
  document.querySelectorAll('#alloc-mode [name=mode]').forEach(r => r.addEventListener('change', async () => {
    try { await ctx.api('/allocation', 'PUT', { mode: r.value }); catalog = null; ctx.render(); } catch (e) { alert(e.message); ctx.render(); }
  }));
}
