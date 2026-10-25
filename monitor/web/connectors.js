// Machine connectors under Settings › Connections & models, for the super user: Monitor polls machines directly over
// OPC UA / Euromap 77, Euromap 63 files or Modbus TCP. Lists each connector with its live status; add, edit, delete,
// enable and disable; and Test connection, which reads once and shows the values without storing them.
// Passwords are typed here but never shown again: the server keeps them encrypted and only says whether one is set.
import { icon, heading } from '/icons.js';
import { btn, dialog, field, select, textarea } from '/setup.js';
let ctx; // { api, esc, state, render }
export const initConnectors = c => { ctx = c; };
const esc = v => ctx.esc(v);
const chip = (cls, label) => `<span class="chip ${cls}">${esc(label)}</span>`;
const ago = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const ENDPOINT = { opcua: ['Endpoint', 'opc.tcp://192.168.10.20:4840'], euromap63: ['Session folder', 'imm-07 (inside the Euromap 63 root)'], modbus: ['Host and port', '192.168.10.21:502'] };
const EXAMPLE = {
  opcua: { mapping: { hydraulic_oil_temp: { node: 'ns=2;s=Machine.OilTemp' }, injection_pressure: { node: 'ns=2;s=Machine.InjPressure', scale: 0.1 } }, state: { node: 'ns=2;s=Machine.MachineMode', map: {} } },
  euromap63: { mapping: { hydraulic_oil_temp: { param: '@ActTmpOil' }, injection_pressure: { param: '@ActPrsInjMax' } }, state: { param: '@ActStsMach', map: { '0A000': 'running', '0I000': 'idle', '0E000': 'down' } } },
  modbus: { mapping: { hydraulic_oil_temp: { address: 100, function: 'holding', type: 'float32', wordOrder: 'big' }, motor_current: { address: 10, function: 'input', type: 'int16', scale: 0.1 } }, state: { address: 200, function: 'holding', map: { 0: 'off', 1: 'idle', 2: 'running', 3: 'down' } } },
};
let info = null;

function statusHtml(c) {
  const s = c.status;
  if (!c.enabled) return chip('', 'Disabled');
  const head = s.connected ? chip('good', 'Connected') : s.lastError ? chip('critical', 'Not connected') : chip('watch', 'Starting');
  return `${head}${s.mode ? ` <span class="small muted">${esc(s.mode)}</span>` : ''}${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ''}
    ${s.lastError ? `<div class="small muted">${icon('risk', 'i xs')} ${esc(s.lastError)}${s.lastErrorAt ? ` · ${ago(s.lastErrorAt)}` : ''}${!s.connected && s.retryInMs ? ` · retry in ${Math.round(s.retryInMs / 1000) || '<1'} s` : ''}</div>` : ''}`;
}
const valuesHtml = v => v && Object.keys(v).length ? `<div class="small muted">${Object.entries(v).map(([k, x]) => `<code>${esc(k)}</code> ${esc(x)}`).join(' · ')}</div>` : '';

export async function connectorsSection() {
  info = await ctx.api('/connectors');
  const list = info.connectors;
  return `<section class="card"><div class="row">${heading('plug', `Machine connectors <span class="count-chip">${list.length}</span>`)}${btn('conn-new', 'Add connector', 'plus', { cls: 'sm primary' })}</div>
    <p class="small muted">Monitor reads machines directly: <b>OPC UA / Euromap 77</b> (newer injection moulding machines, Siemens S7-1500 and most PLCs with an OPC UA server), <b>Euromap 63</b> (older machines, by files in a shared folder) and <b>Modbus TCP</b> (most PLCs and energy meters). Readings go through the same checks as the gateway intake.${info.enabled ? '' : ` ${chip('watch', 'Off on this server')} MONITOR_CONNECTORS is off, so none of them runs.`}</p>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Machine</th><th>Connector</th><th>Status</th><th>Last reading</th><th class="num">Accepted</th><th class="num">Rejected</th><th></th></tr></thead><tbody>
    ${list.map(c => `<tr><td><b>${esc(c.machineTag)}</b><div class="small muted">${esc(c.machineName)}</div></td>
      <td><b>${esc(c.name)}</b><div class="small muted">${esc(c.typeLabel)} · every ${c.pollSeconds} s</div><code class="small">${esc(c.endpoint)}</code></td>
      <td>${statusHtml(c)}</td><td>${ago(c.status.lastReadingAt)}${c.status.lastState ? ` ${chip(c.status.lastState, c.status.lastState)}` : ''}${valuesHtml(c.status.lastValues)}</td>
      <td class="num">${c.status.accepted.toLocaleString()}</td><td class="num">${c.status.rejected.toLocaleString()}${c.status.reasons.length ? `<details><summary class="small">Why</summary><ul class="small">${c.status.reasons.map(x => `<li>${ago(x.at)} · ${esc(x.reason)}</li>`).join('')}</ul></details>` : ''}</td>
      <td><span class="row">${btn('conn-test', 'Test', 'signal', { data: { id: c.id } })}${btn('conn-edit', 'Edit', 'edit', { data: { id: c.id } })}
        ${btn('conn-toggle', c.enabled ? 'Disable' : 'Enable', 'power', { data: { id: c.id, on: c.enabled ? '0' : '1' } })}${btn('conn-del', 'Delete', 'trash', { cls: 'sm danger', data: { id: c.id, name: c.name } })}</span></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No connectors yet. Add one to read a machine directly, without a gateway.</div>'}
    <details><summary class="small">How addresses are written</summary><ul class="small">
      <li><b>OPC UA</b>: node IDs such as <code>ns=2;s=Machine.OilTemp</code>. The machine state node defaults to the Euromap 77 machine modes (Automatic → running, Manual and Setup → idle, Sleep → off); give a map for anything else.</li>
      <li><b>Euromap 63</b>: parameter names such as <code>@ActCycTim</code>. The folder is inside <code>${esc(info.euromap63Root)}</code> on this server.</li>
      <li><b>Modbus TCP</b>: 0-based addresses (register 40001 is address 0, function holding), types ${info.modbus.types.map(x => `<code>${x}</code>`).join(', ')}, word order big (high word first) or little.</li>
      <li>Siemens S7 without OPC UA: use the PLC's Modbus TCP server, or an OPC UA server on the PLC or a gateway.</li></ul></details></section>`;
}

const json = v => JSON.stringify(v, null, 2);
function parseJson(text, name) { if (!text.trim()) return {}; try { return JSON.parse(text); } catch { throw new Error(`${name} is not valid JSON`); } }
function bodyOf(fd, type) {
  const v = Object.fromEntries(fd), options = {}, n = k => v[k] === '' || v[k] == null ? undefined : Number(v[k]);
  if (n('timeoutMs') !== undefined) options.timeoutMs = n('timeoutMs');
  if (type === 'opcua') Object.assign(options, { securityMode: v.securityMode, securityPolicy: v.securityPolicy || undefined, readMode: v.readMode, acceptUnknownCertificates: fd.has('acceptUnknownCertificates') });
  if (type === 'modbus' && n('unitId') !== undefined) options.unitId = n('unitId');
  if (type === 'euromap63') options.machineFolder = v.machineFolder;
  const state = parseJson(v.state ?? '', 'Machine state'); if (Object.keys(state).length) options.state = state;
  const out = { machineId: v.machineId, name: v.name, endpoint: v.endpoint, pollSeconds: Number(v.pollSeconds), enabled: fd.has('enabled'), options, mapping: parseJson(v.mapping ?? '', 'Signal mapping') };
  if (type === 'opcua') { out.username = v.username; if (v.password) out.password = v.password; if (fd.has('clearPassword')) out.password = ''; out.passwordEnv = v.passwordEnv || null; }
  return out;
}
function resultHtml(r) {
  if (!r.ok) return `<div class="error">${esc(r.error)}</div>`;
  const rows = Object.entries(r.values).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(v)}</td><td class="small muted">${esc(JSON.stringify(r.raw?.[k]))}</td></tr>`).join('');
  return `<div class="explain"><div class="row"><b class="grow small">${icon('check', 'i xs')} Read in ${r.ms} ms · not stored</b>${r.state ? chip(r.state, `State: ${r.state}`) : ''}</div>
    ${rows ? `<table><thead><tr><th>Signal</th><th class="num">Value</th><th>Raw</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="small muted">No values came back.</p>'}
    ${r.skipped?.length ? `<ul class="small">${r.skipped.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
}

async function connectorForm(c) {
  const machines = await ctx.api('/machines'), type0 = c?.type ?? 'opcua', o = c?.options ?? {};
  const group = (t, html) => `<div class="form-grid span" data-for="${t}" ${type0 === t ? '' : 'hidden'}>${html}</div>`;
  const body = `<div class="form-grid">${select('machineId', 'Machine', machines.map(m => [m.id, `${m.tag} · ${m.name}`]), { value: c?.machineId, required: true })}
    ${field('name', 'Name', { value: c?.name ?? 'Machine connector', required: true, maxlength: 100 })}
    ${c ? `<label>Type<input type="text" value="${esc(c.typeLabel)}" disabled><small class="muted">Fixed once added</small></label>` : select('type', 'Type', Object.entries(info.types), { value: type0, required: true })}
    <label class="span"><span id="ep-label">${esc(ENDPOINT[type0][0])} <span class="req">*</span></span><input type="text" name="endpoint" required maxlength="300" value="${esc(c?.endpoint ?? '')}" placeholder="${esc(ENDPOINT[type0][1])}"></label>
    ${field('pollSeconds', 'Poll every (seconds)', { value: c?.pollSeconds ?? 60, type: 'number', min: 1, max: 3600, step: 'any', required: true })}
    ${field('timeoutMs', 'Timeout (ms)', { value: o.timeoutMs ?? '', type: 'number', min: 200, max: 120000, help: 'Empty for the default' })}
    <label class="check"><input type="checkbox" name="enabled" ${c?.enabled === false ? '' : 'checked'}> Enabled</label>
    ${group('opcua', `${select('securityMode', 'Security mode', [['None', 'None'], ['Sign', 'Sign'], ['SignAndEncrypt', 'Sign and encrypt']], { value: o.securityMode ?? 'None', required: true })}
      ${select('securityPolicy', 'Security policy', [['None', 'None'], ['Basic256Sha256', 'Basic256Sha256'], ['Aes128_Sha256_RsaOaep', 'Aes128_Sha256_RsaOaep'], ['Aes256_Sha256_RsaPss', 'Aes256_Sha256_RsaPss']], { value: o.securityPolicy, blank: 'Default' })}
      ${select('readMode', 'Read values by', [['subscription', 'Subscription (falls back to polling)'], ['poll', 'Polling']], { value: o.readMode ?? 'subscription', required: true })}
      ${field('username', 'User name', { value: c?.username ?? '', maxlength: 200, autocomplete: 'off', help: 'Empty for anonymous' })}
      ${field('password', 'Password', { type: 'password', maxlength: 200, autocomplete: 'new-password', placeholder: c?.passwordSet && !c?.passwordEnv ? 'Saved, unchanged' : '', help: 'Stored encrypted, never shown again' })}
      ${field('passwordEnv', 'Or: password from variable', { value: c?.passwordEnv ?? '', maxlength: 80, pattern: '^MONITOR_CONNECTOR_[A-Z0-9_]+$', placeholder: 'MONITOR_CONNECTOR_IMM07_PASSWORD', help: 'An environment variable on the server' })}
      ${c?.passwordSet ? '<label class="check"><input type="checkbox" name="clearPassword"> Remove the saved password</label>' : ''}
      <label class="check"><input type="checkbox" name="acceptUnknownCertificates" ${o.acceptUnknownCertificates === false ? '' : 'checked'}> Accept the server's certificate without adding it to the trust list</label>`)}
    ${group('modbus', field('unitId', 'Unit ID', { value: o.unitId ?? 1, type: 'number', min: 0, max: 255 }))}
    ${group('euromap63', field('machineFolder', 'Folder as the machine sees it', { value: o.machineFolder ?? '', maxlength: 200, placeholder: 'C:\\EM63\\', help: 'Prefix for file names in the job; empty when the machine uses its session folder' }))}
    ${textarea('mapping', 'Signal mapping (JSON): signal key → address', json(c?.mapping ?? EXAMPLE[type0].mapping))}
    ${textarea('state', 'Machine state (JSON, optional): source and value → running / idle / down / off', json(o.state ?? (c ? {} : EXAMPLE[type0].state)))}
    <div class="span row"><span class="grow small muted">Test connection reads once with these settings and stores nothing.</span><button class="btn sm" type="button" id="conn-try">${icon('signal', 'bi')}<span>Test connection</span></button></div>
    <div class="span" id="conn-result"></div></div>`;
  dialog(c ? `Edit ${c.name}` : 'Add machine connector', body, { wide: true, submit: c ? 'Save' : 'Add connector', dlgIcon: 'plug', submitIcon: c ? 'check' : 'plus',
    onOpen: d => {
      d.querySelectorAll('textarea').forEach(t => { t.rows = 6; t.maxLength = 20000; t.spellcheck = false; t.classList.add('mono'); });
      const typeOf = () => c?.type ?? d.querySelector('[name=type]').value;
      d.querySelector('[name=type]')?.addEventListener('change', e => {
        const t = e.target.value;
        d.querySelectorAll('[data-for]').forEach(g => { g.hidden = g.dataset.for !== t; });
        d.querySelector('#ep-label').innerHTML = `${esc(ENDPOINT[t][0])} <span class="req">*</span>`; d.querySelector('[name=endpoint]').placeholder = ENDPOINT[t][1];
        d.querySelector('[name=mapping]').value = json(EXAMPLE[t].mapping); d.querySelector('[name=state]').value = json(EXAMPLE[t].state);
      });
      const tryBtn = d.querySelector('#conn-try'), out = d.querySelector('#conn-result');
      tryBtn.addEventListener('click', async () => {
        tryBtn.disabled = true; out.innerHTML = '<p class="small muted">Connecting…</p>';
        try { const t = typeOf(); out.innerHTML = resultHtml(await ctx.api('/connectors/test', 'POST', { ...bodyOf(new FormData(d.querySelector('form')), t), type: t, ...(c ? { id: c.id } : {}) })); }
        catch (x) { out.innerHTML = `<div class="error">${esc(x.message)}</div>`; }
        finally { tryBtn.disabled = false; }
      });
    },
    onSubmit: async fd => {
      const t = c?.type ?? fd.get('type'), b = bodyOf(fd, t);
      if (c) await ctx.api(`/connectors/${c.id}`, 'PATCH', b); else await ctx.api('/connectors', 'POST', { ...b, type: t });
    } });
}

function testDialog(c, r) { dialog(`Test: ${c.name}`, `<p class="small muted">${esc(c.machineTag)} · ${esc(c.typeLabel)} · <code>${esc(c.endpoint)}</code></p>${resultHtml(r)}`, { dlgIcon: 'plug' }); }

export const ACTIONS = ['conn-new', 'conn-edit', 'conn-del', 'conn-toggle', 'conn-test'];
export async function action(act, el) {
  info ??= await ctx.api('/connectors');
  const { id } = el.dataset, c = info.connectors.find(x => x.id === id);
  if (act === 'conn-new') return connectorForm();
  if (act === 'conn-edit') return connectorForm(c);
  if (act === 'conn-toggle') { await ctx.api(`/connectors/${id}`, 'PATCH', { enabled: el.dataset.on === '1' }); return ctx.render(); }
  if (act === 'conn-del') { if (!confirm(`Delete the connector “${el.dataset.name}”? Readings already stored are kept.`)) return; await ctx.api(`/connectors/${id}`, 'DELETE'); return ctx.render(); }
  if (act === 'conn-test') { el.disabled = true; try { testDialog(c, await ctx.api(`/connectors/${id}/test`, 'POST', {})); } finally { el.disabled = false; } }
}
