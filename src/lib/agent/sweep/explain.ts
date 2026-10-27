import { AiError, complete, type AiDeps } from "../../ai";
import type { Session } from "../../auth/claims";
import type { CompleteFn } from "../gateway/types";
import { maskFigures } from "../operator/figures";
import { reasonSentence } from "../reasons";

// The sweep's one model call per drafted fix (design 3.1): Muse Spark writes one short paragraph
// a person reads beside the card. It explains; it never decides. Every number in it must be one
// the engine computed for this fix, or the paragraph is dropped and the card shows the fixed
// reason sentence instead. The call goes through the wrapper with its own small token and cost cap.

// Re-exported so tests name the wrapper's error without importing the wrapper.
export { AiError };

export type ExplainInput = {
  traceId: string;
  check: string;
  category: string;
  reasonCategory: string;
  driverCode: string;
  periodStart: string;
  periodEnd: string;
  // The engine's signed delta for this fix, in cents.
  expectedCents: number;
  maxCostCents: number;
};

export type Explained =
  | { ok: true; text: string; callId: string; costNanocents: number }
  // callId and cost are null when no answer came back (the wrapper's own reservation holds it).
  | { ok: false; category: string; callId: string | null; costNanocents: number | null };

export type ExplainDeps = { complete?: CompleteFn; ai?: AiDeps };

export const EXPLANATION_MAX_CHARS = 400;

const FORMAT = {
  name: "sweep_explanation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["explanation"],
    properties: { explanation: { type: "string", maxLength: EXPLANATION_MAX_CHARS } },
  },
};

const PROMPT =
  "You explain one pay correction to a trucking carrier's payroll clerk. You get a JSON finding " +
  "from the rules engine. Write two or three plain sentences: what the engine found, and what the " +
  "proposed correction does. Use only the dollar amount given in the finding, written exactly as " +
  "given; never compute, round or invent another number. Do not say it is approved or paid: a " +
  'person still decides. Answer as JSON {"explanation": "..."}.';

const CATEGORY = /^[a-z_]{2,40}$/;
// A decimal amount with no dollar sign, such as "54.20" or "1,250.00", that maskFigures does not read.
const BARE_AMOUNT = /\d{1,3}(?:,\d{3})*\.\d{2}\b|\d+\.\d{2}\b/;

function dollars(cents: number): string {
  const abs = Math.abs(cents);
  return `$${Math.trunc(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

// The paragraph, kept only when every figure in it is one of the allowed amounts.
export function checkExplanation(text: string, expectedCents: number): { ok: true; text: string } | { ok: false; category: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { ok: false, category: "empty" };
  if (clean.length > EXPLANATION_MAX_CHARS) return { ok: false, category: "too_long" };
  const allowed = new Set([Math.abs(expectedCents)]);
  if (maskFigures(clean, allowed).masked > 0) return { ok: false, category: "figures" };
  // With the allowed dollar figure taken out, no other decimal amount may remain.
  if (BARE_AMOUNT.test(clean.split(dollars(expectedCents)).join(" "))) return { ok: false, category: "figures" };
  return { ok: true, text: clean };
}

export async function explainFix(
  session: Session,
  input: ExplainInput,
  deps: ExplainDeps = {},
): Promise<Explained> {
  const run: CompleteFn = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const finding = {
    check: input.check,
    category: input.category,
    reason: reasonSentence(input.reasonCategory),
    driver: input.driverCode,
    week: `${input.periodStart} to ${input.periodEnd}`,
    correction: input.expectedCents > 0 ? "adds to the driver's pay" : "takes from the driver's pay",
    amount: dollars(input.expectedCents),
  };
  try {
    const result = await run(
      "spark",
      {
        purpose: "sweep_explain",
        maxCostCents: input.maxCostCents,
        timeoutMs: 8_000,
        traceId: input.traceId,
        maxOutputTokens: 400,
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
    const text = (parsed as { explanation?: unknown } | null)?.explanation;
    if (typeof text !== "string") return { ok: false, category: "bad_answer", ...paid };
    const checked = checkExplanation(text, input.expectedCents);
    if (!checked.ok) return { ok: false, category: checked.category, ...paid };
    return { ok: true, text: checked.text, ...paid };
  } catch (err) {
    // The category only; never the error's text.
    const category = err instanceof AiError && CATEGORY.test(err.category) ? err.category : "unknown";
    return { ok: false, category, callId: null, costNanocents: null };
  }
}
