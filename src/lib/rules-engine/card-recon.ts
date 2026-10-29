import { createHash } from "node:crypto";
import type { ReadBack } from "../adapters/types";
import type { MoneyActionKind, MoneyActionState, OutsideSystem } from "../money/types";
import { addDays, isWithin, localDateOf, type LocalDate, type Period } from "../time/local-date";
import { compareText } from "./types";

// The card check, pure: the card provider's statement against our fuel purchases, card loads and
// cards on file, and each payment record against what its own system reads back. Whole values
// only: a reference, a card token and an amount in cents are equal or they are not; a one-cent
// difference is a difference. No model, no clock, no database: the caller passes every fact.

export const BREAK_CATEGORIES = [
  "fuel_amount_differs",
  "purchase_not_recorded",
  "card_unknown",
  "load_not_in_ledger",
  "load_amount_differs",
  "missing_outside",
  "reversed_outside",
  "amount_differs_outside",
  "pending_outside",
  "not_confirmed",
] as const;
export type BreakCategory = (typeof BREAK_CATEGORIES)[number];

export type Severity = "high" | "medium" | "low";
export type FixKind = "card_match" | "check_pending" | "retry" | "by_hand" | "none";

export const SEVERITY_OF: Readonly<Record<BreakCategory, Severity>> = {
  fuel_amount_differs: "medium",
  purchase_not_recorded: "medium",
  card_unknown: "high",
  load_not_in_ledger: "high",
  load_amount_differs: "high",
  missing_outside: "high",
  reversed_outside: "high",
  amount_differs_outside: "high",
  pending_outside: "low",
  not_confirmed: "medium",
};

// The fix each category gets from code. An unknown card becomes a match card only when a pick was
// made (src/lib/recon/match.ts); until then a person picks the driver by hand.
export const FIX_OF: Readonly<Record<BreakCategory, FixKind>> = {
  fuel_amount_differs: "by_hand",
  purchase_not_recorded: "by_hand",
  card_unknown: "by_hand",
  load_not_in_ledger: "by_hand",
  load_amount_differs: "by_hand",
  missing_outside: "by_hand",
  reversed_outside: "by_hand",
  amount_differs_outside: "by_hand",
  pending_outside: "check_pending",
  not_confirmed: "check_pending",
};

export type ReconBreak = {
  category: BreakCategory;
  severity: Severity;
  fixKind: FixKind;
  outsideSystem: OutsideSystem | null;
  cardTransactionId: string | null;
  moneyActionId: string | null;
  fuelPurchaseId: string | null;
  driverId: string | null;
  ourCents: number | null;
  outsideCents: number | null;
};

// One statement row, as the card provider's portal shows it.
export type StatementTxn = {
  id: string;
  providerRef: string;
  kind: "fuel" | "load";
  cardToken: string;
  cardLast4: string;
  portalName: string;
  postedOn: LocalDate;
  amountCents: number;
  state: string | null;
  gallonsMilli: number | null;
};

export type PurchaseFact = { id: string; driverId: string; purchaseRef: string; amountCents: number };
export type CardFact = {
  driverId: string;
  providerToken: string;
  portalName: string | null;
  status: "active" | "closed";
};
// A confirmed card load in our records: an advance paid to the fuel card through the card provider.
export type CardLoadFact = { moneyActionId: string; outsideId: string; amountCents: number; driverId: string | null };

// A payment record to read back: confirmed or not confirmed, sent inside the window.
export type LedgerFact = {
  id: string;
  kind: MoneyActionKind;
  state: MoneyActionState;
  amountCents: number;
  // Null on a row sent with no answer yet: the system it went to is its kind's.
  outsideSystem: OutsideSystem | null;
  sentAt: string | null;
};

// What reading a payment record back gave: the system's answer, or a category when it threw or
// timed out (an "unchecked" line, never a resolved break).
export type ReadOutcome = { ok: true; readBack: ReadBack } | { ok: false; category: string };

export type ReadComparison =
  | { kind: "clean" }
  | { kind: "break"; break: ReconBreak }
  | { kind: "unchecked"; category: string };

function cents(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} is not whole cents`);
  return n;
}

function make(
  category: BreakCategory,
  more: Partial<Omit<ReconBreak, "category" | "severity" | "fixKind">>,
): ReconBreak {
  return {
    category,
    severity: SEVERITY_OF[category],
    fixKind: FIX_OF[category],
    outsideSystem: null,
    cardTransactionId: null,
    moneyActionId: null,
    fuelPurchaseId: null,
    driverId: null,
    ourCents: null,
    outsideCents: null,
    ...more,
  };
}

// The window: the last windowDays days up to and including today, in the carrier's zone.
export function checkWindow(today: LocalDate, windowDays: number): Period {
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 60) {
    throw new RangeError("the window is 1 to 60 days");
  }
  return { start: addDays(today, -windowDays), end: today };
}

// A payment record is in the window when the local date of its send time, in the carrier's
// zone, is. A record never sent is not.
export function sentInWindow(sentAt: string | null, zone: string, window: Period): boolean {
  if (sentAt === null) return false;
  return isWithin(localDateOf(sentAt, zone), window);
}

// The statement against our records. Only rows posted inside the window are compared.
export function reconcileStatement(input: {
  txns: readonly StatementTxn[];
  purchases: readonly PurchaseFact[];
  cards: readonly CardFact[];
  cardLoads: readonly CardLoadFact[];
  window: Period;
}): ReconBreak[] {
  const byRef = new Map(input.purchases.map((p) => [p.purchaseRef, p]));
  const byToken = new Map(input.cards.map((c) => [c.providerToken, c]));
  const byOutsideId = new Map(input.cardLoads.map((l) => [l.outsideId, l]));
  const out: ReconBreak[] = [];
  const txns = [...input.txns].sort((a, b) => compareText(a.postedOn, b.postedOn) || compareText(a.id, b.id));
  for (const t of txns) {
    if (!isWithin(t.postedOn, input.window)) continue;
    const theirs = cents(t.amountCents, "a statement amount");
    const base = { cardTransactionId: t.id, outsideSystem: "fuel_card_sim" as const, outsideCents: theirs };
    if (t.kind === "fuel") {
      const purchase = byRef.get(t.providerRef);
      if (purchase) {
        const ours = cents(purchase.amountCents, "a purchase amount");
        if (ours !== theirs) {
          out.push(
            make("fuel_amount_differs", {
              ...base,
              fuelPurchaseId: purchase.id,
              driverId: purchase.driverId,
              ourCents: ours,
            }),
          );
        }
        continue;
      }
      const card = byToken.get(t.cardToken);
      out.push(
        card
          ? make("purchase_not_recorded", { ...base, driverId: card.driverId })
          : make("card_unknown", base),
      );
      continue;
    }
    const load = byOutsideId.get(t.providerRef);
    if (!load) {
      out.push(make("load_not_in_ledger", base));
      continue;
    }
    const ours = cents(load.amountCents, "a card load amount");
    if (ours !== theirs) {
      out.push(
        make("load_amount_differs", {
          ...base,
          moneyActionId: load.moneyActionId,
          driverId: load.driverId,
          ourCents: ours,
        }),
      );
    }
  }
  return out;
}

// One payment record against what its own system read back. A record not confirmed yet is a
// difference of its own (Check pending confirms it); it is never read back here.
export function compareReadBack(row: LedgerFact, outcome: ReadOutcome | null): ReadComparison {
  const ours = cents(row.amountCents, "a payment record amount");
  const base = { moneyActionId: row.id, outsideSystem: row.outsideSystem, ourCents: ours };
  if (row.state === "unknown") return { kind: "break", break: make("not_confirmed", base) };
  if (row.state !== "confirmed") return { kind: "clean" };
  if (outcome === null) return { kind: "unchecked", category: "not_read" };
  if (!outcome.ok) return { kind: "unchecked", category: outcome.category };
  const rb = outcome.readBack;
  if (!rb.found) return { kind: "break", break: make("missing_outside", base) };
  const theirs = cents(rb.amountCents, "a read-back amount");
  const seen = { ...base, outsideCents: theirs };
  if (rb.status === "failed" || rb.status === "canceled") {
    return { kind: "break", break: make("reversed_outside", seen) };
  }
  if (rb.status === "pending") return { kind: "break", break: make("pending_outside", seen) };
  if (theirs !== ours) return { kind: "break", break: make("amount_differs_outside", seen) };
  return { kind: "clean" };
}

// The same difference across checks: its category and the ids it names, never its amounts (an
// amount that moved updates the one break).
export function fingerprintOf(b: Pick<ReconBreak, "category" | "cardTransactionId" | "moneyActionId" | "fuelPurchaseId">): string {
  const key = [b.category, b.cardTransactionId ?? "-", b.moneyActionId ?? "-", b.fuelPurchaseId ?? "-"]
    .map((s) => s.toLowerCase())
    .join(":");
  return createHash("sha256").update(key).digest("hex");
}

// ---- Candidates for a card on no driver's file ----

export const MATCH_REASONS = ["on_load_in_state", "worked_that_day", "holds_pool_card", "only_candidate"] as const;
export type MatchReason = (typeof MATCH_REASONS)[number];

export type CandidateDriver = { id: string; code: string; activeFrom: LocalDate; activeTo: LocalDate | null };
export type CandidateDay = { driverId: string; day: LocalDate; loadId: string | null };
export type CandidateLoad = { id: string; originState: string; destState: string };
export type CandidateStateMiles = { loadId: string; state: string };

export type Candidate = {
  driverId: string;
  code: string;
  score: number;
  reasons: MatchReason[];
  // The days that earned the score: the driver's day on or next to the posting day, and its load.
  evidence: { day: LocalDate; loadId: string | null }[];
};

export const MAX_CANDIDATES = 3;

// "POOL CARD 7" -> "POOL CARD": the portal name without its trailing number.
export function portalPrefix(name: string): string {
  return name.replace(/[\s-]*[0-9]+$/, "").trim();
}

// The drivers who could have used the card: anyone active that day with a day of work on the
// posting day or the day either side scores 2, and 3 when that day's load touches the
// transaction's state (origin, destination or a state it crossed). Holding another card with the
// same portal name prefix ("POOL CARD") adds 1. Highest first, then by driver code; at most three.
export function rankCandidates(
  txn: { postedOn: LocalDate; state: string | null; portalName: string },
  facts: {
    drivers: readonly CandidateDriver[];
    days: readonly CandidateDay[];
    loads: readonly CandidateLoad[];
    stateMiles: readonly CandidateStateMiles[];
    cards: readonly CardFact[];
  },
): Candidate[] {
  const near = new Set([addDays(txn.postedOn, -1), txn.postedOn, addDays(txn.postedOn, 1)]);
  const loads = new Map(facts.loads.map((l) => [l.id, l]));
  const crossed = new Map<string, Set<string>>();
  for (const m of facts.stateMiles) {
    const set = crossed.get(m.loadId) ?? new Set<string>();
    set.add(m.state);
    crossed.set(m.loadId, set);
  }
  const touches = (loadId: string | null): boolean => {
    if (loadId === null || txn.state === null) return false;
    const load = loads.get(loadId);
    if (!load) return false;
    return load.originState === txn.state || load.destState === txn.state || (crossed.get(loadId)?.has(txn.state) ?? false);
  };
  const prefix = portalPrefix(txn.portalName);
  const holdsPool = new Set(
    facts.cards
      .filter((c) => c.status === "active" && c.portalName !== null && prefix.length > 0 && portalPrefix(c.portalName) === prefix)
      .map((c) => c.driverId),
  );
  const out: Candidate[] = [];
  for (const d of facts.drivers) {
    if (d.activeFrom > txn.postedOn || (d.activeTo !== null && d.activeTo < txn.postedOn)) continue;
    const days = facts.days
      .filter((x) => x.driverId === d.id && near.has(x.day))
      .sort((a, b) => compareText(a.day, b.day) || compareText(a.loadId ?? "", b.loadId ?? ""));
    if (days.length === 0) continue;
    const inState = days.filter((x) => touches(x.loadId));
    const reasons: MatchReason[] = [inState.length > 0 ? "on_load_in_state" : "worked_that_day"];
    let score = inState.length > 0 ? 3 : 2;
    if (holdsPool.has(d.id)) {
      score += 1;
      reasons.push("holds_pool_card");
    }
    const evidence = (inState.length > 0 ? inState : days).slice(0, 3).map((x) => ({ day: x.day, loadId: x.loadId }));
    out.push({ driverId: d.id, code: d.code, score, reasons, evidence });
  }
  out.sort((a, b) => b.score - a.score || compareText(a.code, b.code));
  const top = out.slice(0, MAX_CANDIDATES);
  if (out.length === 1) top[0].reasons.push("only_candidate");
  return top;
}

// True when more than one candidate shares the top score: code alone cannot say who it was.
export function topIsTied(candidates: readonly Candidate[]): boolean {
  return candidates.length > 1 && candidates[0].score === candidates[1].score;
}

// ---- The match card ----

// The statement row a match card is about, as the card shows it: never the card's token.
export type MatchTxn = {
  id: string;
  providerRef: string;
  last4: string;
  portalName: string;
  postedOn: LocalDate;
  state: string | null;
  amountCents: number;
  gallonsMilli: number | null;
};

// The match card's args, the same from the card check and from the agent's propose_card_match:
// what the card shows and what the executor re-checks. Never the token.
export function matchArgs(txn: MatchTxn, candidates: readonly Candidate[], chosen: Candidate): Record<string, unknown> {
  return {
    transactionId: txn.id,
    providerRef: txn.providerRef,
    last4: txn.last4,
    portalName: txn.portalName,
    postedOn: txn.postedOn,
    state: txn.state,
    amountCents: txn.amountCents,
    gallonsMilli: txn.gallonsMilli,
    driverId: chosen.driverId,
    driverCode: chosen.code,
    candidates: candidates.map((c) => ({ driverId: c.driverId, code: c.code, score: c.score, reasons: [...c.reasons] })),
    reasons: [...chosen.reasons],
  };
}
