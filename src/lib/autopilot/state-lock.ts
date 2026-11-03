// One write to the carrier's Pause autopilot switch at a time, held until the transaction ends:
// a Pause or Resume (./state.ts) and the demo reset's own pause (src/lib/seed/reset.ts) both take
// it before they read or write autopilot_state. Its own module, so the reset (and the demo:reset
// script) shares the key without importing the request-time role check.
const PAUSE_KEY = "hashtextextended('autopilot_state:' || CAST(current_tenant_id() AS text), 0)";

export const PAUSE_LOCK_SQL = `SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${PAUSE_KEY})) AS l`;

// The same key, shared: the approval gate (src/lib/proposals/execute.ts) takes it before it reads
// the pause, so gates run together, a gate waits for a pause write in progress, and a pause write
// waits for the gates already past it.
export const PAUSE_SHARED_LOCK_SQL = `SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock_shared(${PAUSE_KEY})) AS l`;
