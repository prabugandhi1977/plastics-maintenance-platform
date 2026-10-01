/**
 * IoT source adapter interface. An adapter pulls records from one external system and maps them to the canonical
 * shape in ../contract.js. Credentials and endpoints come only from server-side environment variables; nothing here
 * is ever sent to web or mobile clients.
 *
 * @typedef {object} IotAdapter
 * @property {string} name  Stable identifier, stored with cursors, run history, and each reading's `source`.
 * @property {(cursor: string|null) => Promise<{records: object[], nextCursor: string|null, hasMore: boolean}>} fetchBatch
 *   Vendor records after `cursor` (null on first run). The runner persists `nextCursor` in the same transaction as the
 *   ingested batch, so delivery is at-least-once and ingest deduplicates on deviceId + observedAt.
 * @property {(raw: object) => object} toCanonical  Map one vendor record to the canonical record. May throw; the
 *   runner quarantines that record with the error instead of failing the batch.
 *
 * To connect the real machine-data API, add `http.js` exporting a factory `(env) => IotAdapter`, register it below,
 * and set IOT_SYNC_ADAPTER. Rate limiting, retries/backoff, and auth refresh belong inside that adapter.
 */
import { createMockAdapter } from './mock.js';

const factories={mock:createMockAdapter};
export const adapterNames=()=>Object.keys(factories);
export function createAdapter(name,env=process.env) {
  const make=factories[name];
  if (!make) throw new Error(`Unknown IoT adapter "${name}". Available: ${adapterNames().join(', ')}`);
  return make(env);
}
