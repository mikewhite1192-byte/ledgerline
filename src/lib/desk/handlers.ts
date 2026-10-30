import { randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { getDb, type TenantDb } from "../db";
import { runAudit } from "../agent/auditor/run";
import { runCashCheck } from "../cash/check";
import { draftCollections } from "../collections/draft";
import { handOffMessage, sortMessage } from "../inbound/pipeline";
import { advanceCardCheck, startCardCheck } from "../recon/run";
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

export function deskHandlers(deps: HandlerDeps = {}): Handlers {
  const db = () => deps.db ?? getDb();
  const newId = deps.newId ?? randomUUID;

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
  // written already covers it (then nothing new is found here, and no second check is run).
  const cardTransaction: Handler = {
    switchOn: () => flags.cardRecon.enabled === true,
    needsMs: 8_000,
    async run(session, event, ctx) {
      let runId = event.state === "carried" ? event.runId : null;
      if (!runId) {
        const subjectId = event.subjectId;
        if (!subjectId) return failed("bad_request");
        const covering = await db().withTenant(session.tenantId, async (q) => {
          await assertMembership(q, session);
          return q.query<{ id: string }>(COVERING_CHECK_SQL, [subjectId]);
        });
        if (covering[0]) return done({ runId: covering[0].id, found: 0, category: "covered" });
        const started = await startCardCheck(session, { db: db(), clock: ctx.clock });
        if (!started.ok) return skipped(SWITCHED_OFF);
        runId = started.runId;
      }
      const r = await advanceCardCheck(session, runId, ctx.deadlineMs, { db: db(), clock: ctx.clock });
      if (!r.ok) {
        if (r.category === "disabled") return skipped(SWITCHED_OFF);
        return failed(r.category, { runId });
      }
      const cents = whole(r.run.modelCents);
      if (r.run.status === "running") return running({ runId, cents });
      if (r.run.status === "failed") return failed(r.run.failCategory ?? "unknown", { runId, cents });
      return done({ runId, cents, found: sumOf(r.run.counts.statementBreaks, r.run.counts.recordBreaks) });
    },
  };

  // An inbound message: sort it; a message the sort just put in order is carried to the next wake
  // and handed to the agent there as one turn (the agent proposes, a person approves), so each
  // wake runs at most one of the two. A held message is never handed on. Sorting a message that is
  // already sorted answers at once, with no model call.
  const inboundMessage: Handler = {
    switchOn: () => flags.inboxEnabled === true && flags.aiEnabled === true,
    needsMs: 25_000,
    async run(session, event) {
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
    async run(session, event) {
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
      return done({ category: "ready" });
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

  // Friday's cash check: the gap and the options, each a card a person decides.
  const cashCheck: Handler = {
    switchOn: () => flags.cashFridayEnabled === true,
    needsMs: 14_000,
    async run(session, _event, ctx) {
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

  return {
    card_transaction: cardTransaction,
    inbound_message: inboundMessage,
    voice_note: voiceNote,
    customer_payment: customerPayment,
    audit,
    sweep,
    collections,
    cash_check: cashCheck,
  };
}
