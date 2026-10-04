// In-app help: what each page is for, who can use it, and step-by-step instructions for its tasks.
// Topics are keyed by the page ids in NAV_GROUPS (app.js), plus 'start', 'ticket' and 'equipmentRecord'.
// Content is static and trusted (no user data), so it may contain <b>; menu paths use " › ".
import { esc, openDialog } from './ui.js';

const ADMIN='Platform admin';
export const HELP={
  start:{title:'Getting started',what:'The order to set the platform up in, from an empty system to live machines, cameras and traceability.',
    tasks:[
      ['First-time set-up (platform admin)',[
        'Sign in with the admin account created at installation, then change its password under <b>My account</b>.',
        '<b>Administration › Companies, plants & users</b>: add each customer company, then its plants (address, service area, operating pattern).',
        'On each plant use <b>Edit shifts</b>: OEE, energy and alerts are measured only inside planned shift time.',
        'Add users with <b>Add user</b>. Pick the role carefully (see <i>Roles</i> below) and give a temporary password; they must change it at first sign-in.',
        '<b>Administration › Settings</b>: check code lists, service areas, standard checklists, default response targets and the scan policy.',
        '<b>Maintenance › Equipment register</b>: add every machine, mould and auxiliary unit, with its asset tag.',
        '<b>Production › Products & cycle times</b>: add the parts you make with ideal cycle time and cavities, so OEE performance can be calculated.',
        'Connect machine data: open a machine record and use <b>Connect IoT device</b>, then check <b>Administration › Machine data (IoT)</b>.',
        'Optional: <b>Maintenance › Service contracts</b> and <b>Administration › Service providers</b> for outside service partners.',
        'Optional, for vision: add licences and edge nodes under <b>Vision › Edge nodes & licences</b>, then cameras and modules under <b>Cameras & AI modules</b>.']],
      ['Roles',[
        '<b>Platform admin</b>: everything, including licences, settings and service providers.',
        '<b>Dispatcher</b>: assigns and steers tickets for all customers; sees factory and vision pages.',
        '<b>Service engineer</b>: works on tickets assigned to them.',
        '<b>Customer admin</b>: manages their own company: plants, users, equipment, cameras, contracts.',
        '<b>Plant manager</b>: runs production for their company: shifts, products, limits, batch release, decisions.',
        '<b>Maintenance</b>: raises and follows breakdowns, records production data.',
        '<b>Service provider admin / engineer</b>: an outside partner; works on tickets and quotes assigned to their company.']]],
    tips:['Press <b>?</b> on any page to open help for that page.','A missing menu item usually means your role does not have access – ask your administrator.']},

  // ---------- Production (IMM) ----------
  floor:{what:'A live tile per production machine: running, idle, stopped or down, with current part, output and OEE for the shift.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Watch a plant',['Pick the plant in the selector at the top. The page refreshes itself.','Click <b>Machine record</b> on a tile for the machine\'s details, or <b>OEE history</b> for its trend.']]],
    tips:['A machine without data shows as stale: check its IoT device mapping under <b>Machine data (IoT)</b>.']},
  oee:{what:'Overall Equipment Effectiveness = Availability × Performance × Quality, measured only inside planned shift time.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Analyse OEE',['Choose plant, machine and period with the filters at the top.','Read the trend chart, then the <b>By machine</b> table for availability, performance, quality, good and scrap parts, and stopped time.']]],
    tips:['Performance needs the right ideal cycle time and cavities under <b>Products & cycle times</b>.','No shifts on the plant means no planned time, so OEE stays empty: set them in <b>Companies, plants & users › Edit shifts</b>.']},
  products:{what:'The parts you mould and their ideal rate, which OEE performance is measured against.',who:'Customer admins, plant managers and platform admins can add and edit; others read.',
    tasks:[['Add a product',['Click <b>Add product</b>.','Fill in customer, part number, name, material, part weight and what output is counted in.','Enter the ideal cycle time and cavities – the ideal output is calculated from them.','Optionally set the mould and the machine it usually runs on, then save.']],
      ['Change a product',['Click <b>Edit</b> on its row, change the values and save. New values apply from now on.']]]},
  alerts:{what:'Problems detected by machine monitoring and other modules: condition limits, stoppages, quality and safety.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Handle an alert',['Filter by severity, status or source if the list is long.','<b>Acknowledge alert</b> to show it is being looked at.','<b>Report breakdown</b> to turn it into a maintenance ticket (no scan needed), or <b>Open breakdown ticket</b> if one exists.','<b>Mark resolved</b> once the cause is fixed.']],
      ['Get critical alerts by email',['Critical alerts are emailed to the customer\'s admins, plant managers, maintenance staff and dispatchers.','The server needs EMAIL_PROVIDER (brevo, sendgrid or resend), EMAIL_API_KEY and EMAIL_FROM. Until then emails wait as "not configured" in <b>Email notifications</b>.']]],
    tips:['The bell at the top right shows open critical and warning alerts on every page.']},

  // ---------- Vision ----------
  vision:{what:'Live PPE compliance, fire and smoke, restricted-area intrusions and quality inspection across your cameras, with the open alarms.',who:'Customer roles, dispatchers and platform admins. Which alarms you see depends on your vision duties.',
    tasks:[['Respond to an alarm',['Open alarms are listed at the top. Click <b>Acknowledge</b> so others know it is handled.','Use <b>All incidents</b> for the evidence and to resolve it.']],
      ['Choose which alarms you get',['An admin sets your duties under <b>Companies, plants & users › Users › Vision duties</b>: EHS (PPE, fire/smoke), Security (intrusions) or QA (quality).']]]},
  quality:{what:'Camera inspection results: first-pass yield (FPY), rejects in PPM and the defect Pareto.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Find the main defects',['Pick the period and machine, then read the Pareto: the first bars are where fixing pays off most.','Use <b>By machine</b> to compare lines.']]]},
  visionIncidents:{what:'Every detection with its photo and 10-second clip – proof of violation and the audit log.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Close an incident',['Filter by type, camera, status or date and open the incident.','Check the photo and clip, then choose <b>Resolve</b> (with a note) or <b>False alarm</b>.','For a machine problem, <b>Report breakdown on this machine</b> raises a ticket.']],
      ['Keep evidence',['<b>Lock evidence</b> stops the photo and clip from being deleted by the retention clean-up. <b>Unlock evidence</b> releases it.']],
      ['Export',['Use <b>⬇ Export CSV</b> in the page header to download the filtered list.']]]},
  visionCameras:{what:'Every camera, the edge node that processes it, and the AI modules it runs.',who:'Customer admins (own company) and platform admins can change; others read.',
    tasks:[['Add a camera',['An edge node must exist first (<b>Edge nodes & licences</b>).','Click <b>Add camera</b>: name, plant, location, edge node, camera make and connection type.','Enter the address (e.g. rtsp://user:pass@192.168.0.20/stream) and the frame rate, then save.']],
      ['Run an AI module on a camera',['The company needs a valid licence for that module with a free seat.','Click <b>+ Add module</b> on the camera, pick the module and press <b>Next</b> – or drag a module card from <b>AI modules</b> onto the camera.','Set its options (e.g. required PPE, sensitivity, inspection preset), keep <b>Running on this camera</b> ticked and click <b>Add module</b>.']],
      ['Draw zones',['Click <b>Draw zones</b>, click the points of the area on the camera picture, name it and choose the kind and severity, then <b>Save zone</b>.']],
      ['Error: "No valid … licence for this company"',['Only a platform admin can add licences: <b>Edge nodes & licences › Module licences › Edit</b>, set the number of cameras and a valid-until date.']],
      ['Error: "All N … licences are in use"',['Remove the module from another camera, or ask the platform admin to raise the camera count.']]]},
  visionNodes:{what:'The GPU PCs on site that analyse your camera streams, and the AI modules your company is licensed for.',who:'Customer admins and platform admins manage nodes; only the platform admin edits licences.',
    tasks:[['Add a licence ('+ADMIN+')',['In <b>Module licences</b>, click <b>Edit</b> on the company row.','For each module set how many cameras may run it and, if needed, a valid-until date. Save.','Nodes pick up the change within about a minute.']],
      ['Add an edge node',['Click <b>Add edge node</b>: name, plant, hardware and how many camera streams it can take.','Copy the key shown once and enter it in the edge agent on that PC. Lost it? Use <b>New key</b> – the old one stops working.','Use <b>View config</b> to see exactly what the node will run.']]],
    tips:['A licence shows <b>Expired</b> once its valid-until date has passed; cameras beyond the licence stop running that module.']},

  // ---------- Traceability ----------
  traceHub:{what:'Search any code – batch, lot, label, serial, shipment or return – and follow it from raw material to customer and back.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Trace something',['Type or scan the code in <b>Find anything</b> and press <b>Trace</b>.','From the result, open <b>Batch quality & labels</b> or the recall scope of the batch or lot.']],
      ['Recall scope',['<b>Recall scope of this lot</b> lists every batch the lot went into and where those parts were shipped.']]]},
  trace:{what:'Material lots → batches → output, for fast and targeted recalls.',who:'Customer roles and platform admins record; plant managers and admins release, hold or quarantine.',
    tasks:[['Register a material lot',['Click <b>Register material lot</b>: lot number, material, supplier, received date, quantity and certificate (CoA / 3.1).']],
      ['Run a batch',['Click <b>Start batch</b>: product, machine, mould, batch number, operator and planned quantity.','Record the lots loaded into the hopper or dosing unit.','When finished, <b>Complete batch</b> with good quantity and scrap.']],
      ['Release or stop',['<b>Release batch</b> to let it ship, or <b>Put batch on hold</b> (hold or scrap) with a reason.','A suspect lot: <b>Quarantine lot</b>; <b>Release lot</b> undoes it.']]]},
  processControl:{what:'Process windows per product, live deviations and capability (SPC).',who:'Customer roles, dispatchers and platform admins; plant managers and admins decide and edit rules.',
    tasks:[['Set the rules for a product',['Click <b>Edit rules</b> on the product: customer, warranty, quantity per box and what happens when a reading leaves the window.']],
      ['Decide on a deviation',['Open deviations are listed with the affected batch. Click <b>Decide</b>, choose the decision and give the reason and evidence.']]]},
  dispatch:{what:'Scan-verified loading, so only released parts reach the right customer.',who:'Customer roles and platform admins.',
    tasks:[['Ship parts',['<b>Build pallet</b>: choose the boxes that go on it.','<b>New shipment</b>: customer, channel, destination, customer PO and delivery note number.','<b>Scan & load</b>: scan each pallet or box. Unreleased or wrong-customer parts are refused.','Print the <b>Delivery note</b>.']]]},
  fieldReturns:{what:'Complaints, warranty claims and field failures, linked back to how the parts were made.',who:'Customer roles and platform admins record; plant managers and admins decide.',
    tasks:[['Record a return',['Click <b>Record field return</b>: type, customer, label or batch number, defect, quantity and description.','<b>Check claim</b> confirms whether the claiming customer received those parts and they are under warranty.']],
      ['Decide',['Click <b>Decide</b>: the decision, root cause and corrective action (8D).']]]},

  // ---------- Maintenance ----------
  dashboard:{what:'Open breakdowns, repeat faults, response times by priority and upcoming service visits.',who:'Everyone, limited to their own data.',
    tasks:[['Use the overview',['Click a ticket in <b>Active work</b> to open it.','<b>Repeat faults</b> shows machines that break down most – click one for its record.','<b>Records to complete</b> lists machines whose mandatory parameters are still missing.']]]},
  tickets:{what:'Breakdown reports and service work, from report to sign-off.',who:'Customer roles and internal staff raise; dispatchers assign; engineers and providers work on assigned tickets.',
    tasks:[['Report a breakdown',['Click <b>Report breakdown</b>.','Choose the machine (scan its QR label or tag if the scan policy asks), describe the problem, symptoms and error codes.','Set machine state, priority and impact, and answer whether anyone is at risk. Save.']],
      ['Follow a ticket',['Use the filters and search to find it, then click its title. See <i>Breakdown ticket</i> help on that page.']]]},
  ticket:{title:'Breakdown ticket',what:'One breakdown: report, assignment, work, parts, checklist, evidence and sign-off.',
    tasks:[['Assign (dispatcher / admin)',['Click <b>Assign engineer</b> and choose an engineer or service provider.']],
      ['Work on it',['<b>Update job status</b>: accepted → in progress (or escalated / declined with a note).','<b>Log work done</b>: work performed, time spent, parts used.','<b>Add checklist item</b>, <b>Request spare part</b> and <b>Attach photo / evidence</b> as needed.']],
      ['Close it',['<b>Update job status</b> to completed: give failure mode, root cause and action taken (ISO 14224) and downtime. Scan the machine if the scan policy asks.','<b>Customer sign-off</b> on site: the signer\'s name and signature.']]],
    tips:['A dispatcher can proceed without a scan by giving a reason, which stays on the ticket.']},
  equipment:{what:'Machines, moulds and auxiliary equipment with their technical parameters, documents and history.',who:'Customer admins and platform admins add; dispatchers can edit.',
    tasks:[['Add equipment',['Click <b>Add equipment</b>: plant, machine type, asset tag, make, model, serial number, year.','Set criticality, status and location, then fill in the mandatory technical parameters for that machine type.']],
      ['Find a machine',['Search or filter the list, then click the asset tag.']]],
    tips:['"Incomplete" marks machines missing mandatory parameters.']},
  equipmentRecord:{title:'Machine record',what:'Everything about one machine: identification, parameters, live data, documents, label and tickets.',
    tasks:[['Common actions',['<b>Edit</b> to change details.','<b>Report breakdown</b> for this machine.','<b>Attach manual or document</b> (PDF or picture).','<b>Connect IoT device</b>: enter the external device ID from your machine-data system and when to mark it stale.','Print the <b>Equipment label</b> (QR) and fix it to the machine for scan-at-machine.']]]},
  condition:{what:'Machine health from sensor readings, judged against warning and critical limits.',who:'Customer roles, dispatchers and platform admins; plant managers, admins and dispatchers edit limits.',
    tasks:[['Check a reading',['Click a parameter name to see its trend.']],
      ['Set limits',['Click <b>Edit alarm limits</b> on the machine and set warning and critical limits per parameter. Crossing them raises an alert.']]]},
  contracts:{what:'Annual maintenance contracts: coverage, response targets and scheduled visits.',who:'Platform admins, customer admins and dispatchers add and edit; others read.',
    tasks:[['Add a contract',['Click <b>Add service contract</b>: customer, number, title, dates and renewal notice.','Set coverage hours, response and restore targets, preventive visits per year, the first visit, and the covered machines.']],
      ['Plan and renew',['<b>Schedule visit</b> plans a visit on a machine.','<b>Edit terms / renewal</b> changes end date, targets or status.']]],
    tips:['Machines without a contract use the default response targets under <b>Settings</b>.']},
  parts:{what:'Spare part requests: request → quote → approval → order → delivery.',who:'Requested from a ticket; providers quote; customer admins and plant managers approve.',
    tasks:[['Request a part',['On the ticket, click <b>Request spare part</b>: part number, manufacturer, description, quantity, unit and urgency.']],
      ['Quote and approve',['The provider uses <b>Send quote</b>: price, currency, lead time and valid-until date.','The customer opens <b>View quotes</b> and approves one before it expires.']]]},
  assets:{what:'Where moulds, tools, gauges and trolleys are, from BLE beacons and RFID tags.',who:'Customer roles, dispatchers and platform admins; managers add zones and assets.',
    tasks:[['Set up tracking',['<b>Add location zone</b>: plant, name, type and the reader or gateway ID.','<b>Add tracked asset</b>: name, type, tag ID and technology, home zone, linked equipment, and when to report it missing.']],
      ['Find an asset',['Search the list; <b>Location history</b> shows where it has been.']]]},

  // ---------- Energy, safety ----------
  energy:{what:'Electricity use, energy per kg, wasted energy, peaks, CO₂ and cost.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Analyse energy',['Choose plant, machine and period at the top.','Compare machines in <b>By machine</b>: kWh per kg shows efficiency; wasted is energy used while not producing.']]],
    tips:['Electricity price and grid emission factor are set per company under <b>Companies, plants & users › Edit</b>.']},
  safety:{what:'Detected and reported safety events, their investigation, and leading indicators.',who:'Customer roles, dispatchers and platform admins.',
    tasks:[['Report an event',['Click <b>Report safety event</b>: plant, what happened, area, machine, when and a description.']],
      ['Investigate and close',['<b>Start investigation</b> on an open event.','<b>Close event</b> with the root cause and corrective action.']]]},

  // ---------- Administration ----------
  organisation:{what:'Customer companies, their plants and the user accounts.',who:'Platform admins and customer admins; provider admins manage their own users.',
    tasks:[['Add a company ('+ADMIN+')',['Click <b>Add company</b>: name, country, VAT ID, contact, electricity price, emission factor, currency, units and language.']],
      ['Add a plant',['Click <b>Add plant</b>: company, name, address, country, service area and operating pattern.','Then <b>Edit shifts</b> on the plant to set the planned shift times.']],
      ['Add a user',['Click <b>Add user</b>: role, company (or service provider), name, job title, email and a temporary password.','Give them the password; they must change it when they first sign in.']],
      ['Help a user',['<b>Reset password</b> sets a new temporary password.','<b>Vision duties</b> decides which vision alarms they receive.']]]},
  providers:{what:'Approved third-party service partners who can be assigned tickets.',who:'Platform admins edit; dispatchers and engineers read.',
    tasks:[['Add a provider',['Click <b>Add service provider</b>: name, country, certifications, contact and liability insurance date.','Then add their users under <b>Companies, plants & users</b> with a service provider role.']]]},
  settings:{what:'Reference data and defaults used across the platform.',who:'Only the platform admin can change these; others read.',
    tasks:[['Code lists',['Use <b>+ Add</b> beside a list to add a value; click ✕ on a value to remove it.']],
      ['Service areas and checklists',['<b>Add service area</b> / <b>Rename area</b>.','<b>Edit checklist</b> sets the standard inspection items per machine type.']],
      ['Response targets',['Set hours per priority. Used when no contract covers the machine.']],
      ['Scan at the machine',['Choose whether scanning the machine\'s QR label or tag is required or optional when raising and when closing a ticket.']]]},
  integrations:{what:'The machine-data connection: sync runs, device mappings and quarantined records.',who:'Platform admins, dispatchers and customer admins.',
    tasks:[['Connect a machine',['Open the machine in the <b>Equipment register</b> and click <b>Connect IoT device</b>.']],
      ['Check the connection',['<b>Sync now</b> pulls new data immediately.','<b>Recent sync runs</b> shows counts and errors; <b>Quarantined records</b> shows data that could not be read.']]]},
  audit:{what:'Every change, who made it and when.',who:'Platform admins and customer admins.',tasks:[['Find a change',['Search by action, record or user name, or filter by record type.']]]},
  account:{what:'Your profile, language and password.',who:'Everyone.',
    tasks:[['Change password',['Enter your current password and the new one under <b>Change password</b>.']],['Change language',['Use the language selector under your name in the menu.']]]},
};

export function openHelp(topic,{groups,visible,title}) {
  const options=[['start','Getting started'],...groups.flatMap(([, pages])=>pages.filter(p=>visible(p)&&HELP[p]).map(p=>[p,title(p)]))];
  const known=HELP[topic]?topic:'start';
  if (!options.some(o=>o[0]===known)) options.splice(1,0,[known,HELP[known].title||title(known)]);
  const body=k=>{ const h=HELP[k];
    return `<p>${h.what}</p>${h.who?`<p class="muted"><b>Who can use it:</b> ${h.who}</p>`:''}`
      +h.tasks.map(([name,steps],i)=>`<details class="help-task" ${i===0?'open':''}><summary>${name}</summary><ol>${steps.map(s=>`<li>${s}</li>`).join('')}</ol></details>`).join('')
      +(h.tips?.length?`<div class="help-tips"><b>Tips</b><ul>${h.tips.map(s=>`<li>${s}</li>`).join('')}</ul></div>`:''); };
  openDialog('Help',`<div class="fld wide"><label for="help-topic">Topic</label><select id="help-topic">${options.map(([k,v])=>`<option value="${k}" ${k===known?'selected':''}>${esc(v)}</option>`).join('')}</select></div><div id="help-body">${body(known)}</div>`,
    {onOpen:d=>{ d.querySelector('#help-topic').onchange=e=>{ d.querySelector('#help-body').innerHTML=body(e.target.value); }; }});
}
