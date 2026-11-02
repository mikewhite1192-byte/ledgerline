// One write to the carrier's Pause autopilot switch at a time, held until the transaction ends:
// a Pause or Resume (./state.ts) and the demo reset's own pause (src/lib/seed/reset.ts) both take
// it before they read or write autopilot_state. Its own module, so the reset (and the demo:reset
// script) shares the key without importing the request-time role check.
export const PAUSE_LOCK_SQL =
  "SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended('autopilot_state:' || CAST(current_tenant_id() AS text), 0))) AS l";
