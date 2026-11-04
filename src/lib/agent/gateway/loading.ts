// The operator tools sent in full on every model call when tool search is on: the lookups almost
// every question starts with. Every other tool the registry offers the operator, the propose
// tools included, is sent as a name and a description only, and the model searches to load its
// schema before calling it. A tool is deferred unless this list names it, so a tool added later
// is deferred without a change here. Whole names only. Imports nothing.
export const ALWAYS_LOADED: readonly string[] = Object.freeze([
  // A question that names a driver starts here: every other lookup takes the driver's id.
  "find_driver",
  "get_driver",
  "get_loads",
  "get_pay_items",
  "get_advances",
  "explain_paystub",
  "run_checks",
  // This week's pay questions read the week's paystubs beside the pay check in their first step;
  // deferred, the first response searched for it and sent only the checklist (Nov 4).
  "get_settlements",
  // Unbilled detention is found and proposed in one answer: deferred, the finder's search took
  // the first response and the propose tool was never loaded before the clock ran out (Nov 4).
  // A switch that keeps them off still leaves both out of the request.
  "find_unbilled_detention",
  "propose_detention_charge",
  // The answer's checklist is set in the first step, before any search could load it.
  "set_checklist",
]);
