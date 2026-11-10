// Training service: competencies a technician needs for a machine type, and the completions (from a learning management
// system or recorded by hand) that show they hold them. candidatesFor in tickets.js uses them when assigning work.
export * as competencies from './routes/competencies.js';
export { gapsFor } from './competency.js';
