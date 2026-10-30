import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import { requireStaff } from "../../auth/role";
import type { Queryable } from "../../db";
import { readRowsWhereId } from "../../data/read";
import { parseLoadCreateArgs, type LoadAccessorialKind, type LoadCreateArgs } from "../../ratecon/args";
import { rateConCandidates, readStoredRateCon } from "../../ratecon/candidates";
import { recheckCard, type LoadDraft } from "../../ratecon/check";
import { parseRateCon } from "../../ratecon/schema";
import { lockTenantRateCons, markRateConCreated } from "../../ratecon/store";
import type { Executor, Precheck, ProposalRefused, ProposalResult, ProposalRow } from "../execute";

// A person approved a load_create card: write the one load its rate confirmation offers, in one
// tenant transaction, or nothing. Nothing here moves money, writes a ledger row or calls an
// outside system; the load is created planned, with no driver, and no state miles (none are known).
//
// The proposal row is locked first, then the tenant's rate confirmation lock (the one a card is
// made under, so a second card for the number cannot be made while this one is written). Then
// everything the card was made from is checked again (src/lib/ratecon/check.ts, recheckCard): its
// ratecon_reads row still reserves this load id for this card, the transcript still hashes to the
// card's readingHash and is exactly the stored reading's text, and the checks still take the stored
// reading against the records as they are now (the customer still the one row, no load or other
// card holding the number, the dates still in range) and draft exactly the card's values. A card
// that no longer checks fails as its category; nothing is written.
//
// Dedupe key, named: the load's id is the card's subject, reserved in ratecon_reads.load_id before
// any model call, and the insert is ON CONFLICT DO NOTHING against loads.id and loads (tenant_id,
// load_number). A load already holding this id is the earlier run's own write: it is compared
// whole value by whole value and adopted (done), never written twice; a different load holding the
// number fails the card as load_exists. Charge lines are keyed (tenant_id, load_id, kind, seq), so
// the same approval twice writes each line once. Everything written is read back and compared; a
// mismatch throws, so the transaction rolls back. The switch: ratecon.enabled off refuses as
// not_executable before anything is read, here and in the precheck, and the registry offers no
// executor at all.

const done = (proposalId: string): ProposalResult => ({ ok: true, proposalId, status: "done", moneyActionId: null });
const refusal = (category: string, retryable = false): ProposalRefused => ({ ok: false, category, retryable });

// A charge line's description: a fixed phrase for its kind, never the model's words.
const DESCRIPTIONS: Readonly<Record<LoadAccessorialKind, string>> = {
  detention: "Detention, from the rate confirmation",
  layover: "Layover, from the rate confirmation",
  stop: "Extra stop, from the rate confirmation",
  lumper: "Lumper, from the rate confirmation",
};

type Line = { kind: LoadAccessorialKind; seq: number; amountCents: number };

// The charge lines with their sequence numbers: 1, 2, ... within each kind, in the card's order.
export function linesOf(accessorials: LoadDraft["accessorials"]): Line[] {
  const seen = new Map<LoadAccessorialKind, number>();
  return accessorials.map((a) => {
    const seq = (seen.get(a.kind) ?? 0) + 1;
    seen.set(a.kind, seq);
    return { kind: a.kind, seq, amountCents: a.amountCents };
  });
}

// The card's args checked again against the rows, inside the caller's transaction. null: it holds.
async function check(q: Queryable, args: LoadCreateArgs, proposal: ProposalRow, now: Date): Promise<string | null> {
  if (proposal.subjectTable !== "loads" || proposal.subjectId !== args.loadId) return "not_executable";
  if (proposal.amountCents !== args.totalCents || proposal.direction !== "in") return "not_executable";
  const stored = await readStoredRateCon(q, args.loadId);
  if (!stored || stored.status !== "proposed" || stored.proposalId !== proposal.id) return "not_executable";
  const reading = stored.reading === null ? null : parseRateCon(stored.reading);
  if (!reading) return "not_executable";
  const candidates = await rateConCandidates(q, reading, args.loadId);
  const checked = recheckCard(args, stored, candidates, {
    now,
    documentCreatedAt: stored.documentCreatedAt,
    startDate: flags.ratecon.startDate,
  });
  return checked.ok ? null : checked.category;
}

// Before the approval, inside the gate's transaction: the same checks, reads only, so a card that
// cannot be written stays proposed with its Approve button. A demo visitor is refused here too.
const precheck: Precheck = async (q, proposal, now, ctx) => {
  if (!flags.ratecon.enabled || proposal.kind !== "load_create" || !ctx) return refusal("not_executable");
  await requireStaff(q, ctx.session);
  const args = parseLoadCreateArgs(proposal.args);
  if (!args) return refusal("not_executable");
  const category = await check(q, args, proposal, now);
  return category === null ? null : refusal(category);
};

async function fail(q: Queryable, proposalId: string, category: string, nowIso: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [proposalId, category, nowIso],
  );
  console.warn(`load create ${proposalId} refused: ${category}`);
  return refusal(category);
}

async function one(q: Queryable, sql: string, params: (string | number | null)[]): Promise<void> {
  if ((await q.execute(sql, params)) !== 1) throw new Error("a load create write did not change exactly one row");
}

// The load as the card says it is, column by column.
function loadMatches(row: Record<string, unknown>, args: LoadCreateArgs): boolean {
  return (
    row.id === args.loadId &&
    row.load_number === args.loadNumber &&
    row.customer_id === args.customerId &&
    row.driver_id === null &&
    row.status === "planned" &&
    row.origin_city === args.originCity &&
    row.origin_state === args.originState &&
    row.dest_city === args.destCity &&
    row.dest_state === args.destState &&
    row.pickup_on === args.pickupOn &&
    row.delivered_on === null &&
    Number(row.loaded_miles) === args.loadedMiles &&
    Number(row.empty_miles) === 0 &&
    Number(row.linehaul_cents) === args.linehaulCents &&
    Number(row.fuel_surcharge_cents) === args.fuelSurchargeCents
  );
}

// The load's charge lines are exactly the card's: the same count, each kind, seq and amount.
function linesMatch(rows: readonly Record<string, unknown>[], lines: readonly Line[]): boolean {
  if (rows.length !== lines.length) return false;
  return lines.every((l) =>
    rows.some(
      (r) =>
        r.kind === l.kind &&
        Number(r.seq) === l.seq &&
        Number(r.amount_cents) === l.amountCents &&
        r.paid_by_driver === false &&
        r.description === DESCRIPTIONS[l.kind],
    ),
  );
}

const execute: Executor = async (db, session, proposal, _opts, deps) => {
  if (!flags.ratecon.enabled) return refusal("not_executable");
  if (proposal.kind !== "load_create") return refusal("not_executable");
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    // A resume skips the gate: the role is read here too.
    await requireStaff(q, session);
    const locked = await q.query<{ status: string; args: string }>(
      `SELECT status, CAST(args AS text) AS args FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'load_create'
        FOR UPDATE`,
      [proposal.id],
    );
    if (locked.length !== 1) return refusal("not_found");
    const row = locked[0];
    // Already written by an earlier run of this same approval: nothing to do again.
    if (row.status === "done") return done(proposal.id);
    if (row.status !== "approved" && row.status !== "executing") return refusal("already_decided");
    let raw: unknown;
    try {
      raw = JSON.parse(row.args);
    } catch {
      raw = null;
    }
    const args = parseLoadCreateArgs(raw);
    if (!args) return fail(q, proposal.id, "not_executable", nowIso);

    await lockTenantRateCons(q);
    const category = await check(q, args, proposal, now);
    if (category !== null) return fail(q, proposal.id, category, nowIso);

    const inserted = await q.execute(
      `INSERT INTO loads
         (id, tenant_id, load_number, customer_id, driver_id, status, origin_city, origin_state, dest_city,
          dest_state, pickup_on, loaded_miles, empty_miles, linehaul_cents, fuel_surcharge_cents)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), NULL, 'planned', $4, $5, $6, $7,
               CAST($8 AS date), $9, 0, $10, $11)
       ON CONFLICT DO NOTHING`,
      [
        args.loadId,
        args.loadNumber,
        args.customerId,
        args.originCity,
        args.originState,
        args.destCity,
        args.destState,
        args.pickupOn,
        args.loadedMiles,
        args.linehaulCents,
        args.fuelSurchargeCents,
      ],
    );
    const [load] = await readRowsWhereId(q, "loads", "id", args.loadId);
    if (inserted !== 1) {
      // Nothing holds this id: a different load holds the number.
      if (!load) return fail(q, proposal.id, "load_exists", nowIso);
      // This id is held by a load that is not the card's: never adopted.
      if (!loadMatches(load as unknown as Record<string, unknown>, args)) {
        return fail(q, proposal.id, "not_executable", nowIso);
      }
    }
    if (!load || !loadMatches(load as unknown as Record<string, unknown>, args)) {
      throw new Error("the written load does not match the approved card");
    }

    const lines = linesOf(args.accessorials);
    for (const l of lines) {
      await q.execute(
        `INSERT INTO load_accessorials (id, tenant_id, load_id, kind, seq, amount_cents, paid_by_driver, description)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), $3, $4, $5, false, $6)
         ON CONFLICT (tenant_id, load_id, kind, seq) DO NOTHING`,
        [randomUUID(), args.loadId, l.kind, l.seq, l.amountCents, DESCRIPTIONS[l.kind]],
      );
    }
    const written = await readRowsWhereId(q, "load_accessorials", "load_id", args.loadId);
    if (!linesMatch(written as unknown as Record<string, unknown>[], lines)) {
      throw new Error("the written charge lines do not match the approved card");
    }

    if ((await markRateConCreated(q, args.loadId, proposal.id, nowIso)) !== 1) {
      throw new Error("the rate confirmation row did not move to created");
    }
    if (row.status === "approved") {
      await one(
        q,
        `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
        [proposal.id, nowIso],
      );
    }
    await one(
      q,
      `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [proposal.id, nowIso],
    );
    console.info(`load create ${proposal.id} done load=${args.loadId} lines=${lines.length}`);
    return done(proposal.id);
  });
};

export const loadCreateExecutor: Executor = Object.assign(execute, { precheck });
