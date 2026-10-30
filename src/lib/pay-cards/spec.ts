import type { DriverRow, SettlementLineRow, SettlementPeriodRow, SettlementRow } from "../data/rows";
import { KNOWN_LINE_KINDS } from "../format/labels";
import { assertSafeCents, formatCents } from "../format/money";
import { artFor, type PayCardArt } from "./art";
import { CARD_WORDS, type CardLanguage } from "./words";

// What one pay card prints, worked out in code from the settlement's stored rows. The rules engine
// already computed every figure; this only picks them up and words them. The browser draws exactly
// these strings, and the server works the spec out again from the database when it checks a card,
// so a client can never change what "correct" means. Integer cents in, strings out.

export type CardText = {
  carrier: string;
  title: string;
  name: string;
  week: string;
  netLabel: string;
  net: string;
  earned: string;
  takenOut: string;
  work: string;
  change: string;
  topChange: string | null;
  carried: string | null;
  status: string;
  testMode: string;
};

export type CardSpec = {
  version: 1;
  settlementId: string;
  language: CardLanguage;
  art: PayCardArt;
  firstName: string;
  weekText: string;
  netCents: number;
  grossCents: number;
  deductionsCents: number;
  loads: number;
  // Null unless every load pay line carries its miles.
  miles: number | null;
  // Null on the driver's first settled week.
  changeCents: number | null;
  topChange: { kind: string; deltaCents: number } | null;
  carriedCents: number;
  status: "approved" | "paid";
  // Every amount the card prints, as printed (no sign), each once, smallest first.
  amountsCents: number[];
  text: CardText;
};

type Line = Pick<SettlementLineRow, "kind" | "amount_cents" | "sources" | "meta">;

export type CardSourceInput = {
  carrierName: string;
  settlement: Pick<
    SettlementRow,
    "id" | "status" | "gross_cents" | "deductions_cents" | "net_cents" | "carry_forward_cents"
  >;
  period: Pick<SettlementPeriodRow, "period_start" | "period_end">;
  driver: Pick<DriverRow, "id" | "first_name" | "preferred_language">;
  lines: Line[];
  // The same driver's latest settled week before this one, or null when there is none.
  previousNetCents: number | null;
  previousLines: Pick<SettlementLineRow, "kind" | "amount_cents">[] | null;
};

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// Distinct loads on the load pay lines, and their miles when every load pay line carries both
// loaded and empty miles.
function work(lines: Line[]): { loads: number; miles: number | null } {
  const loads = new Set<string>();
  let miles = 0;
  let allMiles = true;
  let payLines = 0;
  for (const l of lines) {
    if (l.kind !== "load_pay") continue;
    payLines += 1;
    for (const src of l.sources ?? []) if (src.table === "loads") loads.add(src.id);
    const loaded = l.meta?.loadedMiles;
    const empty = l.meta?.emptyMiles;
    if (isCount(loaded) && isCount(empty)) miles += loaded + empty;
    else allMiles = false;
  }
  return { loads: loads.size, miles: payLines > 0 && allMiles && Number.isSafeInteger(miles) ? miles : null };
}

// The order ties are broken in: the paystub's own kind order, then any other kind by name.
function kindRank(kind: string): [number, string] {
  const i = KNOWN_LINE_KINDS.indexOf(kind);
  return [i === -1 ? KNOWN_LINE_KINDS.length : i, kind];
}

function sumsByKind(lines: Pick<SettlementLineRow, "kind" | "amount_cents">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    assertSafeCents(l.amount_cents);
    out.set(l.kind, (out.get(l.kind) ?? 0) + l.amount_cents);
  }
  return out;
}

// The line kind whose size changed most from last week. Each kind's size is its summed amount
// without the sign, so a fuel charge that grew reads "up" like pay that grew. Ties go to the
// kind listed first; no change at all is null.
export function topChange(
  lines: Pick<SettlementLineRow, "kind" | "amount_cents">[],
  previous: Pick<SettlementLineRow, "kind" | "amount_cents">[] | null,
): { kind: string; deltaCents: number } | null {
  if (previous === null) return null;
  const now = sumsByKind(lines);
  const before = sumsByKind(previous);
  const kinds = [...new Set([...now.keys(), ...before.keys()])].sort((a, b) => {
    const [ra, na] = kindRank(a);
    const [rb, nb] = kindRank(b);
    return ra !== rb ? ra - rb : na < nb ? -1 : na > nb ? 1 : 0;
  });
  let best: { kind: string; deltaCents: number } | null = null;
  for (const kind of kinds) {
    const delta = Math.abs(now.get(kind) ?? 0) - Math.abs(before.get(kind) ?? 0);
    if (delta !== 0 && (best === null || Math.abs(delta) > Math.abs(best.deltaCents))) {
      best = { kind, deltaCents: delta };
    }
  }
  return best;
}

// The first name the card prints: the stored first name, trimmed, with runs of spaces closed.
function firstNameOf(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

// Null when the settlement is not approved or paid: only an approved paystub gets a card.
export function cardSpec(input: CardSourceInput): CardSpec | null {
  const s = input.settlement;
  if (s.status !== "approved" && s.status !== "paid") return null;
  for (const c of [s.gross_cents, s.deductions_cents, s.net_cents, s.carry_forward_cents]) assertSafeCents(c);
  if (input.previousNetCents !== null) assertSafeCents(input.previousNetCents);

  const language: CardLanguage = input.driver.preferred_language === "es" ? "es" : "en";
  const w = CARD_WORDS[language];
  const { loads, miles } = work(input.lines);
  const changeCents = input.previousNetCents === null ? null : s.net_cents - input.previousNetCents;
  const top = topChange(input.lines, input.previousLines);
  const carriedCents = s.carry_forward_cents;
  const firstName = firstNameOf(input.driver.first_name);
  const weekText = w.week(input.period.period_start, input.period.period_end);

  const amounts = new Set<number>([Math.abs(s.net_cents), Math.abs(s.gross_cents), Math.abs(s.deductions_cents)]);
  if (changeCents !== null && changeCents !== 0) amounts.add(Math.abs(changeCents));
  if (top) amounts.add(Math.abs(top.deltaCents));
  if (carriedCents !== 0) amounts.add(Math.abs(carriedCents));

  const change =
    changeCents === null
      ? w.firstWeek
      : changeCents > 0
        ? w.up(changeCents)
        : changeCents < 0
          ? w.down(-changeCents)
          : w.same;

  return {
    version: 1,
    settlementId: s.id,
    language,
    art: artFor(input.driver.id),
    firstName,
    weekText,
    netCents: s.net_cents,
    grossCents: s.gross_cents,
    deductionsCents: s.deductions_cents,
    loads,
    miles,
    changeCents,
    topChange: top,
    carriedCents,
    status: s.status,
    amountsCents: [...amounts].sort((a, b) => a - b),
    text: {
      carrier: input.carrierName.trim().replace(/\s+/g, " "),
      title: w.title,
      name: firstName,
      week: weekText,
      netLabel: w.netLabel,
      net: formatCents(s.net_cents),
      earned: w.earned(s.gross_cents),
      takenOut: w.takenOut(s.deductions_cents),
      work: miles === null ? w.loads(loads) : `${w.loads(loads)} · ${w.miles(miles)}`,
      change,
      topChange: top ? w.topChange(w.kind(top.kind), top.deltaCents) : null,
      carried: carriedCents !== 0 ? w.carried(Math.abs(carriedCents)) : null,
      status: s.status === "paid" ? w.paid : w.approved,
      // Every payout in this app goes through the test-mode adapters only (production keys are
      // refused at startup), so every card says so.
      testMode: w.testMode,
    },
  };
}

// Two specs are the same card when every field matches. A stored spec comes back from jsonb with
// its keys in another order, so both sides are compared in one canonical form.
export function sameSpec(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
