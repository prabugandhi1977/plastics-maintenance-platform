// Procedures service: step-by-step work procedures for work orders (versioned, with safety callouts, specifications, parts,
// measurements and photos), the record of each run, and analytics on how the steps go. tickets.js attaches and gates on them.
export * as procedures from './routes/procedures.js';
export { attach, autoAttach, openMandatory, runsOf } from './procedures.js';
