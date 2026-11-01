// TMS-MIRROR (T3): the synthetic dispatch feed's fault switches. Each one makes the demo feed act
// like a messy real dispatch system in one way, so the sync can be seen coping with it. They live
// in tms_connections.demo_faults for one tenant, flipped from Settings > Demo while
// flags.tmsSync.demoFaultsEnabled is on, and only the demo feeds (synthetic.ts, and mock-faults.ts
// for the sample dispatch system) read them: the sync never knows a fault exists. All false by default. Pure; safe to import in the browser.
//
// duplicate_wakeups is not a switch here: it is the dispatch webhook's own repeat, shown by
// Settings > Demo's "Fire a wake-up twice" (POST /api/demo/tms-wakeup), which sends one wake-up
// twice and keeps one tms_wakeups row, so the next sync reads the load once.

import { formatCents } from "../../format/money";

export const DEMO_FAULTS = [
  "stale_list_rows",
  "hard_delete",
  "clock_skew",
  "local_date_shift",
  "server_errors",
  "history_page_cut",
  "relabeled_status",
  "custom_status",
  "edit_after_finalize",
] as const;
export type DemoFault = (typeof DEMO_FAULTS)[number];
export type DemoFaults = Readonly<Record<DemoFault, boolean>>;

// The feeds the switches apply to: the synthetic feed, every switch, and the sample dispatch
// system (mock-faults.ts), the switches in MOCK_FAULTS only. The other three change what the feed
// itself would record (a status, a time, a rate), which on the sample system a person does there.
export const DEMO_FEEDS = ["synthetic", "mock"] as const;
export type DemoFeed = (typeof DEMO_FEEDS)[number];

export function isDemoFeed(value: unknown): value is DemoFeed {
  return typeof value === "string" && (DEMO_FEEDS as readonly string[]).includes(value);
}

export const MOCK_FAULTS: readonly DemoFault[] = [
  "stale_list_rows",
  "hard_delete",
  "clock_skew",
  "server_errors",
  "history_page_cut",
  "relabeled_status",
];

// The switches one feed applies, in the panel's order.
export function faultsFor(feed: DemoFeed): readonly DemoFault[] {
  return feed === "mock" ? MOCK_FAULTS : DEMO_FAULTS;
}

export const NO_FAULTS: DemoFaults = Object.freeze(
  Object.fromEntries(DEMO_FAULTS.map((f) => [f, false])) as Record<DemoFault, boolean>,
);

export function isDemoFault(value: unknown): value is DemoFault {
  return typeof value === "string" && (DEMO_FAULTS as readonly string[]).includes(value);
}

// A stored value, read strictly: a fault is on only when its key holds exactly true. Anything
// else (a missing key, a string, an unknown key, a value that is not an object) reads off.
export function readDemoFaults(value: unknown): DemoFaults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_FAULTS;
  const v = value as Record<string, unknown>;
  return Object.fromEntries(DEMO_FAULTS.map((f) => [f, Object.hasOwn(v, f) && v[f] === true])) as Record<DemoFault, boolean>;
}

// A requested change: at least one fault, every key a known fault, every value a boolean.
// Anything else is null (the route refuses it whole).
export function parseFaultChange(value: unknown): Partial<Record<DemoFault, boolean>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  const out: Partial<Record<DemoFault, boolean>> = {};
  for (const [key, on] of entries) {
    if (!isDemoFault(key) || typeof on !== "boolean") return null;
    out[key] = on;
  }
  return out;
}

// edit_after_finalize: how much the revenue of the edited load goes up, in cents.
export const FAULT_EDIT_CENTS = 7_500;

// What each switch does, in plain words, for the Settings > Demo panel.
export const FAULT_WORDS: Readonly<Record<DemoFault, { title: string; detail: string }>> = {
  stale_list_rows: {
    title: "Stale list rows",
    detail: "The load list shows each load's status and update time from 30 minutes ago.",
  },
  hard_delete: {
    title: "A deleted load",
    detail: "The in-transit load with the lowest number is deleted and answers not found.",
  },
  clock_skew: {
    title: "Clocks two days apart",
    detail: "Each delivery's UTC time is two days off its local time.",
  },
  local_date_shift: {
    title: "Delivery day moved back",
    detail: "Ten minutes after a delivery, its local date moves back one day; the UTC time stays.",
  },
  server_errors: {
    title: "Server errors",
    detail: "Every third load read in a sync answers a server error.",
  },
  history_page_cut: {
    title: "Cut history pages",
    detail: "History comes two rows a page, each page repeating the last row of the one before.",
  },
  relabeled_status: {
    title: "Renamed status",
    detail: "In Transit is shown as Rolling, which the carrier's status map knows.",
  },
  custom_status: {
    title: "The carrier's own status",
    detail: "A load sits in Yard check for a while after pickup, a status no map knows.",
  },
  edit_after_finalize: {
    title: "Edit after finalize",
    detail: `An hour after the latest load is finalized, its revenue goes up ${formatCents(FAULT_EDIT_CENTS)}.`,
  },
};
