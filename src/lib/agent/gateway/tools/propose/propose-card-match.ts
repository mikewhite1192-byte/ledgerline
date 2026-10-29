import { z } from "zod";
import { flags } from "../../../../../config/flags";
import type { Queryable } from "../../../../db";
import { readCandidateFacts, readMatchFacts } from "../../../../data/card-recon";
import { readRowsWhereId } from "../../../../data/read";
import { cents } from "../../../../rules-engine";
import { matchArgs, rankCandidates, type Candidate } from "../../../../rules-engine/card-recon";
import { distinctRefs } from "../../refs";
import { defineTool, type GatewayContext, type GatewayRef, type LimitResult } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";

// Matching a fuel card that is on no driver's file to one driver, for a person to approve
// (design 4.3). Nothing changes until a person approves: approval puts the card on the driver's
// file and records the purchase as that driver's fuel (design 6, D3). The amount is the
// statement's own cents for the purchase, never the model's; a driver code did not rank is
// allowed but carries the driver_not_candidate exception, so the card says so. Behind the card
// check's switch, read on every offer and every call, and again in the limit and the run.

export type CardMatchLimitArgs = { transactionId: string; driverId: string };

function unavailable(): LimitResult {
  console.warn("gateway: a card match limit could not be computed");
  return { ok: false, reason: "limit_unavailable", limitCents: null, requestedCents: null };
}

function refused(requestedCents: number): LimitResult {
  return { ok: false, reason: "engine_refused", limitCents: null, requestedCents: cents(requestedCents) };
}

// What the engine says about the pair: the statement row, the ranked candidates, and the chosen
// driver's place among them (or a stand-in with no score when code did not rank that driver).
async function matchOf(q: Queryable, a: CardMatchLimitArgs) {
  const facts = await readMatchFacts(q, a.transactionId);
  if (!facts) return null;
  const candidates = rankCandidates(facts.txn, await readCandidateFacts(q, facts.txn.postedOn));
  const ranked = candidates.find((c) => c.driverId === a.driverId) ?? null;
  return { facts, candidates, ranked };
}

// Only a fuel purchase whose card is on no driver's file and whose purchase is not recorded yet
// may be matched; anything else is engine_refused. The limit is the statement's amount.
export async function cardMatchLimit(
  q: Queryable,
  _ctx: GatewayContext,
  a: CardMatchLimitArgs,
): Promise<LimitResult> {
  if (!flags.cardRecon.enabled) return unavailable();
  try {
    const m = await matchOf(q, a);
    if (!m) return unavailable();
    const amount = m.facts.txn.amountCents;
    if (!Number.isSafeInteger(amount) || amount <= 0) return unavailable();
    if (m.facts.kind !== "fuel" || m.facts.cardOnFile || m.facts.purchaseOnFile) return refused(amount);
    return {
      ok: true,
      limitCents: cents(amount),
      requestedCents: cents(amount),
      exceptions: m.ranked ? [] : ["driver_not_candidate"],
      reasons: m.ranked ? [...m.ranked.reasons] : [],
      sources: [],
    };
  } catch {
    return unavailable();
  }
}

export const proposeCardMatch = defineTool({
  name: "propose_card_match",
  description:
    "Propose matching a fuel purchase on a card that is on no driver's file to one driver, for a " +
    "person to approve. Nothing changes until a person approves; approval puts the card on that " +
    "driver's file and records the purchase as their fuel. transactionId is the card transaction " +
    "from get_card_breaks; driverId should be a driver who worked that day. The amount is the " +
    "statement's own; a purchase already recorded or a card already on file is refused.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the card match",
  enabled: () => flags.cardRecon.enabled,
  args: z.strictObject({
    transactionId: idField(),
    driverId: idField(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "card_transactions", id: a.transactionId },
    { table: "drivers", id: a.driverId },
  ],
  limit: (q, ctx, a) => cardMatchLimit(q, ctx, a),
  run: async (q, _ctx, a, extras) => {
    if (!flags.cardRecon.enabled) throw new Error("the card check is switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The engine's figures again, in this call's own transaction: the draft stores these.
    const m = await matchOf(q, a);
    if (!m || m.facts.txn.amountCents !== limit.limitCents) {
      throw new Error("the card transaction changed after its limit");
    }
    const driverId = a.driverId;
    // A driver code did not rank: named by the driver's own code, with no score or reasons.
    let chosen: Candidate | null = m.ranked;
    if (!chosen) {
      const rows = await readRowsWhereId(q, "drivers", "id", driverId);
      if (rows.length !== 1) throw new Error("the driver could not be read");
      chosen = { driverId, code: rows[0].code, score: 0, reasons: [], evidence: [] };
    }
    const sources: GatewayRef[] = [
      { table: "card_transactions", id: m.facts.txn.id },
      { table: "drivers", id: driverId },
    ];
    for (const e of chosen.evidence) if (e.loadId) sources.push({ table: "loads", id: e.loadId });
    const draft = {
      kind: "card_match" as const,
      subjectTable: "card_transactions" as const,
      subjectId: m.facts.txn.id,
      amountCents: cents(m.facts.txn.amountCents),
      args: matchArgs(m.facts.txn, m.candidates, chosen),
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: distinctRefs([...limit.sources, ...sources]),
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        transactionId: m.facts.txn.id,
        driverId,
        driverRanked: m.ranked !== null,
        score: chosen.score,
        amountCents: draft.amountCents,
        exceptions: draft.exceptions,
        note: "A person must approve this before the card goes on the driver's file.",
      },
      draft,
    };
  },
});
