import type { Session } from "../auth/claims";
import { ledgerRecordSql } from "../card-loads/facts";
import { countOpenBreaks, readLatestRun } from "../data/card-recon";
import type { Queryable, TenantDb } from "../db";
import { localMidnightOf } from "../desk/keys";
import { countApprovalBreaks } from "../invariants/approvals";
import { READ_ONLY_SQL, readOnly } from "../invariants/types";
import { readInvoiceList, readQueueView } from "../invoices/views";
import { statementVerdict } from "../recon/run";
import { assertMembership } from "../tenant/context";
import { addDays, assertLocalDate, dayOfWeek, type LocalDate } from "../time/local-date";

// What the morning digest says, read from SQL and nowhere else. Each group of facts is read in
// its own read-only tenant transaction, inside its own try: a read that throws, or a value that does
// not come back whole, makes that group's facts "not read", never 0. The model never decides a
// number here or which fact needs a person: this list does both.
//
// "Yesterday" is the carrier's local day before the period date, [its midnight, the period date's
// midnight) in the carrier's zone; a state fact (what waits now) is as of the read.

export const NOT_READ = "not read";

export type FactId =
  | "card_check"
  | "card_breaks"
  | "cancelled"
  | "hand_loads"
  | "hand_load_cents"
  | "rulings_waiting"
  | "parked"
  | "parked_reasons"
  | "advance_cards"
  | "advances_paid"
  | "advances_paid_cents"
  | "send"
  | "fix"
  | "add"
  | "past_due"
  | "past_due_cents"
  | "paystubs_paid"
  | "paystubs_net_cents"
  | "month_invoices"
  | "month_invoice_cents"
  | "month_not_posted"
  | "ledger_unknown"
  | "approval_breaks";

export type FactKind = "int" | "cents" | "text";

// One numbered fact as the model and the check read it ("[f3] Trips cancelled yesterday: 1").
// known false: the read failed, and the value is the words NOT_READ.
export type DigestFact = {
  key: string;
  id: FactId;
  label: string;
  kind: FactKind;
  value: number | string;
  known: boolean;
  needsPerson: boolean;
};

type Spec = { id: FactId; label: string; kind: FactKind; needsPerson: boolean };

// Every fact in its fixed order. The Friday and 1st-of-month facts are listed only on those days.
const SPECS: Record<FactId, Spec> = {
  card_check: { id: "card_check", label: "Card check result", kind: "text", needsPerson: false },
  card_breaks: { id: "card_breaks", label: "Card check differences waiting for a person", kind: "int", needsPerson: true },
  cancelled: { id: "cancelled", label: "Trips cancelled yesterday", kind: "int", needsPerson: false },
  hand_loads: { id: "hand_loads", label: "Card loads yesterday with no payment record (hand loads)", kind: "int", needsPerson: false },
  hand_load_cents: { id: "hand_load_cents", label: "Hand loads yesterday, total", kind: "cents", needsPerson: false },
  rulings_waiting: { id: "rulings_waiting", label: "Card load rulings waiting for a person", kind: "int", needsPerson: true },
  parked: { id: "parked", label: "Advances parked, waiting for a person", kind: "int", needsPerson: true },
  parked_reasons: { id: "parked_reasons", label: "Why advances are parked", kind: "text", needsPerson: false },
  advance_cards: { id: "advance_cards", label: "Advance cards waiting for a person", kind: "int", needsPerson: true },
  advances_paid: { id: "advances_paid", label: "Advances paid yesterday", kind: "int", needsPerson: false },
  advances_paid_cents: { id: "advances_paid_cents", label: "Advances paid yesterday, total", kind: "cents", needsPerson: false },
  send: { id: "send", label: "SEND: invoices posted and not yet sent", kind: "int", needsPerson: true },
  fix: { id: "fix", label: "FIX: delivered loads the invoice check refuses", kind: "int", needsPerson: true },
  add: { id: "add", label: "ADD: delivered loads ready to invoice", kind: "int", needsPerson: false },
  past_due: { id: "past_due", label: "FYI: invoices past due", kind: "int", needsPerson: false },
  past_due_cents: { id: "past_due_cents", label: "FYI: past due balance", kind: "cents", needsPerson: false },
  paystubs_paid: { id: "paystubs_paid", label: "Paystubs paid this past week", kind: "int", needsPerson: false },
  paystubs_net_cents: { id: "paystubs_net_cents", label: "Paystubs paid this past week, net total", kind: "cents", needsPerson: false },
  month_invoices: { id: "month_invoices", label: "Last month: invoices issued", kind: "int", needsPerson: false },
  month_invoice_cents: { id: "month_invoice_cents", label: "Last month: invoices issued, total", kind: "cents", needsPerson: false },
  month_not_posted: { id: "month_not_posted", label: "Last month: invoices not posted to QuickBooks sandbox", kind: "int", needsPerson: false },
  ledger_unknown: { id: "ledger_unknown", label: "Ledger rows whose outcome is still unknown", kind: "int", needsPerson: true },
  approval_breaks: { id: "approval_breaks", label: "Approval check breaks", kind: "int", needsPerson: true },
};

export const isFriday = (date: LocalDate): boolean => dayOfWeek(date) === 5;
export const isFirstOfMonth = (date: LocalDate): boolean => date.endsWith("-01");

// The facts listed for a period date, in order: the daily ones, then the Friday ones on a Friday,
// then the 1st-of-month ones on the 1st.
export function factIdsFor(date: LocalDate): FactId[] {
  const ids: FactId[] = [
    "card_check",
    "card_breaks",
    "cancelled",
    "hand_loads",
    "hand_load_cents",
    "rulings_waiting",
    "parked",
    "parked_reasons",
    "advance_cards",
    "advances_paid",
    "advances_paid_cents",
    "send",
    "fix",
    "add",
    "past_due",
    "past_due_cents",
  ];
  if (isFriday(date)) ids.push("paystubs_paid", "paystubs_net_cents");
  if (isFirstOfMonth(date)) {
    ids.push("month_invoices", "month_invoice_cents", "month_not_posted", "ledger_unknown", "approval_breaks");
  }
  return ids;
}

export type ReadValues = Partial<Record<FactId, unknown>>;

function wholeCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function wholeCents(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

// The numbered list from what was read: f1, f2, ... in order. A value that is missing or not the
// right shape (a count that is not a whole number at or above zero, cents that are not whole, an
// empty text) is "not read".
export function numberFacts(ids: readonly FactId[], values: ReadValues): DigestFact[] {
  return ids.map((id, i) => {
    const spec = SPECS[id];
    const v = values[id];
    const ok =
      spec.kind === "int" ? wholeCount(v) : spec.kind === "cents" ? wholeCents(v) : typeof v === "string" && v.length > 0 && v.length <= 80;
    const base = { key: `f${i + 1}`, id, label: spec.label, needsPerson: spec.needsPerson };
    return ok
      ? { ...base, kind: spec.kind, value: v as number | string, known: true }
      : { ...base, kind: "text" as const, value: NOT_READ, known: false };
  });
}

// How many facts that need a person are above zero: the desk line's found.
export function needsCount(facts: readonly DigestFact[]): number {
  return facts.filter((f) => f.needsPerson && f.known && typeof f.value === "number" && f.value > 0).length;
}

// A count read back from SQL as text or a number: whole, or the read is not whole.
function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new RangeError("not a whole number");
  return n;
}

const PARK_WORDS: Record<string, string> = {
  name_mismatch: "name mismatch",
  override: "override",
  no_room: "no room",
  card_removed: "card removed",
};

export type Window = { from: string; to: string; yesterday: LocalDate };

export function windowOf(date: LocalDate, zone: string): Window {
  const yesterday = addDays(assertLocalDate(date, "date"), -1);
  return { from: localMidnightOf(yesterday, zone), to: localMidnightOf(date, zone), yesterday };
}

// The first day of the month before the period date's month, and the period date's month's first day.
export function lastMonthOf(date: LocalDate): { from: LocalDate; to: LocalDate } {
  const to = `${assertLocalDate(date, "date").slice(0, 8)}01`;
  return { from: `${addDays(to, -1).slice(0, 8)}01`, to };
}

const COUNT_PROPOSED_SQL = `SELECT CAST(count(*) AS integer) AS n FROM proposals
  WHERE tenant_id = current_tenant_id() AND kind = $1 AND status = 'proposed'`;

type Ctx = { date: LocalDate; zone: string; window: Window };
type Group = { ids: FactId[]; read: (q: Queryable, ctx: Ctx) => Promise<ReadValues> };

const GROUPS: Group[] = [
  {
    ids: ["card_check"],
    async read(q) {
      const run = await readLatestRun(q);
      if (!run) return { card_check: "no check yet" };
      if (run.status === "running") return { card_check: "check running" };
      if (run.status === "failed") return { card_check: "last check failed" };
      const verdict = statementVerdict(run);
      if (!verdict) throw new RangeError("verdict not read");
      const words = { verified: "statement verified", hold: "statement on hold", empty: "no statement lines" } as const;
      return { card_check: words[verdict.kind] };
    },
  },
  {
    ids: ["card_breaks"],
    async read(q) {
      return { card_breaks: (await countOpenBreaks(q)).needsYou };
    },
  },
  {
    ids: ["cancelled"],
    async read(q, { window }) {
      const [row] = await q.query<{ n: unknown }>(
        `SELECT CAST(count(DISTINCT e.load_id) AS integer) AS n FROM load_events e
          WHERE e.tenant_id = current_tenant_id() AND e.to_status = 'cancelled'
            AND e.at >= CAST($1 AS timestamptz) AND e.at < CAST($2 AS timestamptz)`,
        [window.from, window.to],
      );
      return { cancelled: num(row?.n) };
    },
  },
  {
    ids: ["hand_loads", "hand_load_cents"],
    async read(q, { window }) {
      const [row] = await q.query<{ n: unknown; cents: unknown }>(
        `SELECT CAST(count(*) AS integer) AS n, CAST(COALESCE(sum(t.amount_cents), 0) AS text) AS cents
           FROM card_transactions t
          WHERE t.tenant_id = current_tenant_id() AND t.kind = 'load' AND t.posted_on = CAST($1 AS date)
            AND NOT ${ledgerRecordSql("t.provider_ref", "t.provider", "t.card_token")}`,
        [window.yesterday],
      );
      return { hand_loads: num(row?.n), hand_load_cents: num(row?.cents) };
    },
  },
  {
    ids: ["rulings_waiting"],
    async read(q) {
      const [row] = await q.query<{ n: unknown }>(COUNT_PROPOSED_SQL, ["card_load_ruling"]);
      return { rulings_waiting: num(row?.n) };
    },
  },
  {
    ids: ["parked", "parked_reasons"],
    async read(q) {
      const rows = await q.query<{ park_reason: unknown; n: unknown }>(
        `SELECT park_reason, CAST(count(*) AS integer) AS n FROM advances
          WHERE tenant_id = current_tenant_id() AND status = 'parked'
          GROUP BY park_reason ORDER BY park_reason`,
      );
      let total = 0;
      const reasons: string[] = [];
      for (const r of rows) {
        const words = typeof r.park_reason === "string" ? PARK_WORDS[r.park_reason] : undefined;
        if (!words) throw new RangeError("not a park reason");
        total += num(r.n);
        reasons.push(words);
      }
      return { parked: total, parked_reasons: reasons.length > 0 ? reasons.join(", ") : "none" };
    },
  },
  {
    ids: ["advance_cards"],
    async read(q) {
      const [row] = await q.query<{ n: unknown }>(COUNT_PROPOSED_SQL, ["advance_payout"]);
      return { advance_cards: num(row?.n) };
    },
  },
  {
    ids: ["advances_paid", "advances_paid_cents"],
    async read(q, { window }) {
      const [row] = await q.query<{ n: unknown; cents: unknown }>(
        `SELECT CAST(count(*) AS integer) AS n, CAST(COALESCE(sum(amount_cents), 0) AS text) AS cents FROM advances
          WHERE tenant_id = current_tenant_id() AND status = 'paid'
            AND paid_at >= CAST($1 AS timestamptz) AND paid_at < CAST($2 AS timestamptz)`,
        [window.from, window.to],
      );
      return { advances_paid: num(row?.n), advances_paid_cents: num(row?.cents) };
    },
  },
  {
    ids: ["send"],
    async read(q) {
      // Read here, not through readInvoiceList: its rows do not carry sent_on (0028).
      const [row] = await q.query<{ n: unknown }>(
        `SELECT CAST(count(*) AS integer) AS n FROM invoices
          WHERE tenant_id = current_tenant_id() AND status IN ('open', 'partially_paid')
            AND qbo_id IS NOT NULL AND sent_on IS NULL`,
      );
      return { send: num(row?.n) };
    },
  },
  {
    ids: ["fix", "add"],
    async read(q) {
      const queue = await readQueueView(q);
      return { fix: queue.exceptions.length, add: queue.invoiceable.length };
    },
  },
  {
    ids: ["past_due", "past_due_cents"],
    async read(q, { date }) {
      const late = (await readInvoiceList(q, date)).filter(
        (i) => i.balanceCents > 0 && i.bucket !== null && i.bucket !== "current",
      );
      let cents = 0;
      for (const i of late) {
        if (!Number.isSafeInteger(i.balanceCents)) throw new RangeError("balance not whole");
        cents += i.balanceCents;
      }
      return { past_due: late.length, past_due_cents: cents };
    },
  },
  {
    ids: ["paystubs_paid", "paystubs_net_cents"],
    async read(q, { date, zone, window }) {
      const [row] = await q.query<{ n: unknown; cents: unknown }>(
        `SELECT CAST(count(*) AS integer) AS n, CAST(COALESCE(sum(net_cents), 0) AS text) AS cents FROM settlements
          WHERE tenant_id = current_tenant_id() AND status = 'paid'
            AND paid_at >= CAST($1 AS timestamptz) AND paid_at < CAST($2 AS timestamptz)`,
        [localMidnightOf(addDays(date, -7), zone), window.to],
      );
      return { paystubs_paid: num(row?.n), paystubs_net_cents: num(row?.cents) };
    },
  },
  {
    ids: ["month_invoices", "month_invoice_cents", "month_not_posted"],
    async read(q, { date }) {
      const month = lastMonthOf(date);
      const [row] = await q.query<{ n: unknown; cents: unknown; unposted: unknown }>(
        `SELECT CAST(count(*) AS integer) AS n, CAST(COALESCE(sum(amount_cents), 0) AS text) AS cents,
                CAST(count(*) FILTER (WHERE qbo_id IS NULL) AS integer) AS unposted
           FROM invoices
          WHERE tenant_id = current_tenant_id() AND status <> 'void'
            AND issued_on >= CAST($1 AS date) AND issued_on < CAST($2 AS date)`,
        [month.from, month.to],
      );
      return { month_invoices: num(row?.n), month_invoice_cents: num(row?.cents), month_not_posted: num(row?.unposted) };
    },
  },
  {
    ids: ["ledger_unknown"],
    async read(q) {
      const [row] = await q.query<{ n: unknown }>(
        `SELECT CAST(count(*) AS integer) AS n FROM money_actions
          WHERE tenant_id = current_tenant_id() AND state = 'unknown'`,
      );
      return { ledger_unknown: num(row?.n) };
    },
  },
  {
    ids: ["approval_breaks"],
    async read(q) {
      return { approval_breaks: await countApprovalBreaks(readOnly(q)) };
    },
  },
];

export type FactsDeps = { log?: (line: string) => void };

// Every listed fact for the period date, each group in its own read-only transaction. A group
// that throws is "not read" (its error's name goes to the log, never its text).
export async function readDigestFacts(
  db: TenantDb,
  session: Session,
  date: LocalDate,
  zone: string,
  deps: FactsDeps = {},
): Promise<DigestFact[]> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const ids = factIdsFor(date);
  const window = windowOf(date, zone);
  const values: ReadValues = {};
  for (const group of GROUPS) {
    if (!group.ids.some((id) => ids.includes(id))) continue;
    try {
      const read = await db.withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        await q.execute(READ_ONLY_SQL);
        return group.read(q, { date, zone, window });
      });
      for (const id of group.ids) values[id] = read[id];
    } catch (err) {
      log(`digest: ${group.ids[0]} not read (${err instanceof Error ? err.name : "unknown"})`);
    }
  }
  return numberFacts(ids, values);
}
