import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { callTool } from "../agent/gateway";
import { PROPOSAL_TITLES } from "../agent/gateway/store/proposals";
import type { AgentRole, GatewayContext, ProposalKind } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { ReadLimitError, readTrustInput } from "../data/read";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db } from "../db/types";
import { executeProposal, type Executor, type ExecutorRegistry } from "../proposals/execute";
import { rejectProposal, type RejectCategory } from "../proposals/reject";
import { DEMO_CARRIERS, type DemoCarrier } from "../seed/carriers";
import golden from "../seed/golden.json";
import { buildCarrierPlan, type CarrierPlan } from "../seed/plan";
import { replaceTenantData } from "../seed/run";
import { parseReportArgs } from "./args";
import { reportForSession } from "./for-session";
import { ReportsOffError } from "./switch";
import { bucketWeeks, DISPLAY_ONLY_NOTE, trustReadWindow } from "./trust-meter";
import type { ReportResult } from "./types";

// The review trust meter against a real database, as the app's own role, on both seeded demo
// carriers. Engine cards are written by the admin login (so their audit and recompute results and
// created times can be set), then decided through the real approve and reject gates: each carrier
// counts only its own decisions, by its own pay week in its own zone, with an expired card and a
// waiting one never counted and a decision never checked counted as decided only; the tool and the
// download agree; dark, the tool is unknown and the report is refused; and the paged reader stops
// at its bound. The executor only records its runs, so nothing is paid. The two demo tenants, and
// every card with them, are removed after the file (the fresh test database has no others with
// those slugs).

const [BR, PW] = DEMO_CARRIERS;
const ANCHOR = golden.anchor;
const NOW = Date.UTC(2026, 10, 2, 17, 0, 0);
const HOUR = 3_600_000;

type Seeded = { id: string; carrier: DemoCarrier; plan: CarrierPlan };
const tenants: Seeded[] = [BR, PW].map((carrier) => ({
  id: randomUUID(),
  carrier,
  plan: buildCarrierPlan(carrier, ANCHOR),
}));
const [A, B] = tenants;

let admin: Db;
let app: Db;

const session = (t: Seeded): Session => ({ sub: `sub-${t.id}`, email: `ops@${t.carrier.slug}.example`, tenantId: t.id });

const ctx = (t: Seeded, role: AgentRole = "operator"): GatewayContext => ({
  session: session(t),
  role,
  model: "spark",
  turnId: null,
  traceId: `trace-trust-${t.id.slice(0, 8)}`,
  now: new Date(NOW),
  deadlineAt: NOW + 60_000,
  timeZone: t.carrier.timezone,
});
const clock = () => NOW;
const call = (args: unknown) => ({ id: "c", name: "report_trust_meter", argumentsJson: JSON.stringify(args) });

async function viaTool(t: Seeded, args: Record<string, string>): Promise<Record<string, unknown> & ReportResult> {
  const out = await callTool(ctx(t), call(args), { db: app, clock });
  expect(out.decision, t.carrier.slug).toBe("allowed");
  return out.result as unknown as Record<string, unknown> & ReportResult;
}

async function viaDownload(t: Seeded, args: Record<string, string>): Promise<ReportResult> {
  const request = parseReportArgs("trust_meter", args);
  if (!request) throw new Error("bad args");
  return reportForSession(session(t), request, new Date(NOW), app);
}

// An executor that only counts its runs: no ledger row, no status move past approved.
const ran: string[] = [];
const recorder: Executor = async (_db, _session, p) => {
  ran.push(p.id);
  return { ok: true, proposalId: p.id, status: "recorded", moneyActionId: null };
};
const EXECUTORS: ExecutorRegistry = { invoice_post: recorder, load_rate_fill: recorder };

type Verdict = "pass" | "concerns" | "block" | "unknown";
const AGREES: Record<Verdict, boolean | null> = { pass: true, concerns: false, block: false, unknown: null };
type Card = { kind?: ProposalKind; createdAt: string; verdict: Verdict | null; engine?: "matched" | "mismatch" | null };

// A waiting engine card, written the way the store and the auditor leave it: checked an hour after
// it was made, and the recompute stored with it.
async function addCard(t: Seeded, c: Card): Promise<{ id: string; checkedAt: string | null }> {
  const id = randomUUID();
  const subjectId = randomUUID();
  const kind = c.kind ?? "invoice_post";
  const checkedAt = c.verdict === null ? null : new Date(Date.parse(c.createdAt) + HOUR / 2).toISOString();
  const engine = c.engine ?? null;
  await admin.withTenant(t.id, (q) =>
    q.execute(
      `INSERT INTO proposals (id, tenant_id, origin, kind, subject_table, subject_id, amount_cents, direction, title,
         args, operator_verdict, dedupe_key, created_at, updated_at, auditor_verdict, auditor_agrees,
         auditor_concerns, auditor_checked_at, engine_check, engine_cents, engine_checked_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), 'engine', $2, 'invoices', CAST($3 AS uuid), 100, 'none', $4,
         '{}', 'engine', $5, CAST($6 AS timestamptz), CAST($6 AS timestamptz), $7, $8, CAST($9 AS jsonb),
         CAST($10 AS timestamptz), $11, $12, CAST($13 AS timestamptz))`,
      [
        id,
        kind,
        subjectId,
        PROPOSAL_TITLES[kind],
        `${kind}:${subjectId}:${"0".repeat(64)}`,
        c.createdAt,
        c.verdict,
        c.verdict === null ? null : AGREES[c.verdict],
        JSON.stringify(c.verdict === "block" || c.verdict === "concerns" ? ["amount_wrong"] : []),
        checkedAt,
        engine,
        engine === null ? null : engine === "matched" ? 100 : 90,
        engine === null ? null : checkedAt ?? c.createdAt,
      ],
    ),
  );
  return { id, checkedAt };
}

const at = (iso: string) => () => new Date(iso);
const hourBefore = (iso: string) => new Date(Date.parse(iso) - HOUR).toISOString();

async function approve(t: Seeded, decidedAt: string, card: Omit<Card, "createdAt">, reason?: string): Promise<string> {
  const { id, checkedAt } = await addCard(t, { ...card, createdAt: hourBefore(decidedAt) });
  const opts = reason === undefined ? { confirmed: false } : { confirmed: true, overrideReason: reason, auditedAt: checkedAt };
  const out = await executeProposal(session(t), id, opts, { db: app, clock: at(decidedAt), executors: EXECUTORS });
  expect(out, `approve ${id}`).toMatchObject({ ok: true });
  return id;
}

async function reject(t: Seeded, decidedAt: string, card: Omit<Card, "createdAt">, category: RejectCategory): Promise<string> {
  const { id } = await addCard(t, { ...card, createdAt: hourBefore(decidedAt) });
  expect(await rejectProposal(session(t), id, category, { db: app, clock: at(decidedAt) })).toEqual({ ok: true });
  return id;
}

// Blue Ridge (New York, weeks from Monday) and Prairie Wind (Chicago, weeks from Sunday).
const WED = "2026-10-28T15:00:00.000Z";
const LAST_WED = "2026-10-21T15:00:00.000Z";
// 22:30 on Sunday Nov 1 in New York: the week of Oct 26 there, though Nov 2 in UTC.
const SUNDAY_NIGHT = "2026-11-02T03:30:00.000Z";
const counted: Record<string, string[]> = {};
let waitingId = "";
let expiredId = "";

describe("the review trust meter on a seeded database", () => {
  beforeAll(async () => {
    admin = createPgDb({ connectionString: adminUrl() });
    app = createPgDb({ connectionString: appUrl() });
    const leftover = await admin.withoutTenant((q) =>
      q.query<{ slug: string }>("SELECT slug FROM tenants WHERE slug IN ($1, $2) ORDER BY slug", [BR.slug, PW.slug]),
    );
    if (leftover.length > 0) {
      throw new Error(
        `a tenant ${leftover[0].slug} already exists: the database tests need a fresh database ` +
          "(npm run test:db:fresh)",
      );
    }
    for (const t of tenants) {
      await admin.withTenant(t.id, (q) =>
        q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
          t.carrier.slug,
          t.carrier.name,
          t.carrier.timezone,
        ]),
      );
      await replaceTenantData(app, t.id, t.plan);
      await admin.withTenant(t.id, (q) =>
        q.execute(
          "INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')",
          [`sub-${t.id}`, `ops@${t.carrier.slug}.example`],
        ),
      );
    }
    flags.reportsEnabled = true;
    flags.trustMeterEnabled = true;

    // Blue Ridge's cards, all of one action type.
    counted[A.id] = [
      await approve(A, WED, { verdict: "pass", engine: "matched" }),
      await reject(A, WED, { verdict: "pass", engine: "matched" }, "wrong_amount"),
      await reject(A, WED, { verdict: "pass" }, "not_needed"),
      await approve(A, WED, { verdict: "block" }, "Checked the invoice against the signed rate sheet"),
      await reject(A, WED, { verdict: "pass", engine: "mismatch" }, "wrong_record"),
      await reject(A, WED, { verdict: null }, "wrong_amount"),
      await reject(A, WED, { verdict: "unknown" }, "other"),
      await approve(A, SUNDAY_NIGHT, { verdict: "pass", engine: "matched" }),
      await approve(A, LAST_WED, { verdict: "pass" }),
    ];
    // Eight days old when approved: the gate expires it, and an expired card is no decision.
    const old = await addCard(A, { createdAt: "2026-10-13T14:00:00.000Z", verdict: "pass" });
    expiredId = old.id;
    const expired = await executeProposal(session(A), old.id, { confirmed: false }, {
      db: app,
      clock: at(LAST_WED),
      executors: EXECUTORS,
    });
    expect(expired).toMatchObject({ ok: false, category: "expired" });
    // Still waiting: no decision yet.
    waitingId = (await addCard(A, { createdAt: hourBefore(WED), verdict: "pass" })).id;

    // Prairie Wind's cards, of another action type.
    counted[B.id] = [
      await approve(B, WED, { kind: "load_rate_fill", verdict: "pass", engine: "matched" }),
      await reject(B, WED, { kind: "load_rate_fill", verdict: "pass" }, "wrong_record"),
    ];
  });

  afterAll(async () => {
    flags.reportsEnabled = false;
    flags.trustMeterEnabled = false;
    // Only what this file made: the two tenants (their cards, rows and memberships go with them,
    // by cascade).
    for (const t of tenants) {
      await admin?.withTenant(t.id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
    await app?.close();
    await admin?.close();
  });

  it("counts each carrier's own decisions by its own pay week, the tool and the download alike", async () => {
    expect(ran).toHaveLength(5);
    const post = PROPOSAL_TITLES.invoice_post;
    const fill = PROPOSAL_TITLES.load_rate_fill;
    const a = await viaTool(A, {});
    expect(a.asOf).toBe("2026-11-02");
    expect(a.period).toEqual({ start: "2026-05-11", end: "2026-11-08" });
    expect(a.rows).toEqual([
      { actionType: post, weekStart: "2026-10-19", decided: 1, checked: 1, flagged: 0, passed: 1, wrong: 0, missed: 0, missedBps: null },
      { actionType: post, weekStart: "2026-10-26", decided: 8, checked: 6, flagged: 2, passed: 4, wrong: 3, missed: 1, missedBps: null },
    ]);
    expect(a.subtotals).toEqual([
      { label: post, totals: { decided: 9, checked: 7, flagged: 2, passed: 5, wrong: 3, missed: 1 } },
    ]);
    expect(a.trust).toEqual([{ kind: "invoice_post", upperBps: expect.any(Number), ready: false }]);
    expect(a.notes?.[0]).toBe(DISPLAY_ONLY_NOTE);
    expect(a.notes?.at(-1)).toBe(`Too few to say, under 200 passed: ${post} (5 passed).`);
    const b = await viaTool(B, {});
    expect(b.rows).toEqual([
      { actionType: fill, weekStart: "2026-10-25", decided: 2, checked: 2, flagged: 0, passed: 2, wrong: 1, missed: 1, missedBps: null },
    ]);
    // Neither carrier's result names the other's action type or any card's id.
    expect(JSON.stringify(a)).not.toContain(fill);
    expect(JSON.stringify(b)).not.toContain(post);
    for (const id of [...counted[A.id], ...counted[B.id], waitingId, expiredId]) {
      expect(JSON.stringify(a)).not.toContain(id);
      expect(JSON.stringify(b)).not.toContain(id);
    }
    for (const [t, tool] of [
      [A, a],
      [B, b],
    ] as const) {
      const download = await viaDownload(t, {});
      expect(tool, t.carrier.slug).toEqual({ ...download, truncated: false, rowsShown: download.rows.length });
    }
  });

  it("reads only the carrier's own decided cards, never one expired or waiting", async () => {
    for (const [own, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const window = trustReadWindow(bucketWeeks("2026-11-02", 1));
      const rows = await app.withTenant(own.id, (q) => readTrustInput(q, window));
      expect(rows.map((r) => r.id).sort(), own.carrier.slug).toEqual([...counted[own.id]].sort());
      for (const id of [...counted[other.id], waitingId, expiredId]) {
        expect(rows.some((r) => r.id === id), `${own.carrier.slug} reads ${id}`).toBe(false);
      }
      // The override reason's text is never read, only whether there is one.
      expect(JSON.stringify(rows)).not.toContain("signed rate sheet");
    }
    const overridden = await app.withTenant(A.id, (q) => readTrustInput(q, trustReadWindow(bucketWeeks("2026-11-02", 1))));
    expect(overridden.filter((r) => r.auditor_overridden).map((r) => r.auditor_verdict)).toEqual(["block"]);
  });

  it("pages through the decisions and stops with a read-limit error at its bound", async () => {
    const window = trustReadWindow(bucketWeeks("2026-11-02", 1));
    const whole = await app.withTenant(A.id, (q) => readTrustInput(q, window));
    expect(whole).toHaveLength(9);
    // Nine rows two at a time: the fifth page is short, so the read ends there.
    expect(await app.withTenant(A.id, (q) => readTrustInput(q, window, { pageSize: 2, maxPages: 5 }))).toEqual(whole);
    await expect(
      app.withTenant(A.id, (q) => readTrustInput(q, window, { pageSize: 1, maxPages: 1 })),
    ).rejects.toBeInstanceOf(ReadLimitError);
    // Nine rows three at a time fill every allowed page, so whether a tenth exists is unknown.
    await expect(
      app.withTenant(A.id, (q) => readTrustInput(q, window, { pageSize: 3, maxPages: 3 })),
    ).rejects.toBeInstanceOf(ReadLimitError);
  });

  it("is not offered and is refused while its own switch is off, with the reports on", async () => {
    flags.trustMeterEnabled = false;
    try {
      expect(flags.reportsEnabled).toBe(true);
      for (const role of ["operator", "auditor"] as const) {
        const out = await callTool(ctx(A, role), call({}), { db: app, clock });
        expect(out.decision, role).toBe("unknown_tool");
      }
      await expect(viaDownload(A, {})).rejects.toBeInstanceOf(ReportsOffError);
    } finally {
      flags.trustMeterEnabled = true;
    }
  });
});
