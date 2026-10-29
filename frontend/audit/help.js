// Help for the energy audit app: one screen of collapsible topics, opened from the header's "?". Static, trusted text (may contain <b>).
// German text is in help-de.js with the same topic ids; the user's language picks it, English fills any gap.
import { locale } from '/shared/i18n.js';
import { TOPICS_DE } from '/audit/help-de.js';

const TOPICS=[
  {id:'start',title:'What this app does',steps:[
    'It measures the <b>specific energy consumption (SEC, kWh per kg)</b> of an injection moulding machine during a test run, shows where in the cycle the energy goes, and estimates what a better hydraulic drive (a variable-displacement pump or a servo-driven pump) could save.',
    'Sign in with your MouldCare account. Customer admins, plant managers, maintenance staff and platform admins can run audits for their company; dispatchers can read them.',
    'Install it: in Chrome use <b>Add to home screen</b>. The app needs a connection; nothing is queued offline except Bluetooth samples.']},
  {id:'new',title:'Create an audit',steps:[
    'Tap <b>New audit</b>. Choose the machine, the product or mould (its part weight and ideal cycle are used), and the material (type a new one or edit the list under <b>Settings</b>).',
    'Choose the <b>meter</b>. Before you start, the box under it tells you plainly what that meter supports, for example <i>10 samples per second: SEC yes, cycle map yes</i>, or <i>reports every 10 minutes: SEC yes, cycle map no</i>.',
    'Enter the nameplate data if you have it. The <b>pump type is optional</b>: if you leave it unknown, the app infers the drive from the measured profile and shows how sure it is.',
    '<b>Start a test run</b> now, or choose a <b>past period</b> to analyse data that is already stored. For the mass, use the production counts or type the good kilograms or parts you counted.']},
  {id:'meter',title:'Meters and how they send data',steps:[
    'Open <b>Meters › Register meter</b>. Kinds: <b>clamp-on analyzer</b> (voltage and current: power is measured, normally 10 values per second), <b>LoRaWAN current clamp</b> (current only: power is <b>estimated</b>, reports every few minutes), and <b>generic</b>.',
    '<b>Wi-Fi (HTTP):</b> the meter or a small gateway posts JSON to the address shown on the meter page, with an <b>integration key</b> in the header <code>X-Integration-Key</code>. A customer admin creates the key on the meter page; it is shown once.',
    '<b>MQTT:</b> the platform does not run an MQTT client. Put a bridge (for example Node-RED or a Mosquitto bridge script) between your broker and the <i>payload</i> address; it posts each message there.',
    '<b>Field mapping:</b> because every meter names its fields differently, you say where each value sits, one line per value, like <code>kw=pwr.total *0.001</code>. Use <b>Test mapping</b> with a real payload to check it. Nothing is assumed about any vendor.',
    '<b>Bluetooth (experimental):</b> in Chrome on Android the phone can read a configured GATT characteristic and relay the samples, buffering them while offline. You enter the service, the characteristic and the byte layout. It is untested against any specific meter.',
    'The meter\'s clock may drift. The app uses the meter\'s own timestamps when they are plausible, stores the receive time, and shows the clock offset on the meter page.']},
  {id:'run',title:'Run the test',steps:[
    'Tap <b>Start test run</b> while the machine is producing normally, and <b>Stop</b> after at least 20 to 30 cycles. The screen shows how many values arrived in the last minute.',
    'Longer is better: with 10 values per second, 15 to 30 minutes already gives dozens of cycles.',
    'Add photos of the nameplate and the meter under <b>Setup</b>.']},
  {id:'results',title:'Reading the results',steps:[
    '<b>SEC</b>: energy of the test divided by good product. It is compared with an indicative range for the drive type; those ranges are placeholders to replace with your own history. Anything marked <b>ESTIMATED</b> comes from current only and can be well off.',
    '<b>Cycles</b>: the app finds the cycles in the power trace (or from the machine\'s cycle signal if the meter sends one), shows the detected cycle time against the ideal one, and averages all cycles into one profile with a band from minimum to maximum.',
    'Enter the <b>phase template</b> from the machine screen (names and seconds, e.g. Mould close 2.5, Lock up 1.0 …). Energy per phase is then the area under the curve. Where the screen shows phases running at the same time, enter them as one. Phases marked ⚠ keep power high while little work is done.',
    '<b>Drive</b>: the inferred class with its confidence and evidence. Override it if you know better. The <b>inefficiency score</b> is the share of the cycle energy used above standby in phases where little work is done; it does not depend on the label.']},
  {id:'upgrade',title:'The upgrade case',steps:[
    'Savings come from per-phase saving factors for the target drive (low, typical, high). They are <b>assumptions to validate with the supplier</b>, shown next to the result; you can see them under <b>Show saving factors</b>.',
    'Enter the annual running hours, the retrofit cost and, if you know it, a fixed load such as heater bands that a new pump would not save. You get kWh and money per year, CO₂, simple payback and the net saving over the years. Demand-charge effects are not included.',
    'If the profile is already servo-like or all-electric, there is no upgrade case; the app lists what remains (standby, long cooling, power factor, slow cycle).',
    'The <b>confidence</b> says how far to trust the numbers: cycle map resolution, test length, number of cycles, estimated or measured power.']},
  {id:'report',title:'The report',steps:['Open the audit › <b>Report</b> and choose English or German. The report opens as a page you can print or save as PDF. It contains the method, data quality, SEC against the benchmark, the cycle chart, the phase table, the proposal with assumptions and payback, and the limitations.']},
  {id:'data',title:'Raw data and privacy',steps:[
    'Raw high-rate samples are kept for the audit window only, for 90 days after the audit is completed. All other raw samples are rolled up to one-minute values after 24 hours.',
    'Under <b>Setup › Raw data</b> you can export the samples as CSV or delete them; the stored result stays.']}
];
export function helpView(view) {
  const de=locale()==='de'?TOPICS_DE:{}, open={list:'start',new:'new',audit:'results',meters:'meter',meter:'meter',template:'results',settings:'new'}[view];
  const T=de.__title||'Help';
  return `<header class="top"><button type="button" class="icon" id="helpback" aria-label="OK">‹</button><div class="ttl"><div class="brand">Mould<span>Care</span></div><div class="sub">${T}</div></div></header><main class="content">${TOPICS.map(x=>{ const d=de[x.id]||x; return `<details class="card" ${x.id===open?'open':''}><summary><b>${d.title}</b></summary><ol>${d.steps.map(s=>`<li>${s}</li>`).join('')}</ol></details>`; }).join('')}</main>`;
}
