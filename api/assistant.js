// AI breakdown assistant, using Claude through the Anthropic SDK. Two jobs:
// - a troubleshooting chat on a ticket, shared by everyone working it;
// - a step-by-step repair guide (hazards, PPE, steps with a check each) shown on the ticket and in the VR view.
// Both are grounded in the platform's own data: the machine and its parameters, the breakdown report, live alarms and
// readings, the work done so far, earlier repairs on the same company's machines, and the PDF manuals uploaded to the
// asset. Without an API key the chat is off and the guide falls back to the standard one built from the checklist.
import Anthropic from '@anthropic-ai/sdk';
import { one, all } from './db.js';
import { readStoredFile } from './files.js';
import { telemetry } from './iot/ingest.js';

export const AI_MODEL=process.env.MOULDCARE_AI_MODEL||'claude-opus-5-5';
let client=null;
// Tests inject a stand-in client; production builds one from ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN).
export function setAiClient(c) { client=c; }
export const aiEnabled=()=>!!client||!!(process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN);
const ai=()=>client??=new Anthropic();
// Server-side fallback: if a safety classifier declines, the API re-runs the request on its recommended fallback model.
const FALLBACK={betas:['server-side-fallback-2026-07-01'],fallbacks:'default'};

const INSTRUCTIONS=`You help maintenance technicians diagnose and repair breakdowns on plastics processing equipment: injection moulding machines, blow moulding machines, extruders, moulds and auxiliary equipment (dryers, chillers, temperature control units, loaders, blenders). You work inside a maintenance platform. Each conversation is about one breakdown ticket, and the current ticket record is given to you in a system message before each reply.

Safety comes first. These machines store energy in hydraulic accumulators, pneumatics and springs, run barrels, nozzles, dies and hot runners at 200-300 °C, and have high-voltage heater circuits. Before any step that puts hands inside guards or opens a hydraulic, pneumatic or electrical circuit, tell the technician to apply lock-out/tag-out, discharge accumulators and stored pressure, and let heated zones cool or wear heat protection. Never suggest bypassing guards, interlocks or safety circuits, even temporarily. If the ticket reports a safety issue, start with securing the machine and the area.

Photos of the breakdown may be attached: the machine, the failed part, leaks, burn marks, cracks, wear, the controller screen with its alarm. Say what you see that matters for the diagnosis and how it changes the likely causes, read any alarm text or values shown, and say when a photo is unclear and what to photograph instead.

When asked what to do next, give the single most useful next action first, with why it is the best next step given what has already been checked, then the following one or two actions depending on its result.

Ground your advice in the data provided: the machine make, model and parameters, error codes, alarms and readings, the work already done on this ticket, earlier repairs on this company's machines, and the manufacturer's manuals when attached. Say which source a point comes from (for example "manual, hydraulic pressure section" or "repair of 12 Sep on this machine"). When the data does not settle a question, say so and list the most likely causes in order, each with a quick check, rather than presenting one guess as the answer. Recommend the machine builder's service when a fix needs OEM software, warranty work or specialist calibration.

Write for someone standing at the machine with a phone: short numbered steps, one action per step, and the reading or observation that confirms each step. Keep answers brief unless asked for detail. Reply in the language the technician writes in.`;

const val=v=>v==null||v===''?'—':String(v);
const human=v=>val(v).replaceAll('_',' ');
// The ticket record as plain text: everything the assistant should know, scoped to the ticket's own company.
export function ticketContext(t) {
  const e=one('SELECT * FROM equipment WHERE id=?',t.equipment_id), plant=one('SELECT name,country,timezone FROM plants WHERE id=?',t.plant_id);
  const specs=Object.entries(JSON.parse(e.specs||'{}')).map(([k,v])=>`${k}=${v}`).join(', ');
  const tm=telemetry(e.id), m=tm.metrics;
  const alerts=all("SELECT severity,title,detail,created_at FROM alerts WHERE equipment_id=? AND status<>'resolved' ORDER BY created_at DESC LIMIT 10",e.id);
  const checklist=all('SELECT item,done,note FROM checklist_entries WHERE ticket_id=? ORDER BY rowid',t.id);
  const work=all('SELECT w.description,w.minutes,w.parts_used,w.created_at,u.name FROM work_logs w JOIN users u ON u.id=w.user_id WHERE w.ticket_id=? ORDER BY w.created_at',t.id);
  const parts=all('SELECT item,part_number,quantity,unit,status FROM parts_requests WHERE ticket_id=?',t.id);
  // Earlier repairs on this machine, then on the company's machines of the same make and model.
  const history=all(`SELECT t.title,t.symptoms,t.error_codes,t.failure_category,t.failure_mode,t.root_cause,t.action_taken,t.completed_at,t.equipment_id=? same,
      (SELECT group_concat(description,' | ') FROM work_logs w WHERE w.ticket_id=t.id) work
    FROM tickets t JOIN equipment x ON x.id=t.equipment_id
    WHERE t.company_id=? AND t.status='completed' AND t.id<>? AND (t.equipment_id=? OR (x.make=? AND x.model=?))
    ORDER BY same DESC,t.completed_at DESC LIMIT 8`,e.id,t.company_id,t.id,e.id,e.make,e.model);
  return [
    `Machine: ${e.asset_tag||'—'} · ${human(e.machine_type)} · ${e.make} ${e.model} · serial ${e.serial_number} · built ${val(e.year_built)} · criticality ${e.criticality} · status ${human(e.status)}`,
    `Location: ${plant?.name||'—'} (${plant?.country||'—'}), ${e.location}`,
    `Parameters: ${specs||'—'}`,
    `Ticket: "${t.title}" · priority ${t.priority} · status ${human(t.status)}${t.safety_issue?' · SAFETY ISSUE REPORTED':''}`,
    `Failure category: ${human(t.failure_category)} · machine state: ${human(t.machine_state)} · failure started ${val(t.occurred_at)} · reported ${t.created_at}`,
    `Symptoms: ${t.symptoms}`,
    `Error codes: ${val(t.error_codes)}`,
    `Production impact: ${t.production_impact}`,
    `Machine data: ${tm.status}${m?` · running hours ${val(m.runningHours?.value)} · cycles ${val(m.cycleCount?.value)} · temperature ${val(m.temperatureC?.value)} °C`:''}`,
    `Active alarms: ${tm.activeAlarms.map(a=>`${a.severity} ${a.code} ${a.message}`).join('; ')||'none'}`,
    `Open alerts: ${alerts.map(a=>`${a.severity} ${a.title}${a.detail?` (${a.detail})`:''}`).join('; ')||'none'}`,
    `Checklist: ${checklist.map(c=>`[${c.done?'x':' '}] ${c.item}${c.note?` (${c.note})`:''}`).join('; ')||'not started'}`,
    `Work done on this ticket: ${work.map(w=>`${w.created_at} ${w.name}: ${w.description} (${w.minutes} min${w.parts_used?`, parts ${w.parts_used}`:''})`).join('; ')||'none yet'}`,
    `Photos on the ticket: ${one(`SELECT count(*) n FROM attachments WHERE company_id=? AND kind IN ('photo','evidence') AND mime LIKE 'image/%' AND ((entity_type='ticket' AND entity_id=?) OR (entity_type='work_log' AND entity_id IN (SELECT id FROM work_logs WHERE ticket_id=?)))`,t.company_id,t.id,t.id).n} (the newest are attached as images)`,
    `Parts requested: ${parts.map(p=>`${p.item} ${p.part_number} ×${p.quantity} ${p.unit} (${p.status})`).join('; ')||'none'}`,
    `Earlier repairs (${history.length}): ${history.map(h=>`[${h.same?'this machine':'same model'}, ${h.completed_at?.slice(0,10)}] "${h.title}" — symptoms: ${h.symptoms}; codes: ${val(h.error_codes)}; failure mode: ${human(h.failure_mode)}; root cause: ${human(h.root_cause)}; action: ${human(h.action_taken)}; work: ${val(h.work)}`).join(' || ')||'none recorded'}`,
  ].join('\n');
}

// The asset's PDF manuals (up to two, 5 MB each) as document blocks; the last one carries the cache breakpoint so
// follow-up questions on the same machine reuse them from the prompt cache.
export function manualBlocks(equipmentId) {
  const docs=all("SELECT * FROM attachments WHERE entity_type='equipment' AND entity_id=? AND kind='manual' AND mime='application/pdf' ORDER BY created_at LIMIT 2",equipmentId);
  return docs.map((a,i)=>({type:'document',title:a.filename,source:{type:'base64',media_type:'application/pdf',data:readStoredFile(a).toString('base64')},...(i===docs.length-1?{cache_control:{type:'ephemeral'}}:{})}));
}

// Photos on the ticket (the report, work logs and questions), newest last, as image blocks with a caption each.
const IMAGE_TYPES=['image/jpeg','image/png','image/webp'];
export function photoBlocks(t,limit=6) {
  const rows=all(`SELECT a.*,u.name uploader FROM attachments a JOIN users u ON u.id=a.uploaded_by
    WHERE a.company_id=? AND a.kind IN ('photo','evidence') AND a.mime IN (${IMAGE_TYPES.map(()=>'?').join(',')})
      AND ((a.entity_type='ticket' AND a.entity_id=?) OR (a.entity_type='work_log' AND a.entity_id IN (SELECT id FROM work_logs WHERE ticket_id=?)))
    ORDER BY a.created_at DESC LIMIT ?`,t.company_id,...IMAGE_TYPES,t.id,t.id,limit).reverse();
  return rows.flatMap((a,i)=>[{type:'text',text:`Photo ${i+1} of ${rows.length}: "${a.filename}", added by ${a.uploader} at ${a.created_at}${a.entity_type==='work_log'?' with a work log':''}.`},
    {type:'image',source:{type:'base64',media_type:a.mime,data:readStoredFile(a).toString('base64')}}]);
}

const textOf=r=>r.content.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
const REFUSED='The assistant could not answer this request. Rephrase the question, or contact your supervisor or the machine builder.';

// One reply in the ticket's conversation. history: earlier {role, content} turns, oldest first, alternating.
// photos: the ticket's current photos; they go with the new question, so earlier turns stay as they were (and cached).
export async function askAssistant({history,question,context,manuals=[],photos=[]}) {
  const turns=[...history,{role:'user',content:question}].map(x=>({role:x.role,content:[{type:'text',text:x.content}]}));
  turns.at(-1).content.unshift(...photos);
  turns[0].content.unshift(...manuals);
  // The ticket record changes as work goes on, so it goes last as a system message: the cached prefix (instructions,
  // manuals, earlier turns) stays the same from one question to the next.
  const messages=[...turns,{role:'system',content:`Current ticket record, refreshed for this reply:\n${context}`}];
  const r=await ai().beta.messages.create({...FALLBACK,model:AI_MODEL,max_tokens:16000,thinking:{type:'adaptive'},output_config:{effort:'medium'},
    system:[{type:'text',text:INSTRUCTIONS,cache_control:{type:'ephemeral'}}],messages});
  if (r.stop_reason==='refusal') return REFUSED;
  const text=textOf(r)||REFUSED;
  return r.stop_reason==='max_tokens'?`${text}\n\n(The answer was cut short. Ask for the rest.)`:text;
}

const GUIDE_SCHEMA={type:'object',additionalProperties:false,required:['summary','hazards','ppe','steps'],properties:{
  summary:{type:'string'},hazards:{type:'array',items:{type:'string'}},ppe:{type:'array',items:{type:'string'}},
  steps:{type:'array',items:{type:'object',additionalProperties:false,required:['title','instruction','check'],properties:{title:{type:'string'},instruction:{type:'string'},check:{type:'string'}}}}}};
const clip=(v,n)=>String(v??'').trim().slice(0,n);
const clean=g=>({summary:clip(g.summary,600),hazards:(g.hazards||[]).slice(0,8).map(x=>clip(x,200)).filter(Boolean),ppe:(g.ppe||[]).slice(0,8).map(x=>clip(x,80)).filter(Boolean),
  steps:(g.steps||[]).slice(0,15).map(s=>({title:clip(s.title,80),instruction:clip(s.instruction,500),check:clip(s.check,240)})).filter(s=>s.title&&s.instruction)});

// A step-by-step repair guide for the ticket, as structured JSON.
export async function writeGuide({context,manuals=[],photos=[],conversation=[]}) {
  const chat=conversation.slice(-12).map(x=>`${x.role==='user'?'Technician':'Assistant'}: ${x.content}`).join('\n\n');
  const request=`Write the step-by-step repair guide for this breakdown.

${context}
${chat?`\nTroubleshooting conversation so far on this ticket:\n${chat}\n`:''}
The guide is shown one step at a time on a phone and in a VR headset at the machine, so keep each title under 8 words and each instruction under 60 words. Start with making the machine safe (lock-out/tag-out and stored energy) when the work needs it, then diagnosis in order of likelihood, then the repair, then restart and verification. Give each step a check: the reading or observation that confirms it is done. Use at most 12 steps. List the hazards specific to this machine and the PPE needed. Write in the language of the ticket's symptoms.`;
  const r=await ai().beta.messages.create({...FALLBACK,model:AI_MODEL,max_tokens:16000,thinking:{type:'adaptive'},
    output_config:{effort:'medium',format:{type:'json_schema',schema:GUIDE_SCHEMA}},
    system:[{type:'text',text:INSTRUCTIONS,cache_control:{type:'ephemeral'}}],
    messages:[{role:'user',content:[...manuals,...photos,{type:'text',text:request}]}]});
  if (r.stop_reason==='refusal') throw new Error('The assistant declined to write a guide for this ticket');
  if (r.stop_reason==='max_tokens') throw new Error('The guide was too long; try again');
  let parsed; try { parsed=JSON.parse(textOf(r)); } catch { throw new Error('The assistant returned an unreadable guide; try again'); }
  const guide=clean(parsed); if (!guide.steps.length) throw new Error('The assistant returned a guide without steps; try again');
  return guide;
}

// The standard guide, without AI: hazards and PPE by machine type, making safe, the standard checklist, the last fix
// recorded on this machine, then restart and verification.
const HAZARDS={
  injection:['Stored hydraulic pressure in accumulators and lines','Barrel and nozzle up to 300 °C; molten plastic can spray from the nozzle','Clamp and ejector crush zones','High-voltage heater bands'],
  blow:['Hot parison and head','Clamp, blow pins and cutting knife pinch points','Compressed air at blow pressure','High-voltage heater bands'],
  extrusion:['Melt pressure in the die head: never open it under pressure','Hot barrel, die and adapter','Rotating screw and gearbox','Pullers and cutters downstream'],
  mould:['Heavy load: use the crane and rated slings','Hot runner manifold and nozzles','Sharp edges, slides and springs'],
  auxiliary:['Rotating fans, augers and blades','Hot dryer hoppers and desiccant beds','Pressurised water or refrigerant circuits'],
};
const PPE={injection:['Safety glasses or face shield','Heat-resistant gloves','Safety shoes'],blow:['Safety glasses','Heat-resistant gloves','Safety shoes','Hearing protection'],
  extrusion:['Face shield','Heat-resistant gloves and sleeves','Safety shoes'],mould:['Safety shoes','Cut-resistant gloves','Hard hat when lifting'],auxiliary:['Safety glasses','Gloves','Safety shoes']};
export function standardGuide(t) {
  const e=one('SELECT machine_type,make,model,asset_tag FROM equipment WHERE id=?',t.equipment_id);
  const items=all('SELECT item FROM checklist_entries WHERE ticket_id=? ORDER BY rowid',t.id).map(x=>x.item);
  const checklist=items.length?items:all('SELECT item FROM checklist_templates WHERE machine_type=? ORDER BY position',e.machine_type).map(x=>x.item);
  const last=one("SELECT title,action_taken,root_cause,completed_at FROM tickets WHERE equipment_id=? AND status='completed' AND id<>? ORDER BY completed_at DESC LIMIT 1",t.equipment_id,t.id);
  const steps=[
    {title:'Make the machine safe',instruction:'Stop the machine, apply lock-out/tag-out at the main isolator, release stored hydraulic and pneumatic pressure, and let heated zones cool or wear heat protection.',check:'Isolator locked and tagged; pressure gauges read zero.'},
    {title:'Confirm the reported fault',instruction:`Compare what you find with the report: ${t.symptoms}${t.error_codes?` Error codes: ${t.error_codes}.`:''}`,check:'Fault confirmed, or the difference noted in a work log.'},
    ...(last?[{title:'Check the last repair first',instruction:`The last fix on this machine was "${last.title}" (${human(last.action_taken)}, root cause ${human(last.root_cause)}). Check whether the same part or setting has failed again.`,check:'Earlier repair ruled in or out.'}]:[]),
    ...checklist.map(item=>({title:item.length>60?item.slice(0,57)+'…':item,instruction:item,check:'Done, with any finding noted.'})),
    {title:'Restart and verify',instruction:'Remove locks and tags, restart, run the machine and compare cycle time, pressures and temperatures with normal production.',check:'First good parts produced and verified.'},
  ];
  return {summary:`Standard guide for ${e.asset_tag||''} ${e.make} ${e.model}: ${t.title}.`.replace(/\s+/g,' '),hazards:HAZARDS[e.machine_type]||[],ppe:PPE[e.machine_type]||[],steps:steps.slice(0,15)};
}
