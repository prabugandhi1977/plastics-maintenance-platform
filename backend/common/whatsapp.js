// WhatsApp notifications through the WhatsApp Business Cloud API (Meta). Messages a business starts must use a message
// template approved by Meta; ours has two body variables: {{1}} a short heading, {{2}} the details.
// Messages wait in notification_outbox (channel 'whatsapp') exactly like emails: 'queued' until delivered, then 'sent'
// or 'failed'; without the WHATSAPP_* settings they are stored as 'not_configured' and nothing is sent.
// A user receives WhatsApp messages only when opted in (users.alert_whatsapp=1) with a phone number in E.164 form.
import { id, now, one, all, run } from './db.js';
import { bad } from './validate.js';

// E.164: "+", country code, number; 8-15 digits in all. Spaces and dashes typed between digit groups are ignored.
export function e164(value) {
  const compact=String(value??'').trim().replace(/[\s-]/g,'');
  return /^\+[1-9][0-9]{7,14}$/.test(compact)?compact:null;
}
// For saving a user: WhatsApp can only be turned on with a phone number WhatsApp can reach.
export function requireWhatsappPhone(phoneValue) {
  if (!e164(phoneValue)) bad('To receive WhatsApp messages, the phone number must be in international format: + country code and number, 8-15 digits, e.g. +919876543210');
}
export const flag=(v,name)=>v===true?1:v===false?0:bad(`${name} must be true or false`);

export const whatsappSettings=()=>({token:process.env.WHATSAPP_TOKEN, phoneNumberId:process.env.WHATSAPP_PHONE_NUMBER_ID, template:process.env.WHATSAPP_TEMPLATE,
  lang:process.env.WHATSAPP_TEMPLATE_LANG||'en', version:process.env.WHATSAPP_API_VERSION||'v21.0'});
export function whatsappConfigured() { const s=whatsappSettings(); return !!(s.token&&s.phoneNumberId&&s.template); }
// What admins see (never the token).
export const whatsappStatus=()=>{ const s=whatsappSettings(); return {configured:whatsappConfigured(),template:s.template||null,lang:s.lang,apiVersion:s.version}; };

// Template variables may not contain new lines, tabs or more than four spaces in a row; keep them short.
const clean=(text,max)=>String(text??'').replace(/\s+/g,' ').trim().slice(0,max)||'-';

// The one place that knows Meta's request format: POST /{version}/{phone-number-id}/messages with a template message.
export function whatsappRequest(message,s=whatsappSettings()) {
  return {url:`https://graph.facebook.com/${encodeURIComponent(s.version)}/${encodeURIComponent(s.phoneNumberId)}/messages`,
    init:{method:'POST',headers:{authorization:`Bearer ${s.token}`,'content-type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:message.recipient.replace(/^\+/,''),type:'template',
        template:{name:s.template,language:{code:s.lang},components:[{type:'body',parameters:[{type:'text',text:clean(message.subject,60)},{type:'text',text:clean(message.body,500)}]}]}})}};
}

// Opted-in, active users with a usable number; one message per phone number.
export function whatsappRecipients(rows) {
  return [...new Set(rows.filter(r=>r.alert_whatsapp===1&&r.active!==0).map(r=>e164(r.phone)).filter(Boolean))];
}
let timer=null;
export async function queueWhatsapp({alertId=null,ticketId=null,recipients,heading,detail}) {
  if (!recipients.length) return 0;
  const configured=whatsappConfigured(), subject=clean(heading,60), body=clean(detail,500);
  for (const to of recipients) await run('INSERT INTO notification_outbox (id,alert_id,ticket_id,channel,recipient,subject,body,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',id(),alertId,ticketId,'whatsapp',to,subject,body,configured?'queued':'not_configured',now());
  // Sent shortly after the request commits; the periodic job in server.js picks up anything this misses.
  if (configured&&!timer) timer=setTimeout(()=>{ timer=null; sendQueuedWhatsapp().catch(e=>console.error('WhatsApp sending failed:',e.message)); },1500);
  return recipients.length;
}

const machineText=e=>e?[e.asset_tag,e.make,e.model].filter(Boolean).join(' '):'';
// Alerts: the recipient rules match email (see factory/alerts.js), with the WhatsApp opt-in instead of the email one.
export async function queueAlertWhatsapp(alert,users) {
  const machine=alert.equipment_id?await one('SELECT asset_tag,make,model FROM equipment WHERE id=?',alert.equipment_id):null;
  const label={critical:'Critical',warning:'Warning',info:'Info'}[alert.severity]||alert.severity;
  return await queueWhatsapp({alertId:alert.id,recipients:whatsappRecipients(users),heading:`${label} machine alert`,
    detail:[machineText(machine),alert.title,`severity ${alert.severity}`].filter(Boolean).join(' - ')});
}
async function ticketText(ticketId) {
  const t=await one('SELECT t.*,e.asset_tag,e.make,e.model,p.name plant_name FROM tickets t JOIN equipment e ON e.id=t.equipment_id JOIN plants p ON p.id=t.plant_id WHERE t.id=?',ticketId);
  return {t,detail:[machineText(t),t.title,`priority ${t.priority}`,t.plant_name].filter(Boolean).join(' - ')};
}
// Assigned: the engineer, or the provider's engineers and service manager when a provider is assigned.
export async function notifyTicketAssigned(ticketId) {
  const {t,detail}=await ticketText(ticketId);
  const users=t.assigned_user_id?await all('SELECT phone,active,alert_whatsapp FROM users WHERE id=?',t.assigned_user_id)
    :t.assigned_provider_id?await all("SELECT phone,active,alert_whatsapp FROM users WHERE provider_id=? AND role IN ('provider_engineer','provider_admin')",t.assigned_provider_id):[];
  return await queueWhatsapp({ticketId,recipients:whatsappRecipients(users),heading:'Ticket assigned to you',detail});
}
// Completed: the person who reported the breakdown (unless they completed it themselves).
export async function notifyTicketCompleted(ticketId,actorId) {
  const {t,detail}=await ticketText(ticketId); if (t.created_by===actorId) return 0;
  return await queueWhatsapp({ticketId,recipients:whatsappRecipients(await all('SELECT phone,active,alert_whatsapp FROM users WHERE id=?',t.created_by)),heading:'Your breakdown ticket is completed',detail});
}

// Delivery. One run at a time per server, so the after-commit send and the periodic job never send a row twice.
let sending=false;
export async function sendQueuedWhatsapp(limit=50) {
  if (!whatsappConfigured()||sending) return 0;
  sending=true; let sent=0;
  try {
    for (const m of await all("SELECT * FROM notification_outbox WHERE channel='whatsapp' AND status='queued' ORDER BY created_at LIMIT ?",limit)) {
      const {url,init}=whatsappRequest(m);
      try {
        const r=await fetch(url,{...init,signal:AbortSignal.timeout(15000)});
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0,300)}`);
        await run("UPDATE notification_outbox SET status='sent',sent_at=?,error=NULL WHERE id=?",now(),m.id); sent++;
      } catch(e) { await run("UPDATE notification_outbox SET status='failed',error=? WHERE id=?",String(e.message).slice(0,500),m.id); }
    }
  } finally { sending=false; }
  return sent;
}
