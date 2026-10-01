// One-off pull sync from the configured IoT adapter (default: mock). Safe to repeat: the cursor advances and ingest
// deduplicates on deviceId + observedAt. Usage: npm run iot:sync  (or IOT_SYNC_ADAPTER=<name> node api/iot-sync.js)
import { createAdapter } from './iot/adapters/index.js';
import { runSync } from './iot/sync.js';

const result=await runSync(createAdapter(process.env.IOT_SYNC_ADAPTER||'mock'));
console.log(`IoT sync ${result.status}: ${result.accepted} accepted, ${result.duplicates} duplicate, ${result.rejected} rejected; cursor ${result.cursor_after}${result.error?` - ${result.error}`:''}`);
if (result.status!=='succeeded') process.exitCode=1;
