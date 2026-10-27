import type { Session } from "../../../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../../../db";
import type { TurnView } from "../../view";
import { withAgentTenant } from "../tenant";
import {
  readAuditState,
  releaseAuditLease,
  takeAuditLease,
  writeAuditVerdict,
  type AuditLease,
  type AuditState,
  type VerdictWrite,
} from "./audit";
import { findProposalConflict, flagTurnProposals, persistProposal } from "./proposals";
import { finishStep, finishTurn, openTurn, startStep, type OpenTurnInput } from "./turns";
import type { OpenTurnRefusal, OpenedTurn, TurnStore } from "./types";
import { readRecentTurnViews, readTurnView } from "./views";

// The agent side's only door to its own tables (design 3.7): every call opens the gateway's
// tenant transaction with the membership check. Route and operator code call these; they never
// see the database.

export type { OpenedTurn, OpenTurnRefusal, PersistResult, StepFinish, TurnStore } from "./types";
export { assembleSummary } from "./summary";
export { PROPOSAL_TITLES, canonicalJson, dedupeKey, impactOf } from "./proposals";
export { cardStatusOf } from "./views";
export type { AuditLease, AuditState, VerdictWrite } from "./audit";

export type StoreDeps = { db?: TenantDb; clock?: () => Date };

const UNIQUE_VIOLATION = "23505";

export function dbTurnStore(session: Session, deps: StoreDeps = {}): TurnStore {
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? (() => new Date());
  const tx = <T>(fn: (q: Queryable) => Promise<T>) => withAgentTenant(db, session, fn);
  return {
    startStep: (turnId, step) => tx((q) => startStep(q, turnId, step, clock())),
    finishStep: (turnId, stepId, finish) => tx((q) => finishStep(q, turnId, stepId, finish, clock())),
    persistProposal: async (input) => {
      try {
        return await tx((q) => persistProposal(q, input, clock()));
      } catch (err) {
        if (!(err instanceof DbError) || err.sqlState !== UNIQUE_VIOLATION) throw err;
        const found = await tx((q) => findProposalConflict(q, input));
        if (!found) throw err;
        return found;
      }
    },
    flagTurnProposals: (turnId, inputId) => tx((q) => flagTurnProposals(q, turnId, inputId, clock())),
    finishTurn: (turnId, finish) => tx((q) => finishTurn(q, turnId, finish, clock())),
  };
}

export async function openAgentTurn(
  session: Session,
  input: OpenTurnInput,
  deps: StoreDeps = {},
): Promise<OpenedTurn | { refused: OpenTurnRefusal }> {
  try {
    return await withAgentTenant(deps.db ?? getDb(), session, (q) => openTurn(q, session, input));
  } catch (err) {
    // Two submits raced for the same turn id or the same next seq.
    if (err instanceof DbError && err.sqlState === UNIQUE_VIOLATION) return { refused: "busy" };
    throw err;
  }
}

export async function readAgentTurn(
  session: Session,
  turnId: string,
  deps: StoreDeps = {},
): Promise<TurnView | null> {
  return withAgentTenant(deps.db ?? getDb(), session, (q) => readTurnView(q, session.sub, turnId));
}

export async function readRecentAgentTurns(
  session: Session,
  deps: StoreDeps = {},
): Promise<TurnView[]> {
  return withAgentTenant(deps.db ?? getDb(), session, (q) => readRecentTurnViews(q, session.sub));
}

// The auditor's door to its rows on a proposal (design 4.2 step 4). Each call is its own tenant
// transaction with the membership check; each write is guarded in its WHERE clause.
export interface AuditStore {
  read(proposalId: string): Promise<AuditState | null>;
  // The audit's trace id and this attempt's number when this caller now holds the lease, null
  // when someone else does.
  lease(proposalId: string, now: Date, leaseMs: number, traceId: string): Promise<AuditLease | null>;
  release(proposalId: string, startedAt: Date): Promise<void>;
  // False when a verdict was already there.
  write(proposalId: string, verdict: VerdictWrite, now: Date): Promise<boolean>;
}

export function dbAuditStore(session: Session, deps: StoreDeps = {}): AuditStore {
  const db = deps.db ?? getDb();
  const tx = <T>(fn: (q: Queryable) => Promise<T>) => withAgentTenant(db, session, fn);
  return {
    read: (proposalId) => tx((q) => readAuditState(q, proposalId)),
    lease: (proposalId, now, leaseMs, traceId) =>
      tx((q) => takeAuditLease(q, proposalId, now, leaseMs, traceId)),
    release: async (proposalId, startedAt) => {
      await tx((q) => releaseAuditLease(q, proposalId, startedAt));
    },
    write: (proposalId, verdict, now) => tx((q) => writeAuditVerdict(q, proposalId, verdict, now)),
  };
}
