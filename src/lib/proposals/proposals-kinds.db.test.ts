import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROPOSAL_TITLES, dedupeKey } from "../agent/gateway/store/proposals";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";

// The proposals table on a fresh database after 0015: every kind the code knows is a kind the
// table takes, an engine proposal carries none of a chat turn's links, and an agent proposal keeps
// all of them and its trace. Each row is written by the app's role inside this file's own tenant,
// which is removed after (its rows go with it).

let admin: Db;
let app: Db;
let A: Fixture;

type Row = {
  origin?: "agent" | "engine";
  kind?: string;
  conversationId?: string | null;
  turnId?: string | null;
  decisionId?: string | null;
  traceId?: string | null;
};

function insert(o: Row): Promise<number> {
  const id = randomUUID();
  const subjectId = randomUUID();
  const kind = o.kind ?? "invoice_post";
  const title = PROPOSAL_TITLES[kind as keyof typeof PROPOSAL_TITLES] ?? "Unknown";
  return app.withTenant(A.tenantId, (q) =>
    q.execute(
      `INSERT INTO proposals (id, tenant_id, origin, conversation_id, turn_id, gateway_decision_id, trace_id,
         kind, subject_table, subject_id, amount_cents, direction, title, args, operator_verdict, dedupe_key)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid), CAST($5 AS uuid),
         $6, $7, 'invoices', CAST($8 AS uuid), 100, 'none', $9, '{}', 'engine', $10)`,
      [
        id,
        o.origin ?? "engine",
        o.conversationId ?? null,
        o.turnId ?? null,
        o.decisionId ?? null,
        o.traceId ?? null,
        kind,
        subjectId,
        title,
        `${kind}:${subjectId}:${"0".repeat(64)}`,
      ],
    ),
  );
}

describe("proposal kinds and origins on a fresh database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    A = await makeTenant(admin, `kinds-${randomUUID().slice(0, 8)}`);
  });

  afterAll(async () => {
    await dropTenant(admin, A);
    await app?.close();
    await admin?.close();
  });

  it("names its checks as 0015 wrote them", async () => {
    const rows = await admin.withoutTenant((q) =>
      q.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = CAST('public.proposals' AS regclass)
            AND conname IN ('proposals_kind_check', 'proposals_origin_turn_check', 'proposals_origin_trace_check')
          ORDER BY conname`,
      ),
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "proposals_kind_check",
      "proposals_origin_trace_check",
      "proposals_origin_turn_check",
    ]);
  });

  it("takes one engine proposal of every kind the code knows, and refuses any other kind", async () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(await insert({ kind }), kind).toBe(1);
    }
    expect(await sqlStateOf(insert({ kind: "made_up_kind" }))).toBe("23514");
  });

  it("takes every kind any branch knows, so no migration order drops one", async () => {
    // 0013, 0015 and 0022 each re-create the check, so whichever ran last decides it. Every one of
    // them lists these kinds, kinds without code included.
    const union = [
      "advance_payout",
      "pay_correction",
      "invoice_fix",
      "load_rate_fill",
      "invoice_post",
      "payment_reapply",
      "settlement_approve",
      "detention_charge",
    ];
    // 0013 and 0015 list these three more; 0022 does not, so a fresh database in number order ends
    // without them and one where 0013 or 0015 ran last keeps them.
    const widest = [...union, "factoring_request", "bill_defer", "collections_chase"];
    for (const kind of union) {
      expect(await insert({ kind }), kind).toBe(1);
    }
    const [def] = await admin.withoutTenant((q) =>
      q.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = CAST('public.proposals' AS regclass) AND conname = 'proposals_kind_check'`,
      ),
    );
    const listed = [...def.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(listed).toEqual(expect.arrayContaining(union));
    expect(widest).toEqual(expect.arrayContaining(listed));
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps the dedupe key the engine computes inside the table's pattern", () => {
    const key = dedupeKey("invoice_post", randomUUID().toUpperCase(), { loadId: "x", revision: 0 });
    expect(key).toMatch(/^[a-z_]{3,40}:[0-9a-f-]{36}:[0-9a-f]{64}$/);
  });

  it("refuses turn links on an engine proposal and an agent proposal without them", async () => {
    const someId = randomUUID();
    expect(await sqlStateOf(insert({ origin: "engine", conversationId: someId }))).toBe("23514");
    expect(await sqlStateOf(insert({ origin: "agent", traceId: "trace-1" }))).toBe("23514");
    expect(await sqlStateOf(insert({ origin: "made_up" as "agent" }))).toBe("23514");
  });

  it("refuses an agent proposal without its trace, and takes one with every link", async () => {
    const [conversation, turn, decision] = [randomUUID(), randomUUID(), randomUUID()];
    await admin.withTenant(A.tenantId, async (q) => {
      await q.execute(
        "INSERT INTO conversations (id, tenant_id, created_by) VALUES (CAST($1 AS uuid), current_tenant_id(), $2)",
        [conversation, A.session.sub],
      );
      await q.execute(
        `INSERT INTO turns (id, tenant_id, conversation_id, seq, user_text, status, trace_id, started_at, finished_at)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 1, 'Check the books?', 'done', 'trace-1',
           CAST('2026-11-02T15:00:00Z' AS timestamptz), CAST('2026-11-02T15:00:00Z' AS timestamptz))`,
        [turn, conversation],
      );
      await q.execute(
        `INSERT INTO gateway_decisions (id, tenant_id, turn_id, trace_id, role, model, tool, tier, decision, reason, latency_ms)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), 'trace-1', 'operator', 'spark',
           'propose_payment_reapply', 'propose', 'allowed', 'ok', 1)`,
        [decision, turn],
      );
    });
    const links = { origin: "agent" as const, conversationId: conversation, turnId: turn, decisionId: decision };
    expect(await sqlStateOf(insert({ ...links, kind: "payment_reapply" }))).toBe("23514");
    expect(await insert({ ...links, kind: "payment_reapply", traceId: "trace-1" })).toBe(1);
  });
});
