import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { readAgentAsks, readAgentThread } from "../agent/gateway/store";
import type { AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { autopilotSub } from "../autopilot/session";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Param, Queryable } from "../db/types";
import { deskHandlers } from "../desk/handlers";
import { dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { persistEngineProposal } from "../proposals/engine";
import { serviceSub } from "../sweep/service-session";
import { fillReasons, type ReasonCompleteFn } from "./reason";
import { answerAsksFor, askFor, closeStaleAsks, readShowingAsks, snoozeAsk, tellFor } from "./store";

// The agent's questions against the real database, as the app's role: the desk's proposal gets one
// live question even when two writers race; a person's proposal gets none; a question voids when
// its proposal expires or is decided elsewhere (and hides at once); snooze hides it until its
// time; Yes marks it answered once; the autopilot's done proposal gets one told line inside the
// owner's limit; the reason pass keeps a right line, drops a wrong figure, and never calls twice;
// row-level security holds each carrier to its own questions and the guard refuses a changed
// word. A fixed clock; two tenants made here and removed after.

const NOW = Date.UTC(2026, 10, 2, 16, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const clock = () => new Date(NOW);
const savedAsks = structuredClone(flags.agentAsks);
const savedPilot = structuredClone(flags.autopilot);

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
const desk = (f: Fixture): Session => ({ sub: serviceSub(f.tenantId), email: "", tenantId: f.tenantId });

async function addLogins(f: Fixture, slug: string) {
  await admin.withTenant(f.tenantId, async (q) => {
    await q.execute(
      `INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES
         (current_tenant_id(), $1, $2, 'staff'), (current_tenant_id(), $3, $4, 'staff')`,
      [serviceSub(f.tenantId), `sweep@${slug}.invalid`, autopilotSub(f.tenantId), `autopilot@${slug}.invalid`],
    );
    await q.execute(
      `INSERT INTO autopilot_rules (tenant_id, kind, mode, max_cents, day_max_cents, day_max_count, updated_by)
       VALUES (current_tenant_id(), 'invoice_post', 'auto', 150000, 500000, 3, 'setup')`,
    );
  });
}

// An engine card as the desk's login makes it, in one transaction with its question. (A sketch of
// the shape only: the kinds' own lanes build their real args.)
async function deskCard(
  f: Fixture,
  o: { kind?: "advance_payout" | "invoice_post"; amountCents?: number; at?: number; session?: Session } = {},
): Promise<string> {
  const kind = o.kind ?? "advance_payout";
  const session = o.session ?? desk(f);
  const r = await app.withTenant(f.tenantId, (q) =>
    persistEngineProposal(
      q,
      {
        kind,
        // Each card its own subject, so no card retires another; the driver is named in the args.
        subjectTable: "advances",
        subjectId: randomUUID(),
        amountCents: o.amountCents ?? 140_000,
        args: { driverId: f.driverId, percent: 70 },
        exceptions: [],
        reasons: ["paperwork_complete"],
        sources: [{ table: "drivers", id: f.driverId }],
      },
      session,
      new Date(o.at ?? NOW - HOUR),
    ),
  );
  if (r.kind !== "created") throw new Error(`card not created: ${r.kind}`);
  return r.proposalId;
}

type AskRow = { id: string; kind: string; status: string; text: string; reason: string | null; reason_call_id: string | null };
const asksOf = (f: Fixture, proposalId: string) =>
  admin.withTenant(f.tenantId, (q) =>
    q.query<AskRow>(
      `SELECT CAST(id AS text) AS id, kind, status, text, reason, CAST(reason_call_id AS text) AS reason_call_id
         FROM agent_asks WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)
        ORDER BY created_at, kind`,
      [proposalId],
    ),
  );

const asApp = <T>(f: Fixture, fn: (q: Queryable) => Promise<T>) => app.withTenant(f.tenantId, fn);

const errorOf = async (work: Promise<unknown>) => {
  const err = await work.then(
    () => undefined,
    (e: unknown) => e as { sqlState?: string; constraint?: string },
  );
  return err === undefined ? "no error" : (err.constraint ?? err.sqlState);
};

const reject = (f: Fixture, id: string) =>
  asApp(f, (q) =>
    q.execute(
      `UPDATE proposals SET status = 'rejected', decided_by = $2, decided_at = CAST($3 AS timestamptz),
              decision_note = 'not_needed', updated_at = CAST($3 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'proposed'`,
      [id, f.session.sub, new Date(NOW).toISOString()],
    ),
  );

const answer = (text: string): AiResult => ({
  callId: randomUUID(),
  status: "ok",
  text,
  toolCalls: [],
  usage: { input: 10, cached: 0, output: 10, reasoning: 0 },
  costNanocents: 1,
  upstreamId: null,
  replay: [],
  toolSearches: 0,
});

describe("agent asks", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const tag = randomUUID().slice(0, 8);
    A = await makeTenant(admin, `asks-a-${tag}`);
    B = await makeTenant(admin, `asks-b-${tag}`);
    await addLogins(A, `asks-a-${tag}`);
    await addLogins(B, `asks-b-${tag}`);
  });

  beforeEach(() => {
    Object.assign(flags.agentAsks, structuredClone(savedAsks), { enabled: true, reasonEnabled: true });
    Object.assign(flags.autopilot, structuredClone(savedPilot));
  });

  afterEach(() => {
    Object.assign(flags.agentAsks, structuredClone(savedAsks));
    Object.assign(flags.autopilot, structuredClone(savedPilot));
  });

  afterAll(async () => {
    Object.assign(flags.agentAsks, structuredClone(savedAsks));
    Object.assign(flags.autopilot, structuredClone(savedPilot));
    await dropTenant(admin, A);
    await dropTenant(admin, B);
    await app?.close();
    await admin?.close();
  });

  it("asks once about the desk's card, in the code's words, and never about a person's", async () => {
    const id = await deskCard(A);
    const rows = await asksOf(A, id);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "ask", status: "open", text: "Should I send Test Driver an advance of $1,400.00?", reason: null }),
    ]);
    const mine = await deskCard(A, { session: A.session });
    expect(await asksOf(A, mine)).toEqual([]);
  });

  it("keeps one live ask when two writers race and when it is called again", async () => {
    const id = await deskCard(A, { session: A.session });
    const results = await Promise.all([0, 1, 2].map(() => asApp(A, (q) => askFor(q, id, clock()))));
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "exists")).toHaveLength(2);
    expect(await asApp(A, (q) => askFor(q, id, clock()))).toEqual({ kind: "exists" });
    expect((await asksOf(A, id)).filter((r) => r.status === "open")).toHaveLength(1);
  });

  it("asks nothing with the switch off, for a kind it does not ask about, or while the autopilot would do it", async () => {
    const id = await deskCard(A, { session: A.session });
    flags.agentAsks.enabled = false;
    expect(await asApp(A, (q) => askFor(q, id, clock()))).toEqual({ kind: "skipped", category: "switched_off" });
    flags.agentAsks.enabled = true;
    Object.assign(flags.autopilot, { enabled: true, armed: true, startDate: "2026-10-31" });
    const post = await deskCard(A, { kind: "invoice_post", amountCents: 50_000 });
    expect(await asksOf(A, post)).toEqual([]);
    expect(await asApp(A, (q) => askFor(q, post, clock()))).toEqual({ kind: "skipped", category: "autopilot" });
    // The autopilot's own ask decision still asks.
    expect(await asApp(A, (q) => askFor(q, post, clock(), { mode: "ask" }))).toMatchObject({ kind: "created" });
    expect(await asApp(A, (q) => askFor(q, randomUUID(), clock()))).toEqual({ kind: "skipped", category: "not_found" });
  });

  it("voids an ask whose proposal expired or was decided elsewhere, and hides it at once", async () => {
    const old = await deskCard(A, { at: NOW - (flags.proposalMaxAgeDays + 1) * DAY });
    const decided = await deskCard(A);
    const waiting = await deskCard(A);
    expect(await reject(A, decided)).toBe(1);
    const shown = await asApp(A, (q) =>
      readShowingAsks(q, { nowIso: new Date(NOW).toISOString(), sinceIso: null, limit: 50 }),
    );
    const shownIds = shown.asks.map((a) => a.proposalId);
    expect(shownIds).toContain(waiting);
    expect(shownIds).toContain(old);
    expect(shownIds).not.toContain(decided);
    expect(await asApp(A, (q) => closeStaleAsks(q, clock()))).toBeGreaterThanOrEqual(2);
    expect((await asksOf(A, old))[0].status).toBe("void");
    expect((await asksOf(A, decided))[0].status).toBe("void");
    expect((await asksOf(A, waiting))[0].status).toBe("open");
    // A void ask is final.
    const [voided] = await asksOf(A, old);
    expect(
      await errorOf(
        asApp(A, (q) => q.execute("UPDATE agent_asks SET status = 'open' WHERE id = CAST($1 AS uuid)", [voided.id])),
      ),
    ).toBe("23514");
  });

  it("snoozes an ask out of sight until its time, while its proposal waits", async () => {
    const id = await deskCard(A);
    const [ask] = await asksOf(A, id);
    const until = new Date(NOW + 4 * HOUR).toISOString();
    expect(await asApp(A, (q) => snoozeAsk(q, ask.id, until, clock()))).toBe(true);
    const read = (nowMs: number, sinceIso: string | null = null) =>
      asApp(A, (q) => readShowingAsks(q, { nowIso: new Date(nowMs).toISOString(), sinceIso, limit: 50 }));
    expect((await read(NOW)).asks.map((a) => a.id)).not.toContain(ask.id);
    const later = await read(NOW + 4 * HOUR);
    const back = later.asks.find((a) => a.id === ask.id);
    expect(back).toMatchObject({ status: "snoozed", shownAt: until });
    expect((await read(NOW + 4 * HOUR, new Date(NOW + 4 * HOUR - 1).toISOString())).asks.map((a) => a.id)).toContain(ask.id);
    expect((await read(NOW + 4 * HOUR, until)).asks.map((a) => a.id)).not.toContain(ask.id);
    // Not for a decided proposal, nor an id that is not an ask.
    expect(await reject(A, id)).toBe(1);
    expect(await asApp(A, (q) => snoozeAsk(q, ask.id, until, clock()))).toBe(false);
    expect(await asApp(A, (q) => snoozeAsk(q, randomUUID(), until, clock()))).toBe(false);
  });

  it("marks the ask answered once a person's approval went through", async () => {
    const id = await deskCard(A);
    expect(await asApp(A, (q) => answerAsksFor(q, id, A.session.sub, clock()))).toBe(1);
    expect(await asApp(A, (q) => answerAsksFor(q, id, A.session.sub, clock()))).toBe(0);
    const [row] = await admin.withTenant(A.tenantId, (q) =>
      q.query<{ status: string; answered_by: string }>(
        "SELECT status, answered_by FROM agent_asks WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)",
        [id],
      ),
    );
    expect(row).toEqual({ status: "answered", answered_by: A.session.sub });
  });

  it("writes one told line for the autopilot's done proposal, inside the owner's limit", async () => {
    Object.assign(flags.autopilot, { enabled: true, armed: true, startDate: "2026-10-31" });
    const id = await deskCard(A, { kind: "invoice_post", amountCents: 50_000 });
    // A live ask from the autopilot's own ask decision, to be voided when it acts.
    expect(await asApp(A, (q) => askFor(q, id, clock(), { mode: "ask" }))).toMatchObject({ kind: "created" });
    expect(await asApp(A, (q) => tellFor(q, A.tenantId, id, clock()))).toEqual({ kind: "skipped", category: "not_autopilot" });
    // The autopilot's approval as the gate writes it, then the executor's finish.
    await asApp(A, async (q) => {
      await q.execute(
        `UPDATE proposals SET status = 'approved', decided_by = $2, decided_at = CAST($3 AS timestamptz),
                autopilot_decision = CAST($4 AS jsonb), updated_at = CAST($3 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, autopilotSub(A.tenantId), new Date(NOW).toISOString(), JSON.stringify({ mode: "auto", reason: "inside_limits", maxCents: 150_000 })],
      );
      await q.execute("UPDATE proposals SET status = 'executing' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
      await q.execute("UPDATE proposals SET status = 'done' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
    });
    expect(await asApp(A, (q) => tellFor(q, A.tenantId, id, clock()))).toMatchObject({ kind: "created" });
    expect(await asApp(A, (q) => tellFor(q, A.tenantId, id, clock()))).toEqual({ kind: "exists" });
    const rows = await asksOf(A, id);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ["ask", "void"],
      ["told", "open"],
    ]);
    expect(rows[1].text).toBe("Posted a $500.00 invoice to QuickBooks sandbox, inside your $1,500.00 limit.");
  });

  it("asks when the autopilot's look stores ask (over the owner's limit)", async () => {
    Object.assign(flags.autopilot, { enabled: true, armed: true, startDate: "2026-10-31" });
    const id = await deskCard(A, { kind: "invoice_post", amountCents: 900_000 });
    expect(await asksOf(A, id)).toEqual([]);
    await admin.withTenant(A.tenantId, (q) =>
      q.execute(
        `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_concerns = CAST('[]' AS jsonb),
                auditor_checked_at = CAST($2 AS timestamptz), engine_check = 'matched', engine_cents = amount_cents,
                engine_checked_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [id, new Date(NOW - HOUR / 2).toISOString()],
      ),
    );
    const out = await deskHandlers({ db: app }).autopilot.run(
      desk(A),
      {
        eventKey: `autopilot:${id}`,
        source: "autopilot",
        subjectId: id,
        state: "claimed",
        attempts: 1,
        carries: 0,
        threw: 0,
        runId: null,
        found: null,
        firstAt: new Date(NOW).toISOString(),
      },
      { deadlineMs: NOW + 60_000, clock },
    );
    expect(out).toMatchObject({ outcome: "done", detail: { category: "over_item_limit" } });
    expect((await asksOf(A, id)).map((r) => [r.kind, r.status])).toEqual([["ask", "open"]]);
  });

  it("writes a reason once: a right line kept, a wrong figure dropped, no second call", async () => {
    // Close every earlier ask so the pass reads only these two.
    await admin.withTenant(A.tenantId, (q) =>
      q.execute("UPDATE agent_asks SET status = 'void' WHERE tenant_id = current_tenant_id() AND status IN ('open', 'snoozed') AND kind = 'ask'"),
    );
    const right = await deskCard(A);
    const wrong = await deskCard(A, { amountCents: 90_000 });
    const calls: string[] = [];
    const complete: ReasonCompleteFn = async (_t, request) => {
      const facts = JSON.parse(String(request.messages?.at(-1)?.content)) as { amount: string };
      calls.push(facts.amount);
      return facts.amount === "$1,400.00"
        ? answer('{"reason":"The paperwork is in, so the $1,400.00 advance is due."}')
        : answer('{"reason":"The rule allows $950.00 here."}');
    };
    const logs: string[] = [];
    const first = await fillReasons(desk(A), NOW + 60_000, { db: app, clock, complete, log: (l) => logs.push(l) });
    expect(first).toEqual({ tried: 2, kept: 1 });
    expect(calls.sort()).toEqual(["$1,400.00", "$900.00"]);
    expect((await asksOf(A, right))[0]).toMatchObject({ reason: "The paperwork is in, so the $1,400.00 advance is due." });
    const [dropped] = await asksOf(A, wrong);
    expect(dropped.reason).toBeNull();
    expect(dropped.reason_call_id).not.toBeNull();
    expect(logs.join(" ")).toContain("dropped=figures");
    expect(logs.join(" ")).not.toContain("950");
    // A second pass finds nothing left to try.
    expect(await fillReasons(desk(A), NOW + 60_000, { db: app, clock, complete })).toEqual({ tried: 0, kept: 0 });
    expect(calls).toHaveLength(2);
    // The reason is set once.
    expect(
      await errorOf(
        asApp(A, (q) =>
          q.execute("UPDATE agent_asks SET reason = 'changed' WHERE proposal_id = CAST($1 AS uuid)", [right]),
        ),
      ),
    ).toBe("23514");
    // With the reason switch off, no call at all.
    flags.agentAsks.reasonEnabled = false;
    await deskCard(A);
    expect(await fillReasons(desk(A), NOW + 60_000, { db: app, clock, complete })).toEqual({ tried: 0, kept: 0 });
    expect(calls).toHaveLength(2);
  });

  describe("tenant isolation and the guard", () => {
    it("shows each carrier only its own asks, through the agent's read too", async () => {
      const a = await deskCard(A);
      const b = await deskCard(B);
      const [askA] = await asksOf(A, a);
      const fromB = await readAgentAsks(B.session, { sinceIso: null }, { db: app, clock });
      expect(fromB.asks.map((x) => x.proposalId)).toEqual([b]);
      expect(fromB.openCount).toBe(1);
      expect(fromB.now).toBe(new Date(NOW).toISOString());
      const fromA = await readAgentAsks(A.session, { sinceIso: null }, { db: app, clock });
      expect(fromA.asks.map((x) => x.proposalId)).toContain(a);
      expect(fromA.asks.map((x) => x.proposalId)).not.toContain(b);
      // B's login can neither change nor answer A's ask by its id.
      expect(await asApp(B, (q) => snoozeAsk(q, askA.id, new Date(NOW + HOUR).toISOString(), clock()))).toBe(false);
      expect(await asApp(B, (q) => answerAsksFor(q, a, B.session.sub, clock()))).toBe(0);
      expect((await asksOf(A, a))[0].status).toBe("open");
      // Nor write a row into A.
      expect(
        await errorOf(
          asApp(B, (q) =>
            q.execute(
              `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text)
               VALUES (CAST($1 AS uuid), CAST($2 AS uuid), 'ask', CAST($3 AS uuid), 'drivers', CAST($4 AS uuid), 'Hi?')`,
              [randomUUID(), A.tenantId, a, A.driverId] as Param[],
            ),
          ),
        ),
      ).toBe("42501");
      // The thread merges the person's turns (none here) with the asks, oldest first.
      const thread = await readAgentThread(A.session, { db: app, clock });
      expect(thread.turns).toEqual([]);
      expect(thread.thread.map((t) => t.type)).toEqual(thread.asks.map(() => "ask"));
      expect(thread.thread.map((t) => t.id)).toEqual(thread.asks.map((x) => x.id));
      const ats = thread.thread.map((t) => t.at);
      expect([...ats].sort()).toEqual(ats);
    });

    it("refuses changed words, a delete, and a new ask that does not start open", async () => {
      const id = await deskCard(A);
      const [ask] = await asksOf(A, id);
      expect(
        await errorOf(asApp(A, (q) => q.execute("UPDATE agent_asks SET text = 'Approve it?' WHERE id = CAST($1 AS uuid)", [ask.id]))),
      ).toBe("42501");
      expect(await errorOf(asApp(A, (q) => q.execute("DELETE FROM agent_asks WHERE id = CAST($1 AS uuid)", [ask.id])))).toBe("42501");
      expect(
        await errorOf(
          asApp(A, (q) =>
            q.execute(
              `INSERT INTO agent_asks (id, tenant_id, kind, proposal_id, subject_table, subject_id, text, status, answered_by, answered_at)
               VALUES (CAST($1 AS uuid), current_tenant_id(), 'told', CAST($2 AS uuid), 'drivers', CAST($3 AS uuid), 'Done.',
                       'answered', 'x', now())`,
              [randomUUID(), id, A.driverId],
            ),
          ),
        ),
      ).not.toBe("no error");
    });
  });
});
