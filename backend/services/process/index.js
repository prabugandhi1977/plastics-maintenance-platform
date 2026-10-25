// Process service: the mould process fingerprint (what a good run looks like, drift against it) and AI process-setting
// advice. Builds on traceability (process readings, deviations, gates), production counts, the ML helpers and alerts.
export * as processFingerprint from './routes/fingerprint.js';
export { scanFingerprints } from './fingerprint.js';
