import { createHash, randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, spendRoom, type AiDeps, type AiErrorCategory, type AiRequest, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { isPayCardPng } from "./png";
import {
  PAY_CARD_PURPOSE,
  countRecentCards,
  expireStaleCards,
  finishCard,
  lockCards,
  readBatchSpend,
  readCardStatus,
  readMemberId,
  readSettlementCards,
  readSettlementSpec,
  reserveCard,
  currentChecked,
  type CardFinish,
  type CardStatus,
  type CardCategory,
} from "./read";
import { PAY_CARD_PROMPT, PAY_CARD_READ_FORMAT, parseCardRead, type CardRead } from "./schema";
import type { CardSpec } from "./spec";

// Checks one pay card picture before it can be saved or shared. The only file in src/lib/pay-cards
// that reaches a model, and only through complete() in src/lib/ai, which checks aiEnabled,
// reserves the worst case in the spend ledger and enforces the global cap.
//
// The browser drew the card from a spec the server gave it; here the server works the spec out
// again from the settlement's own rows (the browser's numbers are never read), has the model read
// the picture back under a strict schema whose prompt holds no expected value, and compares the
// read to the spec in code, whole values only. Only a card that matches is kept, with its bytes;
// a card that does not match keeps no image, so nothing the driver could be sent ever differs from
// the paystub. The model never computes or changes a number.
//
// Each card is reserved first: its row is written (checking) before the model call, in the one
// statement that refuses a fourth attempt. A spend check the wrapper would refuse is answered
// before the row, so a full budget uses no attempt. A call complete() turned down before any
// request went out (switched off, over a cap) deletes the bare reservation: no model was called.
// A timeout or a failure after the request was sent uses the attempt (unavailable, with a
// category). A row left checking by a crash is closed as unavailable (unknown) once its lease
// runs out, the next time anyone checks a card for that settlement.

export const CHECK_TIMEOUT_MS = 20_000;
export const CHECK_OUTPUT_TOKENS = 400;
const NANOCENTS_PER_CENT = 1_000_000_000;

export type CheckRefusal =
  | "cards_off"
  | "ai_off"
  | "not_found"
  | "not_approved"
  | "bad_image"
  | "attempts"
  | "day_cap"
  | "batch_cap"
  | "budget"
  | "busy"
  | "already_checked"
  | "unknown";

export type CheckResult =
  | { ok: true; cardId: string; attempt: number; status: Exclude<CardStatus, "checking">; category: CardCategory | null }
  | { ok: false; category: CheckRefusal };

export type CheckDeps = {
  db?: TenantDb;
  ai?: AiDeps;
  complete?: (request: AiRequest, session: Session) => Promise<AiResult>;
  newId?: () => string;
};

// complete() throws these before any provider request (spend.ts reserve writes no ledger row for
// cap or job_cap; disabled, not_configured and too_expensive come before the reserve).
const BEFORE_ANY_REQUEST: ReadonlySet<AiErrorCategory> = new Set<AiErrorCategory>([
  "disabled",
  "not_configured",
  "too_expensive",
  "cap",
  "job_cap",
]);

const refuse = (category: CheckRefusal): CheckResult => ({ ok: false, category });

function tx<T>(session: Session, deps: CheckDeps, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return (deps.db ?? getDb()).withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

function logFailure(step: string, err: unknown): void {
  const what = err instanceof AiError ? `${err.name}:${err.category}` : err instanceof Error ? err.name : "unknown";
  console.error("pay card step failed:", step, what);
}

// The one read-back request. Only the picture and the fixed prompt go to the model: no figure,
// name or week, so the read cannot copy the answer.
export function checkRequest(png: Uint8Array, traceId: string): AiRequest {
  return {
    purpose: PAY_CARD_PURPOSE,
    reasoningEffort: "low",
    maxOutputTokens: CHECK_OUTPUT_TOKENS,
    maxCostCents: flags.payCardLimits.checkMaxCostCents,
    timeoutMs: CHECK_TIMEOUT_MS,
    traceId,
    format: PAY_CARD_READ_FORMAT,
    messages: [
      { role: "system", content: PAY_CARD_PROMPT },
      { role: "user", content: "Read this pay card.", attachments: [{ kind: "image", mime: "image/png", bytes: png }] },
    ],
  };
}

// Names and week lines are compared after closing runs of spaces, the same Unicode form and one
// letter case; never a substring.
export function normText(s: string): string {
  return s.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase();
}

// What the model read against what the card should say. Null when they agree; otherwise the kind
// of difference. Numbers first: a wrong number is the worse fault.
export function compareCard(spec: CardSpec, read: CardRead): "number_mismatch" | "text_mismatch" | null {
  const printed: [number | null, number | null][] = [
    [read.net_pay_cents, spec.netCents],
    [read.earned_cents, spec.grossCents],
    [read.taken_out_cents, spec.deductionsCents],
    [read.loads, spec.loads],
    [read.miles, spec.miles],
    [read.change_cents, spec.changeCents],
  ];
  // A null on either side alone is a difference: the card left out a figure it should show, or
  // shows one it should not.
  for (const [seen, want] of printed) if (seen !== want) return "number_mismatch";
  // Both ways, whole values: every other amount read is one the card prints, and every amount the
  // card prints was read somewhere, so a card missing a line (a carried shortfall, the biggest
  // change) is a difference too.
  const amounts = new Set(spec.amountsCents);
  if (!read.other_amounts_cents.every((a) => amounts.has(Math.abs(a)))) return "number_mismatch";
  const seenAmounts = new Set(
    [read.net_pay_cents, read.earned_cents, read.taken_out_cents, read.change_cents, ...read.other_amounts_cents]
      .filter((a): a is number => a !== null)
      .map((a) => Math.abs(a)),
  );
  if (!spec.amountsCents.every((a) => seenAmounts.has(a))) return "number_mismatch";
  if (read.any_other_digits) return "number_mismatch";
  if (read.first_name === null || normText(read.first_name) !== normText(spec.firstName)) return "text_mismatch";
  if (read.week_text === null || normText(read.week_text) !== normText(spec.weekText)) return "text_mismatch";
  return null;
}

type Claim = { cardId: string; attempt: number; spec: CardSpec } | CheckResult;

// Checks one card picture for one settlement. png is the browser's drawing; traceId groups one run
// of the cards page (its batch cap).
export async function checkPayCard(
  session: Session,
  input: { settlementId: string; traceId: string; png: Uint8Array },
  deps: CheckDeps = {},
): Promise<CheckResult> {
  // Each switch is re-checked here, whoever calls; complete() checks aiEnabled again.
  if (!flags.payCardsEnabled) return refuse("cards_off");
  if (!flags.aiEnabled) return refuse("ai_off");
  const limits = flags.payCardLimits;
  if (!isPayCardPng(input.png, limits.maxPngBytes)) return refuse("bad_image");

  const request = checkRequest(input.png, input.traceId);
  const worstNanocents = limits.checkMaxCostCents * NANOCENTS_PER_CENT;
  const cardId = (deps.newId ?? randomUUID)();

  const claim: Claim = await tx(session, deps, async (q) => {
    await lockCards(q);
    const read = await readSettlementSpec(q, input.settlementId);
    if (!read) return refuse("not_found");
    if (!read.spec) return refuse("not_approved");
    const spec = read.spec;
    await expireStaleCards(q, input.settlementId);
    // A card still checking inside its lease holds the paystub: a second click or another tab is
    // refused before it takes an attempt or makes a call of its own.
    const cards = await readSettlementCards(q, input.settlementId);
    if (cards.some((c) => c.status === "checking")) return refuse("busy");
    if (currentChecked(cards, spec)) return refuse("already_checked");

    // The wrapper's own spend checks first, read without a lock: a call they would refuse now is
    // never made, and uses no attempt.
    const room = await spendRoom("spark", request, q);
    if (room === null) return refuse("ai_off");
    if (room !== "room") return refuse("budget");
    // The run's own cap: the next card must fit under it at its worst case.
    if ((await readBatchSpend(q, input.traceId, worstNanocents)) + worstNanocents > limits.maxBatchCents * NANOCENTS_PER_CENT) {
      return refuse("batch_cap");
    }
    if ((await countRecentCards(q)) >= limits.cardsPerTenantPerDay) return refuse("day_cap");

    const createdBy = await readMemberId(q, session.sub);
    if (!createdBy) return refuse("not_found");
    const attempt = await reserveCard(q, {
      id: cardId,
      settlementId: input.settlementId,
      art: spec.art,
      spec,
      traceId: input.traceId,
      createdBy,
    });
    if (attempt === null) return refuse("attempts");
    return { cardId, attempt, spec };
  }).catch((err: unknown): CheckResult => {
    // 23505: another request reserved the same attempt number first. The lock and the busy check
    // above keep that from happening; the unique key is only the backstop.
    if (err instanceof DbError && err.sqlState === "23505") return refuse("busy");
    throw err;
  });
  if ("ok" in claim) return claim;

  const finish = await readBack(session, request, input.png, claim.spec, deps);
  if ("beforeRequest" in finish) {
    // No model was called: the bare reservation goes, so it uses no attempt. If the delete fails,
    // the row stays checking and its lease closes it later.
    await tx(session, deps, (q) => q.execute(
      `DELETE FROM pay_cards
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'checking'`,
      [claim.cardId],
    )).catch((err) => logFailure("release", err));
    return refuse(finish.beforeRequest);
  }

  let finished = false;
  try {
    finished = await tx(session, deps, (q) => finishCard(q, claim.cardId, finish));
  } catch (err) {
    logFailure("finish", err);
  }
  // The write may have landed with its reply lost, or another request may have closed the row:
  // read it back. Unknown is not zero: a read-back that fails, or a row still checking, is unknown.
  const after = finished
    ? { status: finish.status, category: "category" in finish ? finish.category : null }
    : await tx(session, deps, (q) => readCardStatus(q, claim.cardId)).catch((err) => {
        logFailure("finish read-back", err);
        return null;
      });
  if (!after || after.status === "checking") return refuse("unknown");
  return { ok: true, cardId: claim.cardId, attempt: claim.attempt, status: after.status, category: after.category };
}

// The one model call and what its answer means for the card.
async function readBack(
  session: Session,
  request: AiRequest,
  png: Uint8Array,
  spec: CardSpec,
  deps: CheckDeps,
): Promise<CardFinish | { beforeRequest: "budget" | "ai_off" }> {
  let result: AiResult;
  try {
    result = deps.complete ? await deps.complete(request, session) : await complete("spark", request, session, deps.ai);
  } catch (err) {
    logFailure("read-back", err);
    if (!(err instanceof AiError)) return { status: "unavailable", category: "unknown", callId: null };
    if (BEFORE_ANY_REQUEST.has(err.category)) {
      return { beforeRequest: err.category === "disabled" || err.category === "not_configured" ? "ai_off" : "budget" };
    }
    if (err.category === "timeout") return { status: "unavailable", category: "timeout", callId: null };
    if (err.category === "billing") return { status: "unavailable", category: "budget", callId: null };
    return { status: "unavailable", category: "unknown", callId: null };
  }
  const read = result.status === "ok" ? parseCardRead(result.text) : null;
  if (!read) {
    console.error("pay card read-back off schema:", result.status);
    return { status: "unavailable", category: "off_schema", callId: result.callId };
  }
  const difference = compareCard(spec, read);
  if (difference) return { status: "mismatch", category: difference, read, callId: result.callId };
  return {
    status: "checked",
    read,
    callId: result.callId,
    bytesBase64: Buffer.from(png).toString("base64"),
    byteLength: png.length,
    contentHash: createHash("sha256").update(png).digest("hex"),
  };
}
