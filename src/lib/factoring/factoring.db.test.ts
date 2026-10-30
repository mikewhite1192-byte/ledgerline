import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { createFactoringSim, factoringBehavior } from "../adapters/factoring/sim";
import type { FactoringAdapter } from "../adapters/types";
import type { Session } from "../auth/claims";
import { runCashCheck } from "../cash/check";
import { factoringArgsSchema, type FactoringArgs } from "../cash/args";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable, TenantDb } from "../db/types";
import { readCashFridayInput } from "../data/read";
import { readTenantZone } from "../money/read";
import { EXECUTORS, executeProposal, type ExecutorRegistry, type ProposalResult } from "../proposals/execute";
import { persistEngineProposal } from "../proposals/engine";
import { computeCashFriday } from "../rules-engine";
import { factoringFor } from "../rules-engine/factoring";
import { DEMO_ANCHOR } from "../seed/anchor";
import { DEMO_CARRIERS } from "../seed/carriers";
import { buildCarrierPlan } from "../seed/plan";
import { clearTenantAgent, replaceTenantData } from "../seed/run";
import { localDateOf } from "../time/local-date";
import { checkPendingFactoring, precheckFactoring, type FactoringDeps } from "./execute";
import { factoringProposalOf } from "./propose";
import { listRequests, readFactoredLine, readFactoringInput, readRequest } from "./read";

// FACTORING against the real database, as the app's role, with the simulated partner (balance
// ending in 99 cents declined, 98 slow, every other funded). An engine Cash Friday card approved
// with every switch on makes one request, one line and one ledger row per invoice, funded, and
// approving it again (or twice at once) writes nothing more. A card with one 99 invoice ends
// partly funded; a 98 invoice stays unknown until Check pending reads it back. A card naming an
// invoice already factored, or any switch off, is refused before anything is written. A card whose
// request write hits a unique index ends failed, so approving it again repeats nothing. A card
// whose run stopped after the approval, or while executing, resumes and sends each invoice once
// (two resumes at once too); with a switch off a resume refuses and writes nothing. Another
// carrier reads and changes nothing. Both demo carriers are seeded from their plans; the two
// tenants are removed after.

const [BR, PW] = DEMO_CARRIERS;
const planA = buildCarrierPlan(BR, DEMO_ANCHOR);
const planB = buildCarrierPlan(PW, DEMO_ANCHOR);

const NOW = new Date(`${DEMO_ANCHOR}T18:00:00.000Z`);
const clock = () => NOW;
const A = randomUUID();
const B = randomUUID();
const ADMIN_A: Session = { sub: `sub-admin-${A}`, email: "admin@factor-a.example", tenantId: A };
const STAFF_B: Session = { sub: `sub-staff-${B}`, email: "staff@factor-b.example", tenantId: B };

const saved = { ...flags, factoring: { ...flags.factoring }, cashFridayLimits: { ...flags.cashFridayLimits } };

function switchesOn(): void {
  flags.cashFridayEnabled = true;
  flags.payoutsEnabled = true;
  flags.factoring.enabled = true;
  flags.factoring.armed = true;
  flags.factoring.requirePacket = false;
}

let admin: Db;
let app: Db;

const explain = async () => ({ ok: true as const, text: "Short for Friday.", callId: randomUUID(), costNanocents: 1 });
const approve = (s: Session, id: string) =>
  executeProposal(s, id, { confirmed: false }, { db: app, clock, executors: EXECUTORS });

async function storePass(tenantId: string, id: string): Promise<void> {
  await admin.withTenant(tenantId, (q) =>
    q.execute(
      `UPDATE proposals SET auditor_verdict = 'pass', auditor_agrees = true, auditor_checked_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id, NOW.toISOString()],
    ),
  );
}

type Proposal = { status: string; money_action_id: string | null; decision_note: string | null; args: string };

async function proposal(id: string): Promise<Proposal> {
  const [row] = await admin.withTenant(A, (q) =>
    q.query<Proposal>(
      `SELECT status, CAST(money_action_id AS text) AS money_action_id, decision_note, CAST(args AS text) AS args
         FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [id],
    ),
  );
  return row;
}

type RequestRow = { id: string; status: string; net_cents: string; funded_at: string | null; membership_id: string };

async function requestFor(proposalId: string): Promise<RequestRow | null> {
  const rows = await admin.withTenant(A, (q) =>
    q.query<RequestRow>(
      `SELECT CAST(id AS text) AS id, status, CAST(net_cents AS text) AS net_cents, CAST(funded_at AS text) AS funded_at,
              CAST(membership_id AS text) AS membership_id
         FROM factoring_requests WHERE tenant_id = current_tenant_id() AND proposal_id = CAST($1 AS uuid)`,
      [proposalId],
    ),
  );
  return rows[0] ?? null;
}

type LineRow = { invoice_id: string; status: string; net_cents: string; money_action_id: string | null; provider_ref: string | null };

async function linesOf(requestId: string): Promise<LineRow[]> {
  return admin.withTenant(A, (q) =>
    q.query<LineRow>(
      `SELECT CAST(invoice_id AS text) AS invoice_id, status, CAST(net_cents AS text) AS net_cents,
              CAST(money_action_id AS text) AS money_action_id, provider_ref
         FROM factoring_request_invoices WHERE tenant_id = current_tenant_id() AND request_id = CAST($1 AS uuid)
        ORDER BY invoice_id`,
      [requestId],
    ),
  );
}

type MoneyRow = {
  id: string;
  subject_id: string;
  state: string;
  settled_via: string | null;
  failure_category: string | null;
  amount_cents: string;
  idempotency_key: string;
  outside_system: string | null;
  counterparty_table: string;
  channel: string;
  proposed_by: string;
};

async function moneyRows(): Promise<MoneyRow[]> {
  return admin.withTenant(A, (q) =>
    q.query<MoneyRow>(
      `SELECT CAST(id AS text) AS id, CAST(subject_id AS text) AS subject_id, state, settled_via, failure_category,
              CAST(amount_cents AS text) AS amount_cents, idempotency_key, outside_system, counterparty_table,
              channel, proposed_by
         FROM money_actions WHERE tenant_id = current_tenant_id() AND kind = 'factoring_advance'
        ORDER BY subject_id, attempt`,
    ),
  );
}

async function countRows(tenantId: string, table: "factoring_requests" | "factoring_request_invoices" | "money_actions"): Promise<number> {
  const [row] = await admin.withTenant(tenantId, (q) =>
    q.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = current_tenant_id()`),
  );
  return Number(row.n);
}

// The open load invoices the engine will factor today, one at a time, largest balance first.
async function factorable(): Promise<{ id: string; balance: number }[]> {
  return app.withTenant(A, async (q) => {
    const rows = await q.query<{ id: string; balance: string }>(
      `SELECT CAST(i.id AS text) AS id,
              CAST(i.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM payment_applications a
                                               WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id), 0) AS text) AS balance
         FROM invoices i
        WHERE i.tenant_id = current_tenant_id() AND i.source = 'load' AND i.status IN ('open', 'partially_paid')
        ORDER BY 2 DESC, i.invoice_number`,
    );
    // The engine's own checks, on one read of the carrier's records (the card path reads the
    // same input per card).
    const zone = await readTenantZone(q);
    const today = localDateOf(NOW.toISOString(), zone);
    const limits = flags.cashFridayLimits;
    const cash = computeCashFriday(await readCashFridayInput(q, zone, limits), today);
    if (!cash.ok || cash.figures.gapCents >= 0) throw new Error("the carrier is not short");
    const input = await readFactoringInput(q, cash.periodId);
    const opts = { maxAgeDays: limits.factoringMaxAgeDays, maxInvoices: limits.maxFactorInvoices };
    return rows
      .filter((r) => factoringFor(input, [r.id], today, opts, -cash.figures.gapCents).ok)
      .map((r) => ({ id: r.id, balance: Number(r.balance) }));
  });
}

// Moves an invoice's balance by under a dollar so it ends in the given cents (the simulated
// partner's convention). Written by the admin login; no money moves.
async function endBalanceIn(invoiceId: string, balance: number, tail: number): Promise<void> {
  const delta = tail - (balance % 100);
  await admin.withTenant(A, (q) =>
    q.execute(
      "UPDATE invoices SET amount_cents = amount_cents + $2 WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
      [invoiceId, delta],
    ),
  );
}

// An engine factoring card for exactly these invoices, sized by the rules engine now, with the
// auditor's pass stored. Persisting retires any other waiting factoring card for the week.
async function cardFor(invoiceIds: string[]): Promise<{ id: string; args: FactoringArgs }> {
  const made = await app.withTenant(A, async (q: Queryable) => {
    const p = await factoringProposalOf(q, await readTenantZone(q), NOW, invoiceIds);
    if (!p.ok) throw new Error(`the engine refused the card: ${p.category}`);
    const r = await persistEngineProposal(
      q,
      {
        kind: "factoring_request",
        subjectTable: "settlement_periods",
        subjectId: p.option.subjectId,
        amountCents: p.option.amountCents,
        args: p.args,
        exceptions: [],
        reasons: [],
        sources: p.option.sources,
      },
      ADMIN_A,
      NOW,
    );
    if (r.kind !== "created") throw new Error(`the card was not created: ${r.kind}`);
    return { id: r.proposalId, args: p.args };
  });
  await storePass(A, made.id);
  return made;
}

// Invoices the engine would factor today that the simulated partner funds, n of them.
async function fundable(n: number): Promise<string[]> {
  const picked = (await factorable()).filter((c) => factoringBehavior(c.balance) === "funded").slice(0, n);
  if (picked.length < n) throw new Error(`only ${picked.length} invoices left to factor`);
  return picked.map((c) => c.id);
}

// The gate's real precheck and approve write, then the run stops before the executor's first
// transaction (the process went away): the card is left approved with nothing else written.
const STOPPED = "stopped after the approval";
const stopsAfterApproval: ExecutorRegistry = {
  factoring_request: Object.assign(
    async (): Promise<ProposalResult> => {
      throw new Error(STOPPED);
    },
    { precheck: precheckFactoring },
  ),
};

async function approveThenStop(id: string): Promise<void> {
  await expect(
    executeProposal(ADMIN_A, id, { confirmed: false }, { db: app, clock, executors: stopsAfterApproval }),
  ).rejects.toThrow(STOPPED);
  expect((await proposal(id)).status).toBe("approved");
  expect(await requestFor(id)).toBeNull();
}

// The simulated partner, noting every invoice offered to it.
function countingPartner(): { adapter: FactoringAdapter; sent: string[] } {
  const sim = createFactoringSim({ log: () => undefined });
  const sent: string[] = [];
  return {
    sent,
    adapter: {
      system: sim.system,
      ready: () => sim.ready(),
      submitInvoice: (r, ctx) => {
        sent.push(r.invoiceNumber);
        return sim.submitInvoice(r, ctx);
      },
      readBack: (ref, ctx) => sim.readBack(ref, ctx),
    },
  };
}

// Resume is the same approve request again (the card's Resume button sends it).
function resume(id: string, adapter: FactoringAdapter, db: TenantDb = app): Promise<ProposalResult> {
  const deps: FactoringDeps = { db, clock, executors: EXECUTORS, adapter };
  return executeProposal(ADMIN_A, id, { confirmed: false }, deps);
}

const ledgerFor = async (ids: readonly string[]) => (await moneyRows()).filter((m) => ids.includes(m.subject_id));

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  for (const [id, plan] of [
    [A, planA],
    [B, planB],
  ] as const) {
    await admin.withTenant(id, (q) =>
      q.execute("INSERT INTO tenants (id, slug, name, timezone) VALUES (current_tenant_id(), $1, $2, $3)", [
        plan.carrier.slug,
        plan.carrier.name,
        plan.carrier.timezone,
      ]),
    );
    await replaceTenantData(app, id, plan);
  }
  await admin.withTenant(A, (q) =>
    q.execute("INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'admin')", [
      ADMIN_A.sub,
      ADMIN_A.email,
    ]),
  );
  await admin.withTenant(B, (q) =>
    q.execute("INSERT INTO memberships (tenant_id, cognito_sub, email, role) VALUES (current_tenant_id(), $1, $2, 'staff')", [
      STAFF_B.sub,
      STAFF_B.email,
    ]),
  );
});

afterEach(() => {
  Object.assign(flags, saved, { factoring: { ...saved.factoring }, cashFridayLimits: { ...saved.cashFridayLimits } });
});

afterAll(async () => {
  Object.assign(flags, saved, { factoring: { ...saved.factoring }, cashFridayLimits: { ...saved.cashFridayLimits } });
  if (admin) {
    for (const id of [A, B]) {
      await clearTenantAgent(admin, id).catch(() => undefined);
      await admin.withTenant(id, (q) => q.execute("DELETE FROM tenants WHERE id = current_tenant_id()"));
    }
  }
  await app?.close();
  await admin?.close();
});

describe("factoring on the real database", { timeout: 60_000 }, () => {
  let engineCard: { id: string; args: FactoringArgs };
  let engineRequest: RequestRow;

  it("funds the Cash Friday card once, one line and one ledger row per invoice, however often it is approved", async () => {
    switchesOn();
    const check = await runCashCheck(ADMIN_A, NOW, { db: app, explain });
    if (!check.ok) throw new Error(`the check refused: ${check.category}`);
    const option = check.options.find((o) => o.kind === "factoring_request");
    if (!option) throw new Error("no factoring card");
    const stored = await proposal(option.proposalId);
    const args = factoringArgsSchema.parse(JSON.parse(stored.args));
    engineCard = { id: option.proposalId, args };
    // The seeded balances are all funded by the simulated partner.
    expect(args.invoices.every((i) => factoringBehavior(i.balanceCents) === "funded")).toBe(true);
    await storePass(A, engineCard.id);

    // Two presses at once: the second either finds the card decided or resumes the first run's
    // request; the ledger's one row per invoice keeps either from sending twice.
    const results = await Promise.all([approve(ADMIN_A, engineCard.id), approve(ADMIN_A, engineCard.id)]);
    expect(results.some((r) => r.ok && r.status === "done")).toBe(true);
    for (const r of results) expect(r.ok ? r.status : r.category).toMatch(/^(done|already_decided)$/);
    expect(await approve(ADMIN_A, engineCard.id)).toMatchObject({ ok: false, category: "already_decided" });

    const request = await requestFor(engineCard.id);
    if (!request) throw new Error("no factoring request");
    engineRequest = request;
    expect([request.status, Number(request.net_cents), request.funded_at !== null]).toEqual(["funded", args.amountCents, true]);
    const lines = await linesOf(request.id);
    expect(lines.map((l) => l.invoice_id)).toEqual(args.invoices.map((i) => i.invoiceId).sort());
    expect(lines.every((l) => l.status === "funded" && /^fsim_adv_[0-9a-f]{24}$/.test(l.provider_ref ?? ""))).toBe(true);

    const money = await moneyRows();
    expect(money).toHaveLength(args.invoices.length);
    for (const i of args.invoices) {
      const row = money.find((m) => m.subject_id === i.invoiceId);
      expect(row).toMatchObject({
        state: "confirmed",
        settled_via: "response",
        amount_cents: String(i.netCents),
        idempotency_key: `factoring_advance:${i.invoiceId}:1`,
        outside_system: "factoring_sim",
        counterparty_table: "customers",
        channel: "payment",
        proposed_by: "person",
      });
      expect(lines.find((l) => l.invoice_id === i.invoiceId)?.money_action_id).toBe(row?.id);
    }
    const done = await proposal(engineCard.id);
    expect(done.status).toBe("done");
    expect(money.map((m) => m.id)).toContain(done.money_action_id);
  });

  it("reads the request back through the app role and marks each invoice factored", async () => {
    const list = await app.withTenant(A, (q) => listRequests(q, 50));
    expect(list.map((r) => [r.id, r.status, r.invoiceCount, r.netCents, r.proposalId])).toEqual([
      [engineRequest.id, "funded", engineCard.args.invoices.length, engineCard.args.amountCents, engineCard.id],
    ]);
    expect(list[0].balanceCents).toBe(engineCard.args.balanceCents);
    expect(list[0].reserveCents).toBe(engineCard.args.reserveCents);
    const detail = await app.withTenant(A, (q) => readRequest(q, engineRequest.id));
    expect(detail?.lines.map((l) => l.invoiceNumber)).toEqual(engineCard.args.invoices.map((i) => i.invoiceNumber).sort());
    expect(detail?.lines.every((l) => l.packet.invoice === true)).toBe(true);
    const first = engineCard.args.invoices[0].invoiceId;
    expect(await app.withTenant(A, (q) => readFactoredLine(q, first))).toMatchObject({ requestId: engineRequest.id, status: "funded" });
  });

  it("never offers or chases a factored invoice again", async () => {
    switchesOn();
    const check = await runCashCheck(ADMIN_A, NOW, { db: app, explain });
    if (!check.ok) throw new Error(`the check refused: ${check.category}`);
    const sold = new Set(engineCard.args.invoices.map((i) => i.invoiceId));
    const option = check.options.find((o) => o.kind === "factoring_request");
    if (option) {
      const args = factoringArgsSchema.parse(JSON.parse((await proposal(option.proposalId)).args));
      expect(args.invoices.some((i) => sold.has(i.invoiceId))).toBe(false);
    }
    const left = await factorable();
    expect(left.some((i) => sold.has(i.id))).toBe(false);
  });

  it("refuses a card that names an invoice already factored, before anything is written", async () => {
    switchesOn();
    // The funded card's own figures under a new card (a different short, so a new card).
    const copy = { ...engineCard.args, shortCents: engineCard.args.shortCents + 1 };
    const id = await app.withTenant(A, async (q) => {
      const r = await persistEngineProposal(
        q,
        {
          kind: "factoring_request",
          subjectTable: "settlement_periods",
          subjectId: copy.periodId,
          amountCents: copy.amountCents,
          args: copy,
          exceptions: [],
          reasons: [],
          sources: copy.invoices.map((i) => ({ table: "invoices" as const, id: i.invoiceId })),
        },
        ADMIN_A,
        NOW,
      );
      return r.proposalId;
    });
    await storePass(A, id);
    const before = [await countRows(A, "factoring_requests"), await countRows(A, "money_actions")];
    expect(await approve(ADMIN_A, id)).toMatchObject({ ok: false, category: "invoices_changed" });
    expect([await countRows(A, "factoring_requests"), await countRows(A, "money_actions")]).toEqual(before);
    expect((await proposal(id)).status).toBe("proposed");
  });

  it("refuses with any switch off, and writes nothing", async () => {
    const [one] = await factorable();
    const card = await cardFor([one.id]);
    const before = [await countRows(A, "factoring_requests"), await countRows(A, "money_actions")];
    for (const [flip, category] of [
      [() => (flags.factoring.armed = false), "factoring_not_armed"],
      [() => (flags.payoutsEnabled = false), "factoring_payouts_off"],
      [() => (flags.factoring.maxNetCents = card.args.amountCents - 1), "over_factoring_cap"],
      [() => (flags.factoring.startDate = "2026-11-03"), "factoring_before_start"],
    ] as const) {
      switchesOn();
      flags.factoring.maxNetCents = saved.factoring.maxNetCents;
      flags.factoring.startDate = saved.factoring.startDate;
      flip();
      expect(await approve(ADMIN_A, card.id)).toMatchObject({ ok: false, category });
    }
    expect([await countRows(A, "factoring_requests"), await countRows(A, "money_actions")]).toEqual(before);
    expect((await proposal(card.id)).status).toBe("proposed");
  });

  it("ends the card when its request's write hits a unique index, and approving again changes nothing", async () => {
    switchesOn();
    const [x, y] = await factorable();
    const card = await cardFor([x.id, y.id]);
    // The request's id, then one id for every line: the second line's write hits the line key, the
    // same unique violation (23505) the one-live-line-per-invoice index raises when another request
    // takes an invoice first, and the request's transaction rolls back.
    const lineId = randomUUID();
    let calls = 0;
    const deps: FactoringDeps = {
      db: app,
      clock,
      executors: EXECUTORS,
      newId: () => (calls++ === 0 ? randomUUID() : lineId),
    };
    const tables = ["factoring_requests", "factoring_request_invoices", "money_actions"] as const;
    const counts = () => Promise.all(tables.map((t) => countRows(A, t)));
    const before = await counts();
    expect(await executeProposal(ADMIN_A, card.id, { confirmed: false }, deps)).toMatchObject({
      ok: false,
      category: "invoices_changed",
    });
    expect(calls).toBe(3);
    expect(await counts()).toEqual(before);
    const ended = await proposal(card.id);
    expect([ended.status, ended.decision_note, ended.money_action_id]).toEqual(["failed", "refused: invoices_changed", null]);
    // Approving again finds the card decided: nothing is sent, and the refusal is not run again.
    expect(await approve(ADMIN_A, card.id)).toMatchObject({ ok: false, category: "already_decided" });
    expect(await counts()).toEqual(before);
  });

  it("declines a 99-cent invoice alone and funds the rest: partly funded, the card done", async () => {
    switchesOn();
    const [x, y] = await factorable();
    await endBalanceIn(x.id, x.balance, 99);
    if (factoringBehavior(y.balance) !== "funded") await endBalanceIn(y.id, y.balance, 0);
    const card = await cardFor([x.id, y.id]);
    expect(await approve(ADMIN_A, card.id)).toMatchObject({ ok: true, status: "done" });
    const request = await requestFor(card.id);
    expect(request?.status).toBe("partly_funded");
    const lines = await linesOf(request?.id ?? "");
    expect(Object.fromEntries(lines.map((l) => [l.invoice_id, l.status]))).toEqual({ [x.id]: "declined", [y.id]: "funded" });
    // The request keeps its planned total; what came in is the funded invoice's own net only.
    const planned = lines.reduce((t, l) => t + Number(l.net_cents), 0);
    const cameIn = Number(lines.find((l) => l.invoice_id === y.id)?.net_cents);
    const listed = (await app.withTenant(A, (q) => listRequests(q, 50))).find((r) => r.id === request?.id);
    const detail = await app.withTenant(A, (q) => readRequest(q, request?.id ?? ""));
    for (const r of [listed, detail]) {
      expect(r).toMatchObject({ id: request?.id, status: "partly_funded", netCents: planned, cameInCents: cameIn });
    }
    expect(cameIn).toBeLessThan(planned);
    const money = await moneyRows();
    expect(money.find((m) => m.subject_id === x.id)).toMatchObject({ state: "failed", failure_category: "declined" });
    expect(money.find((m) => m.subject_id === y.id)).toMatchObject({ state: "confirmed" });
    // The proposal names the funded line's ledger row.
    expect((await proposal(card.id)).money_action_id).toBe(money.find((m) => m.subject_id === y.id)?.id);
    // The declined invoice is the carrier's again: the engine offers it once more.
    expect((await factorable()).some((i) => i.id === x.id)).toBe(true);
  });

  it("keeps a 98-cent invoice unknown until Check pending reads it back, then funds it", async () => {
    switchesOn();
    const candidates = await factorable();
    const z = candidates.find((c) => factoringBehavior(c.balance) !== "declined") ?? candidates[0];
    await endBalanceIn(z.id, z.balance, 98);
    const card = await cardFor([z.id]);
    expect(await approve(ADMIN_A, card.id)).toMatchObject({ ok: true, status: "executing" });
    const request = await requestFor(card.id);
    if (!request) throw new Error("no factoring request");
    expect(request.status).toBe("unknown");
    expect((await linesOf(request.id)).map((l) => l.status)).toEqual(["unknown"]);
    expect((await moneyRows()).find((m) => m.subject_id === z.id)?.state).toBe("unknown");
    expect((await proposal(card.id)).status).toBe("executing");

    // Approving again sends nothing new.
    const rowsBefore = await countRows(A, "money_actions");
    await approve(ADMIN_A, card.id);
    expect(await countRows(A, "money_actions")).toBe(rowsBefore);

    const checked = await checkPendingFactoring(ADMIN_A, request.id, { db: app, clock });
    expect(checked).toMatchObject({ ok: true, status: "funded", tooNew: 0, stillWaiting: 0 });
    if (checked.ok) expect(checked.summary.confirmed).toBe(1);
    expect((await linesOf(request.id)).map((l) => l.status)).toEqual(["funded"]);
    expect((await moneyRows()).find((m) => m.subject_id === z.id)).toMatchObject({ state: "confirmed", settled_via: "read_back" });
    const closed = await proposal(card.id);
    expect(closed.status).toBe("done");
    expect(closed.money_action_id).not.toBeNull();
    // A second press finds nothing waiting.
    const second = await checkPendingFactoring(ADMIN_A, request.id, { db: app, clock });
    expect(second).toMatchObject({ ok: true, status: "funded" });
    if (second.ok) expect(second.summary.checked).toBe(0);
  });

  it("resumes a card whose run stopped right after the approval, and sends each invoice once", async () => {
    switchesOn();
    const ids = await fundable(1);
    const card = await cardFor(ids);
    await approveThenStop(card.id);
    const partner = countingPartner();
    expect(await resume(card.id, partner.adapter)).toMatchObject({ ok: true, status: "done" });
    expect(partner.sent).toEqual([card.args.invoices[0].invoiceNumber]);
    const request = await requestFor(card.id);
    expect(request?.status).toBe("funded");
    expect((await linesOf(request?.id ?? "")).map((l) => l.status)).toEqual(["funded"]);
    const rows = await ledgerFor(ids);
    expect(rows.map((m) => m.state)).toEqual(["confirmed"]);
    expect((await proposal(card.id)).money_action_id).toBe(rows[0].id);
    // Pressed again: the card is decided, and nothing more is sent or written.
    expect(await resume(card.id, partner.adapter)).toMatchObject({ ok: false, category: "already_decided" });
    expect(partner.sent).toHaveLength(1);
    expect(await ledgerFor(ids)).toHaveLength(1);
  });

  it("sends each invoice once when two resumes of a stopped card run at once", async () => {
    switchesOn();
    const ids = await fundable(2);
    const card = await cardFor(ids);
    await approveThenStop(card.id);
    const partner = countingPartner();
    const results = await Promise.all([resume(card.id, partner.adapter), resume(card.id, partner.adapter)]);
    for (const r of results) expect(r.ok ? r.status : r.category).toMatch(/^(done|already_decided)$/);
    expect(results.some((r) => r.ok && r.status === "done")).toBe(true);
    expect([...partner.sent].sort()).toEqual(card.args.invoices.map((i) => i.invoiceNumber).sort());
    const rows = await ledgerFor(ids);
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => m.state === "confirmed")).toBe(true);
    expect((await requestFor(card.id))?.status).toBe("funded");
    expect((await proposal(card.id)).status).toBe("done");
  });

  it("resumes a card whose run stopped while executing, sending only what had not gone out, and leaves it while factoring is off", async () => {
    switchesOn();
    const ids = await fundable(2);
    const card = await cardFor(ids);
    // The database goes away after the executor's first transaction: the request and its lines are
    // written and the card is executing, but no invoice has gone out.
    let calls = 0;
    const fading: TenantDb = {
      withTenant: <T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> =>
        calls++ < 2 ? app.withTenant(tenantId, fn) : Promise.reject(new Error("connection lost")),
    };
    const lost = countingPartner();
    expect(await resume(card.id, lost.adapter, fading)).toMatchObject({ ok: false, category: "factoring_pending" });
    expect(lost.sent).toEqual([]);
    expect((await proposal(card.id)).status).toBe("executing");
    const request = await requestFor(card.id);
    if (!request) throw new Error("no factoring request");
    expect(request.status).toBe("submitted");
    expect((await linesOf(request.id)).map((l) => [l.status, l.money_action_id])).toEqual([
      ["submitted", null],
      ["submitted", null],
    ]);
    expect(await ledgerFor(ids)).toEqual([]);

    // Factoring switched off with Cash Friday on: the card is not closed as test mode over a
    // request that went to the partner. Nothing is written.
    flags.factoring.enabled = false;
    const partner = countingPartner();
    expect(await resume(card.id, partner.adapter)).toMatchObject({ ok: false, category: "factoring_off" });
    expect((await proposal(card.id)).status).toBe("executing");
    expect(await ledgerFor(ids)).toEqual([]);

    switchesOn();
    expect(await resume(card.id, partner.adapter)).toMatchObject({ ok: true, status: "done" });
    expect([...partner.sent].sort()).toEqual(card.args.invoices.map((i) => i.invoiceNumber).sort());
    expect((await linesOf(request.id)).map((l) => l.status)).toEqual(["funded", "funded"]);
    expect((await ledgerFor(ids)).map((m) => m.state)).toEqual(["confirmed", "confirmed"]);
    expect((await requestFor(card.id))?.status).toBe("funded");
    expect(await resume(card.id, partner.adapter)).toMatchObject({ ok: false, category: "already_decided" });
    expect(partner.sent).toHaveLength(2);
  });

  it("refuses to resume a stopped card with any switch off, and writes nothing", async () => {
    switchesOn();
    const ids = await fundable(1);
    const card = await cardFor(ids);
    await approveThenStop(card.id);
    const partner = countingPartner();
    const tables = ["factoring_requests", "factoring_request_invoices", "money_actions"] as const;
    const counts = () => Promise.all(tables.map((t) => countRows(A, t)));
    const before = await counts();
    for (const [flip, category] of [
      [() => (flags.factoring.armed = false), "factoring_not_armed"],
      [() => (flags.payoutsEnabled = false), "factoring_payouts_off"],
      [() => (flags.factoring.maxNetCents = card.args.amountCents - 1), "over_factoring_cap"],
      [() => (flags.factoring.startDate = "2026-11-03"), "factoring_before_start"],
      [
        () => {
          flags.factoring.enabled = false;
          flags.cashFridayEnabled = false;
        },
        "not_executable",
      ],
    ] as const) {
      switchesOn();
      flags.factoring.maxNetCents = saved.factoring.maxNetCents;
      flags.factoring.startDate = saved.factoring.startDate;
      flip();
      expect(await resume(card.id, partner.adapter)).toMatchObject({ ok: false, category });
    }
    expect(await counts()).toEqual(before);
    expect(partner.sent).toEqual([]);
    expect((await proposal(card.id)).status).toBe("approved");
  });

  it("shows and changes nothing for another carrier", async () => {
    switchesOn();
    expect(await app.withTenant(B, (q) => listRequests(q, 50))).toEqual([]);
    expect(await app.withTenant(B, (q) => readRequest(q, engineRequest.id))).toBeNull();
    const first = engineCard.args.invoices[0].invoiceId;
    expect(await app.withTenant(B, (q) => readFactoredLine(q, first))).toBeNull();
    expect(await checkPendingFactoring(STAFF_B, engineRequest.id, { db: app, clock })).toMatchObject({
      ok: false,
      category: "not_found",
    });
    const changed = await app.withTenant(B, (q) =>
      q.execute("UPDATE factoring_requests SET status = 'failed' WHERE id = CAST($1 AS uuid)", [engineRequest.id]),
    );
    expect(changed).toBe(0);
    const seen = await app.withTenant(B, (q) =>
      q.query<{ n: string }>("SELECT count(*) AS n FROM factoring_request_invoices"),
    );
    expect(Number(seen[0].n)).toBe(0);
    expect(await countRows(B, "factoring_requests")).toBe(0);
    expect((await requestFor(engineCard.id))?.status).toBe("funded");
  });
});
