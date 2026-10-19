// Alerts shared by every monitoring module, and their email notifications.
// An alert is identified by a dedupe key (e.g. "oee-down:<machine>"): while one is open, raising the same key again
// does nothing, so a long fault produces one alert, not one per reading. Resolving it allows the next one.
import { id, now, one, all, run } from '../../common/db.js';

const RANK={info:0,warning:1,critical:2};
const setting=async (key,fallback)=>{ try { return JSON.parse((await one('SELECT value FROM settings WHERE key=?',key))?.value??'null')??fallback; } catch { return fallback; } };
// Lowest severity that is emailed (in-app alerts are always shown). Default: only critical alerts are emailed.
export const emailThreshold=async ()=>await setting('alert_email_min_severity','critical');

export async function raiseAlert({companyId,plantId=null,module,severity,equipmentId=null,title,detail='',dedupeKey,at=now()}) {
  if (await one("SELECT 1 FROM alerts WHERE dedupe_key=? AND status<>'resolved'",dedupeKey)) return null;
  const key=id();
  await run('INSERT INTO alerts (id,company_id,plant_id,module,severity,equipment_id,title,detail,status,dedupe_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',key,companyId,plantId,module,severity,equipmentId,title.slice(0,200),detail.slice(0,2000),'open',dedupeKey,at);
  if (RANK[severity]>=RANK[await emailThreshold()]) await queueEmails(await one('SELECT * FROM alerts WHERE id=?',key));
  return key;
}
// Raises an open alert's severity (e.g. warning → critical); emails go out if it now meets the email threshold.
export async function escalateAlert(alertId,{severity,title,detail}) {
  const before=await one('SELECT * FROM alerts WHERE id=?',alertId); if (!before) return;
  await run("UPDATE alerts SET severity=?,title=?,detail=?,status='open' WHERE id=?",severity,title.slice(0,200),detail.slice(0,2000),alertId);
  if (RANK[severity]>=RANK[await emailThreshold()]&&RANK[before.severity]<RANK[await emailThreshold()]) await queueEmails(await one('SELECT * FROM alerts WHERE id=?',alertId));
}
// Auto-resolve when the condition clears (e.g. the machine runs again).
export async function resolveAlertKey(dedupeKey,at=now()) { await run("UPDATE alerts SET status='resolved',resolved_at=? WHERE dedupe_key=? AND status<>'resolved'",at,dedupeKey); }

// Who is told: the customer's admins, plant managers and maintenance staff who accept alert emails, plus the
// platform's dispatchers for critical alerts.
async function recipients(alert) {
  const customer=await all("SELECT email FROM users WHERE company_id=? AND active=1 AND alert_emails=1 AND role IN ('customer_admin','plant_manager','maintenance')",alert.company_id);
  const dispatch=alert.severity==='critical'?await all("SELECT email FROM users WHERE active=1 AND alert_emails=1 AND role='dispatcher'"):[];
  return [...new Set([...customer,...dispatch].map(r=>r.email))];
}
async function queueEmails(alert) {
  const machine=alert.equipment_id?await one('SELECT asset_tag,make,model FROM equipment WHERE id=?',alert.equipment_id):null;
  const subject=`[${alert.severity.toUpperCase()}] ${alert.title}${machine?` – ${machine.asset_tag||''} ${machine.make} ${machine.model}`:''}`.slice(0,200);
  const body=`${alert.title}\n\n${alert.detail}\n\nMachine: ${machine?`${machine.asset_tag||''} ${machine.make} ${machine.model}`:'—'}\nRaised: ${alert.created_at} (UTC)\nModule: ${alert.module}\n\nOpen the platform to acknowledge the alert or raise a maintenance ticket.`;
  const configured=!!(process.env.EMAIL_PROVIDER&&process.env.EMAIL_API_KEY&&process.env.EMAIL_FROM);
  for (const to of await recipients(alert)) await run('INSERT INTO notification_outbox (id,alert_id,channel,recipient,subject,body,status,created_at) VALUES (?,?,?,?,?,?,?,?)',id(),alert.id,'email',to,subject,body,configured?'queued':'not_configured',now());
  if (configured) setTimeout(()=>sendQueued().catch(e=>console.error('Email sending failed:',e.message)),0);
}

// Email delivery through an HTTPS email API (no SMTP library needed). Configure EMAIL_PROVIDER (brevo, sendgrid or
// resend), EMAIL_API_KEY and EMAIL_FROM on the server. Without them, emails stay in the outbox as "not_configured".
const PROVIDERS={
  brevo:(m,key,from)=>['https://api.brevo.com/v3/smtp/email',{'api-key':key},{sender:{email:from},to:[{email:m.recipient}],subject:m.subject,textContent:m.body}],
  sendgrid:(m,key,from)=>['https://api.sendgrid.com/v3/mail/send',{authorization:`Bearer ${key}`},{personalizations:[{to:[{email:m.recipient}]}],from:{email:from},subject:m.subject,content:[{type:'text/plain',value:m.body}]}],
  resend:(m,key,from)=>['https://api.resend.com/emails',{authorization:`Bearer ${key}`},{from,to:[m.recipient],subject:m.subject,text:m.body}]
};
export async function sendQueued(limit=50) {
  const make=PROVIDERS[process.env.EMAIL_PROVIDER], key=process.env.EMAIL_API_KEY, from=process.env.EMAIL_FROM;
  if (!make||!key||!from) return 0;
  let sent=0;
  for (const m of await all("SELECT * FROM notification_outbox WHERE status='queued' ORDER BY created_at LIMIT ?",limit)) {
    const [url,headers,body]=make(m,key,from);
    try {
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0,200)}`);
      await run("UPDATE notification_outbox SET status='sent',sent_at=? WHERE id=?",now(),m.id); sent++;
    } catch(e) { await run("UPDATE notification_outbox SET status='failed',error=? WHERE id=?",String(e.message).slice(0,500),m.id); }
  }
  return sent;
}
