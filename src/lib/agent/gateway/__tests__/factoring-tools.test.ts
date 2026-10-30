import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { optionArgs, sameArgs } from "../../../cash/args";
import { readCashFridayInput } from "../../../data/read";
import { PACKET_INVOICES_SQL } from "../../../factoring/packet";
import { computeCashFriday } from "../../../rules-engine";
import golden from "../../../seed/golden.json";
import { instantAt } from "../../../seed/calendar";
import { callTool } from "../index";
import type { GatewayContext } from "../types";
import { context, fixedClock, TENANT, type Handler } from "./fake-db";
import { blueRidgePlan, PLAN_ANCHOR, planDb, PROPOSAL_ID, proposalRowFor, withProposal } from "./plan-db";

// The three factoring tools over the synthetic Blue Ridge plan at the golden anchor, on the real
// readers and the real rules engine: switched off they refuse before reading a record; on, the
// propose tool drafts exactly the engine's figures for the invoices named (the same cents and args
// Cash Friday's own card carries), the packet tool says per invoice whether it can be factored and
// which papers are on file, and none of them writes anything. No database, no clock, no network.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(PLAN_ANCHOR, 12, 0, zone)), timeZone: zone });
const want = golden.carriers["blue-ridge"].cashFriday;
const paid = plan.rows.invoices.find((i) => i.status === "paid" && i.source === "load")!;

const LATEST_CHECK = /^SELECT CAST\(id AS text\) AS id, CAST\(created_at AS text\) AS created_at\s+FROM cash_checks /;
const OPEN_CARDS = /^SELECT CAST\(id AS text\) AS id, kind, status\s+FROM proposals\s+WHERE tenant_id = current_tenant_id\(\) AND origin = 'engine'/;
const REQUEST_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

const none: Handler = (sql) => (LATEST_CHECK.test(sql) || OPEN_CARDS.test(sql) ? [] : undefined);

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });
async function run(name: string, args: unknown, extra: Handler = none, role: GatewayContext["role"] = "operator") {
  const db = planDb(plan, extra);
  const out = await callTool({ ...ctx, role }, call(name, args), { db, clock: fixedClock });
  return { out, db };
}

// Nothing but the gateway's own decision row is written.
function wroteNothing(db: ReturnType<typeof planDb>) {
  const writes = db.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql));
  expect(writes.map((s) => s.sql.slice(0, 40))).toEqual(["INSERT INTO gateway_decisions"].map((p) => expect.stringContaining(p)));
}

// Cash Friday's factoring option on the anchor, as get_cash_friday returns it.
async function engineOption() {
  flags.cashFridayEnabled = true;
  try {
    const { out } = await run("get_cash_friday", {});
    if (out.decision !== "allowed") throw new Error("get_cash_friday was refused");
    const r = out.result as { periodId: string; options: Record<string, unknown>[] };
    const o = r.options.find((x) => x.kind === "factoring_request")!;
    return { periodId: r.periodId, ...(o as { amountCents: number; feeCents: number; reserveCents: number; invoiceIds: string[] }) };
  } finally {
    flags.cashFridayEnabled = false;
  }
}

const saved = structuredClone(flags);

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
});

describe("factoring tools switched off", () => {
  it.each([
    ["propose_factoring", { invoiceIds: [paid.id], sourceRefs: [] }],
    ["get_factoring_packet", { invoiceIds: [paid.id] }],
    ["get_factoring_requests", {}],
  ])("%s refuses as disabled before reading a record, with one decision row", async (name, args) => {
    flags.factoring.enabled = false;
    const { out, db } = await run(name, args);
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    expect(db.decisions).toHaveLength(1);
    for (const st of db.statements) {
      expect(st.sql).not.toMatch(/FROM (invoices|factoring_requests|factoring_request_invoices|documents|portal_evidence)\b/);
    }
  });
});

describe("propose_factoring", () => {
  it("drafts the engine's own figures for the named invoices, the same args as Cash Friday's card, and writes nothing", async () => {
    const engine = await engineOption();
    expect(engine.invoiceIds).toHaveLength(want.factoringInvoices);
    expect(engine.amountCents).toBe(want.factoringNetCents);
    flags.factoring.enabled = true;
    // The order the agent names them in does not matter: the engine sorts the lines.
    const { out, db } = await run("propose_factoring", { invoiceIds: [...engine.invoiceIds].reverse(), sourceRefs: [] });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.draft).toMatchObject({
      kind: "factoring_request",
      subjectTable: "settlement_periods",
      subjectId: engine.periodId,
      amountCents: want.factoringNetCents,
      limitCents: want.factoringNetCents,
      exceptions: [],
      reasons: ["narrows_short", "factoring_test_mode"],
    });
    const args = out.draft!.args as Record<string, unknown> & { invoices: { invoiceId: string }[] };
    expect(args).toMatchObject({
      periodId: engine.periodId,
      payDay: want.payDay,
      shortCents: -want.gapCents,
      amountCents: want.factoringNetCents,
      feeCents: engine.feeCents,
      reserveCents: engine.reserveCents,
    });
    expect(args.invoices.map((l) => l.invoiceId)).toEqual(engine.invoiceIds);
    // Every invoice and its customer is a source, with the week.
    const sources = out.draft!.sources.map((s) => `${s.table}:${s.id}`);
    expect(sources).toContain(`settlement_periods:${engine.periodId}`);
    for (const id of engine.invoiceIds) expect(sources).toContain(`invoices:${id}`);
    expect(out.result).toMatchObject({ proposed: true, netCents: want.factoringNetCents, coversShort: false });
    wroteNothing(db);

    // The same args Cash Friday's own card stores (cash/check.ts), so the approval's recompute matches either.
    const card = await planDb(plan, none).withTenant(TENANT, async (q) => {
      const r = computeCashFriday(await readCashFridayInput(q, zone, flags.cashFridayLimits), PLAN_ANCHOR);
      if (!r.ok) throw new Error("no Cash Friday on the anchor");
      const o = r.options.find((x) => x.kind === "factoring_request")!;
      return optionArgs(o, r.payDay, -r.figures.gapCents);
    });
    expect(sameArgs(card, args)).toBe(true);
  });

  it("refuses a request above the most one request may bring in, with the cap as the limit", async () => {
    const engine = await engineOption();
    flags.factoring.enabled = true;
    flags.factoring.maxNetCents = 100_000;
    const { out, db } = await run("propose_factoring", { invoiceIds: engine.invoiceIds, sourceRefs: [] });
    expect(out).toMatchObject({ decision: "blocked", reason: "amount_over_limit", result: { limitCents: 100_000 } });
    expect(db.decisions[0]).toMatchObject({ limitCents: 100_000, requestedCents: want.factoringNetCents });
  });

  it("refuses an invoice the engine will not factor (a paid one) with no number", async () => {
    flags.factoring.enabled = true;
    const { out } = await run("propose_factoring", { invoiceIds: [paid.id], sourceRefs: [] });
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused", result: { limitCents: null } });
  });

  it("takes invoices only, never a number, and at most three", async () => {
    const engine = await engineOption();
    flags.factoring.enabled = true;
    const withNumber = await run("propose_factoring", { invoiceIds: engine.invoiceIds, amountCents: 1, sourceRefs: [] });
    expect(withNumber.out).toMatchObject({ decision: "invalid_args" });
    const four = [...engine.invoiceIds, paid.id];
    expect((await run("propose_factoring", { invoiceIds: four, sourceRefs: [] })).out).toMatchObject({
      decision: "invalid_args",
    });
    expect((await run("propose_factoring", { invoiceIds: [], sourceRefs: [] })).out).toMatchObject({
      decision: "invalid_args",
    });
  });

  it("is never offered to the auditor", async () => {
    flags.factoring.enabled = true;
    const { out } = await run("propose_factoring", { invoiceIds: [paid.id], sourceRefs: [] }, none, "auditor");
    expect(out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
  });
});

describe("get_factoring_packet", () => {
  it("says per invoice whether the engine would factor it, its net, and which papers are on file", async () => {
    const engine = await engineOption();
    flags.factoring.enabled = true;
    const { out, db } = await run("get_factoring_packet", { invoiceIds: [engine.invoiceIds[0], paid.id] });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const r = out.result as {
      asOf: string;
      invoices: { invoiceId: string; factorable: boolean; refusal: string | null; netCents: number | null; missing: string[] }[];
    };
    expect(r.asOf).toBe(PLAN_ANCHOR);
    const [open, closed] = r.invoices;
    expect(open).toMatchObject({ invoiceId: engine.invoiceIds[0], factorable: true, refusal: null });
    expect(open.netCents).toBeGreaterThan(0);
    // The plan holds no uploaded papers and no portal run, so only the invoice itself is on file.
    expect(open.missing).toEqual(["rate_confirmation", "bill_of_lading", "pod"]);
    expect(closed).toMatchObject({ invoiceId: paid.id, factorable: false, refusal: "invoice_not_open", netCents: null });
    wroteNothing(db);
  });

  it("is offered to the auditor too", async () => {
    flags.factoring.enabled = true;
    const { out } = await run("get_factoring_packet", { invoiceIds: [paid.id] }, none, "auditor");
    expect(out).toMatchObject({ decision: "allowed" });
  });
});

describe("get_factoring_requests", () => {
  it("lists the requests newest first in integer cents, and none on a fresh plan", async () => {
    flags.factoring.enabled = true;
    const empty = await run("get_factoring_requests", {});
    expect(empty.out).toMatchObject({ decision: "allowed", result: { requests: [] } });
    const one: Handler = (sql) =>
      sql.includes("FROM factoring_requests r")
        ? [
            {
              id: REQUEST_ID,
              created_at: "2026-11-02T17:00:00.000Z",
              invoice_count: "2",
              balance_cents: "250000",
              advance_cents: "225000",
              fee_cents: "7500",
              net_cents: "217500",
              reserve_cents: "25000",
              came_in_cents: "130500",
              status: "partly_funded",
              funded_at: "2026-11-02T17:01:00.000Z",
              proposal_id: null,
              advance_bps: "9000",
              fee_bps: "300",
            },
          ]
        : none(sql, []);
    const { out, db } = await run("get_factoring_requests", { limit: 5 }, one);
    expect(out).toMatchObject({
      decision: "allowed",
      result: {
        requests: [
          {
            requestId: REQUEST_ID,
            invoiceCount: 2,
            netCents: 217_500,
            cameInCents: 130_500,
            reserveCents: 25_000,
            status: "partly_funded",
          },
        ],
      },
    });
    const listed = db.statements.find((s) => s.sql.includes("FROM factoring_requests r"))!;
    expect(listed.sql).toMatch(/LIMIT 5$/);
    wroteNothing(db);
  });
});

describe("get_proposal on a factoring card, factoring on", () => {
  async function cardRow(over: Record<string, unknown> = {}) {
    const engine = await engineOption();
    flags.factoring.enabled = true;
    const { out } = await run("propose_factoring", { invoiceIds: engine.invoiceIds, sourceRefs: [] });
    if (out.decision !== "allowed" || !out.draft) throw new Error("no draft");
    const d = out.draft;
    return proposalRowFor(plan, "advance_payout", {
      kind: d.kind,
      title: "Factor invoices (Test mode)",
      subject_table: d.subjectTable,
      subject_id: d.subjectId,
      subject_label: null,
      amount_cents: d.amountCents,
      direction: "in",
      operator_verdict: null,
      reasons: JSON.stringify(d.reasons.map((category) => ({ category }))),
      sources: JSON.stringify(d.sources),
      args: JSON.stringify(d.args),
      ...over,
    });
  }

  it("checks the card on exactly its invoices and names each invoice's missing papers", async () => {
    const row = await cardRow();
    const db = planDb(plan, withProposal(row, none));
    const out = await callTool({ ...ctx, role: "auditor" }, call("get_proposal", { proposalId: PROPOSAL_ID }), {
      db,
      clock: fixedClock,
    });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const engine = out.result.engine as Record<string, unknown> & {
      engine: Record<string, unknown>;
      packet: { invoiceId: string; missing: string[] }[];
    };
    expect(engine).toMatchObject({ ok: true, check: "factoring", proposedCents: want.factoringNetCents });
    expect(engine.engine).toMatchObject({ ok: true, amountCents: want.factoringNetCents, matchesProposal: true });
    expect(engine.packet).toHaveLength(want.factoringInvoices);
    for (const line of engine.packet) expect(line.missing).toEqual(["rate_confirmation", "bill_of_lading", "pod"]);
  });

  it("gives no engine figure for a decided card, and reads none of its invoices or papers", async () => {
    const read = async (status: string) => {
      const db = planDb(plan, withProposal(await cardRow({ status }), none));
      const out = await callTool({ ...ctx, role: "auditor" }, call("get_proposal", { proposalId: PROPOSAL_ID }), {
        db,
        clock: fixedClock,
      });
      if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
      return {
        engine: out.result.engine,
        packets: db.statements.some((st) => st.sql === PACKET_INVOICES_SQL),
        lines: db.statements.some((st) => /FROM factoring_request_invoices\b/.test(st.sql)),
      };
    };
    // A card still waiting for a person is checked, so these reads are what a decided card skips.
    expect(await read("proposed")).toMatchObject({ engine: { ok: true, check: "factoring" }, packets: true, lines: true });
    for (const status of ["approved", "executing", "done", "failed", "rejected", "expired"]) {
      expect(await read(status), status).toEqual({ engine: { ok: false, reason: "unavailable" }, packets: false, lines: false });
    }
  });

  it("says the card no longer matches when its stored amount differs from the engine's", async () => {
    const row = await cardRow({ amount_cents: want.factoringNetCents + 1 });
    const db = planDb(plan, withProposal(row, none));
    const out = await callTool({ ...ctx, role: "auditor" }, call("get_proposal", { proposalId: PROPOSAL_ID }), {
      db,
      clock: fixedClock,
    });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect((out.result.engine as { engine: Record<string, unknown> }).engine).toMatchObject({ matchesProposal: false });
  });
});
