// The operator tools sent in full on every model call when tool search is on: the lookups almost
// every question starts with. Every other tool the registry offers the operator, the propose
// tools included, is sent as a name and a description only, and the model searches to load its
// schema before calling it. A tool is deferred unless this list names it, so a tool added later
// is deferred without a change here. Whole names only. Imports nothing.
export const ALWAYS_LOADED: readonly string[] = Object.freeze([
  "get_driver",
  "get_loads",
  "get_pay_items",
  "get_advances",
  "explain_paystub",
  "run_checks",
]);
