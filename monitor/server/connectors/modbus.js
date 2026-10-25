// Modbus TCP: a small client over node:net (no dependency), for PLCs (Allen-Bradley, Mitsubishi, Omron, Delta,
// Schneider, Siemens with a Modbus module), drives and energy meters. Reads holding registers (function 3), input
// registers (4), coils (1) and discrete inputs (2). Neighbouring registers are read in one request.
//
// A register entry: { address, function: holding|input|coil|discrete, type: int16|uint16|int32|uint32|float32,
// wordOrder: big|little, scale, offset }. Addresses are the 0-based protocol address (register 40001 is address 0
// with function holding, 30001 is address 0 with function input).
import net from 'node:net';
import { scaled, mapState, within } from './common.js';

export const FUNCTIONS = { coil: 1, discrete: 2, holding: 3, input: 4 };
export const TYPES = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 };
const MAX_REGS = 120, MAX_BITS = 2000, GAP = 8;

// The value of one entry from its registers (array of 16-bit words, in the order the device sent them).
export function decode(words, type = 'uint16', wordOrder = 'big') {
  const w = wordOrder === 'little' && words.length === 2 ? [words[1], words[0]] : words;
  const b = Buffer.alloc(w.length * 2); w.forEach((x, i) => b.writeUInt16BE(x & 0xffff, i * 2));
  switch (type) {
    case 'int16': return b.readInt16BE(0);
    case 'uint16': return b.readUInt16BE(0);
    case 'int32': return b.readInt32BE(0);
    case 'uint32': return b.readUInt32BE(0);
    case 'float32': return b.readFloatBE(0);
    default: throw new Error(`Unknown Modbus type ${type}`);
  }
}

// Requests that cover the entries, merging neighbours of the same function.
export function plan(entries) {
  const out = [];
  for (const fn of Object.keys(FUNCTIONS)) {
    const bits = fn === 'coil' || fn === 'discrete', max = bits ? MAX_BITS : MAX_REGS;
    const list = entries.filter(e => e.function === fn).map(e => ({ ...e, count: bits ? 1 : TYPES[e.type] })).sort((a, b) => a.address - b.address);
    let cur = null;
    for (const e of list) {
      const end = e.address + e.count;
      if (cur && e.address - cur.end <= GAP && end - cur.start <= max) { cur.end = Math.max(cur.end, end); cur.entries.push(e); continue; }
      cur = { function: fn, start: e.address, end, entries: [e] }; out.push(cur);
    }
  }
  return out;
}

class ModbusClient {
  constructor(host, port, { unitId = 1, timeoutMs = 3000 } = {}) { Object.assign(this, { host, port, unitId, timeoutMs, tid: 0, pending: new Map(), buf: Buffer.alloc(0), chain: Promise.resolve() }); }
  connect(onLost) {
    return within(this.timeoutMs, new Promise((ok, no) => {
      const s = this.socket = net.connect({ host: this.host, port: this.port });
      s.setNoDelay(true);
      s.once('connect', () => { s.off('error', no); s.on('error', () => {}); ok(); });
      s.once('error', no);
      s.on('data', d => this.data(d));
      s.on('close', () => { const e = new Error('The Modbus device closed the connection'); for (const p of this.pending.values()) p.no(e); this.pending.clear(); if (!this.closing) onLost?.(e); });
    }), `Connecting to ${this.host}:${this.port}`).catch(e => { this.socket?.destroy(); throw e; });
  }
  data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 7) {
      const len = this.buf.readUInt16BE(4); if (this.buf.length < 6 + len) return;
      const frame = this.buf.subarray(0, 6 + len); this.buf = this.buf.subarray(6 + len);
      const p = this.pending.get(frame.readUInt16BE(0)); if (!p) continue;
      this.pending.delete(frame.readUInt16BE(0)); p.ok(frame.subarray(7));
    }
  }
  // One request at a time: many small devices handle only one.
  request(fn, start, count) {
    const run = () => new Promise((ok, no) => {
      const tid = this.tid = (this.tid + 1) & 0xffff, f = Buffer.alloc(12);
      f.writeUInt16BE(tid, 0); f.writeUInt16BE(0, 2); f.writeUInt16BE(6, 4); f.writeUInt8(this.unitId, 6); f.writeUInt8(fn, 7); f.writeUInt16BE(start, 8); f.writeUInt16BE(count, 10);
      const t = setTimeout(() => { this.pending.delete(tid); no(new Error(`No Modbus reply within ${this.timeoutMs / 1000} s (function ${fn}, address ${start})`)); }, this.timeoutMs);
      this.pending.set(tid, { ok: pdu => { clearTimeout(t); ok(pdu); }, no: e => { clearTimeout(t); no(e); } });
      this.socket.write(f);
    }).then(pdu => {
      if (pdu[0] === (fn | 0x80)) throw new Error(`Modbus exception ${pdu[1]} (${EXCEPTIONS[pdu[1]] ?? 'unknown'}) reading function ${fn} address ${start}`);
      if (pdu[0] !== fn) throw new Error(`Unexpected Modbus reply (function ${pdu[0]})`);
      const bytes = pdu.subarray(2, 2 + pdu[1]);
      if (fn <= 2) return Array.from({ length: count }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
      if (bytes.length < count * 2) throw new Error(`Short Modbus reply: ${bytes.length / 2} of ${count} registers`);
      return Array.from({ length: count }, (_, i) => bytes.readUInt16BE(i * 2));
    });
    const p = this.chain.then(run, run); this.chain = p.catch(() => {}); return p;
  }
  close() { this.closing = true; this.socket?.destroy(); }
}
const EXCEPTIONS = { 1: 'illegal function', 2: 'illegal data address', 3: 'illegal data value', 4: 'device failure', 6: 'device busy', 10: 'gateway path unavailable', 11: 'gateway target did not respond' };

export function hostPort(endpoint) {
  const m = /^(?:modbus(?:\+tcp)?:\/\/|tcp:\/\/)?(\[[^\]]+\]|[^:/\s]+)(?::(\d{1,5}))?\/?$/i.exec(endpoint.trim());
  if (!m) throw new Error('A Modbus TCP endpoint is host or host:port, e.g. 192.168.10.21:502');
  const port = Number(m[2] ?? 502); if (port < 1 || port > 65535) throw new Error('The Modbus port must be 1 to 65535');
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

export function modbusDriver(cfg, { onLost } = {}) {
  const { host, port } = hostPort(cfg.endpoint), o = cfg.options ?? {};
  const entries = Object.entries(cfg.mapping).map(([key, m]) => ({ key, ...m }));
  if (o.state) entries.push({ key: '$state', ...o.state, type: o.state.type ?? 'uint16' });
  const requests = plan(entries);
  let client = null;
  return {
    mode: 'poll',
    async open() { client = new ModbusClient(host, port, { unitId: o.unitId ?? 1, timeoutMs: o.timeoutMs ?? 3000 }); await client.connect(onLost); },
    async read() {
      const values = {}, raw = {}, skipped = []; let state = null;
      for (const r of requests) {
        const fn = FUNCTIONS[r.function], data = await client.request(fn, r.start, r.end - r.start);
        for (const e of r.entries) {
          const i = e.address - r.start, v = fn <= 2 ? data[i] : decode(data.slice(i, i + TYPES[e.type]), e.type, e.wordOrder);
          raw[e.key] = v;
          if (e.key === '$state') { state = mapState(v, o.state.map); if (!state) skipped.push(`state: value ${v} is not mapped`); }
          else if (Number.isFinite(v)) values[e.key] = scaled(v, e); else skipped.push(`${e.key}: not a number`);
        }
      }
      return { values, state, raw, skipped };
    },
    async close() { client?.close(); client = null; },
  };
}
