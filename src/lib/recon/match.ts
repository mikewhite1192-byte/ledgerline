import { AiError, complete, type AiDeps } from "../ai";
import { distinctRefs } from "../agent/gateway/refs";
import type { CompleteFn, GatewayRef } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { persistEngineProposal, type EnginePersistResult } from "../proposals/engine";
import { MATCH_REASONS, matchArgs, topIsTied, type Candidate, type MatchTxn } from "../rules-engine/card-recon";
import { money } from "./words";

// A card on no driver's file (design 4.3): code ranks the drivers who could have used it, Muse
// Spark picks one of them, and the pick becomes a match card a person approves or rejects. The
// model never names a driver code did not rank, never breaks a tie code could not, and never sees
// the card's token. With no candidate, a tie at the top, or no usable pick, the break stays
// "By hand". Approving the card is the executor's job (src/lib/proposals/executors/card-match.ts).

export const MATCH_TIMEOUT_MS = 10_000;
export const MATCH_MAX_TOKENS = 120;

export type { MatchTxn };

export type Picked =
  | { ok: true; driverId: string; callId: string | null; costNanocents: number | null }
  | { ok: false; category: string; callId: string | null; costNanocents: number | null };

export type MatchDeps = { complete?: CompleteFn; ai?: AiDeps };

const CATEGORY = /^[a-z_]{2,40}$/;
const NONE = "NONE";

const PROMPT =
  "A trucking carrier's fuel card statement shows a purchase on a card that is on no driver's file. " +
  "Code ranked the drivers who could have used it, with a score and the facts behind it. Pick the " +
  "one driver the facts point to, or NONE when they do not point to one. Pick only from the list. " +
  'Answer as JSON {"driverCode": "...", "reasons": [...]}, the reasons taken from the list given.';

function formatFor(codes: readonly string[]) {
  return {
    name: "card_match_pick",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["driverCode", "reasons"],
      properties: {
        driverCode: { type: "string", enum: [...codes, NONE] },
        reasons: { type: "array", maxItems: 4, items: { type: "string", enum: [...MATCH_REASONS] } },
      },
    },
  };
}

// The model's pick among the ranked candidates. No call with no candidate or a tie at the top.
export async function pickDriver(
  session: Session,
  input: { traceId: string; txn: MatchTxn; candidates: readonly Candidate[]; maxCostCents: number },
  deps: MatchDeps = {},
): Promise<Picked> {
  const { candidates, txn } = input;
  if (candidates.length === 0) return { ok: false, category: "no_candidates", callId: null, costNanocents: null };
  if (topIsTied(candidates)) return { ok: false, category: "tied", callId: null, costNanocents: null };
  const run: CompleteFn = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const facts = {
    purchase: {
      amount: money(txn.amountCents),
      postedOn: txn.postedOn,
      state: txn.state,
      portalName: txn.portalName,
      cardEnding: txn.last4,
    },
    candidates: candidates.map((c) => ({
      driverCode: c.code,
      score: c.score,
      reasons: c.reasons,
      days: c.evidence.map((e) => e.day),
    })),
  };
  try {
    const result = await run(
      "spark",
      {
        purpose: "card_recon_match",
        maxCostCents: input.maxCostCents,
        timeoutMs: MATCH_TIMEOUT_MS,
        traceId: input.traceId,
        maxOutputTokens: MATCH_MAX_TOKENS,
        reasoningEffort: "low",
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: JSON.stringify(facts) },
        ],
        format: formatFor(candidates.map((c) => c.code)),
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
    const code = (parsed as { driverCode?: unknown } | null)?.driverCode;
    if (typeof code !== "string") return { ok: false, category: "bad_answer", ...paid };
    if (code === NONE) return { ok: false, category: "no_pick", ...paid };
    // Whole values: the code must be exactly one ranked candidate's.
    const chosen = candidates.filter((c) => c.code === code);
    if (chosen.length !== 1) return { ok: false, category: "not_candidate", ...paid };
    return { ok: true, driverId: chosen[0].driverId, ...paid };
  } catch (err) {
    const category = err instanceof AiError && CATEGORY.test(err.category) ? err.category : "unknown";
    return { ok: false, category, callId: null, costNanocents: null };
  }
}

export function matchSources(txn: MatchTxn, chosen: Candidate): GatewayRef[] {
  const refs: GatewayRef[] = [
    { table: "card_transactions", id: txn.id },
    { table: "drivers", id: chosen.driverId },
  ];
  for (const e of chosen.evidence) if (e.loadId) refs.push({ table: "loads", id: e.loadId });
  return distinctRefs(refs);
}

// The match card, inside the caller's tenant transaction. The same transaction and pick give the
// same dedupe key, so a card a person rejected is not put back until something about it changes.
export async function persistMatch(
  q: Queryable,
  session: Session,
  now: Date,
  input: { txn: MatchTxn; candidates: readonly Candidate[]; driverId: string; exceptions?: string[] },
): Promise<EnginePersistResult | null> {
  const chosen = input.candidates.find((c) => c.driverId === input.driverId);
  if (!chosen) return null;
  return persistEngineProposal(
    q,
    {
      kind: "card_match",
      subjectTable: "card_transactions",
      subjectId: input.txn.id,
      amountCents: input.txn.amountCents,
      args: matchArgs(input.txn, input.candidates, chosen),
      exceptions: input.exceptions ?? [],
      reasons: [...chosen.reasons],
      sources: matchSources(input.txn, chosen),
      operatorVerdict: "match_picked",
    },
    session,
    now,
  );
}
