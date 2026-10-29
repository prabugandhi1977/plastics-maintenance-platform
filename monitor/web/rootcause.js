// "Why did this happen?" on a finding: the root-cause analysis (AI, or standard rules without it), shown as ranked
// causes with confidence, the evidence for and against (each cited item with a small chart for signals), the checks to
// do and a shortcut to draft a ticket with the chosen cause. Also the actual-cause field when a finding is resolved,
// and the accuracy figures for Settings. Engineers and the super user run it; viewers read what is stored.
import { icon, heading } from '/icons.js';
import { sparkline } from '/charts.js';
import { btn, dialog, select, textarea, sourcesHtml } from '/setup.js';
let ctx; // { api, esc, state, render }
export const initRootCause = c => { ctx = c; };
const esc = v => ctx.esc(v);
const canRun = () => ['admin', 'engineer'].includes(ctx.state.user?.role);
const time = t => t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const chip = (cls, label) => `<span class="chip ${esc(cls)}">${esc(label)}</span>`;
const CONF = { high: ['good', 'High confidence'], medium: ['watch', 'Medium confidence'], low: ['', 'Low confidence'] };
const open = new Set(), cache = new Map(); // finding id → { data } or { error }

// ---- On the finding card ----
export const whyAvailable = f => canRun() || f.rootCause?.analysed;
export const whyButton = f => whyAvailable(f) ? `<button class="btn sm" data-act="why" data-id="${esc(f.id)}" type="button" aria-expanded="${open.has(f.id)}">${icon(open.has(f.id) ? 'x' : 'search', 'bi')}<span>${open.has(f.id) ? 'Hide why' : 'Why did this happen?'}</span></button>` : '';
// The line under the title: the recorded actual cause, else the analysis' top cause.
export function causeLine(f) {
  const r = f.rootCause; if (!r) return '';
  if (r.actual) return `<div class="small cause-line">${icon('wrench', 'i xs')} <b>Actual cause:</b> ${esc(r.actual.cause)}${r.actual.topWasRight === true ? ` ${chip('good', 'The analysis was right')}` : r.actual.topWasRight === false ? ` ${chip('watch', 'The analysis ranked another first')}` : ''}</div>`;
  if (r.top) return `<div class="small cause-line">${icon('search', 'i xs')} <b>Most likely:</b> ${esc(r.top.cause)} ${chip(CONF[r.top.confidence]?.[0] ?? '', r.top.confidence)} ${chip(r.top.source === 'ai' ? 'ai' : '', r.top.source === 'ai' ? 'AI' : 'Standard rules')}</div>`;
  return '';
}
export const recordButton = f => ctx.state.user && canRun() && f.status === 'resolved' && !f.rootCause?.actual ? btn('cause-record', 'Record actual cause', 'wrench', { data: { id: f.id } }) : '';

// ---- The analysis ----
const dur = m => Math.abs(m) >= 60 ? `${Math.round(m / 6) / 10} h` : `${m} min`;
function refChips(ids, ev) { return ids.map(i => ev[i] ? `<span class="ref" title="${esc(ev[i].label)}"><b>${esc(i)}</b> ${esc(ev[i].label)}</span>` : '').join(' '); }
const cites = (list, ev) => list.length ? `<ul class="cites">${list.map(e => `<li>${esc(e.text)}${e.ids.length ? `<div class="refs">${refChips(e.ids, ev)}</div>` : ''}</li>`).join('')}</ul>` : '';
function windowSpark(it) {
  const from = it.moved && it.onset ? Math.max(it.from, it.onset - 12 * 3600000) : it.from, pts = it.spark.filter(p => p[0] >= from);
  return { pts, from };
}
function evidenceDetail(it) {
  const head = `<div class="row"><b class="ev-id">${esc(it.id)}</b><span class="grow"><b>${esc(it.label)}</b></span></div>`;
  if (it.type === 'signal') {
    const w = windowSpark(it);
    return `${head}<div class="small muted">${esc(it.note)}${it.moved ? ` · ${it.baseline} → ${it.current} ${esc(it.unit)} (${it.deltaSpreads} spreads from normal) · ${it.shape === 'step' ? 'a sudden step' : it.shape === 'transient' ? 'a short event' : 'a gradual drift'}${it.order ? ` · moved number ${it.order}${it.leadMinutes ? `, ${dur(it.leadMinutes)} after the first` : ' (first)'}` : ''}` : ''}</div>
      ${sparkline(w.pts, it.moved ? 'warning' : 'normal')}<div class="small muted">${time(w.from)} to ${time(it.to)}${it.moved && it.onset ? ` · onset ${time(it.onset)}` : ''}</div>`;
  }
  if (it.type === 'correlation') return `${head}<div class="small muted">${it.lagMinutes ? `${esc(it.bLabel)} follows ${esc(it.aLabel)} by about ${dur(it.lagMinutes)}.` : 'Moving together, with no clear lag.'} Correlation is not cause: two signals that both trend correlate on their own.</div>`;
  if (it.type === 'state') return `${head}<div class="small muted">${time(it.from)} to ${time(it.to)} · ${Object.entries(it.minutes).map(([k, v]) => `${esc(k)} ${Math.round(v / 60 * 10) / 10} h`).join(', ') || 'no state data'}${it.stoppedNearOnset ? ' · stopped shortly before the change began' : ''}</div>
    ${it.events.length ? `<div class="small muted">${it.events.map(e => `${time(e.ts)} ${esc(e.state)}`).join(' · ')}</div>` : ''}`;
  if (it.type === 'model') return `${head}<div class="small muted">${it.trained ? `Relationship distance ${it.distance ?? '—'} (alarm above ${it.distanceThreshold ?? '—'}), isolation score ${it.score ?? '—'} (alarm above ${it.threshold ?? '—'})${it.contributors.length ? ` · driven by ${it.contributors.map(c => `${esc(c.label)} ${c.value} (normal ${c.normal}, ${Math.round(c.share * 100)}%)`).join(', ')}` : ''}` : 'Not trained yet.'}</div>`;
  if (it.type === 'finding') return `${head}<div class="small muted">${it.sameMachine ? 'This machine' : `Same type of machine, ${esc(it.machineTag)}`} · ${time(it.start)} · ${esc(it.outcome.replace('_', ' '))}${it.reason ? ` (${esc(it.reason)})` : ''}${it.actualCause ? ` · <b>actual cause: ${esc(it.actualCause)}</b>${it.actualDetail ? ` (${esc(it.actualDetail)})` : ''}` : ''}${it.note ? ` · note: “${esc(it.note)}”` : ''}</div>`;
  if (it.type === 'manual') return `${head}${sourcesHtml([it], '')}<div class="small muted passage">${esc(it.text)}</div>`;
  if (it.type === 'ticket') return `${head}<div class="small muted">${esc(it.status)} · ${esc(it.priority)} priority · ${esc(it.symptoms)}</div>`;
  return head;
}
function causeCard(c, ev, f, data) {
  const [cls, label] = CONF[c.confidence] ?? CONF.low;
  return `<article class="cause"><div class="row"><span class="rank">${c.rank}</span><h4 class="grow">${esc(c.cause)}</h4>${chip(cls, label)}</div>
    ${c.mechanism ? `<p>${esc(c.mechanism)}</p>` : ''}
    <p class="small muted">${esc(c.confidenceReason)}</p>
    ${c.evidenceFor.length ? `<div><b class="small">Evidence for</b>${cites(c.evidenceFor, ev)}</div>` : ''}
    ${c.evidenceAgainst.length ? `<div><b class="small">Evidence against</b>${cites(c.evidenceAgainst, ev)}</div>` : ''}
    ${c.checks.length ? `<div><b class="small">Check to confirm</b><ol class="cites">${c.checks.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
    ${c.ruledOutBy.length ? `<div><b class="small">Ruled out if</b><ul class="cites">${c.ruledOutBy.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${canRun() && f.status !== 'false_alarm' ? `<div class="row">${btn('why-ticket', 'Draft ticket with this cause', 'tickets', { cls: 'sm primary', data: { id: f.id, index: c.rank - 1 } })}</div>` : ''}</article>`;
}
function resultView(f, data) {
  const r = data.result, ev = r.evidence, movers = r.movers.map(i => ev[i]).filter(Boolean), cited = Object.values(ev).filter(i => !r.movers.includes(i.id)).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return `<div class="why">
    ${heading('search', 'Why did this happen?', 3, 'ai')}
    <div class="row">${r.source === 'ai' ? chip('ai', `AI${r.model ? ' · ' + r.model : ''}`) : chip('', 'Standard rules, not AI')}<span class="small muted grow">${time(r.generatedAt)}${r.generatedBy ? ` by ${esc(r.generatedBy)}` : ''} · looked at ${r.considered.signals} signals, ${r.considered.pastFindings} past findings, ${r.considered.manuals} manual passages, ${r.considered.tickets} tickets</span>
      ${canRun() ? btn('why-run', 'Refresh', 'refresh', { data: { id: f.id } }) : ''}</div>
    ${data.stale ? `<div class="notice">The data has changed since this was made.${canRun() ? ' Refresh to include it.' : ' An engineer can refresh it.'}</div>` : ''}
    ${r.note ? `<div class="small muted">${esc(r.note)}</div>` : ''}
    ${r.summary ? `<p style="margin:0">${esc(r.summary)}</p>` : ''}
    <div><b class="small">What moved, in order</b>${movers.length ? `<ol class="movers">${movers.map(m => `<li><div class="row"><b class="grow">${esc(m.label)}</b><span class="small muted">${m.direction === 'down' ? 'down' : 'up'} · ${time(m.onset)}${m.leadMinutes ? ` · +${dur(m.leadMinutes)}` : ' · first'}</span></div>${sparkline(windowSpark(m).pts, 'warning')}</li>`).join('')}</ol>` : '<p class="small muted">No signal left its normal band persistently in the window.</p>'}</div>
    <div class="causes">${r.causes.map(c => causeCard(c, ev, f, data)).join('')}</div>
    ${r.cannotTell.length ? `<div><b class="small">What we can't tell from the data</b><ul class="cites">${r.cannotTell.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${cited.length ? `<details><summary class="small">Evidence cited (${cited.length})</summary><div class="grid" style="margin-top:8px">${cited.map(i => `<div class="ev">${evidenceDetail(i)}</div>`).join('')}</div></details>` : ''}
    ${r.droppedRefs ? `<div class="small muted">${r.droppedRefs} citation${r.droppedRefs === 1 ? '' : 's'} to evidence that was not given were removed.</div>` : ''}
    ${r.movers.length ? `<details><summary class="small">Signal windows (${movers.length})</summary><div class="grid" style="margin-top:8px">${movers.map(i => `<div class="ev">${evidenceDetail(i)}</div>`).join('')}</div></details>` : ''}</div>`;
}
export function whyPanel(f) {
  if (!open.has(f.id)) return '';
  const c = cache.get(f.id);
  if (!c) return `<div class="explain muted" role="status">${canRun() ? 'Gathering the evidence and working out the cause…' : 'Loading…'}</div>`;
  if (c.error) return `<div class="error">${esc(c.error)}</div>`;
  if (!c.data.result) return `<div class="explain">${icon('search', 'i xs')} <span class="muted">No analysis has been run for this finding yet.</span> ${canRun() ? btn('why-run', 'Run the analysis', 'search', { cls: 'sm primary', data: { id: f.id } }) : ''}</div>`;
  return `<div class="explain">${resultView(f, c.data)}</div>`;
}

async function load(id, { run = false, refresh = false } = {}) {
  ctx.state.busy.add(id);
  try { cache.set(id, { data: run ? await ctx.api(`/findings/${id}/root-cause`, 'POST', { refresh }) : await ctx.api(`/findings/${id}/root-cause`) }); }
  catch (e) { cache.set(id, { error: e.message }); }
  finally { ctx.state.busy.delete(id); }
}

// ---- Recording the actual cause ----
// Fields for the "Mark fixed" dialog: the suggested causes of the stored analysis to pick from, and free text.
export async function causeFields(id) {
  let data = null; try { data = await ctx.api(`/findings/${id}/root-cause`); } catch { /* the fields still work without it */ }
  const causes = data?.result?.causes ?? [];
  return `<fieldset class="span form-grid"><legend>What was the actual root cause? (optional)</legend>
    ${causes.length ? select('cause', 'One of the suggested causes', causes.map((c, i) => [i, `${i + 1}. ${c.cause}`]), { blank: 'None of these / not recorded' }) : '<p class="small muted span">No analysis has been run for this finding, so type the cause if you know it.</p>'}
    ${textarea('cause_text', causes.length ? 'In your words (needed if none above fits; otherwise adds detail)' : 'The actual cause in your words')}</fieldset>`;
}
export function causeFrom(fd) {
  const pick = fd.get('cause'), text = String(fd.get('cause_text') || '').trim();
  return pick !== null && pick !== '' ? { pick: Number(pick), ...(text ? { text } : {}) } : text ? { text } : undefined;
}

// ---- Settings › Connections & models ----
export function statsHtml(s) {
  if (!s) return '—';
  const t = s.total, pc = x => x.rightShare == null ? '—' : `${Math.round(x.rightShare * 100)} %`;
  if (!t.recorded) return `${chip('', 'None yet')}<div class="small muted">When an engineer resolves a finding they can record the actual cause. The figures here then show how often the analysis ranked it first.</div>`;
  return `${t.compared ? `The top cause was right ${t.right} of ${t.compared} times (${pc(t)})` : `${t.recorded} recorded`}${t.ai.compared ? ` · AI ${t.ai.right} of ${t.ai.compared}` : ''}${t.standard.compared ? ` · standard rules ${t.standard.right} of ${t.standard.compared}` : ''}
    <ul class="small" style="margin:6px 0 0;padding-left:18px">${s.types.map(x => `<li><b>${esc(x.label)}</b>: ${x.recorded} recorded${x.compared ? `, top cause right ${x.right}, wrong ${x.wrong} (${pc(x)})` : ''}${x.inList > x.right ? `, ${x.inList - x.right} other suggested cause${x.inList - x.right === 1 ? '' : 's'} picked` : ''}</li>`).join('')}</ul>
    <div class="small muted">Right means the engineer picked the analysis' first-ranked cause. Recorded causes are shown as evidence in later analyses; nothing else changes.</div>`;
}

export const ACTIONS = ['why', 'why-run', 'why-ticket', 'cause-record'];
export async function action(act, el) {
  const { id } = el.dataset;
  if (act === 'why') {
    if (open.has(id)) { open.delete(id); return ctx.render(); }
    open.add(id); cache.delete(id); await ctx.render();
    await load(id, { run: canRun() }); return ctx.render();
  }
  if (act === 'why-run') { const refresh = !!cache.get(id)?.data?.result; cache.delete(id); await ctx.render(); await load(id, { run: true, refresh }); return ctx.render(); }
  if (act === 'why-ticket') { el.disabled = true; el.querySelector('span').textContent = 'Drafting…'; await ctx.api(`/findings/${id}/ticket`, 'POST', { rootCauseIndex: Number(el.dataset.index) }); location.hash = '#/tickets'; return; }
  if (act === 'cause-record') {
    const fields = await causeFields(id);
    return dialog('Record the actual cause', `<p class="small muted span">Recorded against this finding. It is shown as evidence on later findings of this type and counted in the accuracy figures; nothing else changes.</p>${fields}`,
      { submit: 'Record cause', dlgIcon: 'wrench', onSubmit: async fd => { const rc = causeFrom(fd); if (!rc) throw new Error('Pick a suggested cause or describe it.'); await ctx.api(`/findings/${id}/actual-cause`, 'POST', rc); } });
  }
}
