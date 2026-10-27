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
// dropped and the page shows the engine's own sentence instead. The call goes through the wrapper
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
  "found and which of them would cover it. Use only the dollar amounts given, written exactly as " +
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
    pastDueInvoices: o.overdueInvoices,
  };
}

// What the model is given, and the cents of every dollar figure in it (the only ones allowed back).
export function explainFacts(
  r: CashPosition,
  billCategory: (billId: string) => string | null,
): { facts: Record<string, unknown>; allowed: Set<number> } {
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
  const allowed = new Set<number>(
    [
      f.gapCents,
      f.cashOnHandCents,
      f.expectedReceiptsCents,
      f.payRunCents,
      f.fuelLoadsCents,
      f.vendorBillsDueCents,
      ...r.options.flatMap((o) => (o.kind === "factoring_request" ? [o.amountCents, o.feeCents] : [o.amountCents])),
    ].map((c) => Math.abs(c)),
  );
  return { facts, allowed };
}

// The paragraph, kept only when every figure in it is one of the allowed amounts.
export function checkExplanation(
  text: string,
  allowed: ReadonlySet<number>,
): { ok: true; text: string } | { ok: false; category: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { ok: false, category: "empty" };
  if (clean.length > flags.cashFridayLimits.maxExplainChars) return { ok: false, category: "too_long" };
  if (maskFigures(clean, allowed).masked > 0) return { ok: false, category: "figures" };
  // With every allowed dollar figure taken out, no other decimal amount may remain.
  let rest = clean;
  for (const cents of [...allowed].sort((a, b) => b - a)) rest = rest.split(dollars(cents)).join(" ");
  if (BARE_AMOUNT.test(rest)) return { ok: false, category: "figures" };
  return { ok: true, text: clean };
}

export async function explainCheck(
  session: Session,
  input: { traceId: string; result: CashPosition; billCategory: (billId: string) => string | null },
  deps: ExplainDeps = {},
): Promise<Explained> {
  const run: CompleteFn = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const { facts, allowed } = explainFacts(input.result, input.billCategory);
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
    const checked = checkExplanation(text, allowed);
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
