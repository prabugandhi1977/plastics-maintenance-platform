// AI breakdown assistant and repair guides on a ticket. Anyone who can see the ticket can read the conversation and
// the guide; customers and the people servicing it can ask questions and (re)write the guide.
import Anthropic from '@anthropic-ai/sdk';
import { id, now, one, all, run, transaction } from '../../../common/db.js';
import { isCustomer } from '../../../common/security.js';
import { audit, canService, getTicket } from '../../../common/access.js';
import { HttpError, deny, required } from '../../../common/validate.js';
import { AI_MODEL, aiEnabled, askAssistant, manualBlocks, photoBlocks, standardGuide, ticketContext, writeGuide } from '../assistant.js';
import { storeFile } from '../../../common/files.js';

const conversation=ticketId=>all('SELECT m.id,m.role,m.content,m.attachment_id,m.created_at,u.name user_name FROM ticket_assistant_messages m JOIN users u ON u.id=m.user_id WHERE m.ticket_id=? ORDER BY m.created_at,m.rowid',ticketId);
const canAsk=(u,t)=>isCustomer(u)||canService(u,t);
const MAX_TURNS=60;
function needAi() { if (!aiEnabled()) throw new HttpError(503,'The AI assistant is not set up on this server. An administrator adds ANTHROPIC_API_KEY to the server settings.'); }
// SDK errors become a clear 502/503 for the client; the details go to the server log.
async function callAi(fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(503,'The AI assistant is busy. Try again in a minute.');
    if (e instanceof Anthropic.AuthenticationError) { console.error('AI assistant:',e.message); throw new HttpError(503,'The AI assistant is not set up correctly (API key rejected).'); }
    if (e instanceof Anthropic.APIError) { console.error('AI assistant:',e.status,e.message); throw new HttpError(502,'The AI assistant is unavailable right now. Try again shortly.'); }
    if (e instanceof HttpError) throw e;
    throw new HttpError(502,e.message||'The AI assistant failed');
  }
}
const storedGuide=t=>{ const g=one('SELECT * FROM ticket_guides WHERE ticket_id=?',t.id); return g?{source:g.source,guide:JSON.parse(g.guide),createdAt:g.created_at}:{source:'standard',guide:standardGuide(t),createdAt:null}; };

export function register(r) {
  r.get('/tickets/:id/assistant',({u,params})=>{ const t=getTicket(u,params.id); return {enabled:aiEnabled(),model:aiEnabled()?AI_MODEL:null,canAsk:canAsk(u,t),messages:conversation(t.id)}; });
  r.post('/tickets/:id/assistant',async({u,body,params})=>{
    const t=getTicket(u,params.id); if (!canAsk(u,t)) deny(); needAi();
    // A question can come with a photo; it is kept on the ticket as a photo, so everyone (and later questions) see it.
    const hasPhoto=!!body.photo&&typeof body.photo==='object';
    if (hasPhoto&&!['image/jpeg','image/png','image/webp'].includes(body.photo.mime)) throw new HttpError(400,'The photo must be a JPEG, PNG or WebP image');
    const question=hasPhoto&&!String(body.message??'').trim()?'What do you see in this photo, and what should I do next?':required(body.message,'message',2000), history=conversation(t.id);
    if (history.length>=MAX_TURNS*2) throw new HttpError(409,'This conversation is full. Write the guide, or continue in a work log.');
    const photo=hasPhoto?storeFile(u,{companyId:t.company_id,entityType:'ticket',entityId:t.id,kind:'photo',filename:body.photo.filename,mime:body.photo.mime,base64:body.photo.base64}):null;
    const answer=await callAi(()=>askAssistant({history,question,context:ticketContext(t),manuals:manualBlocks(t.equipment_id),photos:photoBlocks(t)}));
    // Stored only once answered, so the history always alternates question and answer.
    const at=now(), later=new Date(Date.parse(at)+1).toISOString();
    transaction(()=>{ run('INSERT INTO ticket_assistant_messages (id,ticket_id,user_id,role,content,created_at,attachment_id) VALUES (?,?,?,?,?,?,?)',id(),t.id,u.id,'user',question,at,photo?.id??null);
      run('INSERT INTO ticket_assistant_messages (id,ticket_id,user_id,role,content,created_at) VALUES (?,?,?,?,?,?)',id(),t.id,u.id,'assistant',answer,later); });
    audit(u,'ticket.assistant','ticket',t.id,t.company_id); return {enabled:true,model:AI_MODEL,canAsk:true,messages:conversation(t.id)};
  });
  r.get('/tickets/:id/guide',({u,params})=>({...storedGuide(getTicket(u,params.id)),aiEnabled:aiEnabled()}));
  // Writes the guide: with AI when it is set up (using the conversation so far), otherwise the standard guide.
  r.post('/tickets/:id/guide',async({u,params})=>{
    const t=getTicket(u,params.id); if (!canAsk(u,t)) deny();
    const ai=aiEnabled(), guide=ai?await callAi(()=>writeGuide({context:ticketContext(t),manuals:manualBlocks(t.equipment_id),photos:photoBlocks(t),conversation:conversation(t.id)})):standardGuide(t), at=now();
    run("INSERT INTO ticket_guides (ticket_id,guide,source,created_by,created_at) VALUES (?,?,?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET guide=excluded.guide,source=excluded.source,created_by=excluded.created_by,created_at=excluded.created_at",t.id,JSON.stringify(guide),ai?'ai':'standard',u.id,at);
    audit(u,'ticket.guide','ticket',t.id,t.company_id,{source:ai?'ai':'standard'}); return {source:ai?'ai':'standard',guide,createdAt:at,aiEnabled:ai};
  });
}
