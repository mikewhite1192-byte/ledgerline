import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { matchArgs, rankCandidates } from "../../../rules-engine/card-recon";
import { instantAt } from "../../../seed/calendar";
import { callTool } from "../index";
import { cardMatchLimit } from "../tools/propose/propose-card-match";
import type { GatewayContext } from "../types";
import { cardReconHandler } from "./card-db";
import { context, fixedClock, TENANT, type Row } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// The card check's two agent tools on the real readers and the real ranking over the synthetic
// seed plan: switched off they refuse before reading a record; on, the read tool lists breaks by
// the card's last four digits only, and the propose tool drafts the statement's own cents for a
// card on no driver's file, with an exception when the driver is not one code ranked.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(plan.anchor, 12, 0, zone)), timeZone: zone });
const planted = plan.planted.cardRecon;
const unknown = plan.rows.card_transactions.find((t) => t.id === planted.cardUnknownId)!;
const onFile = plan.rows.card_transactions.find(
  (t) => t.kind === "fuel" && plan.rows.driver_cards.some((c) => c.provider_token === t.card_token),
)!;
const loadRow = plan.rows.card_transactions.find((t) => t.kind === "load")!;

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });
const run = (name: string, args: unknown, role: GatewayContext["role"] = "operator", breaks: Row[] = []) => {
  const db = planDb(plan, cardReconHandler(plan, breaks));
  return callTool({ ...ctx, role }, call(name, args), { db, clock: fixedClock }).then((out) => ({ out, db }));
};

// Put back as shipped after each test: each test sets the switch it assumes.
const shipped = structuredClone(flags);

afterEach(() => {
  Object.assign(flags, structuredClone(shipped));
});

const BREAK: Row = {
  id: "5b0c4a0e-1d2e-4f3a-8b4c-5d6e7f8a9b0c",
  category: "card_unknown",
  severity: "high",
  outside_system: "fuel_card_sim",
  fix_kind: "card_match",
  status: "open",
  dismiss_category: null,
  our_cents: null,
  outside_cents: 21_240,
  explanation: null,
  proposal_id: null,
  txn_id: "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b",
  txn_kind: "fuel",
  card_last4: "4821",
  portal_name: "POOL CARD 7",
  posted_on: "2026-10-27",
  txn_state: "TN",
  gallons_milli: 52_850,
  txn_cents: 21_240,
  money_id: null,
  money_kind: null,
  money_subject_table: null,
  money_subject_id: null,
  money_state: null,
  purchase_id: null,
  driver_id: null,
  driver_code: null,
  first_seen_at: "2026-11-02T18:00:00.000Z",
  updated_at: "2026-11-02T18:00:00.000Z",
};

describe("card tools switched off", () => {
  beforeEach(() => {
    flags.cardRecon.enabled = false;
  });

  it.each([
    ["get_card_breaks", { status: "open" }],
    ["propose_card_match", { transactionId: planted.cardUnknownId, driverId: plan.rows.drivers[0].id }],
  ])("%s refuses as disabled before reading a record, with one decision row", async (name, args) => {
    const { out, db } = await run(name, args);
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    expect(db.decisions).toHaveLength(1);
    for (const st of db.statements) expect(st.sql).not.toMatch(/FROM (card_transactions|card_recon_breaks|drivers)\b/);
  });

  it("the limit re-checks the switch itself", async () => {
    const db = planDb(plan, cardReconHandler(plan));
    const out = await db.withTenant(TENANT, (q) =>
      cardMatchLimit(q, ctx, { transactionId: planted.cardUnknownId, driverId: plan.rows.drivers[0].id }),
    );
    expect(out).toMatchObject({ ok: false, reason: "limit_unavailable" });
    expect(db.statements).toEqual([]);
  });
});

describe("get_card_breaks", () => {
  it("lists breaks with the card's last four digits and never a token, for the operator and the auditor", async () => {
    flags.cardRecon.enabled = true;
    for (const role of ["operator", "auditor"] as const) {
      const { out } = await run("get_card_breaks", {}, role, [BREAK]);
      if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
      expect(out.result).toMatchObject({
        status: "open",
        rows: [
          {
            id: BREAK.id,
            category: "card_unknown",
            fixKind: "card_match",
            outsideCents: 21_240,
            transaction: { cardLast4: "4821", amountCents: 21_240, kind: "fuel" },
          },
        ],
      });
      expect(JSON.stringify(out.result)).not.toMatch(/fcs_card_|token|POOL CARD/);
    }
  });

  it("refuses a status outside the list and a limit over 20", async () => {
    flags.cardRecon.enabled = true;
    for (const args of [{ status: "closed" }, { limit: 21 }, { limit: 0 }]) {
      const { out } = await run("get_card_breaks", args);
      expect(out, JSON.stringify(args)).toMatchObject({ decision: "invalid_args" });
    }
  });
});

describe("propose_card_match", () => {
  const facts = () => {
    const days = plan.rows.driver_days;
    const near = (d: string) => d >= addDay(unknown.posted_on, -1) && d <= addDay(unknown.posted_on, 1);
    const dayRows = days.filter((d) => near(d.day));
    const loadIds = new Set(dayRows.filter((d) => d.load_id).map((d) => d.load_id as string));
    return rankCandidates(
      { postedOn: unknown.posted_on as never, state: unknown.state, portalName: unknown.portal_name },
      {
        drivers: [...plan.rows.drivers]
          .sort((a, b) => (a.code < b.code ? -1 : 1))
          .map((d) => ({ id: d.id, code: d.code, activeFrom: d.active_from as never, activeTo: d.active_to as never })),
        days: dayRows.map((d) => ({ driverId: d.driver_id, day: d.day as never, loadId: d.load_id })),
        loads: plan.rows.loads
          .filter((l) => loadIds.has(l.id))
          .map((l) => ({ id: l.id, originState: l.origin_state, destState: l.dest_state })),
        stateMiles: plan.rows.load_state_miles
          .filter((m) => loadIds.has(m.load_id))
          .map((m) => ({ loadId: m.load_id, state: m.state })),
        cards: plan.rows.driver_cards.map((c) => ({
          driverId: c.driver_id,
          providerToken: c.provider_token,
          portalName: c.portal_name,
          status: c.status === "active" ? "active" : "closed",
        })),
      },
    );
  };

  it("drafts the statement's own cents for the driver code ranked first", async () => {
    flags.cardRecon.enabled = true;
    expect(planted.candidateDriverId).not.toBeNull();
    const driverId = planted.candidateDriverId!;
    const { out, db } = await run("propose_card_match", { transactionId: unknown.id, driverId });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const candidates = facts();
    const chosen = candidates.find((c) => c.driverId === driverId)!;
    expect(out.draft).toMatchObject({
      kind: "card_match",
      subjectTable: "card_transactions",
      subjectId: unknown.id,
      amountCents: unknown.amount_cents,
      limitCents: unknown.amount_cents,
      exceptions: [],
      reasons: chosen.reasons,
    });
    const txn = {
      id: unknown.id,
      providerRef: unknown.provider_ref,
      last4: unknown.card_last4,
      portalName: unknown.portal_name,
      postedOn: unknown.posted_on as never,
      state: unknown.state,
      amountCents: unknown.amount_cents,
      gallonsMilli: unknown.gallons_milli,
    };
    expect(out.draft?.args).toEqual(matchArgs(txn, candidates, chosen));
    expect(out.draft?.sources).toEqual(
      expect.arrayContaining([
        { table: "card_transactions", id: unknown.id },
        { table: "drivers", id: driverId },
      ]),
    );
    expect(JSON.stringify(out.draft)).not.toMatch(/fcs_card_/);
    expect(out.result).toMatchObject({ driverRanked: true, amountCents: unknown.amount_cents });
    expect(db.decisions).toHaveLength(1);
  });

  it("allows a driver code did not rank, with the driver_not_candidate exception", async () => {
    flags.cardRecon.enabled = true;
    const ranked = new Set(facts().map((c) => c.driverId));
    const other = plan.rows.drivers.find((d) => !ranked.has(d.id))!;
    const { out } = await run("propose_card_match", { transactionId: unknown.id, driverId: other.id });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.draft).toMatchObject({ exceptions: ["driver_not_candidate"], reasons: [] });
    expect(out.draft?.args).toMatchObject({ driverId: other.id, driverCode: other.code });
    expect(out.result).toMatchObject({ driverRanked: false, score: 0 });
  });

  it("refuses a card already on file and a card load", async () => {
    flags.cardRecon.enabled = true;
    for (const t of [onFile, loadRow]) {
      const { out } = await run("propose_card_match", { transactionId: t.id, driverId: plan.rows.drivers[0].id });
      expect(out, t.kind).toMatchObject({ decision: "blocked", reason: "engine_refused" });
    }
  });

  it("is never offered to the auditor", async () => {
    flags.cardRecon.enabled = true;
    const { out } = await run(
      "propose_card_match",
      { transactionId: unknown.id, driverId: plan.rows.drivers[0].id },
      "auditor",
    );
    expect(out).toMatchObject({ decision: "denied", reason: "role_not_allowed" });
  });
});

function addDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
