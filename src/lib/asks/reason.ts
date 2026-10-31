import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { maskFigures } from "../agent/operator/figures";
import { reasonSentence } from "../agent/reasons";
import { AiError, complete, type AiDeps, type AiRequest, type AiResult, type AiTextTarget } from "../ai";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { dollars } from "../money/format";
import { assertMembership } from "../tenant/context";
import { cachedReason, claimReasonTry, readReasonCandidates, saveReason, type ReasonCandidate } from "./store";
import { kindInWords } from "./words";

// The one Muse Spark line beside a question (caller ask_reason, design-event-lanes 3): why the
// agent is asking, in one sentence. It explains; it never decides, and the question's own words
// and number come from code. The call goes through the wrapper with its own cap (2 cents, 80
// output tokens), one try per question, reserved on the row before the call; a reason already
// written for the same proposal (its dedupe key) is reused with no call. The line is dropped when
// it names any number but the engine's amount and a percent; on any failure the reason stays empty and the
// question still shows. Never inside a database transaction.

export const REASON_MAX_CHARS = 200;
export const REASON_TIMEOUT_MS = 6_000;

export type ReasonCompleteFn = (target: AiTextTarget, request: AiRequest, session: Session) => Promise<AiResult>;

export type ReasonDeps = { complete?: ReasonCompleteFn; ai?: AiDeps };

export type Reasoned = { ok: true; text: string; callId: string } | { ok: false; category: string };

const FORMAT = {
  name: "ask_reason",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["reason"],
    properties: { reason: { type: "string", maxLength: REASON_MAX_CHARS } },
  },
};

const PROMPT =
  "You write one short sentence telling a trucking carrier's owner why their back office agent is " +
  "asking them about one action. You get JSON facts from the records: the question, the action, " +
  "the amount and the reasons the rules engine gave. Say why in plain words, under 30 words. Use " +
  "no dollar amount other than the one given, written exactly as given; never compute, round or " +
  "invent a number. Do not say it is approved, sent or done: the owner decides. Answer as JSON " +
  '{"reason": "..."}.';

const CATEGORY = /^[a-z_]{2,40}$/;
// A percent the engine's facts may carry, such as "70%".
const PERCENT = /\b\d{1,3}(?:\.\d+)?%/g;
// Any cardinal in words, whole words only (plurals too), since any of them could carry an amount:
// "one dollar more", "a twenty dollar fee", "fifteen hundred", "two grand". "Someone" and "anyone"
// still pass; a line such as "one load" is dropped, which is fine for an optional line.
const NUMBER_WORD =
  /\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|hundred|thousand|million|billion|dozen|grand)(?:e?s)?|(?:twent|thirt|fort|fift|sixt|sevent|eight|ninet)(?:y|ies))\b/i;

// The sentence, kept only when its one amount is the engine's, written exactly as given: with that
// amount and any percent taken out, no digit and no number word may remain. Strict on purpose
// (the line is optional): "1,400 dollars", "about 1500" or "USD 1400" drop the line.
export function checkReason(text: string, amountCents: number): { ok: true; text: string } | { ok: false; category: string } {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return { ok: false, category: "empty" };
  if (clean.length > REASON_MAX_CHARS) return { ok: false, category: "too_long" };
  const cents = Math.abs(amountCents);
  if (maskFigures(clean, new Set([cents])).masked > 0) return { ok: false, category: "figures" };
  const rest = clean.split(dollars(cents)).join(" ").replace(PERCENT, " ");
  if (/\d/.test(rest) || NUMBER_WORD.test(rest)) return { ok: false, category: "figures" };
  return { ok: true, text: clean };
}

// One call for one question. Null text on any failure; the category only, never the error's text.
export async function writeReason(
  session: Session,
  input: ReasonCandidate & { traceId: string },
  deps: ReasonDeps = {},
): Promise<Reasoned> {
  const run: ReasonCompleteFn = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const facts = {
    question: input.text,
    action: kindInWords(input.proposalKind),
    amount: dollars(Math.abs(input.amountCents)),
    reasons: input.reasons.map(reasonSentence),
    records: input.sources,
  };
  try {
    const result = await run(
      "spark",
      {
        purpose: "ask_reason",
        maxCostCents: flags.agentAsks.reasonMaxCostCents,
        maxOutputTokens: flags.agentAsks.reasonMaxOutputTokens,
        timeoutMs: REASON_TIMEOUT_MS,
        traceId: input.traceId,
        reasoningEffort: "low",
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify(facts) },
        ],
        format: FORMAT,
      },
      session,
    );
    if (result.status !== "ok") return { ok: false, category: "incomplete" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return { ok: false, category: "bad_answer" };
    }
    const text = (parsed as { reason?: unknown } | null)?.reason;
    if (typeof text !== "string") return { ok: false, category: "bad_answer" };
    const checked = checkReason(text, input.amountCents);
    if (!checked.ok) return checked;
    return { ok: true, text: checked.text, callId: result.callId };
  } catch (err) {
    const category = err instanceof AiError && CATEGORY.test(err.category) ? err.category : "unknown";
    return { ok: false, category };
  }
}

export type FillDeps = ReasonDeps & {
  db?: TenantDb;
  clock?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
};

// The desk's reason pass: up to reasonsPerWake questions, each tried once, stopping before the
// deadline. Returns the tries and the lines kept.
export async function fillReasons(
  session: Session,
  deadlineMs: number,
  deps: FillDeps = {},
): Promise<{ tried: number; kept: number }> {
  const out = { tried: 0, kept: 0 };
  if (flags.agentAsks.enabled !== true || flags.agentAsks.reasonEnabled !== true) return out;
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((line: string) => console.log(line));
  const tx = <T>(fn: (q: Queryable) => Promise<T>) =>
    db.withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return fn(q);
    });
  const candidates = await tx((q) => readReasonCandidates(q, flags.agentAsks.reasonsPerWake));
  for (const c of candidates) {
    if (deadlineMs - clock().getTime() < REASON_TIMEOUT_MS + 1_000) break;
    const traceId = newId();
    const held = await tx(async (q) => {
      if (!(await claimReasonTry(q, c.id, traceId))) return { claimed: false, cached: null };
      // A reason written for this proposal's dedupe key is reused only when it passes this ask's
      // check; one that fails (a different amount) counts as none, and the one try makes the call.
      const found = await cachedReason(q, c.dedupeKey);
      const cached = found !== null && checkReason(found, c.amountCents).ok ? found : null;
      if (cached !== null) await saveReason(q, c.id, traceId, cached);
      return { claimed: true, cached };
    });
    if (!held.claimed || held.cached !== null) continue;
    out.tried += 1;
    const r = await writeReason(session, { ...c, traceId }, deps);
    if (!r.ok) {
      log(`asks reason tenant=${session.tenantId} ask=${c.id} dropped=${r.category}`);
      continue;
    }
    if (await tx((q) => saveReason(q, c.id, traceId, r.text))) out.kept += 1;
  }
  return out;
}
