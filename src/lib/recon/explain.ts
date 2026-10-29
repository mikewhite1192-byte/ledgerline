import { AiError, complete, type AiDeps } from "../ai";
import { maskFigures } from "../agent/operator/figures";
import type { CompleteFn } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { categoryWords, money, systemWords } from "./words";

// One short sentence per difference the card check found (design 4.3): Muse Spark says in plain
// words what differs, between which records. It explains; it never decides. Every dollar figure
// in it must be one of the difference's own amounts (ours, theirs, or the gap between them), or
// the sentence is dropped and the page shows the fixed sentence code builds instead. The call goes
// through the wrapper with its own small token and cost cap.

export { AiError };

export const EXPLAIN_TIMEOUT_MS = 8_000;
export const EXPLAIN_MAX_TOKENS = 120;
export const SENTENCE_MAX_CHARS = 300;

export type ExplainBreakInput = {
  traceId: string;
  category: string;
  // What the record is, in plain words: "card ending 1234", "advance payout".
  record: string;
  outsideSystem: string | null;
  ourCents: number | null;
  outsideCents: number | null;
  maxCostCents: number;
};

export type Explained =
  | { ok: true; text: string; callId: string; costNanocents: number }
  | { ok: false; category: string; callId: string | null; costNanocents: number | null };

export type ExplainDeps = { complete?: CompleteFn; ai?: AiDeps };

const FORMAT = {
  name: "card_check_sentence",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentence"],
    properties: { sentence: { type: "string", maxLength: SENTENCE_MAX_CHARS } },
  },
};

const PROMPT =
  "You explain one difference a trucking carrier's card check found, to its office clerk. You get " +
  "a JSON finding computed by code. Write ONE plain sentence: what differs and between which " +
  "records. Use only the dollar amounts given in the finding, written exactly as given; never " +
  "compute, round or invent another number. Do not say what caused it or that anything was fixed. " +
  'Answer as JSON {"sentence": "..."}.';

const CATEGORY = /^[a-z_]{2,40}$/;
// A decimal amount with no dollar sign, such as "54.20" or "1,250.00", that maskFigures does not read.
const BARE_AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b|\d+\.\d{2}\b/;

// The figures a sentence may name: ours, theirs and the gap between them.
export function allowedCents(ourCents: number | null, outsideCents: number | null): number[] {
  const out = new Set<number>();
  if (ourCents !== null) out.add(Math.abs(ourCents));
  if (outsideCents !== null) out.add(Math.abs(outsideCents));
  if (ourCents !== null && outsideCents !== null && ourCents !== outsideCents) out.add(Math.abs(ourCents - outsideCents));
  return [...out];
}

// The sentence, kept only when every figure in it is an allowed amount.
export function checkSentence(
  text: string,
  allowed: readonly number[],
): { ok: true; text: string } | { ok: false; category: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { ok: false, category: "empty" };
  if (clean.length > SENTENCE_MAX_CHARS) return { ok: false, category: "too_long" };
  if (maskFigures(clean, new Set(allowed)).masked > 0) return { ok: false, category: "figures" };
  // With every allowed dollar figure taken out, no other decimal amount may remain. Longest first,
  // so "$1,234.00" goes before a "$234.00" inside it.
  let rest = clean;
  for (const s of allowed.map((c) => money(c)).sort((a, b) => b.length - a.length)) rest = rest.split(s).join(" ");
  if (BARE_AMOUNT.test(rest)) return { ok: false, category: "figures" };
  return { ok: true, text: clean };
}

export async function explainBreak(
  session: Session,
  input: ExplainBreakInput,
  deps: ExplainDeps = {},
): Promise<Explained> {
  const run: CompleteFn = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const finding = {
    difference: categoryWords(input.category),
    record: input.record,
    otherSystem: systemWords(input.outsideSystem),
    ours: input.ourCents === null ? "none" : money(input.ourCents),
    theirs: input.outsideCents === null ? "none" : money(input.outsideCents),
  };
  const allowed = allowedCents(input.ourCents, input.outsideCents);
  try {
    const result = await run(
      "spark",
      {
        purpose: "card_recon_explain",
        maxCostCents: input.maxCostCents,
        timeoutMs: EXPLAIN_TIMEOUT_MS,
        traceId: input.traceId,
        maxOutputTokens: EXPLAIN_MAX_TOKENS,
        reasoningEffort: "low",
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify(finding) },
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
    const text = (parsed as { sentence?: unknown } | null)?.sentence;
    if (typeof text !== "string") return { ok: false, category: "bad_answer", ...paid };
    const checked = checkSentence(text, allowed);
    if (!checked.ok) return { ok: false, category: checked.category, ...paid };
    return { ok: true, text: checked.text, ...paid };
  } catch (err) {
    // The category only; never the error's text.
    const category = err instanceof AiError && CATEGORY.test(err.category) ? err.category : "unknown";
    return { ok: false, category, callId: null, costNanocents: null };
  }
}
