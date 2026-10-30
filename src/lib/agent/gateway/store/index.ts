import { flags } from "../../../../config/flags";
import type { Session } from "../../../auth/claims";
import { DbError, getDb, type Queryable, type TenantDb } from "../../../db";
import type { TurnTrace } from "../../../trace/types";
import { relevantNotes, type NoteRow } from "../../../memory/notes";
import { summarizeModelWeek, type ModelWeek } from "../../../trace/week";
import type { TurnView } from "../../view";
import { withAgentTenant } from "../tenant";
import type { GatewayContext } from "../types";
import {
  readAuditState,
  readEngineCheckDue,
  releaseAuditLease,
  takeAuditLease,
  writeAuditVerdict,
  writeEngineCheck,
  type AuditLease,
  type AuditState,
  type VerdictWrite,
} from "./audit";
import { engineCheck } from "./engine-check";
import { findProposalConflict, flagTurnProposals, persistProposal } from "./proposals";
import { finishStep, finishTurn, openTurn, setChecklist, startStep, type OpenTurnInput } from "./turns";
import type { OpenTurnRefusal, OpenedTurn, TurnStore } from "./types";
import { readModelWeek, readTurnTrace, readTurnTraceInRun } from "./trace";
import { readRecentTurnViews, readTurnView } from "./views";

// The agent side's only door to its own tables (design 3.7): every call opens the gateway's
// tenant transaction with the membership check. Route and operator code call these; they never
// see the database.

export type { OpenedTurn, OpenTurnRefusal, PersistResult, StepFinish, TurnStore } from "./types";
export { assembleSummary } from "./summary";
export { PROPOSAL_TITLES, canonicalJson, dedupeKey, impactOf } from "./proposals";
export { cardStatusOf, readEngineProposalViews, readWaitingRuleChangeViews } from "./views";
export type { AuditLease, AuditState, EngineCheckWrite, VerdictWrite } from "./audit";
export { compareEngine, comparePayCorrection, type EngineCheck, type EngineCheckResult } from "./engine-check";

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
    setChecklist: (turnId, checklist) => tx((q) => setChecklist(q, turnId, checklist)),
    finishTurn: (turnId, finish) => tx((q) => finishTurn(q, turnId, finish, clock())),
  };
}

// What a caller of openAgentTurn passes: the turn, and readNotes for one of the operator's own
// questions (the chat, the advance desk, a voice note's hand-off), whose model reads the summary.
// Only those read the carrier notes; a sweep or fan-out check turn leaves it out and gets no notes
// section and no extra transaction.
export type AgentTurnInput = Omit<OpenTurnInput, "notes"> & { readNotes?: boolean };

// The carrier notes for a turn, in their own short read-only transaction before the turn opens:
// a failed read inside the turn's transaction would end it, and a notes problem must never stop a
// question. Off (carrierMemoryEnabled), nothing is read. A read that fails gives no notes and one
// log line with the turn id only.
async function readTurnNotes(
  db: TenantDb,
  session: Session,
  input: Omit<OpenTurnInput, "notes">,
): Promise<readonly NoteRow[] | undefined> {
  if (!flags.carrierMemoryEnabled) return undefined;
  try {
    return await withAgentTenant(db, session, (q) =>
      relevantNotes(q, { conversationId: input.conversationId, sub: session.sub }, flags.carrierMemoryLimits),
    );
  } catch {
    console.error(`memory: notes unreadable for turn ${input.turnId}`);
    return [];
  }
}

export async function openAgentTurn(
  session: Session,
  input: AgentTurnInput,
  deps: StoreDeps = {},
): Promise<OpenedTurn | { refused: OpenTurnRefusal }> {
  const db = deps.db ?? getDb();
  const { readNotes, ...turn } = input;
  const notes = readNotes === true ? await readTurnNotes(db, session, turn) : undefined;
  try {
    return await withAgentTenant(db, session, (q) => openTurn(q, session, { ...turn, notes }));
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
  // Writes as the holder of the lease taken at startedAt. False when a verdict was already there,
  // the proposal was decided, or that lease is no longer this caller's.
  write(proposalId: string, verdict: VerdictWrite, now: Date, startedAt: Date): Promise<boolean>;
  // The code-side engine check (design 3.6), as of ctx.now: computed and stored once, in one
  // transaction, on a proposal still waiting with none stored; anything else is left as it is.
  // No model call. True when this call stored it.
  checkEngine(proposalId: string, ctx: GatewayContext): Promise<boolean>;
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
    write: (proposalId, verdict, now, startedAt) =>
      tx((q) => writeAuditVerdict(q, proposalId, verdict, now, startedAt)),
    checkEngine: (proposalId, ctx) =>
      tx(async (q) => {
        if ((await readEngineCheckDue(q, proposalId)) !== true) return false;
        return writeEngineCheck(q, proposalId, await engineCheck(q, ctx, proposalId), ctx.now);
      }),
  };
}

// How a turn was worked out (MODEL-TRACE), only for the person who started its conversation.
export async function readAgentTurnTrace(
  session: Session,
  turnId: string,
  deps: StoreDeps = {},
): Promise<TurnTrace | null> {
  return withAgentTenant(deps.db ?? getDb(), session, (q) => readTurnTrace(q, session.sub, turnId));
}

// How one turn of a sweep run's second opinion was worked out: any member of the carrier may read
// it, as with the run itself, but only a turn that run names.
export async function readSweepTurnTrace(
  session: Session,
  runId: string,
  turnId: string,
  deps: StoreDeps = {},
): Promise<TurnTrace | null> {
  return withAgentTenant(deps.db ?? getDb(), session, (q) => readTurnTraceInRun(q, runId, turnId));
}

// This carrier's model calls, gateway decisions and screenings for the pay week holding now.
export async function readAgentModelWeek(session: Session, deps: StoreDeps = {}): Promise<ModelWeek> {
  const now = (deps.clock ?? (() => new Date()))();
  const raw = await withAgentTenant(deps.db ?? getDb(), session, (q) => readModelWeek(q, now));
  return summarizeModelWeek(raw);
}
