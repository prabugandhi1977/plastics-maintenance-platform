// Store-and-forward uplink to the platform. Items are queued in order and sent in batches; network errors, 5xx and
// 429 keep the items and retry with back-off (the platform de-duplicates, so retries are safe); a 400 for a whole
// batch drops it and is counted; per-record rejections are counted by reason. An optional spool file keeps the queue
// across restarts. Chaos (see chaos.js) can sit in front to damage the stream on purpose.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

const ROUTES = { factory: { path: '/api/integrations/factory/events', field: 'events', max: 1000 }, iot: { path: '/api/integrations/iot/records', field: 'records', max: 500 } };

export class Sender {
  constructor({ baseUrl, key, fetchImpl = globalThis.fetch, chaos = null, spoolFile = null, log = () => {}, batchSize = 500 }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.key = key; this.fetch = fetchImpl; this.chaos = chaos; this.spoolFile = spoolFile; this.log = log; this.batchSize = batchSize;
    this.queues = { factory: [], iot: [] }; this.backoffMs = 0; this.nextTry = 0; this.paused = false; this.timer = null; this.busy = false;
    this.stats = { queued: 0, sent: 0, accepted: 0, duplicates: 0, unchanged: 0, rejected: 0, retries: 0, droppedBatches: 0, lastError: null, rejectReasons: {} };
    if (spoolFile && existsSync(spoolFile)) { try { const s = JSON.parse(readFileSync(spoolFile, 'utf8')); this.queues = { factory: s.factory ?? [], iot: s.iot ?? [] }; this.log(`spool: restored ${this.depth()} queued items`); } catch (e) { this.log(`spool unreadable: ${e.message}`); } }
  }
  depth() { return this.queues.factory.length + this.queues.iot.length; }
  push(route, item) { for (const it of this.chaos ? this.chaos.apply(route, item) : [item]) { this.queues[route].push(it); this.stats.queued++; } }
  setPaused(p) { this.paused = p; }
  start(everyMs = 1000) { this.timer = setInterval(() => this.flush().catch(e => this.log(`flush: ${e.message}`)), everyMs); return this; }
  async stop() { clearInterval(this.timer); await this.flush().catch(() => {}); this.spool(); }
  spool() { if (!this.spoolFile) return; writeFileSync(this.spoolFile + '.tmp', JSON.stringify(this.queues)); renameSync(this.spoolFile + '.tmp', this.spoolFile); }

  async flush() {
    if (this.busy || this.paused || Date.now() < this.nextTry) return; this.busy = true;
    try {
      if (this.chaos) this.chaos.release(this.queues);
      for (const route of Object.keys(ROUTES)) {
        const cfg = ROUTES[route], q = this.queues[route];
        while (q.length) {
          const batch = q.slice(0, Math.min(cfg.max, this.batchSize));
          let res;
          try { res = await this.fetch(this.baseUrl + cfg.path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-integration-key': this.key }, body: JSON.stringify({ [cfg.field]: batch }) }); }
          catch (e) { return this.fail(`network: ${e.cause?.code ?? e.message}`); }
          if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) return this.fail(`HTTP ${res.status}`);
          q.splice(0, batch.length);
          if (res.status === 400) { this.stats.droppedBatches++; this.stats.lastError = `HTTP 400 (${batch.length} ${route} items dropped)`; this.log(this.stats.lastError); continue; }
          const data = await res.json().catch(() => ({})); this.stats.sent += batch.length; this.backoffMs = 0;
          this.stats.accepted += data.accepted ?? 0; this.stats.duplicates += data.duplicates ?? 0; this.stats.unchanged += data.unchanged ?? 0; this.stats.rejected += data.rejected ?? 0;
          for (const r of data.results ?? []) if (r.status === 'rejected') { const why = (r.error ?? (r.errors ?? []).join('; ')).slice(0, 120) || 'rejected'; this.stats.rejectReasons[why] = (this.stats.rejectReasons[why] ?? 0) + 1; }
        }
      }
      this.spool();
    } finally { this.busy = false; }
  }
  fail(reason) { this.stats.retries++; this.stats.lastError = reason; this.backoffMs = Math.min(30000, this.backoffMs ? this.backoffMs * 2 : 500); this.nextTry = Date.now() + this.backoffMs; this.log(`uplink ${reason}; ${this.depth()} queued, retry in ${this.backoffMs} ms`); this.spool(); }
}
