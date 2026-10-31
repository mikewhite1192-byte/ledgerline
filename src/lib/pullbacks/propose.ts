import { flags } from "../../config/flags";
import type { GatewayRef } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import type { Queryable } from "../db";
import { persistEngineProposal } from "../proposals/engine";
import { planPull, type PullAsk, type PullFactRefusal, type PullPlanned } from "./facts";
import { pullbackOn } from "./switches";

// A person's pull-back card (S6 design 4.4): the take-back of a paid advance, with the pull-back
// switch on, makes this card instead of recording the take-back. The engine plans the numbers from
// the card's own records; a person approves the card, and only then does the executor
// (./execute.ts) reserve the ledger row and call the card. Nothing is pulled here.
//
// Inside a tenant transaction the caller holds. One live card per subject (persistEngineProposal):
// the same plan again returns the card already there; a different plan replaces a card nobody has
// approved yet, and a card already approved or running stands.

export type PullProposeResult =
  | { ok: true; proposalId: string; changed: boolean }
  | { ok: false; category: PullFactRefusal | "pullback_off" | "pull_exists" };

export const pullSources = (plan: Pick<PullPlanned, "driverId" | "advanceId">): GatewayRef[] =>
  plan.advanceId === null
    ? [{ table: "drivers", id: plan.driverId }]
    : [
        { table: "drivers", id: plan.driverId },
        { table: "advances", id: plan.advanceId },
      ];

export async function proposePull(q: Queryable, session: Session, ask: PullAsk, now: Date): Promise<PullProposeResult> {
  // The switches again, here as well as by the caller.
  if (!pullbackOn()) return { ok: false, category: "pullback_off" };
  const facts = await planPull(q, ask, flags.advanceTakeback.maxCents, now, { lock: true });
  if (!facts.ok) return { ok: false, category: facts.refusal };
  const plan = facts.plan;
  const saved = await persistEngineProposal(
    q,
    {
      kind: "card_pullback",
      subjectTable: plan.advanceId === null ? "drivers" : "advances",
      subjectId: plan.advanceId ?? plan.driverId,
      amountCents: plan.requestedCents,
      args: { ...plan },
      exceptions: [],
      reasons: [],
      sources: pullSources(plan),
      operatorVerdict: "person_asked",
    },
    session,
    now,
  );
  if (saved.kind === "created") return { ok: true, proposalId: saved.proposalId, changed: true };
  if (saved.kind === "duplicate") return { ok: true, proposalId: saved.proposalId, changed: false };
  // A card already approved or running, or this same plan already decided: never a second card.
  return { ok: false, category: "pull_exists" };
}
