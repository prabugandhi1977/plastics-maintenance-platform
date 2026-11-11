// Euromap 63-style file interface. The real standard exchanges text files and commands between a host and the
// machine controller; this emulation keeps the part that matters for the gateway: each machine publishes a small
// KEY=VALUE text file with its actual values, which the host polls. It is NOT a full Euromap 63 implementation
// (no serial/command channel, no job upload); check your controller's real interface before relying on field names.
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIELDS, flatten, unflatten } from './codec.js';

export class Euromap63Writer {
  constructor(dir, plant) { this.dir = dir; this.plant = plant; this.n = 0; }
  write() {
    for (const m of this.plant.machines.values()) {
      if (m.cfg.protocol !== 'euromap63') continue;
      const d = join(this.dir, m.cfg.tag); mkdirSync(d, { recursive: true });
      const f = flatten(m.snapshot()), lines = ['; Euromap 63-style ACTUAL VALUES (virtual plant)', `MACHINE=${m.cfg.make} ${m.cfg.model}`, ...FIELDS.map(([k]) => `${k.toUpperCase()}=${f[k]}`)];
      const file = join(d, 'ACTUAL.TXT'), text = lines.join('\r\n') + '\r\n';
      // Write-then-rename keeps readers from seeing half a file; on Windows the rename fails while a reader or sync tool holds the file, so fall back to a direct write.
      try { writeFileSync(file + '.tmp', text); renameSync(file + '.tmp', file); } catch { try { writeFileSync(file, text); } catch { continue; } }
      this.n++;
    }
  }
}
export function readEuromap63(dir, tag, deviceId) {
  const file = join(dir, tag, 'ACTUAL.TXT'); if (!existsSync(file)) return null;
  let text; try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const f = {}; for (const line of text.split(/\r?\n/)) { if (!line || line.startsWith(';')) continue; const i = line.indexOf('='); if (i > 0) f[line.slice(0, i)] = line.slice(i + 1); }
  const low = {}; for (const [k] of FIELDS) low[k] = f[k.toUpperCase()];
  if (low.at == null) return null; // half-written or foreign file
  return unflatten(deviceId, low);
}
