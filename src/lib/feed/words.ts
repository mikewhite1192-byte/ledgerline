import { codeToWords } from "../format/labels";
import { formatCents } from "../format/money";
import { formatInstant, isRealInstant } from "../format/dates";
import { hrefOrNull, recordHref } from "../records/href";
import type { FeedActor, FeedRow } from "./read";

// The live feed's words: one plain sentence per row, from its code words, cents, counts and the
// proposal's title only. Who did it reads as a role word; a login id or an email never reaches a
// line, and neither does a note, an outside id or error text (the row does not carry them).

export const ACTOR_LABELS: Readonly<Record<FeedActor, string>> = {
  admin: "Admin",
  staff: "Staff",
  judge: "Demo visitor",
  autopilot: "Autopilot",
  agent: "Agent",
  desk: "Desk",
  someone: "Someone",
};

export type FeedLine = {
  key: string;
  at: string;
  // The instant in the carrier's time zone.
  time: string;
  actor: string;
  words: string;
  // A short note beside the words: where the money went, or the autopilot's ruling on a draft.
  tag: string | null;
  // The record's page, when it has one.
  href: string | null;
};

// What the desk picked up, by its source, with its article.
const DESK_SOURCE_WORDS: Readonly<Record<string, string>> = {
  card_transaction: "card transaction",
  inbound_message: "message",
  voice_note: "voice note",
  customer_payment: "customer payment",
  audit: "audit",
  sweep: "pay sweep",
  collections: "collections check",
  cash_check: "cash check",
  autopilot: "autopilot step",
  document: "document",
  load_event: "load update",
  tms_event: "dispatch update",
  digest: "morning digest",
};

const withArticle = (words: string) => `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;

function deskThing(source: string | null): string {
  if (source === null) return "a step";
  return withArticle(Object.hasOwn(DESK_SOURCE_WORDS, source) ? DESK_SOURCE_WORDS[source] : codeToWords(source).toLowerCase());
}

// The autopilot rulings that hold a step (nothing decided, nothing written) rather than skip it.
const HELD = new Set(["switched_off", "unarmed", "paused", "not_waiting", "kind_unarmed", "before_start", "no_rule"]);

// Why the autopilot asked a person, in the owner's words.
const REASON_WORDS: Readonly<Record<string, string>> = {
  kind_never_alone: "a person always approves this kind",
  kind_not_allowed: "not allowed for this kind",
  bad_limit: "its limit does not read",
  no_rule: "no rule set",
  mode_off: "the rule is Off",
  mode_ask: "the rule is Ask me",
  before_start: "before its start date",
  flagged: "flagged",
  not_audited: "not audited yet",
  audit_not_pass: "the audit did not pass",
  engine_unverified: "the pay math did not check out",
  bad_amount: "the amount does not read",
  no_driver: "no driver named",
  unknown_today: "today's total does not read",
  over_item_limit: "over its limit each time",
  over_driver_day_cents: "over the driver's day limit",
  over_day_cents: "over its day limit",
  over_day_count: "over its count for the day",
};

const words = (code: string) => codeToWords(code).toLowerCase();
const reasonWords = (code: string | null) =>
  code === null ? null : Object.hasOwn(REASON_WORDS, code) ? REASON_WORDS[code] : words(code);

const MODE_WORDS: Readonly<Record<string, string>> = { off: "Off", ask: "Ask me", auto: "Auto" };

const AUDIT_WORDS: Readonly<Record<string, string>> = {
  pass: "Audit passed",
  concerns: "Audit raised concerns",
  block: "Audit blocked",
  unknown: "Audit could not finish",
};

// Where a money action went, as a tag.
const SYSTEM_WORDS: Readonly<Record<string, string>> = {
  mock: "Mock",
  stripe_test: "Test mode",
  fuel_card_sim: "Test mode",
  factoring_sim: "Test mode",
  qbo_sandbox: "QuickBooks sandbox",
};

// A payout by the rail that carried it; every other kind in its own words.
const PAYOUT_KINDS = new Set(["advance_payout", "settlement_payout"]);
const PAYOUT_WORDS: Readonly<Record<string, string>> = {
  fuel_card_sim: "Fuel card load",
  stripe_test: "Bank transfer",
  mock: "Payout",
};
const MONEY_WORDS: Readonly<Record<string, string>> = {
  advance_payout: "Payout",
  settlement_payout: "Payout",
  advance_expense: "Advance expense",
  settlement_bill: "Settlement bill",
  settlement_bill_payment: "Settlement bill payment",
  invoice: "Invoice",
  customer_payment: "Customer payment",
  factoring_advance: "Factoring advance",
  money_code_issue: "Money code",
  escrow_release: "Escrow release",
  card_pullback: "Card pull-back",
};

function moneyThing(kind: string | null, system: string | null): string {
  if (kind === null) return "Money step";
  if (PAYOUT_KINDS.has(kind) && system !== null && Object.hasOwn(PAYOUT_WORDS, system)) return PAYOUT_WORDS[system];
  return Object.hasOwn(MONEY_WORDS, kind) ? MONEY_WORDS[kind] : codeToWords(kind);
}

const systemTag = (system: string | null) =>
  system === null ? null : Object.hasOwn(SYSTEM_WORDS, system) ? SYSTEM_WORDS[system] : codeToWords(system);

const amount = (cents: number | null) => (cents === null ? null : formatCents(cents));
const withAmount = (text: string, cents: number | null) => (cents === null || cents === 0 ? text : `${text}, ${formatCents(cents)}`);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function batchItems(scope: string | null, n: number | null): string {
  const count = n ?? 0;
  if (scope === "settlements") return plural(count, "paystub", "paystubs");
  if (scope === "proposals") return plural(count, "card", "cards");
  return plural(count, "item", "items");
}

function proposalWords(r: FeedRow, actor: string): { words: string; tag: string | null } | null {
  const title = r.title ?? "a proposal";
  const moving = r.direction === "out" || r.direction === "in";
  switch (r.event) {
    case "proposal_proposed": {
      const sum = moving && r.cents !== null && r.cents > 0 ? `, ${formatCents(r.cents)} ${r.direction}` : "";
      const tag =
        r.code === "ask"
          ? `Autopilot: asks a person${reasonWords(r.reason) ? ` (${reasonWords(r.reason)})` : ""}`
          : r.code === "off"
            ? "Autopilot: off for this kind"
            : null;
      return { words: `Agent proposed ${title}${sum}`, tag };
    }
    case "proposal_audited":
      return { words: `${r.code !== null && Object.hasOwn(AUDIT_WORDS, r.code) ? AUDIT_WORDS[r.code] : "Audited"}: ${title}`, tag: null };
    case "proposal_decided": {
      if (r.code === "rejected") return { words: `${actor} rejected ${title}`, tag: null };
      const cents = moving ? r.cents : null;
      if (r.actor === "autopilot" && r.limitCents !== null) {
        return { words: `${withAmount(`Autopilot approved ${title}`, cents)}, within its limit of ${formatCents(r.limitCents)}`, tag: null };
      }
      return { words: withAmount(`${actor} approved ${title}`, cents), tag: null };
    }
    default:
      return null;
  }
}

function moneyWords(r: FeedRow): string | null {
  const thing = moneyThing(r.kind, r.system);
  const sum = amount(r.cents);
  const what = sum === null ? thing : `${thing}, ${sum}`;
  const accounting = r.channel === "accounting";
  if (r.event === "money_sent") {
    if (r.code === "unknown") return `Not confirmed yet: ${what}; the desk will read it back`;
    if (accounting) return withAmount(`${thing} posted to the QuickBooks sandbox`, r.cents);
    return withAmount(`${thing} sent`, r.cents);
  }
  if (r.event === "money_settled") {
    if (r.code === "failed") return `Failed: ${what}${r.reason ? ` (${words(r.reason)})` : ""}`;
    if (r.once) return accounting ? `Posted and confirmed in the QuickBooks sandbox: ${what}` : `Paid and confirmed: ${what}`;
    return `Confirmed: ${what}`;
  }
  return null;
}

function deskWords(r: FeedRow): string | null {
  const thing = deskThing(r.kind);
  const cat = r.code === null ? "" : `: ${words(r.code)}`;
  switch (r.event) {
    case "desk_claimed":
      return `Desk picked up ${thing}`;
    case "desk_done":
      return `Desk finished ${thing}${cat}`;
    case "desk_failed":
      return `Desk could not finish ${thing}${cat}`;
    case "desk_skipped":
      return r.kind === "autopilot" && r.code !== null && HELD.has(r.code)
        ? `Autopilot held ${thing}${cat}`
        : `Desk skipped ${thing}${cat}`;
    case "desk_sleep":
      return r.count === null || r.count === 0 ? null : `Desk checked in: ${plural(r.count, "thing", "things")} done`;
    default:
      return null;
  }
}

function changeWords(r: FeedRow, actor: string, timeZone: string): string | null {
  switch (r.event) {
    case "autopilot_pause":
      return `${actor} paused the autopilot${r.until !== null && isRealInstant(r.until) ? ` until ${formatInstant(r.until, timeZone)}` : ""}`;
    case "autopilot_resume":
      return `${actor} resumed the autopilot`;
    case "autopilot_rule": {
      const kind = r.kind === null ? "a rule" : codeToWords(r.kind);
      const mode = r.code !== null && Object.hasOwn(MODE_WORDS, r.code) ? MODE_WORDS[r.code] : "a new setting";
      const each = r.limitCents !== null ? `, up to ${formatCents(r.limitCents)} each` : "";
      const day = r.dayLimitCents !== null ? `, ${formatCents(r.dayLimitCents)} a day` : "";
      return `${actor} set ${kind} to ${mode}${r.code === "off" ? "" : `${each}${day}`}`;
    }
    case "batch_started":
      return withAmount(`${actor} approved ${batchItems(r.kind, r.count)}`, r.cents);
    case "batch_finished": {
      const how =
        r.code === "done" ? "done" : r.code === "partial" ? "partly done" : r.code === "refused" ? "refused" : r.code ? words(r.code) : "finished";
      return `Batch of ${batchItems(r.kind, r.count)} ${how}`;
    }
    default:
      return null;
  }
}

// One row as one line, or null for a row that says nothing (a desk wake that finished nothing).
export function feedLine(r: FeedRow, timeZone: string): FeedLine | null {
  const actor = ACTOR_LABELS[r.actor];
  let text: string | null;
  let tag: string | null = null;
  if (r.event.startsWith("proposal_")) {
    const p = proposalWords(r, actor);
    text = p?.words ?? null;
    tag = p?.tag ?? null;
  } else if (r.event.startsWith("money_")) {
    text = moneyWords(r);
    tag = systemTag(r.system);
  } else if (r.event.startsWith("desk_")) {
    text = deskWords(r);
  } else {
    text = changeWords(r, actor, timeZone);
  }
  if (text === null) return null;
  return {
    key: r.key,
    at: r.at,
    time: formatInstant(r.at, timeZone),
    actor,
    words: text,
    tag,
    href: r.record === null ? null : hrefOrNull(recordHref, r.record),
  };
}

export function feedLines(rows: readonly FeedRow[], timeZone: string): FeedLine[] {
  return rows.map((r) => feedLine(r, timeZone)).filter((l): l is FeedLine => l !== null);
}
