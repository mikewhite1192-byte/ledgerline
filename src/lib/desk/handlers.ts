import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { askFor, tellFor } from "../asks/store";
import { getDb, type Queryable, type TenantDb } from "../db";
import { proposeAdvanceAtPickup } from "../advances/at-pickup";
import { proposeCardLoadRuling } from "../card-loads/ruling";
import { runAudit } from "../agent/auditor/run";
import { runAutopilot } from "../autopilot/run";
import { runCashCheck } from "../cash/check";
import { draftCollections } from "../collections/draft";
import { handOffMessage, sortMessage } from "../inbound/pipeline";
import { moveFromDocument, moveFromMessage, moveFromTmsEvent, type MessageTable, type MoveOutcome } from "../loads/movement";
import { advanceCardCheck, startCardCheck, statementVerdict } from "../recon/run";
import { advanceSweep, startSweep } from "../sweep/run";
import { assertMembership } from "../tenant/context";
import { prepareVoiceNote } from "../voice/pipeline";
import type { DeskSource } from "./keys";
import { categoryWord, type LineDetail } from "./log";
import type { OpenEvent } from "./log";

// What each piece of work is handed to: the entry an existing button already calls, run as the
// carrier's service login. The loop adds nothing to what those entries may do: each re-checks its
// own switch and caps, and none moves money. The loop itself makes no model call.

export type Outcome = "done" | "running" | "skipped" | "failed";
export type HandlerOutcome = { outcome: Outcome; detail: LineDetail };

export type HandlerContext = {
  // The slice's deadline, ms since the epoch: entries that take one stop by it.
  deadlineMs: number;
  clock: () => Date;
};

export type Handler = {
  // The agent's own switch; off, the loop writes skipped switched_off and calls nothing.
  switchOn: () => boolean;
  // How long one call may take at most. A piece of work starts only as a wake's first, or when this
  // much is left before the deadline, so no call outlives the route.
  needsMs: number;
  run: (session: Session, event: OpenEvent, ctx: HandlerContext) => Promise<HandlerOutcome>;
};

export type Handlers = Record<DeskSource, Handler>;

const done = (detail: LineDetail = {}): HandlerOutcome => ({ outcome: "done", detail });
const running = (detail: LineDetail = {}): HandlerOutcome => ({ outcome: "running", detail });
const skipped = (category: string): HandlerOutcome => ({ outcome: "skipped", detail: { category } });
const failed = (category: unknown, detail: LineDetail = {}): HandlerOutcome => ({
  outcome: "failed",
  detail: { ...detail, category: categoryWord(category) },
});

const SWITCHED_OFF = "switched_off";

// A whole count from a run's counts, or absent: unknown is not zero.
function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sumOf(...values: unknown[]): number | undefined {
  let total = 0;
  for (const v of values) {
    const n = whole(v);
    if (n === undefined) return undefined;
    total += n;
  }
  return total;
}

export type HandlerDeps = { db?: TenantDb; newId?: () => string };

// The finished card check that started at or after a card row was written already covers it.
const COVERING_CHECK_SQL = `SELECT CAST(r.id AS text) AS id FROM card_recon_runs r
  WHERE r.tenant_id = current_tenant_id() AND r.status = 'done'
    AND r.started_at >= (SELECT t.created_at FROM card_transactions t
                          WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid))
  ORDER BY r.started_at DESC LIMIT 1`;

// The carrier's newest cash check stored at or after an instant, and how many options it made.
const STORED_CHECK_SQL = `SELECT CAST(c.id AS text) AS id, CAST(jsonb_array_length(c.options) AS integer) AS options
  FROM cash_checks c
 WHERE c.tenant_id = current_tenant_id() AND c.created_at >= CAST($1 AS timestamptz)
 ORDER BY c.created_at DESC, c.id DESC LIMIT 1`;

// What a move did, as a line: moved (found = the moves), a card for a person (found 1), already
// there, or nothing to do. Switched off is skipped.
function moveLine(r: MoveOutcome): HandlerOutcome {
  if (r.kind === "moved") return done({ found: r.events.length, category: "moved" });
  if (r.kind === "card") return done({ found: 1, category: "card" });
  if (r.kind === "already") return done({ found: 0, category: "already" });
  if (r.category === "switched_off") return skipped(SWITCHED_OFF);
  return done({ found: 0, category: r.category });
}

export function deskHandlers(deps: HandlerDeps = {}): Handlers {
  const db = () => deps.db ?? getDb();
  const newId = deps.newId ?? randomUUID;

  // LOAD-MOVEMENT: a driver's message Muse Spark sorted as load_update gets code's check and move
  // (src/lib/loads/movement.ts asks loadMovement itself). Null when code did nothing with it (not
  // sorted so, the switch off, before the start date, no sender, unclear, a driver's card already
  // waiting): the message goes on as before.
  const moveOnMessage = async (session: Session, table: MessageTable, id: string, clock: () => Date) => {
    const r = await db().withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return moveFromMessage(q, session, table, id, clock());
    });
    return r.kind === "nothing" ? null : moveLine(r);
  };

  // A read document matched to one load: its paperwork may move the load (one transaction).
  const document: Handler = {
    switchOn: () => flags.loadMovement.enabled === true,
    needsMs: 5_000,
    async run(session, event, ctx) {
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await db().withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        return moveFromDocument(q, session, id, ctx.clock());
      });
      return moveLine(r);
    },
  };

  // A recorded move. ADVANCE-AT-PICKUP: a move to in transit, for a carrier whose advances unlock
  // at pickup, drafts one advance card for a person to approve (src/lib/advances/at-pickup.ts asks
  // its own switch and start date again). The other lanes that follow a move hang off here too.
  const loadEvent: Handler = {
    switchOn: () => flags.loadMovement.enabled === true || flags.advanceAtPickup.enabled === true,
    needsMs: 2_000,
    async run(session, event, ctx) {
      if (flags.advanceAtPickup.enabled !== true) return done({ found: 0, category: "recorded" });
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await db().withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        return proposeAdvanceAtPickup(q, session, id, ctx.clock());
      });
      if (r.kind === "proposed") return done({ found: 1, category: "advance_proposed" });
      if (r.category === "switched_off") return done({ found: 0, category: "recorded" });
      return done({ found: 0, category: r.category });
    },
  };

  // TMS-MIRROR (0075): a mirrored status event may move its linked load (one transaction).
  // movement.ts asks tmsSync, its start date and loadMovement itself; off, it is skipped.
  const tmsEvent: Handler = {
    switchOn: () => flags.tmsSync.enabled === true,
    needsMs: 5_000,
    async run(session, event, ctx) {
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await db().withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        return moveFromTmsEvent(q, session, id, ctx.clock());
      });
      return moveLine(r);
    },
  };

  // The pay sweep for the carrier's day: start (the schedule trigger returns the day's earlier run),
  // then advance until the deadline; still open, carried on by the next wake with its run id.
  const sweep: Handler = {
    switchOn: () => flags.sweepEnabled === true,
    needsMs: 8_000,
    async run(session, event, ctx) {
      let runId = event.state === "carried" ? event.runId : null;
      if (!runId) {
        const started = await startSweep(session, { runId: newId(), trigger: "schedule" }, { db: db(), clock: ctx.clock });
        if (!started.ok) {
          if (started.category === "disabled") return skipped(SWITCHED_OFF);
          if (started.category === "no_open_period") return skipped("no_open_period");
          return failed(started.category);
        }
        runId = started.runId;
      }
      const r = await advanceSweep(session, runId, ctx.deadlineMs, { db: db(), clock: ctx.clock });
      if (!r.ok) {
        if (r.category === "disabled") return skipped(SWITCHED_OFF);
        if (r.category === "busy") return running({ runId });
        return failed(r.category, { runId });
      }
      if (r.status === "running") return running({ runId });
      if (r.status === "failed") return failed(r.failureCategory ?? "unknown", { runId });
      return done({ runId, found: whole(r.counts.found) });
    },
  };

  // A new card row: the card check, unless a finished check that started after the row was
  // written already covers it (then nothing new is found here, and no second check is run). A
  // finished check's line names the statement's verdict (statement_verified, statement_hold or
  // statement_empty); nothing here pays it.
  // CARD-LOAD-RULING: first, on the row's first try, a load with no payment record behind it drafts
  // one ruling card for a person (src/lib/card-loads/ruling.ts asks its own switch and start date
  // again); the card it drafted counts in the line's found.
  const cardTransaction: Handler = {
    switchOn: () => flags.cardRecon.enabled === true || flags.cardLoadRuling.enabled === true,
    needsMs: 8_000,
    async run(session, event, ctx) {
      let runId = event.state === "carried" ? event.runId : null;
      let drafted = 0;
      let ruling: string | null = null;
      if (!runId && flags.cardLoadRuling.enabled === true) {
        const subjectId = event.subjectId;
        if (!subjectId) return failed("bad_request");
        const r = await db().withTenant(session.tenantId, async (q) => {
          await assertMembership(q, session);
          return proposeCardLoadRuling(q, session, subjectId, ctx.clock());
        });
        drafted = r.kind === "proposed" ? 1 : 0;
        ruling = r.kind === "proposed" ? "ruling_drafted" : `ruling_${r.category}`;
      }
      // The ruling's line alone while the card check is off.
      if (flags.cardRecon.enabled !== true) {
        return ruling === null ? skipped(SWITCHED_OFF) : done({ found: drafted, category: ruling });
      }
      const plus = (found: number | undefined) => (found === undefined ? undefined : found + drafted);
      if (!runId) {
        const subjectId = event.subjectId;
        if (!subjectId) return failed("bad_request");
        const covering = await db().withTenant(session.tenantId, async (q) => {
          await assertMembership(q, session);
          return q.query<{ id: string }>(COVERING_CHECK_SQL, [subjectId]);
        });
        if (covering[0]) return done({ runId: covering[0].id, found: drafted, category: "covered" });
        const started = await startCardCheck(session, { db: db(), clock: ctx.clock });
        if (!started.ok) return ruling === null ? skipped(SWITCHED_OFF) : done({ found: drafted, category: ruling });
        runId = started.runId;
      }
      const r = await advanceCardCheck(session, runId, ctx.deadlineMs, { db: db(), clock: ctx.clock });
      if (!r.ok) {
        if (r.category === "disabled") return ruling === null ? skipped(SWITCHED_OFF) : done({ found: drafted, category: ruling });
        return failed(r.category, { runId });
      }
      const cents = whole(r.run.modelCents);
      if (r.run.status === "running") return running({ runId, cents });
      if (r.run.status === "failed") return failed(r.run.failCategory ?? "unknown", { runId, cents });
      const verdict = statementVerdict(r.run);
      return done({
        runId,
        cents,
        found: plus(sumOf(r.run.counts.statementBreaks, r.run.counts.recordBreaks)),
        ...(verdict ? { category: `statement_${verdict.kind}` } : {}),
      });
    },
  };

  // An inbound message: sort it; a message the sort just put in order is carried to the next wake
  // and handed to the agent there as one turn (the agent proposes, a person approves), so each
  // wake runs at most one of the two. A held message is never handed on. Sorting a message that is
  // already sorted answers at once, with no model call.
  const inboundMessage: Handler = {
    switchOn: () => flags.inboxEnabled === true && flags.aiEnabled === true,
    needsMs: 25_000,
    async run(session, event, ctx) {
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await sortMessage(session, id, { db: db() });
      if (!r.ok) {
        if (r.category === "disabled" || r.category === "ai_off") return skipped(SWITCHED_OFF);
        if (r.retryable) return running();
        return failed(r.category);
      }
      if (r.status === "handed_off") return done({ found: 0, category: "already_handed_off" });
      if (r.status === "blocked") return done({ found: 0, category: "held" });
      if (r.status !== "triaged") return failed(r.category ?? "unknown");
      // A load update is code's to move or card; it is not handed to the agent as a turn.
      if (event.state !== "carried") {
        const moved = await moveOnMessage(session, "inbound_messages", id, ctx.clock);
        if (moved) return moved;
      }
      if (flags.agentEnabled !== true) return done({ found: 0, category: "sorted" });
      if (event.state !== "carried") return running({ category: "sorted" });
      const h = await handOffMessage(session, id, { db: db() });
      if (h.ok) return done({ runId: h.turnId, found: 1, category: "handed_off" });
      if (h.category === "already_handed_off") return done({ found: 0, category: "already_handed_off" });
      if (h.category === "disabled" || h.category === "agent_off" || h.category === "ai_off") return skipped(SWITCHED_OFF);
      if (h.retryable) return running();
      return failed(h.category);
    },
  };

  // A transcribed voice note: prepare it (language, English text, triage). Handing it on stays a
  // person's button.
  const voiceNote: Handler = {
    switchOn: () => flags.voiceIntakeEnabled === true && flags.aiEnabled === true,
    needsMs: 27_000,
    async run(session, event, ctx) {
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await prepareVoiceNote(session, id, { db: db() });
      if (!r.ok) {
        if (r.category === "disabled" || r.category === "ai_off") return skipped(SWITCHED_OFF);
        if (r.retryable) return running();
        return failed(r.category);
      }
      if (r.status === "failed") return failed(r.category ?? "unknown");
      if (r.status === "blocked") return done({ category: "held" });
      const moved = await moveOnMessage(session, "voice_notes", id, ctx.clock);
      return moved ?? done({ category: "ready" });
    },
  };

  // Collections drafts reminders for what is late; a person approves each before it is sent. More
  // late invoices than one call reaches: carried on, counting what each call drafted.
  const collectionsRun = (category: string): Handler["run"] =>
    async (session, event, ctx) => {
      const r = await draftCollections(session, new Date(ctx.deadlineMs), { db: db(), clock: ctx.clock });
      if (!r.ok) return skipped(SWITCHED_OFF);
      const found = (event.state === "carried" ? (event.found ?? 0) : 0) + r.drafted;
      // A model that failed: the reminders it did not write wait for a person's press or the next day.
      if (r.stoppedBy === "model") return failed("model", { found });
      // Its own run cap: the rest wait for the next day's run.
      if (r.stoppedBy === "cap") return done({ found, category: "cap" });
      if (r.more) return running({ found, category });
      return done({ found, category });
    };

  const collections: Handler = {
    switchOn: () => flags.collectionsEnabled === true && flags.aiEnabled === true,
    needsMs: 14_000,
    run: collectionsRun("drafted"),
  };

  // A customer payment: what is still late after it (no money path here, and none is added).
  const customerPayment: Handler = {
    switchOn: () => flags.collectionsEnabled === true && flags.aiEnabled === true,
    needsMs: 14_000,
    run: collectionsRun("after_payment"),
  };

  // Friday's cash check: the gap and the options, each a card a person decides. A check stored
  // since the week's event was first seen (an earlier try whose done line was never written, or a
  // person's press) already covers it: no second check row.
  const cashCheck: Handler = {
    switchOn: () => flags.cashFridayEnabled === true,
    needsMs: 14_000,
    async run(session, event, ctx) {
      const stored = await db().withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        return q.query<{ id: string; options: unknown }>(STORED_CHECK_SQL, [event.firstAt]);
      });
      if (stored[0]) return done({ runId: stored[0].id, found: whole(stored[0].options) });
      const r = await runCashCheck(session, ctx.clock(), { db: db() });
      if (!r.ok) return r.category === "disabled" ? skipped(SWITCHED_OFF) : failed(r.category);
      return done({ runId: r.checkId, found: r.options.length });
    },
  };

  // A proposal waiting for its second check: the auditor (a stored verdict is read back without a
  // call; it bounds its own tries).
  const audit: Handler = {
    switchOn: () => flags.auditorEnabled === true,
    needsMs: 25_000,
    async run(session, event) {
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await runAudit(session, id, { db: db() });
      if (r.state === "done") return done({ found: r.concerns.length, category: r.verdict });
      if (r.state === "in_progress") return running();
      if (r.state === "disabled") return skipped(SWITCHED_OFF);
      if (r.state === "not_auditable") return skipped("not_auditable");
      return failed(r.state);
    },
  };

  // A proposal the auditor passed and the engine matched, of a kind set to Auto: the autopilot's
  // look. The policy decides auto, ask or off in code (never the model); auto goes through the same
  // approval gate a person's press does, as the carrier's autopilot login, and the kind's executor
  // runs. Ask or off is stored and the proposal waits for a person. A pause writes a skipped line
  // (the proposal stays for a person). A proposal already decided is never approved again: an
  // approval that did not finish is reported as an unknown outcome for a person, not retried.
  // The agent's question or told line after the autopilot's look (src/lib/asks), in its own tenant
  // transaction. A failure here never changes the outcome: the proposal's card still waits.
  const noteAsk = async (session: Session, write: (q: Queryable) => Promise<unknown>): Promise<void> => {
    if (flags.agentAsks.enabled !== true) return;
    try {
      await db().withTenant(session.tenantId, async (q) => {
        await assertMembership(q, session);
        await write(q);
      });
    } catch (err) {
      console.warn("desk: the agent's question could not be written:", err instanceof Error ? err.name : "unknown");
    }
  };

  const autopilot: Handler = {
    switchOn: () => flags.autopilot.enabled === true && flags.autopilot.armed === true,
    needsMs: 20_000,
    async run(session, event, ctx) {
      const id = event.subjectId;
      if (!id) return failed("bad_request");
      const r = await runAutopilot(session.tenantId, id, { db: db(), clock: ctx.clock });
      if (!r.ok) return failed(r.category);
      const o = r.result;
      // Done by the autopilot: a told line. Stored as ask: the question, if none is live yet.
      if ((o.outcome === "approved" || (o.outcome === "earlier" && o.mine)) && o.status === "done") {
        await noteAsk(session, (q) => tellFor(q, session.tenantId, id, ctx.clock()));
      } else if (o.outcome === "decided" && o.mode === "ask") {
        await noteAsk(session, (q) => askFor(q, id, ctx.clock(), { mode: "ask" }));
      }
      switch (o.outcome) {
        case "approved":
          if (o.status === "done") return done({ found: 1, category: "executed" });
          return failed(o.status === "failed" ? "executor_failed" : "outcome_unknown");
        case "decided":
          return done({ found: 0, category: o.mode === "off" ? "kept_off" : o.reason });
        case "held":
          if (o.reason === "switched_off" || o.reason === "unarmed") return skipped(SWITCHED_OFF);
          return skipped(o.reason);
        case "executor_refused":
          // The gate expired a proposal too old to approve: nothing ran.
          if (o.category === "expired") return skipped("expired");
          return failed(o.category);
        case "retry":
          return running({ category: o.category });
        case "earlier":
          if (!o.mine) return skipped(o.asked ? "already_asked" : "decided_by_person");
          if (o.status === "expired") return skipped("expired");
          if (o.status === "done") return done({ found: 0, category: "executed" });
          if (o.status === "failed") return failed("executor_failed");
          return failed("outcome_unknown");
      }
    },
  };

  return {
    card_transaction: cardTransaction,
    inbound_message: inboundMessage,
    voice_note: voiceNote,
    customer_payment: customerPayment,
    audit,
    sweep,
    collections,
    cash_check: cashCheck,
    autopilot,
    document,
    load_event: loadEvent,
    tms_event: tmsEvent,
  };
}
