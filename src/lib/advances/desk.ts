import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { dbTurnStore, openAgentTurn } from "../agent/gateway/store";
import { LOOP_TEXT } from "../agent/policy";
import { defaultTurnDeps, runTurn } from "../agent/operator/turn";
import type { TurnStatus } from "../agent/view";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { readDriverCode, readDriverLoadNumber } from "./read";
import {
  DESK_LOAD_NUMBER,
  deskRequestText,
  isDeskAmount,
  isRequestCategory,
  type AdvanceRequestCategory,
} from "./request";

// The request desk: a person picks a driver, an amount and a reason, and the desk hands the agent
// the same sentence every time ("Request an advance of $300.00 for driver D-01 (fuel)", plus
// "for load <number>" when a load is picked, read back from the driver's own loads). The agent
// then checks eligibility through the gateway and proposes; a person approves on the card. The desk
// itself decides nothing and writes no advance: it is a typed question, run as one agent turn in
// this request (a function call, not an HTTP hop).

export type DeskInput = {
  driverId: string;
  amountCents: number;
  category: AdvanceRequestCategory;
  loadId?: string | null;
};

export type DeskResult =
  | { ok: true; conversationId: string; turnId: string; status: TurnStatus }
  | { ok: false; category: "disabled" | "agent_off" | "ai_off" | "bad_request" | "not_found" | "busy" };

type Opened = Awaited<ReturnType<typeof openAgentTurn>>;

export type DeskDeps = {
  db?: TenantDb;
  clock?: () => number;
  newId?: () => string;
  open?: (session: Session, input: Parameters<typeof openAgentTurn>[1]) => Promise<Opened>;
  run?: (session: Session, turn: Exclude<Opened, { refused: unknown }>, text: string, startedAt: number) => Promise<TurnStatus>;
};

async function runDefault(
  session: Session,
  turn: Exclude<Opened, { refused: unknown }>,
  text: string,
  startedAt: number,
): Promise<TurnStatus> {
  try {
    return (await runTurn({ session, turn, text, startedAt }, defaultTurnDeps(session))).status;
  } catch (err) {
    console.error("desk turn failed:", err instanceof Error ? err.name : "unknown");
    try {
      await dbTurnStore(session).finishTurn(turn.turnId, {
        status: "failed",
        endedReason: "store",
        text: LOOP_TEXT.failed,
        summary: "",
        stepCount: 0,
        modelCallCount: 0,
        costNanocents: 0,
      });
    } catch {
      console.error("desk turn could not be closed");
    }
    return "failed";
  }
}

export async function requestFromDesk(
  session: Session,
  input: DeskInput,
  deps: DeskDeps = {},
): Promise<DeskResult> {
  if (flags.advancesEnabled !== true) return { ok: false, category: "disabled" };
  if (flags.agentEnabled !== true) return { ok: false, category: "agent_off" };
  if (flags.aiEnabled !== true) return { ok: false, category: "ai_off" };
  if (!isDeskAmount(input.amountCents) || !isRequestCategory(input.category)) {
    return { ok: false, category: "bad_request" };
  }
  const db = deps.db ?? getDb();
  const read = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const code = await readDriverCode(q, input.driverId);
    if (code === null || input.loadId === undefined || input.loadId === null) return { code, loadNumber: null };
    return { code, loadNumber: await readDriverLoadNumber(q, input.driverId, input.loadId) };
  });
  if (read.code === null) return { ok: false, category: "not_found" };
  const named = input.loadId !== undefined && input.loadId !== null;
  if (named && read.loadNumber === null) return { ok: false, category: "not_found" };
  if (read.loadNumber !== null && !DESK_LOAD_NUMBER.test(read.loadNumber)) return { ok: false, category: "bad_request" };
  const text = deskRequestText(input.amountCents, read.code, input.category, read.loadNumber);
  const startedAt = (deps.clock ?? Date.now)();
  const opened = await (deps.open ?? openAgentTurn)(session, {
    conversationId: null,
    turnId: (deps.newId ?? randomUUID)(),
    text,
    now: new Date(startedAt),
    summaryChars: flags.agentTurnLimits.summaryChars,
  });
  if ("refused" in opened) return { ok: false, category: opened.refused === "busy" ? "busy" : "not_found" };
  const status = await (deps.run ?? runDefault)(session, opened, text, startedAt);
  return { ok: true, conversationId: opened.conversationId, turnId: opened.turnId, status };
}
