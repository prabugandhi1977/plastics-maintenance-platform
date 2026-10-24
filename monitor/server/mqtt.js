// MQTT intake: subscribes to a broker and feeds every message into the same ingest() path as POST /api/ingest.
// Two payload formats:
//   1. JSON on any topic: one reading { device, at?, state?, values: { signal: number } } or { readings: [...] }.
//      Without "at" the time of receipt is used.
//   2. One value per topic: <prefix>/<device>/<signal> with a plain number, or <prefix>/<device>/state with
//      running, idle, down or off. The time of receipt is used.
// Messages are collected and ingested in batches, so a busy broker does not mean one transaction per message.
import mqtt from 'mqtt';
import { ingest } from './ingest.js';

const KEEP_REASONS = 10, MAX_QUEUE = 20000;

export function mqttConfig(env = process.env) {
  const url = env.MONITOR_MQTT_URL?.trim();
  if (!url) return null;
  if (!/^(mqtts?|wss?):\/\//i.test(url)) throw new Error('MONITOR_MQTT_URL must start with mqtt://, mqtts://, ws:// or wss://');
  return { url, username: env.MONITOR_MQTT_USERNAME || undefined, password: env.MONITOR_MQTT_PASSWORD || undefined,
    topic: env.MONITOR_MQTT_TOPIC?.trim() || 'mouldcare/#', clientId: env.MONITOR_MQTT_CLIENT_ID?.trim() || undefined };
}
// The broker address as it may be shown: no user name or password, even if they were written into the URL.
const safeUrl = url => { try { const u = new URL(url); u.username = ''; u.password = ''; return u.toString().replace(/\/$/, ''); } catch { return 'invalid URL'; } };

let client = null, state = fresh(null), queue = [], timer = null, retry = null;
function fresh(cfg) {
  return { enabled: !!cfg, url: cfg ? safeUrl(cfg.url) : null, topic: cfg?.topic ?? null, clientId: cfg?.clientId ?? null, username: cfg?.username ?? null,
    connected: false, connectedAt: null, lastMessageAt: null, lastError: null, messages: 0, accepted: 0, rejected: 0, batches: 0, reconnects: 0, reasons: [] };
}
export const mqttStatus = () => ({ ...state, queued: queue.length, reasons: [...state.reasons] });

function reject(topic, reason) {
  state.rejected++;
  state.reasons.unshift({ at: Date.now(), topic, reason });
  state.reasons.length = Math.min(state.reasons.length, KEEP_REASONS);
}

// Turns one message into readings for ingest(), or throws with the reason it cannot be used.
export function parseMessage(topic, payload, now = Date.now()) {
  const textOf = String(payload).trim();
  if (textOf.startsWith('{') || textOf.startsWith('[')) {
    let data; try { data = JSON.parse(textOf); } catch { throw new Error('Payload is not valid JSON'); }
    const items = Array.isArray(data) ? data : Array.isArray(data?.readings) ? data.readings : [data];
    if (!items.length) throw new Error('No readings in the payload');
    return items.map(x => x && typeof x === 'object' && x.at == null ? { ...x, at: now } : x);
  }
  const parts = topic.split('/');
  if (parts.length < 3) throw new Error('Plain payloads need a topic like <prefix>/<device>/<signal>');
  const [device, signal] = parts.slice(-2);
  if (signal === 'state') return [{ device, at: now, state: textOf.toLowerCase() }];
  const value = textOf === '' ? NaN : Number(textOf);
  // A non-number is passed on so that ingest() rejects it with its usual reason.
  return [{ device, at: now, values: { [signal]: Number.isFinite(value) ? value : textOf } }];
}

export function flush() {
  clearTimeout(timer); timer = null;
  while (queue.length) {
    const batch = queue.splice(0, state.batchSize);
    state.batches++;
    let results;
    try { results = ingest(batch.map(x => x.item)); } catch (e) { for (const x of batch) reject(x.topic, e.message); continue; }
    for (const r of results) r.status === 'accepted' ? state.accepted++ : reject(batch[r.index].topic, r.reason);
  }
}
function enqueue(topic, payload) {
  state.messages++; state.lastMessageAt = Date.now();
  let items; try { items = parseMessage(topic, payload); } catch (e) { return reject(topic, e.message); }
  for (const item of items) {
    if (queue.length >= MAX_QUEUE) { reject(topic, 'Intake queue is full'); continue; }
    queue.push({ topic, item });
  }
  if (queue.length >= state.batchSize) flush();
  else if (!timer) timer = setTimeout(flush, state.flushMs);
}

// Starts the subscriber (once). Reconnects with backoff from minBackoffMs, doubling up to maxBackoffMs.
export function startMqtt(cfg = mqttConfig(), { flushMs = 1000, batchSize = 500, minBackoffMs = 1000, maxBackoffMs = 60000 } = {}) {
  if (!cfg || client) return client;
  state = { ...fresh(cfg), flushMs, batchSize };
  let attempt = 0;
  const c = client = mqtt.connect(cfg.url, { username: cfg.username, password: cfg.password, clientId: cfg.clientId,
    // With a fixed client ID the broker keeps the session, and holds QoS 1 messages while Monitor is away.
    clean: !cfg.clientId, reconnectPeriod: 0, resubscribe: false, connectTimeout: 15000 });
  c.on('connect', () => {
    attempt = 0; state.connected = true; state.connectedAt = Date.now(); state.lastError = null;
    c.subscribe(cfg.topic, { qos: 1 }, err => { if (err) state.lastError = `Subscribe failed: ${err.message}`; });
  });
  c.on('message', enqueue);
  c.on('error', e => { state.lastError = e.message; });
  c.on('close', () => {
    state.connected = false;
    if (client !== c || retry) return;
    const wait = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt++);
    retry = setTimeout(() => { retry = null; if (client !== c) return; state.reconnects++; c.reconnect({ incomingStore: c.incomingStore, outgoingStore: c.outgoingStore }); }, wait);
    retry.unref?.();
  });
  return c;
}

// Ingests what is still queued and disconnects.
export async function stopMqtt() {
  const c = client; client = null;
  clearTimeout(retry); retry = null;
  flush();
  if (c) await new Promise(r => c.end(false, {}, () => r()));
  state.connected = false;
}
