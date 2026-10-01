// Spare parts: request → quotation → customer approval → ordered → shipped → fulfilled.
import { id, now, one, all, run, transaction } from '../db.js';
import { isCustomer, isInternal } from '../security.js';
import { audit, byId, canService, getTicket, visibleTickets } from '../access.js';
import { created } from '../http.js';
import { bad, choice, currency, date, deny, integer, missing, required } from '../validate.js';
import { PART_UNITS, PART_URGENCY } from '../catalog.js';

const FULFILMENT={approved:['ordered','shipped','fulfilled'],ordered:['shipped','fulfilled'],shipped:['fulfilled']};
const latestQuote=requestId=>one('SELECT id,amount_minor,currency,lead_days,status,valid_until FROM quotations WHERE request_id=? ORDER BY created_at DESC LIMIT 1',requestId)||null;
function partFor(u,key) { const p=byId('parts_requests',key); if (!p) missing(); getTicket(u,p.ticket_id); return p; }
function advance(u,p,status,reference) {
  if (!isInternal(u)) deny();
  if (!(FULFILMENT[p.status]||[]).includes(status)) bad(`Cannot move a ${p.status} request to ${status}`);
  // Ordering needs the purchase order number; shipping needs the carrier tracking or delivery note reference.
  if (['ordered','shipped'].includes(status)&&!String(reference??'').trim()) bad(status==='ordered'?'Enter the purchase order number':'Enter the tracking number or delivery note');
  run('UPDATE parts_requests SET status=?,fulfilment_reference=?,updated_at=? WHERE id=?',status,reference==null?p.fulfilment_reference:String(reference).slice(0,200),now(),p.id);
  audit(u,`parts.${status}`,'parts_request',p.id,p.company_id,{reference:reference??null}); return byId('parts_requests',p.id);
}

export function register(r) {
  r.get('/parts',({u})=>visibleTickets(u).flatMap(t=>all('SELECT * FROM parts_requests WHERE ticket_id=? ORDER BY created_at DESC',t.id).map(p=>({...p,ticketTitle:t.title,quote:latestQuote(p.id)}))));
  r.post('/tickets/:id/parts',({u,body,params})=>{
    const t=getTicket(u,params.id); if (!canService(u,t)&&!isCustomer(u)) deny();
    const key=id(); run('INSERT INTO parts_requests (id,company_id,ticket_id,item,quantity,status,created_at,updated_at,part_number,unit,urgency,manufacturer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',key,t.company_id,t.id,required(body.item,'item',300),integer(typeof body.quantity==='string'?Number(body.quantity):body.quantity,'quantity',1,100000),'requested',now(),now(),required(body.partNumber,'partNumber',80),choice(body.unit,'unit',PART_UNITS),choice(body.urgency,'urgency',PART_URGENCY),String(body.manufacturer??'').trim().slice(0,80));
    audit(u,'parts.request','parts_request',key,t.company_id); return created(byId('parts_requests',key));
  },{offline:true});
  // A new quote supersedes any pending one; approved or later requests cannot be re-quoted.
  r.post('/parts/:id/quote',({u,body,params})=>{
    const p=partFor(u,params.id); if (!isInternal(u)) deny();
    if (!['requested','quoted','rejected'].includes(p.status)) bad(`A ${p.status} request cannot be re-quoted`);
    const key=id(),amount=integer(body.amountMinor,'amountMinor',1),code=currency(body.currency),lead=integer(body.leadDays,'leadDays',0,365),validUntil=date(body.validUntil,'validUntil');
    // Quotes carry a validity date (prices and lead times are only held for a period).
    if (validUntil<new Date().toISOString().slice(0,10)||validUntil>new Date(Date.now()+366*86400000).toISOString()) bad('Valid-until date must be between today and one year ahead');
    transaction(()=>{
      run("UPDATE quotations SET status='superseded' WHERE request_id=? AND status='pending'",p.id);
      run('INSERT INTO quotations (id,request_id,company_id,amount_minor,currency,lead_days,status,created_at,valid_until) VALUES (?,?,?,?,?,?,?,?,?)',key,p.id,p.company_id,amount,code,lead,'pending',now(),validUntil);
      run("UPDATE parts_requests SET status='quoted',updated_at=? WHERE id=?",now(),p.id);
    });
    audit(u,'quote.create','quotation',key,p.company_id); return created(byId('quotations',key));
  });
  r.get('/parts/:id/quotes',({u,params})=>all('SELECT * FROM quotations WHERE request_id=? ORDER BY created_at DESC',partFor(u,params.id).id));
  r.post('/quotes/:id/decision',({u,body,params})=>{
    const q=byId('quotations',params.id); if (!q) missing();
    if (!isCustomer(u)||u.company_id!==q.company_id||!['customer_admin','plant_manager'].includes(u.role)) deny();
    if (q.status!=='pending') bad('Quotation already decided');
    const status=choice(body.decision,'decision',['approved','rejected']);
    // End of the valid-until day, so a quote valid until today can still be approved today.
    if (status==='approved'&&q.valid_until&&Date.parse(q.valid_until)+86400000<=Date.now()) bad('This quotation has expired. Ask for a new quote.');
    transaction(()=>{ run('UPDATE quotations SET status=?,approved_by=? WHERE id=?',status,u.id,q.id); run('UPDATE parts_requests SET status=?,updated_at=? WHERE id=?',status,now(),q.request_id); });
    audit(u,'quote.decision','quotation',q.id,q.company_id,{status}); return byId('quotations',q.id);
  });
  r.post('/parts/:id/fulfilment',({u,body,params})=>advance(u,partFor(u,params.id),choice(body.status,'status',['ordered','shipped','fulfilled']),body.reference));
  r.post('/parts/:id/fulfil',({u,params})=>{ const p=partFor(u,params.id); if (!isInternal(u)||!FULFILMENT[p.status]) deny(); return advance(u,p,'fulfilled'); });
}
