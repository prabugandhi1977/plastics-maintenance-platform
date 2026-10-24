// Hand-off to MouldCare: an approved ticket draft becomes a breakdown ticket there, through its ticket intake
// (POST /api/integrations/tickets with a company integration key). Set MONITOR_MOULDCARE_URL (MouldCare's address)
// and MONITOR_MOULDCARE_KEY. The key is only ever sent to MouldCare: never returned, stored or logged.
// The draft id is the reference, so sending a draft twice finds the ticket already raised instead of a second one.
// A send never fails the approval: the result (sent, failed, not_configured) is kept on the draft, and failed
// sends are retried by a background job.
import { one, all, run, audit } from './db.js';
import { assignmentOut } from './people.js';

export const TIMEOUT_MS = 10000, MAX_AUTO_ATTEMPTS = 10;
// Monitor's failure categories and machine states in MouldCare's catalogue (the other categories share their names).
const CATEGORY = { control: 'controls' };
const STATE = { running: 'running', running_degraded: 'reduced_output', stopped: 'stopped' };
const IMPACT = { running: 'Machine still running. Found by condition monitoring before a breakdown.', running_degraded: 'Machine running with reduced output or quality.', stopped: 'Machine stopped.' };

export function mouldcareConfig() {
  const raw = (process.env.MONITOR_MOULDCARE_URL || '').trim(), key = (process.env.MONITOR_MOULDCARE_KEY || '').trim();
  let url = null; try { const u = new URL(raw); if (['http:', 'https:'].includes(u.protocol)) url = u.origin + u.pathname.replace(/\/+$/, ''); } catch {}
  return { url, key, configured: !!(url && key), problem: !raw ? 'MONITOR_MOULDCARE_URL is not set' : !url ? 'MONITOR_MOULDCARE_URL is not an http(s) address' : !key ? 'MONITOR_MOULDCARE_KEY is not set' : null };
}
// For Settings › Connections: never the key, only whether it is set.
export function mouldcareStatus() {
  const c = mouldcareConfig(), n = s => one('SELECT COUNT(*) n FROM ticket_drafts WHERE mouldcare_status=?', s).n;
  const lastError = one("SELECT mouldcare_error e, mouldcare_attempted_at at FROM ticket_drafts WHERE mouldcare_status='failed' ORDER BY mouldcare_attempted_at DESC LIMIT 1");
  return { configured: c.configured, url: c.url, keySet: !!c.key, problem: c.problem, sent: n('sent'), failed: n('failed'), notConfigured: n('not_configured'),
    lastSentAt: one('SELECT MAX(mouldcare_sent_at) t FROM ticket_drafts').t ?? null, lastError: lastError?.e ?? null, lastErrorAt: lastError?.at ?? null };
}
export const mouldcareOut = t => ({ mouldcare: t.mouldcare_status ? { status: t.mouldcare_status, ticketId: t.mouldcare_ticket_id, error: t.mouldcare_error, sentAt: t.mouldcare_sent_at, attempts: t.mouldcare_attempts, attemptedAt: t.mouldcare_attempted_at,
  autoRetry: t.mouldcare_status === 'failed' && t.mouldcare_attempts < MAX_AUTO_ATTEMPTS } : null });

export function payloadOf(t) {
  const d = JSON.parse(t.draft_json), m = one('SELECT tag FROM machines WHERE id=?', t.machine_id), f = t.finding_id ? one('SELECT first_seen FROM findings WHERE id=?', t.finding_id) : null;
  const clip = (s, n) => String(s ?? '').trim().slice(0, n);
  const actions = [...(d.suggestedActions ?? []), ...(d.partsToCheck?.length ? [`Parts to check: ${d.partsToCheck.join(', ')}`] : [])].map(a => clip(a, 500)).filter(Boolean).slice(0, 20);
  return { source: 'monitor', externalId: t.id, assetTag: m?.tag ?? d.machineTag, title: clip(d.title, 160), symptoms: clip(d.symptoms, 3000), failureCategory: CATEGORY[d.failureCategory] ?? d.failureCategory,
    priority: d.priority, machineState: STATE[d.machineState] ?? 'running', safetyIssue: false, occurredAt: new Date(Math.min(f?.first_seen ?? t.created_at, Date.now())).toISOString(),
    productionImpact: IMPACT[d.machineState] ?? IMPACT.running, suggestedActions: actions, ...(assignmentOut(t).assignee ? { assigneeName: assignmentOut(t).assignee.name } : {}) };
}

const inflight = new Set();
// Sends one approved draft and records the outcome. Returns the outcome; never throws for MouldCare's sake.
export async function sendDraft(draftId, { by = null, timeoutMs = TIMEOUT_MS } = {}) {
  const t = one('SELECT * FROM ticket_drafts WHERE id=?', draftId);
  if (!t || t.status !== 'approved') return null;
  if (t.mouldcare_status === 'sent' || inflight.has(t.id)) return mouldcareOut(t).mouldcare;
  const c = mouldcareConfig(), at = Date.now();
  const record = (status, ticketId, error) => {
    run('UPDATE ticket_drafts SET mouldcare_status=?,mouldcare_ticket_id=COALESCE(?,mouldcare_ticket_id),mouldcare_error=?,mouldcare_sent_at=CASE WHEN ?=\'sent\' THEN ? ELSE mouldcare_sent_at END,mouldcare_attempts=mouldcare_attempts+?,mouldcare_attempted_at=? WHERE id=?',
      status, ticketId, error, status, at, status === 'not_configured' ? 0 : 1, at, t.id);
    audit(by, `ticket.mouldcare_${status}`, 'ticket', t.id, { ticketId, error });
    return mouldcareOut(one('SELECT * FROM ticket_drafts WHERE id=?', t.id)).mouldcare;
  };
  if (!c.configured) return record('not_configured', null, c.problem);
  inflight.add(t.id);
  try {
    let payload; try { payload = payloadOf(t); } catch (e) { return record('failed', null, `Could not read the draft: ${e.message}`); }
    const res = await fetch(`${c.url}/api/integrations/tickets`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-integration-key': c.key }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ticket?.id) return record('sent', String(data.ticket.id).slice(0, 100), null);
    const why = res.status === 401 ? 'MouldCare refused the integration key. Check MONITOR_MOULDCARE_KEY.' : `MouldCare answered ${res.status}${data.error ? `: ${String(data.error).slice(0, 300)}` : ''}`;
    return record('failed', null, why);
  } catch (e) {
    return record('failed', null, e.name === 'TimeoutError' ? `MouldCare did not answer within ${Math.round(timeoutMs / 1000)} s` : `Could not reach MouldCare: ${e.cause?.code ?? e.message}`);
  } finally { inflight.delete(t.id); }
}

// Background job: failed sends (up to the automatic limit), and drafts approved while MouldCare was not set up.
export async function retryPending({ limit = 20, timeoutMs } = {}) {
  if (!mouldcareConfig().configured) return { tried: 0, sent: 0 };
  const due = all("SELECT id FROM ticket_drafts WHERE status='approved' AND (mouldcare_status='not_configured' OR (mouldcare_status='failed' AND mouldcare_attempts<?)) ORDER BY mouldcare_attempted_at LIMIT ?", MAX_AUTO_ATTEMPTS, limit);
  let sent = 0;
  for (const { id } of due) if ((await sendDraft(id, { timeoutMs }))?.status === 'sent') sent++;
  return { tried: due.length, sent };
}
