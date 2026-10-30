import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import type { AiResult } from "../../../ai";
import { chargeArgsOf, detentionChargeOf } from "../../../data/detention-charge";
import { instantAt } from "../../../seed/calendar";
import type { CarrierPlan } from "../../../seed/plan";
import { callTool } from "../index";
import { monthPeriod } from "../tools/read/find-unbilled-detention";
import type { CompleteFn, GatewayContext } from "../types";
import { context, fixedClock } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";
import type { Handler } from "./fake-db";

// The two detention tools on the real readers and the real rules engine over the synthetic seed
// plan: switched off they refuse before reading anything; on, the find tool gives the seed's four
// planted loads and their engine cents, and the propose tool drafts exactly the engine's figures.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
// The seed's anchor day: October 2026 is the carrier's last full month.
const ctx: GatewayContext = context({ now: new Date(instantAt(plan.anchor, 12, 0, zone)), timeZone: zone });
const ids = plan.planted.detentionLoadIds;
const GOLDEN = [41_250, 30_000, 37_500, 26_250];
const firstInvoice = plan.rows.invoices.find((i) => i.load_id === ids[0])!;

const screenStore: Handler = (sql) => {
  if (sql.startsWith("SELECT verdict, CAST(categories AS text)")) return [];
  if (sql.startsWith("INSERT INTO screenings")) return 1;
  return undefined;
};
const complete: CompleteFn = async () =>
  ({
    callId: "c0ffee00-0000-4000-8000-000000000003",
    status: "ok",
    text: "VERDICT: clean\nCATEGORIES: none\nCONFIDENCE: 0.99",
    toolCalls: [],
    usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
    costNanocents: 1,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  }) satisfies AiResult;

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });
const run = (name: string, args: unknown, p: CarrierPlan = plan, role: GatewayContext["role"] = "operator") => {
  const db = planDb(p, screenStore);
  return callTool({ ...ctx, role }, call(name, args), { db, clock: fixedClock, complete }).then((out) => ({ out, db }));
};

type FoundRow = { loadId: string; amountCents: number; canPropose: boolean; blockedBy: string | null } & Record<
  string,
  unknown
>;

const shipped = flags.detentionEnabled;

afterEach(() => {
  flags.detentionEnabled = shipped;
});

describe("detention tools switched off", () => {
  it.each([
    ["find_unbilled_detention", { month: "2026-10" }],
    ["propose_detention_charge", { loadId: ids[0], amountCents: GOLDEN[0], sourceRefs: [] }],
  ])("%s refuses as disabled before reading a record, with one decision row", async (name, args) => {
    flags.detentionEnabled = false;
    const { out, db } = await run(name, args);
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    expect(db.decisions).toHaveLength(1);
    expect(db.decisions[0]).toMatchObject({ tool: name, decision: "blocked" });
    for (const st of db.statements) expect(st.sql).not.toMatch(/FROM (loads|invoices|customers|load_accessorials)\b/);
  });
});

describe("find_unbilled_detention", () => {
  it("finds the seed's four planted loads in October, 135,000 cents in all, each ready to propose", async () => {
    flags.detentionEnabled = true;
    const { out, db } = await run("find_unbilled_detention", { month: "2026-10" });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const result = out.result as { window: unknown; rows: FoundRow[]; count: number; totalCents: number };
    expect(result.window).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(result.count).toBe(4);
    expect(result.totalCents).toBe(135_000);
    const byLoad = new Map(result.rows.map((r) => [r.loadId, r]));
    expect(ids.map((id) => byLoad.get(id)?.amountCents)).toEqual(GOLDEN);
    for (const r of result.rows) {
      expect(r).toMatchObject({ canPropose: true, blockedBy: null, invoiceStatus: "open", postedToAccounting: false });
    }
    expect(db.decisions).toHaveLength(1);
  });

  it("defaults to the carrier's last full month and is offered to the auditor too", async () => {
    flags.detentionEnabled = true;
    const { out } = await run("find_unbilled_detention", {}, plan, "auditor");
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.result).toMatchObject({ window: { start: "2026-10-01", end: "2026-10-31" }, totalCents: 135_000 });
  });

  it("says why a found charge cannot go on its invoice", async () => {
    flags.detentionEnabled = true;
    const posted: CarrierPlan = {
      ...plan,
      rows: {
        ...plan.rows,
        invoices: plan.rows.invoices.map((i) => (i.id === firstInvoice.id ? { ...i, qbo_id: "1042" } : i)),
      },
    };
    const { out } = await run("find_unbilled_detention", { month: "2026-10" }, posted);
    if (out.decision !== "allowed") throw new Error("not allowed");
    const row = (out.result.rows as FoundRow[]).find((r) => r.loadId === ids[0])!;
    expect(row).toMatchObject({ canPropose: false, blockedBy: "invoice_posted", postedToAccounting: true });
  });

  it("refuses a month that is not YYYY-MM", async () => {
    flags.detentionEnabled = true;
    for (const month of ["2026-13", "October", "2026-1", "1999-10"]) {
      const { out } = await run("find_unbilled_detention", { month });
      expect(out, month).toMatchObject({ decision: "invalid_args" });
    }
  });

  it("maps a month to its first and last day", () => {
    expect(monthPeriod("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthPeriod("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(monthPeriod("2026-12")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
    expect(() => monthPeriod("2026-00")).toThrow(RangeError);
  });
});

describe("propose_detention_charge", () => {
  it("drafts exactly the engine's figures for the load and its open invoice", async () => {
    flags.detentionEnabled = true;
    const args = { loadId: ids[0], amountCents: GOLDEN[0], sourceRefs: [{ table: "loads", id: ids[0] }] };
    const { out, db } = await run("propose_detention_charge", args);
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const load = plan.rows.loads.find((l) => l.id === ids[0])!;
    const check = detentionChargeOf({
      load,
      customer: plan.rows.customers.find((c) => c.id === load.customer_id)!,
      miles: plan.rows.load_state_miles.filter((m) => m.load_id === load.id),
      accessorials: plan.rows.load_accessorials.filter((a) => a.load_id === load.id),
      invoices: plan.rows.invoices.filter((i) => i.load_id === load.id),
    });
    if (!check.ok) throw new Error("no charge");
    expect(out.draft).toMatchObject({
      kind: "detention_charge",
      subjectTable: "loads",
      subjectId: ids[0],
      amountCents: GOLDEN[0],
      limitCents: GOLDEN[0],
      args: chargeArgsOf(check.charge),
    });
    expect(out.result).toMatchObject({
      invoiceId: firstInvoice.id,
      invoiceAmountBeforeCents: firstInvoice.amount_cents,
      invoiceAmountAfterCents: firstInvoice.amount_cents + GOLDEN[0],
    });
    expect(db.decisions).toHaveLength(1);
  });

  it("refuses any cents but the engine's, with one decision row", async () => {
    flags.detentionEnabled = true;
    const { out, db } = await run("propose_detention_charge", {
      loadId: ids[0],
      amountCents: GOLDEN[0] + 2_500,
      sourceRefs: [],
    });
    expect(out).toMatchObject({ decision: "blocked", reason: "engine_refused" });
    expect(db.decisions).toHaveLength(1);
  });

  it("is never offered to the auditor", async () => {
    flags.detentionEnabled = true;
    const { out } = await run(
      "propose_detention_charge",
      { loadId: ids[0], amountCents: GOLDEN[0], sourceRefs: [] },
      plan,
      "auditor",
    );
    expect(out.decision).not.toBe("allowed");
  });
});
