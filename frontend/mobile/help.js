// Field app help: one screen of collapsible topics, opened from the header's "?" button. The topic for the screen the
// user came from opens first. Content is static and trusted, so it may contain <b>. Cached by sw.js for offline use.
const TOPICS=[
  {id:'list',title:'Your work list',steps:[
    '<b>Assigned work</b> lists the breakdown tickets assigned to you, newest first. Tap one to open it.',
    'The header shows <b>Online</b> or <b>Offline</b>, and how many changes are <b>queued</b> on this phone.',
    '<b>Sync now</b> sends queued changes and fetches your latest work.',
    '<b>Sign out</b> works only when nothing is queued, so no work is lost. Sync first.']},
  {id:'scan',title:'Scan a machine',steps:[
    'Under <b>Scan a machine</b>, scan the machine\'s QR label with the camera, read its RFID tag, or type the code.',
    'If you have open work on that machine, it opens straight away.',
    'Otherwise, if your role may report breakdowns, the <b>report a breakdown</b> form opens for that machine: short description, symptoms, machine state, priority and impact.',
    'Offline, the app matches the code against your cached work. A breakdown reported offline is queued and the machine is identified when it syncs.'],
    tips:['"Unknown code" means the label or tag is not registered to any machine – check the machine record in the office.','"This machine has no work for you" means it belongs to a customer or job you are not assigned to.']},
  {id:'ticket',title:'Working on a ticket',steps:[
    '<b>Update job status</b>: assigned → accepted (or declined / escalated with a note) → in progress → completed.',
    'To complete, give failure mode, root cause, action taken and downtime. If the scan policy asks, scan the machine\'s label again to prove you are at it.',
    '<b>Log work done</b>: what you did, minutes spent and parts used.',
    '<b>Add checklist item</b> for each inspection point; tap an item to tick it off.',
    '<b>Request spare part</b>: part number, description, quantity, unit and urgency. The office handles quotes and approval.',
    '<b>Add photo</b> to attach evidence from the camera.',
    '<b>⚠ Report safety concern</b> for a hazard, near miss or injury. It goes to the plant\'s safety log.',
    'After completion, hand the phone to the customer for <b>Customer sign-off</b>: their name and signature.'],
    tips:['A red <b>Safety issue reported</b> note means the machine must be secured before you start.','Live machine readings appear under <b>Machine data</b> when the machine is connected.']},
  {id:'assistant',title:'AI assistant and repair guide',steps:[
    '<b>Ask AI assistant</b>: describe what you see; it answers using the ticket, the machine\'s manuals and live data. You can add a photo.',
    '<b>Repair guide</b> gives step-by-step repair instructions for this machine. On critical tickets it can open as a <b>VR guide</b>.',
    'Both need a connection, and the AI assistant must be switched on by your administrator.']},
  {id:'offline',title:'Working offline',steps:[
    'Your assigned work and the tickets you opened are kept on this phone, so you can work without signal.',
    'Every change is saved on the phone at once ("Saved on this device. It will sync when connected.") and shown on the ticket.',
    'When the connection returns, queued changes are sent in order automatically. You can also tap <b>Sync now</b>.',
    'A change is never applied twice, even if it is sent again after a dropped connection.'],
    tips:['Open the tickets you will need before going somewhere without signal, so they are cached.','The AI assistant, repair guide and photos of other work need a connection.']},
  {id:'vision',title:'Vision alarms',vision:true,steps:[
    'If you have a vision duty (EHS, security or QA), camera alarms for your plant appear at the top of the app.',
    'A critical alarm such as fire or a PPE violation makes the phone vibrate and sound.',
    'Tap <b>View</b> for the photo and details, and <b>Acknowledge</b> so colleagues know it is handled.'],
    tips:['Your duties are set by an administrator in the office workspace under Companies, plants & users › Users › Vision duties.']},
  {id:'install',title:'Install the app on your phone',steps:[
    'Open this page in the phone\'s browser and sign in.',
    'Android (Chrome): menu ⋮ › <b>Install app</b> or <b>Add to Home screen</b>.',
    'iPhone (Safari): Share › <b>Add to Home Screen</b>.',
    'Start it from the home-screen icon. It then works offline as described above.']},
];

export function helpView(openId,{canSeeVision}) {
  const topics=TOPICS.filter(x=>!x.vision||canSeeVision);
  return `<div class="card"><h2>Help</h2><p class="muted">Tap a topic to open it. Your administrator can help with access and roles.</p></div>`
    +topics.map(x=>`<details class="card help-topic" ${x.id===openId?'open':''}><summary>${x.title}</summary><ol>${x.steps.map(s=>`<li>${s}</li>`).join('')}</ol>${x.tips?`<div class="help-tips"><b>Tips</b><ul>${x.tips.map(s=>`<li>${s}</li>`).join('')}</ul></div>`:''}</details>`).join('');
}
