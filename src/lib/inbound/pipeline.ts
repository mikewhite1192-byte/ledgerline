import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError } from "../ai";
import { screenUntrustedInput } from "../agent/gateway";
import { dbTurnStore, openAgentTurn, type StoreDeps } from "../agent/gateway/store";
import { runTriage, triageTarget, type TriageResult } from "../agent/gateway/triage/run";
import type { CompleteFn, GatewayContext, GatewayDeps } from "../agent/gateway/types";
import { defaultTurnDeps, runTurn } from "../agent/operator/turn";
import { LOOP_TEXT } from "../agent/policy";
import type { TurnStatus } from "../agent/view";
import type { Session } from "../auth/claims";
import { untrustedContentHash } from "../data/content-hash";
import { DbError, getDb, type Queryable, type TenantDb } from "../db";
import { readTenantZone } from "../money/read";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import {
  CLAIM_HANDOFF_SQL,
  CLAIM_SORT_SQL,
  countToday,
  findExisting,
  insertInbound,
  LINK_SQL,
  matchDriver,
  readInbound,
  readStep,
  SET_BLOCKED_SQL,
  SET_FAILED_SQL,
  SET_SORTED_SQL,
  UNCLAIM_HANDOFF_SQL,
} from "./store";
import type { InboundMessage, InboundStatus, ReceiveInput } from "./types";

// A driver's message, in three steps, each one request inside the 30 second window:
//   1. receive: check the switch, the size and the carrier's daily count, match the sender to a
//      driver by the whole address, and store the text as an untrusted input with its Inbox row,
//      in one transaction. A repeated paste id or email Message-ID is the row already there.
//   2. sort: the gateway's safety screen (Muse Spark Open), then the triage model's one
//      classify_message call (Muse Spark Open, or Muse Spark when the owner says so). A flagged
//      message is held for a person to read and never sorted or handed on; a failed or timed-out
//      call leaves the row failed with a category, never sorted. Three tries per message.
//   3. hand off: one agent turn with the fixed sentence naming the message's input. The agent
//      reads it through get_inbound_message (screened again, from the cache) and proposes through
//      the usual tools; a person approves.
// Nothing here decides an amount or moves money. Users and stored reasons get categories only;
// the log gets a category or an error's name, never the text, the sender or upstream words.

export const SORT_PURPOSE = "inbound_triage";

// Each sort stops starting new model calls this long after it began, and needs at least
// MIN_CALL_MS left to start the sort's call.
export const STEP_BUDGET_MS = 25_000;
export const MIN_CALL_MS = 3_000;

type Opened = Awaited<ReturnType<typeof openAgentTurn>>;
type OpenTurn = Exclude<Opened, { refused: unknown }>;

export type InboundDeps = {
  db?: TenantDb;
  clock?: () => number;
  newId?: () => string;
  complete?: CompleteFn;
  screen?: typeof screenUntrustedInput;
  triage?: typeof runTriage;
  open?: (session: Session, input: Parameters<typeof openAgentTurn>[1]) => Promise<Opened>;
  run?: (session: Session, turn: OpenTurn, text: string, startedAt: number) => Promise<TurnStatus>;
};

export type Refusal = { ok: false; category: string; retryable: boolean };
const refused = (category: string, retryable = false): Refusal => ({ ok: false, category, retryable });

function inTenant<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

// What a failure may be stored as: a model's category, a database category, or unknown. Never text.
function failCategory(err: unknown): string {
  if (err instanceof AiError) return err.category;
  if (err instanceof DbError) return err.category;
  return "unknown";
}

// What the log may say about a failure: a category or a name, never text.
function errorName(err: unknown): string {
  if (err instanceof AiError || err instanceof DbError) return err.category;
  return err instanceof Error ? err.name : "unknown";
}

// --- 1. receive ---

export type ReceiveResult = { ok: true; message: InboundMessage; duplicate: boolean } | Refusal;

const MAX_ADDRESS = 320;
const MAX_SUBJECT = 300;
const MAX_MESSAGE_ID = 998;
const BRACKETED = /^[^<>]*<([^<>\s]+)>\s*$/;

// The sender's address, whole: "Name <a@b.example>" gives a@b.example; anything else is taken as
// written. Lowercased and trimmed; empty is no address. Never a prefix or a part of one.
export function normalizeAddress(raw: string | null): string | null | "bad" {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const address = (BRACKETED.exec(trimmed)?.[1] ?? trimmed).toLowerCase();
  if (address.length > MAX_ADDRESS || /\s/.test(address)) return "bad";
  return address;
}

// A repeated event, rolled back so its untrusted input is not kept.
class AlreadyHere extends Error {
  constructor() {
    super("inbound message already stored");
    this.name = "AlreadyHere";
  }
}

export async function receiveMessage(
  session: Session,
  input: ReceiveInput,
  deps: InboundDeps = {},
): Promise<ReceiveResult> {
  if (flags.inboxEnabled !== true) return refused("disabled");
  if (!isUuid(input.id)) return refused("bad_request");
  if (input.channel !== "paste" && input.channel !== "email") return refused("bad_request");
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime())) return refused("bad_request");
  const messageId = input.messageId === null ? null : input.messageId.trim();
  if ((input.channel === "email") !== (messageId !== null)) return refused("bad_request");
  if (messageId !== null && (messageId.length === 0 || messageId.length > MAX_MESSAGE_ID)) return refused("bad_request");
  if (typeof input.text !== "string") return refused("bad_request");
  const text = input.text.trim();
  if (text.length === 0) return refused("empty");
  if (text.length > flags.inboxLimits.maxChars) return refused("too_long");
  const fromAddress = normalizeAddress(input.fromAddress);
  if (fromAddress === "bad") return refused("bad_request");
  const subjectText = input.subject?.trim() ?? "";
  // A display line only: a long one is cut, never a reason to lose the message.
  const subject = subjectText === "" ? null : subjectText.slice(0, MAX_SUBJECT);

  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const id = input.id.toLowerCase();
  const nowIso = new Date(clock()).toISOString();
  const row = { ...input, id, text, fromAddress, subject, messageId };

  const existingResult = async (): Promise<ReceiveResult> => {
    const message = await inTenant(db, session, async (q) => {
      const existing = await findExisting(q, id, messageId);
      return existing === null ? null : readInbound(q, existing);
    });
    // The id is another carrier's, or the row went between the two reads.
    return message === null ? refused("conflict") : { ok: true, message, duplicate: true };
  };

  let outcome: { kind: "stored"; message: InboundMessage } | { kind: "duplicate"; message: InboundMessage } | { kind: "cap" };
  try {
    outcome = await inTenant(db, session, async (q) => {
      // A repeated press or delivery first, so it is never counted against the cap.
      const existing = await findExisting(q, id, messageId);
      if (existing !== null) {
        const message = await readInbound(q, existing);
        if (message === null) throw new DbError("unknown");
        return { kind: "duplicate" as const, message };
      }
      if ((await countToday(q, nowIso)) >= flags.inboxLimits.messagesPerDay) return { kind: "cap" as const };
      const driverId = await matchDriver(q, fromAddress);
      const written = await insertInbound(q, row, untrustedContentHash("email", text), {
        inputId: newId(),
        driverId,
        traceId: newId(),
        createdBy: session.sub,
        nowIso,
      });
      if (written === 0) throw new AlreadyHere();
      const message = await readInbound(q, id);
      if (message === null) throw new DbError("unknown");
      return { kind: "stored" as const, message };
    });
  } catch (err) {
    if (err instanceof AlreadyHere) return existingResult();
    throw err;
  }
  if (outcome.kind === "cap") return refused("daily_cap");
  return { ok: true, message: outcome.message, duplicate: outcome.kind === "duplicate" };
}

// --- 2. sort ---

export type StepResult =
  | { ok: true; inboundId: string; status: InboundStatus; category: string | null; attempts: number }
  | Refusal;

const stepOk = (inboundId: string, status: InboundStatus, category: string | null, attempts: number): StepResult => ({
  ok: true,
  inboundId,
  status,
  category,
  attempts,
});

export async function sortMessage(session: Session, inboundId: string, deps: InboundDeps = {}): Promise<StepResult> {
  if (flags.inboxEnabled !== true) return refused("disabled");
  if (flags.aiEnabled !== true) return refused("ai_off");
  if (!isUuid(inboundId)) return refused("bad_request");
  const id = inboundId.toLowerCase();
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const iso = () => new Date(clock()).toISOString();
  const maxAttempts = flags.inboxLimits.maxAttempts;

  const read = await inTenant(db, session, async (q) => ({ row: await readStep(q, id), zone: await readTenantZone(q) }));
  const row = read.row;
  if (!row) return refused("not_found");
  const seen = Number(row.attempts);
  if (!Number.isSafeInteger(seen)) throw new DbError("unknown");
  if (row.status !== "received" && row.status !== "failed") return stepOk(id, row.status, row.fail_category, seen);
  if (seen >= maxAttempts) return refused("no_tries_left");
  if (!row.input_id || row.body_text === null) return refused("not_found");
  const inputId = row.input_id;
  const text = row.body_text;

  // One try, taken before any model call: a second press finds it taken.
  const claimed = await inTenant(db, session, (q) => q.execute(CLAIM_SORT_SQL, [id, seen, iso(), maxAttempts]));
  if (claimed === 0) return refused("busy", true);
  const attempts = seen + 1;

  // Every way out after the claim writes the row's outcome, guarded by this try.
  const fail = async (category: string, giveBack: boolean): Promise<StepResult> => {
    try {
      const changed = await inTenant(db, session, (q) =>
        q.execute(SET_FAILED_SQL, [id, attempts, category, giveBack ? 1 : 0, iso()]),
      );
      if (changed === 0) return current();
    } catch (err) {
      // The row still reads received with this try used, and Sort again picks it up.
      console.error("inbound message failure not recorded:", errorName(err));
      return refused(category, true);
    }
    return stepOk(id, "failed", category, giveBack ? attempts - 1 : attempts);
  };
  const current = async (): Promise<StepResult> => {
    const now = await inTenant(db, session, (q) => readStep(q, id));
    return now ? stepOk(id, now.status, now.fail_category, Number(now.attempts)) : refused("not_found");
  };

  const ctx: GatewayContext = {
    session,
    role: "triage",
    model: "spark_open",
    turnId: null,
    traceId: row.trace_id,
    now: new Date(started),
    deadlineAt: started + STEP_BUDGET_MS,
    timeZone: read.zone,
  };
  const gateway: GatewayDeps = { db, clock, ...(deps.complete ? { complete: deps.complete } : {}) };

  // The safety screen first: nothing reads the words before it passes them.
  let screen: Awaited<ReturnType<typeof screenUntrustedInput>>;
  try {
    screen = await (deps.screen ?? screenUntrustedInput)(ctx, inputId, gateway);
  } catch (err) {
    console.error("inbound message screen failed:", errorName(err));
    return fail(failCategory(err), false);
  }
  // A screen that could not finish (its model failed, or the budget refused it) is stored for ten
  // minutes and is not the message's fault: the try is given back.
  if (screen.decision === "blocked") return fail(screen.reason, true);
  const hash = screen.verdict.contentHash;
  const version = screen.verdict.screenerVersion;
  if (screen.verdict.verdict === "flagged") {
    // Categories are fixed enum words; they go to the log line only.
    console.error("inbound message held for a person:", screen.verdict.categories.join(","));
    let held: number;
    try {
      held = await inTenant(db, session, (q) => q.execute(SET_BLOCKED_SQL, [id, attempts, hash, version, iso()]));
    } catch (err) {
      // An outcome that may or may not have landed: the guarded failure write reads which.
      console.error("inbound message hold not recorded:", errorName(err));
      return fail(failCategory(err), false);
    }
    return held === 0 ? current() : stepOk(id, "blocked", "screen_flagged", attempts);
  }

  if (ctx.deadlineAt - clock() < MIN_CALL_MS) return fail("out_of_time", false);
  const target = triageTarget();
  let sorted: TriageResult;
  try {
    sorted = await (deps.triage ?? runTriage)(ctx, { text, inputId, purpose: SORT_PURPOSE }, gateway);
  } catch (err) {
    console.error("inbound message sort failed:", errorName(err));
    return fail(failCategory(err), false);
  }

  const callId = sorted.callId && isUuid(sorted.callId) ? sorted.callId : null;
  let changed: number;
  try {
    changed = await inTenant(db, session, (q) =>
      q.execute(SET_SORTED_SQL, [
        id,
        attempts,
        hash,
        version,
        sorted.category,
        sorted.urgency,
        sorted.decided ? (sorted.amountCents ?? null) : null,
        JSON.stringify(sorted.decided ? (sorted.dates ?? []) : []),
        callId,
        target,
        sorted.decided ? (sorted.driverId ?? null) : null,
        iso(),
      ]),
    );
  } catch (err) {
    // A sort that may or may not have landed: the failure write is guarded by the status, so it
    // changes nothing if the sort did land, and the answer reads where the message is.
    console.error("inbound message sort not recorded:", errorName(err));
    return fail(failCategory(err), false);
  }
  if (changed === 0) return current();
  return stepOk(id, "triaged", null, attempts);
}

// --- 3. hand off to the agent ---

export type HandOffResult =
  | {
      ok: true;
      inboundId: string;
      status: "handed_off";
      conversationId: string;
      turnId: string;
      turnStatus: TurnStatus;
    }
  | Refusal;

// Names the message's untrusted input, the id get_inbound_message reads it by.
export const handOffText = (inputId: string) => `Handle inbound message ${inputId}`;

// A turn that failed or will never run, closed as failed so it does not stay running.
async function closeFailedTurn(session: Session, turnId: string, store: StoreDeps = {}): Promise<void> {
  try {
    await dbTurnStore(session, store).finishTurn(turnId, {
      status: "failed",
      endedReason: "store",
      text: LOOP_TEXT.failed,
      summary: "",
      stepCount: 0,
      modelCallCount: 0,
      costNanocents: 0,
    });
  } catch (err) {
    console.error("inbound message turn could not be closed:", errorName(err));
  }
}

async function runDefault(session: Session, turn: OpenTurn, text: string, startedAt: number): Promise<TurnStatus> {
  try {
    return (await runTurn({ session, turn, text, startedAt }, defaultTurnDeps(session))).status;
  } catch (err) {
    console.error("inbound message turn failed:", errorName(err));
    await closeFailedTurn(session, turn.turnId);
    return "failed";
  }
}

export async function handOffMessage(session: Session, inboundId: string, deps: InboundDeps = {}): Promise<HandOffResult> {
  if (flags.inboxEnabled !== true) return refused("disabled");
  if (flags.agentEnabled !== true) return refused("agent_off");
  if (flags.aiEnabled !== true) return refused("ai_off");
  if (!isUuid(inboundId)) return refused("bad_request");
  const id = inboundId.toLowerCase();
  const db = deps.db ?? getDb();
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const iso = () => new Date(clock()).toISOString();

  const row = await inTenant(db, session, (q) => readStep(q, id));
  if (!row) return refused("not_found");
  if (row.status === "handed_off") return refused("already_handed_off");
  if (row.status !== "triaged") return refused("not_ready");
  if (!row.input_id) return refused("not_found");

  // Claim the message first, so two presses start one turn.
  const claimed = await inTenant(db, session, (q) => q.execute(CLAIM_HANDOFF_SQL, [id, iso()]));
  if (claimed === 0) return refused("busy", true);

  const text = handOffText(row.input_id);
  let opened: Opened;
  try {
    opened = await (deps.open ?? openAgentTurn)(session, {
      conversationId: null,
      turnId: (deps.newId ?? randomUUID)(),
      text,
      now: new Date(startedAt),
      summaryChars: flags.agentTurnLimits.summaryChars,
    });
  } catch (err) {
    await inTenant(db, session, (q) => q.execute(UNCLAIM_HANDOFF_SQL, [id, iso()]));
    throw err;
  }
  if ("refused" in opened) {
    await inTenant(db, session, (q) => q.execute(UNCLAIM_HANDOFF_SQL, [id, iso()]));
    return refused(opened.refused === "busy" ? "busy" : "not_found", opened.refused === "busy");
  }
  try {
    await inTenant(db, session, (q) => q.execute(LINK_SQL, [id, opened.conversationId, iso()]));
  } catch (err) {
    // The turn opened but the message may not name it. Give the claim back (the unclaim touches
    // only a message with no conversation, so a link that did land stays) and close the turn that
    // will not run.
    try {
      await inTenant(db, session, (q) => q.execute(UNCLAIM_HANDOFF_SQL, [id, iso()]));
    } catch (unclaimErr) {
      console.error("inbound message claim not given back:", errorName(unclaimErr));
    }
    await closeFailedTurn(session, opened.turnId, { db, clock: () => new Date(clock()) });
    throw err;
  }
  const turnStatus = await (deps.run ?? runDefault)(session, opened, text, startedAt);
  return { ok: true, inboundId: id, status: "handed_off", conversationId: opened.conversationId, turnId: opened.turnId, turnStatus };
}
