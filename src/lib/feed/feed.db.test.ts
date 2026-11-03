import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autopilotSub } from "../autopilot/session";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { addAdvance, addJudge, clearLedger, dropTenant, makeTenant, type Fixture } from "../money/test-db";
import { readFeed, readFeedHeader, type FeedRow } from "./read";
import { feedLines } from "./words";

// The live feed's one read against a real database, as the app's own role: each table's steps in
// one list, newest first with ties broken by key in byte order, paged without a repeat or a gap,
// limited across every arm at once, with who did each step as a role word (a login no membership
// names reads "Someone"), a wake that finished nothing and the desk's other lines left out, and
// another carrier's rows never in it. Every row is written by the admin login at fixed instants,
// so nothing depends on the wall clock. Both tenants are removed after.

const T0 = Date.UTC(2026, 10, 2, 16, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const micro = (minutes: number) => at(minutes).replace(/\.(\d{3})Z$/, ".$1000Z");

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
const ids: Record<string, string> = {};

async function exec(f: Fixture, sql: string, params: (string | number | null)[] = []) {
  await admin.withTenant(f.tenantId, (q) => q.execute(sql, params));
}

async function deskLine(f: Fixture, kind: string, minutes: number, detail: object, source: string | null = null) {
  const id = randomUUID();
  const subject = source === null ? null : randomUUID();
  await exec(
    f,
    `INSERT INTO desk_log (id, tenant_id, wake_id, at, kind, event_key, source, by, detail)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS timestamptz), $4, $5, $6, 'schedule',
       CAST($7 AS jsonb))`,
    [id, randomUUID(), at(minutes), kind, source === null ? null : `${source}:${subject}`, source, JSON.stringify(detail)],
  );
  return id;
}

// A waiting proposal for an advance, drafted at `minutes`, audited at `audited` when given.
async function proposal(f: Fixture, title: string, minutes: number, audited: number | null): Promise<string> {
  const [conversation, turn, decision, id, trace] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const advance = await addAdvance(admin, f, 12_500);
  await exec(f, "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)", [
    conversation,
    f.session.sub,
  ]);
  await exec(
    f,
    `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'An advance, please', 'done', $3,
       CAST($4 AS timestamptz), CAST($4 AS timestamptz))`,
    [turn, conversation, trace, at(minutes)],
  );
  await exec(
    f,
    `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, 'operator', 'spark', 'propose_advance_payout',
       'propose', 'allowed', 'ok', 1)`,
    [decision, turn, trace],
  );
  await exec(
    f,
    `INSERT INTO proposals (id, tenant_id, conversation_id, turn_id, kind, subject_table, subject_id,
       amount_cents, direction, title, args, operator_verdict, gateway_decision_id, dedupe_key, trace_id,
       created_at, updated_at, auditor_verdict, auditor_agrees, auditor_checked_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), 'advance_payout',
       'advances', CAST($4 AS uuid), 12500, 'out', $5, CAST('{}' AS jsonb), 'not_given', CAST($6 AS uuid), $7, $8,
       CAST($9 AS timestamptz), CAST($9 AS timestamptz), $10, $11, CAST($12 AS timestamptz))`,
    [
      id,
      conversation,
      turn,
      advance,
      title,
      decision,
      `advance_payout:${advance}:${randomBytes(32).toString("hex")}`,
      trace,
      at(minutes),
      audited === null ? null : "pass",
      audited === null ? null : "true",
      audited === null ? null : at(audited),
    ],
  );
  return id;
}

async function decide(f: Fixture, id: string, status: "approved" | "rejected", by: string, minutes: number, decision: object | null) {
  await exec(
    f,
    `UPDATE proposals SET status = $2, decided_by = $3, decided_at = CAST($4 AS timestamptz),
       autopilot_decision = CAST($5 AS jsonb)
     WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id, status, by, at(minutes), decision === null ? null : JSON.stringify(decision)],
  );
}

// A payout on a fresh advance, reserved at `sent`, sent at `sent`, then left as `end`.
async function payout(f: Fixture, cents: number, sent: number, end: "confirmed_at_once" | "unknown"): Promise<string> {
  const id = randomUUID();
  const advance = await addAdvance(admin, f, cents);
  await exec(
    f,
    `INSERT INTO money_actions (id, tenant_id, kind, channel, subject_table, subject_id, idempotency_key, request_id,
       amount_cents, counterparty_table, counterparty_id, proposed_by, approver_membership_id, created_at)
     VALUES (CAST($1 AS uuid), current_tenant_id(), 'advance_payout', 'payment', 'advances', CAST($2 AS uuid),
       $7, $8, $3, 'drivers', CAST($4 AS uuid), 'agent', CAST($5 AS uuid), CAST($6 AS timestamptz))`,
    [id, advance, cents, f.driverId, f.memberId, at(sent), `advance_payout:${advance}:1`, id.replace(/-/g, "")],
  );
  await exec(
    f,
    "UPDATE money_actions SET state = 'sent', sent_at = CAST($2 AS timestamptz) WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [id, at(sent)],
  );
  if (end === "unknown") {
    await exec(f, "UPDATE money_actions SET state = 'unknown' WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)", [id]);
  } else {
    await exec(
      f,
      `UPDATE money_actions SET state = 'confirmed', settled_at = CAST($2 AS timestamptz), settled_via = 'response',
         outside_system = 'mock', outside_id = 'mock_payout_1', outside_amount_cents = amount_cents
       WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, at(sent)],
    );
  }
  return id;
}

async function pauseChange(f: Fixture, minutes: number, paused: boolean) {
  await exec(
    f,
    `INSERT INTO autopilot_changes (tenant_id, subject, after, changed_by, created_at)
     VALUES (current_tenant_id(), 'pause', CAST($1 AS jsonb), $2, CAST($3 AS timestamptz))`,
    [
      JSON.stringify(paused ? { pausedAt: at(minutes), pausedBy: f.session.sub, pausedUntil: null } : { pausedAt: null, pausedBy: null, pausedUntil: null }),
      f.session.sub,
      at(minutes),
    ],
  );
}

const read = (f: Fixture, limit: number, before: { at: string; key: string } | null = null) =>
  app.withTenant(f.tenantId, (q) => readFeed(q, { limit, before }));

const words = (rows: FeedRow[]) => feedLines(rows, "America/Chicago").map((l) => l.words);

describe("the live feed's read", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `feed-a-${randomUUID().slice(0, 8)}`);
    B = await makeTenant(admin, `feed-b-${randomUUID().slice(0, 8)}`);
    const judge = await addJudge(admin, A);
    for (const f of [A, B]) {
      await exec(
        f,
        `INSERT INTO memberships (tenant_id, cognito_sub, email, role)
         VALUES (current_tenant_id(), $1, 'autopilot@feed.invalid', 'staff') ON CONFLICT (cognito_sub) DO NOTHING`,
        [autopilotSub(f.tenantId)],
      );
    }

    // The desk: a wake (left out), a pickup, a finish that ties with an audit, a wake's end that
    // finished two things, and one that finished nothing (left out of the list, but the last
    // check-in).
    await deskLine(A, "wake", 0, {});
    ids.claimed = await deskLine(A, "claimed", 1, {}, "card_transaction");
    ids.done = await deskLine(A, "done", 6, { category: "drafted", found: 1 }, "inbound_message");
    await deskLine(A, "sleep", 3, { found: 2 });
    await deskLine(A, "sleep", 4, { found: 0 });

    // Proposals: one the autopilot approved within its limit, one staff rejected, one a login no
    // membership names rejected, one a demo visitor rejected.
    ids.p1 = await proposal(A, "Advance for Driver 1", 5, 6);
    await decide(A, ids.p1, "approved", autopilotSub(A.tenantId), 7, { mode: "auto", reason: "within_limits", maxCents: 50_000 });
    ids.p2 = await proposal(A, "Advance for Driver 2", 8, null);
    await decide(A, ids.p2, "rejected", A.session.sub, 9, null);
    ids.p3 = await proposal(A, "Advance for Driver 3", 10, null);
    await decide(A, ids.p3, "rejected", "sub-of-a-login-that-left", 11, null);
    ids.p4 = await proposal(A, "Advance for Driver 4", 11.25, null);
    await decide(A, ids.p4, "rejected", judge.sub, 11.5, null);

    // Money: one sent and confirmed by its answer at once, one with no answer yet.
    ids.m1 = await payout(A, 12_500, 12.5, "confirmed_at_once");
    ids.m2 = await payout(A, 8_000, 13, "unknown");

    // The owner paused the autopilot, then resumed it.
    await pauseChange(A, 14, true);
    await pauseChange(A, 15, false);

    // One approval over a listed set, started and finished.
    ids.batch = randomUUID();
    await exec(
      A,
      `INSERT INTO approval_batches (id, tenant_id, scope, item_ids, total_cents, status, requested_by, created_at, finished_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'proposals', ARRAY[CAST($2 AS uuid)], 12500, 'done', $3,
         CAST($4 AS timestamptz), CAST($5 AS timestamptz))`,
      [ids.batch, ids.p1, A.session.sub, at(16), at(17)],
    );

    // Another carrier's steps, later than all of A's.
    await deskLine(B, "claimed", 30, {}, "card_transaction");
    ids.b1 = await proposal(B, "Advance for another carrier", 31, null);
  });

  afterAll(async () => {
    if (admin) {
      for (const f of [A, B]) if (f) await clearLedger(admin, f);
      await dropTenant(admin, A);
      await dropTenant(admin, B);
    }
    await app?.close();
    await admin?.close();
  });

  it("lists every step newest first, a tie broken by key, in words, with who did each as a role word", async () => {
    const { rows, next } = await read(A, 50);
    expect(next).toBeNull();
    expect(rows.map((r) => [r.at, r.event])).toEqual([
      [micro(17), "batch_finished"],
      [micro(16), "batch_started"],
      [micro(15), "autopilot_resume"],
      [micro(14), "autopilot_pause"],
      [micro(13), "money_sent"],
      [micro(12.5), "money_settled"],
      [micro(11.5), "proposal_decided"],
      [micro(11.25), "proposal_proposed"],
      [micro(11), "proposal_decided"],
      [micro(10), "proposal_proposed"],
      [micro(9), "proposal_decided"],
      [micro(8), "proposal_proposed"],
      [micro(7), "proposal_decided"],
      // The tie at minute 6: "proposal:" sorts after "desk:" in byte order, so it comes first.
      [micro(6), "proposal_audited"],
      [micro(6), "desk_done"],
      [micro(5), "proposal_proposed"],
      [micro(3), "desk_sleep"],
      [micro(1), "desk_claimed"],
    ]);
    expect(words(rows)).toEqual([
      "Batch of 1 card done",
      "Staff approved 1 card, $125.00",
      "Staff resumed the autopilot",
      "Staff paused the autopilot",
      "Not confirmed yet: Payout, $80.00; the desk will read it back",
      "Paid and confirmed: Payout, $125.00",
      "Demo visitor rejected Advance for Driver 4",
      "Agent proposed Advance for Driver 4, $125.00 out",
      "Someone rejected Advance for Driver 3",
      "Agent proposed Advance for Driver 3, $125.00 out",
      "Staff rejected Advance for Driver 2",
      "Agent proposed Advance for Driver 2, $125.00 out",
      "Autopilot approved Advance for Driver 1, $125.00, within its limit of $500.00",
      "Audit passed: Advance for Driver 1",
      "Desk finished a message: drafted",
      "Agent proposed Advance for Driver 1, $125.00 out",
      "Desk checked in: 2 things done",
      "Desk picked up a card transaction",
    ]);
    expect(rows.find((r) => r.event === "money_settled")?.once).toBe(true);
    expect(rows.find((r) => r.event === "money_settled")?.record).toEqual({ table: "advances", id: expect.any(String) });
    expect(rows.some((r) => r.key.includes(ids.m1) && r.event === "money_sent")).toBe(false);
  });

  it("never shows another carrier's steps", async () => {
    const a = await read(A, 50);
    const b = await read(B, 50);
    expect(a.rows.some((r) => r.key.includes(ids.b1))).toBe(false);
    expect(b.rows.map((r) => r.event)).toEqual(["proposal_proposed", "desk_claimed"]);
    expect(b.rows.some((r) => [ids.p1, ids.p2, ids.m1, ids.batch, ids.claimed].some((id) => r.key.includes(id)))).toBe(false);
  });

  it("limits the whole list across every table, and pages back through it with no repeat and no gap", async () => {
    const all = (await read(A, 50)).rows.map((r) => r.key);
    expect((await read(A, 3)).rows.map((r) => r.key)).toEqual(all.slice(0, 3));
    for (const size of [1, 4, 5]) {
      const seen: string[] = [];
      let before: { at: string; key: string } | null = null;
      for (let pages = 0; pages < 40; pages += 1) {
        const page: Awaited<ReturnType<typeof read>> = await read(A, size, before);
        seen.push(...page.rows.map((r) => r.key));
        if (page.next === null) break;
        before = page.next;
      }
      expect(seen, `pages of ${size}`).toEqual(all);
    }
  });

  it("gives the desk's last check-in, quiet or not, and whether the autopilot is paused", async () => {
    const header = await app.withTenant(A.tenantId, (q) => readFeedHeader(q, T0 + 60 * 60_000));
    expect(header).toEqual({ deskCheckedAt: micro(4), paused: false });
    const none = await app.withTenant(B.tenantId, (q) => readFeedHeader(q, T0));
    expect(none).toEqual({ deskCheckedAt: null, paused: false });
  });
});
