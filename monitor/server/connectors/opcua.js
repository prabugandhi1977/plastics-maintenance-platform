// OPC UA, including Euromap 77 (OPC 40077) injection moulding machines, Siemens S7-1200/1500 and any PLC or
// gateway with an OPC UA server. Values come from a subscription (the server pushes changes) or, when the server
// does not allow one or read mode is "poll", from a read of all nodes on every poll. Either way Monitor stores the
// latest values once per poll interval.
//
// A node entry: { node: 'ns=2;s=Machine.OilTemp', scale, offset }. The machine state comes from options.state.node
// with options.state.map (by default the Euromap 77 machine modes).
import { join } from 'node:path';
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds, TimestampsToReturn, UserTokenType, ClientMonitoredItem, StatusCodes, resolveNodeId } from 'node-opcua-client';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';
import { DATA_DIR } from '../db.js';
import { numberOf, scaled, mapState, within, EUROMAP77_STATES } from './common.js';

export const SECURITY = { None: MessageSecurityMode.None, Sign: MessageSecurityMode.Sign, SignAndEncrypt: MessageSecurityMode.SignAndEncrypt };
export const POLICIES = { None: SecurityPolicy.None, Basic256Sha256: SecurityPolicy.Basic256Sha256, Aes128_Sha256_RsaOaep: SecurityPolicy.Aes128_Sha256_RsaOaep, Aes256_Sha256_RsaPss: SecurityPolicy.Aes256_Sha256_RsaPss };
export const validNodeId = s => { try { resolveNodeId(s); return true; } catch { return false; } };

// One certificate for Monitor as an OPC UA client, kept on the data disk so a server that trusts it keeps trusting it.
// Two managers on the same folder (one accepts unknown server certificates, one does not), set up one after the other.
const managers = {}; let ready = Promise.resolve();
function certificates(acceptUnknown) {
  const key = acceptUnknown ? 'accept' : 'strict';
  managers[key] ??= (ready = ready.then(async () => {
    const m = new OPCUACertificateManager({ rootFolder: join(DATA_DIR, 'opcua-pki'), automaticallyAcceptUnknownCertificate: acceptUnknown });
    await m.initialize(); return m;
  }));
  ready = ready.catch(() => {});
  return managers[key].catch(e => { delete managers[key]; throw e; });
}

export function opcuaDriver(cfg, { onLost } = {}) {
  const o = cfg.options ?? {}, timeoutMs = o.timeoutMs ?? 10000;
  const entries = Object.entries(cfg.mapping).map(([key, m]) => ({ key, ...m }));
  if (o.state?.node) entries.push({ key: '$state', node: o.state.node });
  const stateMap = o.state?.map && Object.keys(o.state.map).length ? o.state.map : EUROMAP77_STATES;
  let client = null, session = null, sub = null, latest = new Map(), failed = new Map(), mode = 'poll', note = null, closing = false;

  const lost = why => { if (!closing) onLost?.(new Error(why)); };
  const toResult = dataValues => {
    const values = {}, raw = {}, skipped = []; let state = null;
    entries.forEach((e, i) => {
      const dv = dataValues[i];
      if (!dv) { skipped.push(`${e.key}: ${failed.get(i) ?? 'no value yet'}`); return; }
      if (dv.statusCode && dv.statusCode.value !== StatusCodes.Good.value && !dv.statusCode.name?.startsWith('Uncertain')) { skipped.push(`${e.key}: ${dv.statusCode.name}`); return; }
      const v = dv.value?.value; raw[e.key] = typeof v === 'bigint' ? Number(v) : v;
      if (e.key === '$state') { state = mapState(v, stateMap); if (!state) skipped.push(`state: value ${String(v?.text ?? v)} is not mapped`); return; }
      const n = numberOf(v); if (n == null) skipped.push(`${e.key}: not a number`); else values[e.key] = scaled(n, e);
    });
    return { values, state, raw, skipped };
  };

  return {
    get mode() { return mode; }, get note() { return note; },
    async open() {
      closing = false;
      const securityMode = SECURITY[o.securityMode ?? 'None'], securityPolicy = POLICIES[o.securityPolicy ?? (o.securityMode && o.securityMode !== 'None' ? 'Basic256Sha256' : 'None')];
      client = OPCUAClient.create({ applicationName: 'MouldCare Monitor', endpointMustExist: false, securityMode, securityPolicy, keepSessionAlive: true, requestedSessionTimeout: 60000,
        connectionStrategy: { maxRetry: 0, initialDelay: 1000, maxDelay: 1000 }, transportTimeout: timeoutMs, clientCertificateManager: await certificates(o.acceptUnknownCertificates !== false) });
      client.on('connection_lost', () => lost('The connection to the OPC UA server was lost'));
      client.on('close', () => lost('The OPC UA server closed the connection'));
      await within(timeoutMs, client.connect(cfg.endpoint), 'Connecting to the OPC UA server').catch(e => {
        const code = /\b(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ECONNRESET|EAI_AGAIN)\b/.exec(e.message)?.[1];
        throw code ? new Error(`Cannot reach the OPC UA server (${code})`) : e;
      });
      const identity = cfg.username ? { type: UserTokenType.UserName, userName: cfg.username, password: cfg.password ?? '' } : { type: UserTokenType.Anonymous };
      session = await within(timeoutMs, client.createSession(identity), 'Opening the OPC UA session');
      session.on('session_closed', () => lost('The OPC UA session was closed'));
      mode = 'poll'; note = null; latest = new Map(); failed = new Map();
      if (o.readMode !== 'poll' && entries.length) {
        try {
          sub = await within(timeoutMs, session.createSubscription2({ requestedPublishingInterval: Math.min(1000, cfg.pollMs), requestedLifetimeCount: 600, requestedMaxKeepAliveCount: 20, maxNotificationsPerPublish: 1000, publishingEnabled: true, priority: 1 }), 'Creating the OPC UA subscription');
          sub.on('terminated', () => lost('The OPC UA subscription ended'));
          await Promise.all(entries.map((e, i) => new Promise(ok => {
            const item = ClientMonitoredItem.create(sub, { nodeId: e.node, attributeId: AttributeIds.Value }, { samplingInterval: Math.min(1000, cfg.pollMs), discardOldest: true, queueSize: 1 }, TimestampsToReturn.Both);
            item.on('changed', dv => latest.set(i, dv)); item.on('initialized', ok); item.on('err', m => { failed.set(i, String(m)); ok(); });
          })));
          mode = 'subscription';
        } catch (e) {
          // Polling still works on servers that limit or refuse subscriptions.
          note = `Subscription failed, polling instead: ${e.message}`;
          try { await sub?.terminate(); } catch {} sub = null; latest = new Map();
        }
      }
    },
    async read() {
      if (mode === 'subscription') return toResult(entries.map((_, i) => latest.get(i)));
      const dvs = await within(timeoutMs, session.read(entries.map(e => ({ nodeId: e.node, attributeId: AttributeIds.Value }))), 'Reading from the OPC UA server');
      return toResult(dvs);
    },
    async close() {
      closing = true;
      try { await sub?.terminate(); } catch {}
      try { await session?.close(); } catch {}
      try { await client?.disconnect(); } catch {}
      sub = session = client = null;
    },
  };
}
