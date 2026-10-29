import { flags } from "../../config/flags";
import { AiError, complete, type AiDeps, type AiRequest, type AiResult, type AiTextTarget } from "../ai";
import type { Session } from "../auth/claims";
import { maskFigures } from "../agent/operator/figures";
import { formatLocalDate } from "../format/dates";
import type { CashOption, CashPosition } from "../rules-engine";
import { dayOfWeek, type LocalDate } from "../time/local-date";

// Cash Friday's one model call per check (design 4.4): Muse Wonder writes one short paragraph the
// owner reads under the figures. It explains; it never decides. It gets the engine's figures as
// dollar strings and the moves the engine found, never a memo, a name or anything a customer or
// vendor wrote. Every dollar figure in the paragraph must be one it was given, or the paragraph is
// dropped and the page shows the engine's own sentence instead. So is a paragraph that says a move
// closes the short when the engine did not find that it does. The call goes through the wrapper
// with its own token and cost cap.

export { AiError };

export type CompleteFn = (target: AiTextTarget, request: AiRequest, session: Session) => Promise<AiResult>;

export type Explained =
  | { ok: true; text: string; callId: string; costNanocents: number }
  // callId and cost are null when no answer came back (the wrapper's own reservation holds it).
  | { ok: false; category: string; callId: string | null; costNanocents: number | null };

export type ExplainDeps = { complete?: CompleteFn; ai?: AiDeps };

export const EXPLAIN_TIMEOUT_MS = 10_000;
export const EXPLAIN_MAX_OUTPUT_TOKENS = 600;

const FORMAT = {
  name: "cash_friday_explanation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["explanation"],
    properties: { explanation: { type: "string", maxLength: flags.cashFridayLimits.maxExplainChars } },
  },
};

const PROMPT =
  "You explain to a trucking carrier's owner whether the business can cover Friday's driver pay " +
  "run. You get JSON from the rules engine. Write three or four plain sentences: whether pay day " +
  "is covered and by how much, what makes up the gap, and, when it is short, the moves the engine " +
  "found and which of them would cover it. A move covers the short only when its coversShort is " +
  "true; say any other move narrows the short, never that it covers it or is enough. For a late " +
  "payer, newCash is the part of pastDue the engine does not already count: it is what chasing " +
  "adds. Use only the dollar amounts given, written exactly as " +
  "given; never add, subtract, round or invent a number. Never say a move is approved, paid or " +
  'sent: a person decides each one. Answer as JSON {"explanation": "..."}.';

const CATEGORY = /^[a-z_]{2,40}$/;
// A decimal amount with no dollar sign, such as "54.20" or "1,250.00", that maskFigures does not read.
const BARE_AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b|\d+\.\d{2}\b/;

export function dollars(cents: number): string {
  const abs = Math.abs(cents);
  return `$${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

// "2026-11-06" as "Friday, Nov 6": the weekday and the day the owner reads on the page.
export function dayWords(value: LocalDate): string {
  return `${WEEKDAYS[dayOfWeek(value)]}, ${formatLocalDate(value).replace(/, \d{4}$/, "")}`;
}

const BILL_WORDS: Readonly<Record<string, string>> = {
  fuel_supplier: "fuel supplier",
  insurance: "insurance",
  maintenance: "shop and tires",
  tolls: "tolls",
  software: "software",
  lease: "truck lease",
  other: "other",
};

function moveOf(o: CashOption, billCategory: (billId: string) => string | null) {
  if (o.kind === "factoring_request") {
    return {
      move: "factor invoices with a factoring partner (test mode: nothing is sent)",
      invoices: o.invoices.length,
      paidNow: dollars(o.amountCents),
      fee: dollars(o.feeCents),
      coversShort: o.coversShort,
    };
  }
  if (o.kind === "bill_defer") {
    const category = billCategory(o.subjectId);
    return {
      move: "move one flexible vendor bill to after pay day",
      bill: category ? (BILL_WORDS[category] ?? "other") : "other",
      amount: dollars(o.amountCents),
      newDueDate: dayWords(o.deferredTo),
      coversShort: o.coversShort,
    };
  }
  return {
    move: "ask a late-paying customer for what is past due (test mode: nothing is sent)",
    pastDue: dollars(o.amountCents),
    newCash: dollars(o.newCashCents),
    pastDueInvoices: o.overdueInvoices,
    coversShort: o.coversShort,
  };
}

// A move as the paragraph check reads it: its kind, the cents of the dollar figures that name it,
// and whether the engine found it closes the short on its own.
export type MoveClaim = { kind: CashOption["kind"]; cents: readonly number[]; covers: boolean };

// What a paragraph is checked against: every figure it may use (the only ones allowed back), the
// position's own figures (naming one names no move) and the moves.
export type ExplainGuard = {
  allowed: ReadonlySet<number>;
  position: ReadonlySet<number>;
  moves: readonly MoveClaim[];
};

function moveCents(o: CashOption): number[] {
  if (o.kind === "factoring_request") return [o.amountCents, o.feeCents];
  if (o.kind === "collections_chase") return [o.amountCents, o.newCashCents];
  return [o.amountCents];
}

// What the model is given, and what its paragraph is checked against.
export function explainFacts(
  r: CashPosition,
  billCategory: (billId: string) => string | null,
): { facts: Record<string, unknown>; guard: ExplainGuard } {
  const f = r.figures;
  const facts = {
    payDay: dayWords(r.payDay),
    verdict: f.gapCents < 0 ? "short" : "covered",
    gap: dollars(f.gapCents),
    cashOnHand: dollars(f.cashOnHandCents),
    expectedFromCustomersByPayDay: dollars(f.expectedReceiptsCents),
    driverPayRun: dollars(f.payRunCents),
    payRunIs: r.payRunSource === "stored" ? "the pay run as stored" : "a preview of this week's pay",
    fuelCardLoads: dollars(f.fuelLoadsCents),
    billsDueByPayDay: dollars(f.vendorBillsDueCents),
    moves: r.options.map((o) => moveOf(o, billCategory)),
  };
  const position = [
    f.gapCents,
    f.cashOnHandCents,
    f.expectedReceiptsCents,
    f.payRunCents,
    f.fuelLoadsCents,
    f.vendorBillsDueCents,
  ].map((c) => Math.abs(c));
  const moves = r.options.map((o): MoveClaim => ({ kind: o.kind, cents: moveCents(o), covers: o.coversShort }));
  const guard: ExplainGuard = {
    allowed: new Set([...position, ...moves.flatMap((m) => m.cents)]),
    position: new Set(position),
    moves,
  };
  return { facts, guard };
}

// Wording that says something closes the short. "Narrows", "brings in" and "helps" do not.
const COVERS =
  /\b(?:cover(?:s|ed|ing)?|clos(?:e|es|ed|ing)|enough|sufficient|mak(?:e|es|ing) up|fill\w*|bridg\w*|eliminat\w*|wip\w* out|solv\w*)\b/gi;
// A claim with one of these in the four words before it is denied: "does not cover", "not enough".
const NEGATION = /\b(?:not|never|cannot|nor|none|neither)\b|n['\u2019]t\b/i;
// The words that name a move of each kind, with or without its figure.
const MOVE_WORDS: Readonly<Record<CashOption["kind"], RegExp>> = {
  factoring_request: /\bfactor/i,
  bill_defer: /\b(?:defer|delay|postpon|reschedul|push\w* (?:back|out)|mov(?:e|es|ed|ing)\b.{0,40}\bbill)/i,
  collections_chase: /\b(?:chas|collect|ask|past[- ]due|overdue|late[- ]pa)/i,
};
// Clauses: sentence ends and semicolons (never the point inside $1.00), and a turn such as "but".
const CLAUSE = /[.!?;](?=\s|$)|,?\s+(?:but|while|whereas|although)\s+/i;
// A clause that opens on one of these points back at the last move named: "That covers it."
const POINTS_BACK = /^\s*(?:that|this|it|which|doing so|together|both|either|each|those|these|they)\b/i;
// Dollar and cents figures, read the way maskFigures reads them.
const DOLLAR_FIGURE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g;
const CENTS_FIGURE = /\b(\d{1,3}(?:,\d{3})+|\d+)\s?cents\b/gi;

function figuresIn(clause: string): number[] {
  const whole = (s: string) => Number(s.replace(/,/g, ""));
  return [
    ...[...clause.matchAll(DOLLAR_FIGURE)].map((m) => whole(m[1]) * 100 + (m[2] ? whole(m[2].padEnd(2, "0")) : 0)),
    ...[...clause.matchAll(CENTS_FIGURE)].map((m) => whole(m[1])),
  ];
}

function claimsCover(clause: string): boolean {
  for (const m of clause.matchAll(COVERS)) {
    const before = clause.slice(0, m.index).trimEnd().split(/\s+/).slice(-4).join(" ");
    if (!NEGATION.test(before.replace(/\bnot only\b/gi, ""))) return true;
  }
  return false;
}

// For each move a clause names, whether the engine found it closes the short. A figure names the
// moves it belongs to; a word names its kind, narrowed to the moves of that kind whose figures the
// clause gives. A name that matches no move found is never a covering one.
function namedMoves(clause: string, guard: ExplainGuard): boolean[] {
  const figures = figuresIn(clause).filter((c) => !guard.position.has(c));
  const out = figures.map((c) => {
    const own = guard.moves.filter((m) => m.cents.includes(c));
    return own.length > 0 && own.every((m) => m.covers);
  });
  for (const [kind, words] of Object.entries(MOVE_WORDS)) {
    if (!words.test(clause)) continue;
    const ofKind = guard.moves.filter((m) => m.kind === kind);
    const byFigure = ofKind.filter((m) => figures.some((c) => m.cents.includes(c)));
    const named = byFigure.length > 0 ? byFigure : ofKind;
    out.push(named.length > 0 && named.every((m) => m.covers));
  }
  return out;
}

// Whether the paragraph says a move closes the short when the engine did not find that it does
// (a chase whose new cash is less than the short, two moves that only cover it together). A word
// list cannot read every wording; what it misses the prompt and the engine's flags still steer,
// and what it catches falls back to the engine's sentence like any other dropped paragraph.
function overclaims(text: string, guard: ExplainGuard): boolean {
  if (guard.moves.length === 0) return false;
  let last: boolean[] = [];
  for (const clause of text.split(CLAUSE)) {
    const named = namedMoves(clause, guard);
    if (named.length > 0) last = named;
    const subject = named.length > 0 ? named : POINTS_BACK.test(clause) ? last : [];
    if (claimsCover(clause) && subject.some((covers) => !covers)) return true;
  }
  return false;
}

// The paragraph, kept only when every figure in it is one of the allowed amounts and it never says
// a move covers the short that the engine did not mark as covering it.
export function checkExplanation(
  text: string,
  guard: ExplainGuard,
): { ok: true; text: string } | { ok: false; category: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { ok: false, category: "empty" };
  if (clean.length > flags.cashFridayLimits.maxExplainChars) return { ok: false, category: "too_long" };
  if (maskFigures(clean, guard.allowed).masked > 0) return { ok: false, category: "figures" };
  // With every allowed dollar figure taken out, no other decimal amount may remain.
  let rest = clean;
  for (const cents of [...guard.allowed].sort((a, b) => b - a)) rest = rest.split(dollars(cents)).join(" ");
  if (BARE_AMOUNT.test(rest)) return { ok: false, category: "figures" };
  if (overclaims(clean, guard)) return { ok: false, category: "overclaim" };
  return { ok: true, text: clean };
}

export async function explainCheck(
  session: Session,
  input: { traceId: string; result: CashPosition; billCategory: (billId: string) => string | null },
  deps: ExplainDeps = {},
): Promise<Explained> {
  const run: CompleteFn = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const { facts, guard } = explainFacts(input.result, input.billCategory);
  try {
    const result = await run(
      "wonder",
      {
        purpose: "cash_friday_explain",
        maxCostCents: flags.cashFridayLimits.maxExplainCents,
        timeoutMs: EXPLAIN_TIMEOUT_MS,
        traceId: input.traceId,
        maxOutputTokens: EXPLAIN_MAX_OUTPUT_TOKENS,
        reasoningEffort: "low",
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify(facts) },
        ],
        format: FORMAT,
      },
      session,
    );
    const paid = { callId: result.callId, costNanocents: result.costNanocents };
    if (result.status !== "ok") return { ok: false, category: "incomplete", ...paid };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { ok: false, category: "bad_answer", ...paid };
    }
    const text = (parsed as { explanation?: unknown } | null)?.explanation;
    if (typeof text !== "string") return { ok: false, category: "bad_answer", ...paid };
    const checked = checkExplanation(text, guard);
    if (!checked.ok) return { ok: false, category: checked.category, ...paid };
    return { ok: true, text: checked.text, ...paid };
  } catch (err) {
    // The category only; never the error's text.
    const category = err instanceof AiError && CATEGORY.test(err.category) ? err.category : "unknown";
    return { ok: false, category, callId: null, costNanocents: null };
  }
}

// The engine's own sentence, shown when there is no paragraph (Wonder off, refused or dropped):
// every figure is the engine's, in the order the gap adds up.
export type SentenceFigures = Readonly<
  Record<
    "cashOnHandCents" | "expectedReceiptsCents" | "payRunCents" | "fuelLoadsCents" | "vendorBillsDueCents" | "gapCents",
    number
  >
>;

export function engineSentence(payDay: LocalDate, f: SentenceFigures): string {
  const onHand = f.cashOnHandCents < 0 ? `-${dollars(f.cashOnHandCents)}` : dollars(f.cashOnHandCents);
  const parts =
    `Cash on hand ${onHand} plus ${dollars(f.expectedReceiptsCents)} expected by ${dayWords(payDay)}`;
  const costs =
    `the ${dollars(f.payRunCents)} pay run, ${dollars(f.fuelLoadsCents)} of fuel card loads and ` +
    `${dollars(f.vendorBillsDueCents)} of bills due`;
  if (f.gapCents >= 0) return `${parts} covers ${costs}, with ${dollars(f.gapCents)} to spare.`;
  return `${parts} does not cover ${costs}. Short by ${dollars(f.gapCents)}.`;
}
