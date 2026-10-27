import type { Session } from "../auth/claims";
import { flags } from "../../config/flags";
import type { Queryable, TenantDb } from "../db";
import { readBySubject } from "../money/read";
import { MoneyError } from "../money/types";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import {
  bookConfirmedPayout,
  latestOf,
  refuseStalePayout,
  runAccountingLegs,
  sendLeg,
  type LegsOutcome,
  type SettlementMoneyDeps,
} from "./legs";
import { readStoredSettlement } from "./stored";

// The record page's two buttons. Each sends through the same ledger keys as the approve and the
// batch drain, so a click never sends a leg twice.
//
// "Post to QuickBooks": the bill and its payment for a paid paystub. A failed leg is tried again as
// the next attempt (at most settlementLimits.maxPayoutAttempts); an unknown one waits for the
// reconcile pass.
//
// "Retry payout": a new payout attempt for an approved paystub whose payout failed or was never
// sent (the switch was off at the approve). Before it goes, the paystub is re-checked against its
// records under its lock (the approve's check) and a stale one is refused with nothing sent. A
// paid paystub is never paid again; a payout in flight or unknown is left alone. When the payout is
// already confirmed and only the booking failed, the same button ("Retry booking") books the
// paystub and sends nothing.

export type PostResult =
  | { ok: true; legs: LegsOutcome }
  | {
      ok: false;
      category: "disabled" | "not_found" | "not_paid_yet" | "role" | "already_posted" | "not_connected" | "not_configured";
    };

export type RetryResult =
  | { ok: true; state: string; moneyActionId: string }
  | {
      ok: false;
      category:
        | "disabled"
        | "not_found"
        | "not_approved"
        | "already_paid"
        | "in_flight"
        | "attempts_used"
        | "role"
        | "not_connected"
        | "not_configured"
        | "not_booked"
        | "records_changed"
        | "failed";
    };

// The approver line applies to these buttons the way it applies to the approve.
async function roleAllows(q: Queryable, session: Session, netCents: number): Promise<boolean> {
  if (netCents <= flags.approverRole.adminAboveCents) return true;
  const [member] = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [session.sub],
  );
  return member?.role === "admin";
}

type Party = { settlementId: string; driverId: string; netCents: number; status: string };

async function readParty(db: TenantDb, session: Session, settlementId: string) {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const stored = await readStoredSettlement(q, settlementId, false);
    if (!stored) return null;
    const party: Party = {
      settlementId: stored.id,
      driverId: stored.driverId,
      netCents: stored.netCents,
      status: stored.status,
    };
    const allowed = await roleAllows(q, session, stored.netCents);
    const rows = await readBySubject(q, "settlements", stored.id);
    return { party, allowed, rows };
  });
}

export async function postSettlementLegs(
  db: TenantDb,
  session: Session,
  settlementId: string,
  money: SettlementMoneyDeps = {},
  clock: () => Date = () => new Date(),
): Promise<PostResult> {
  if (!flags.settlementsEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(settlementId)) return { ok: false, category: "not_found" };
  const read = await readParty(db, session, settlementId.toLowerCase());
  if (!read) return { ok: false, category: "not_found" };
  if (read.party.status !== "paid") return { ok: false, category: "not_paid_yet" };
  if (!read.allowed) return { ok: false, category: "role" };
  const bill = latestOf(read.rows, "settlement_bill");
  const payment = latestOf(read.rows, "settlement_bill_payment");
  if (bill?.state === "confirmed" && payment?.state === "confirmed") return { ok: false, category: "already_posted" };
  const legs = await runAccountingLegs(
    db,
    session,
    read.party.settlementId,
    { proposalId: null, batchId: null, retryFailed: true },
    money,
    clock,
  );
  // The first leg refused before any write: say why, so the page shows it.
  const first = legs.bill !== "confirmed" ? legs.bill : legs.billPayment;
  if (first === "disabled" || first === "not_connected" || first === "not_configured") {
    return { ok: false, category: first };
  }
  return { ok: true, legs };
}

export async function retryPayout(
  db: TenantDb,
  session: Session,
  settlementId: string,
  money: SettlementMoneyDeps = {},
  clock: () => Date = () => new Date(),
): Promise<RetryResult> {
  if (!flags.settlementsEnabled) return { ok: false, category: "disabled" };
  if (!isUuid(settlementId)) return { ok: false, category: "not_found" };
  const read = await readParty(db, session, settlementId.toLowerCase());
  if (!read) return { ok: false, category: "not_found" };
  if (read.party.status === "paid") return { ok: false, category: "already_paid" };
  if (read.party.status !== "approved" || read.party.netCents <= 0) return { ok: false, category: "not_approved" };
  if (!read.allowed) return { ok: false, category: "role" };
  const latest = latestOf(read.rows, "settlement_payout");
  if (latest?.state === "confirmed") {
    // The money went out; only the booking is left. Never sent again.
    const booked = await bookConfirmedPayout(db, session.tenantId, read.party.settlementId, clock);
    return booked === "booked"
      ? { ok: true, state: latest.state, moneyActionId: latest.id }
      : { ok: false, category: "not_booked" };
  }
  let attempt = 1;
  if (latest !== null) {
    if (latest.state === "sent" || latest.state === "unknown") return { ok: false, category: "in_flight" };
    if (latest.state === "reserved") attempt = latest.attempt;
    else {
      attempt = latest.attempt + 1;
      if (attempt > flags.settlementLimits.maxPayoutAttempts) return { ok: false, category: "attempts_used" };
    }
  }
  const check = await db.withTenant(session.tenantId, async (q) => {
    const stored = await readStoredSettlement(q, read.party.settlementId, true);
    if (stored?.status !== "approved") return stored?.status === "paid" ? "paid" : "moved";
    return (await refuseStalePayout(q, stored, clock())) ? "stale" : "fresh";
  });
  if (check === "paid") return { ok: false, category: "already_paid" };
  if (check === "moved") return { ok: false, category: "not_approved" };
  if (check === "stale") return { ok: false, category: "records_changed" };
  try {
    const out = await sendLeg(
      db,
      session,
      "settlement_payout",
      read.party,
      {
        attempt,
        // A reserved row is replayed whole (same key, same request); a new attempt stands alone.
        proposalId: latest?.state === "reserved" ? latest.proposalId : null,
        batchId: latest?.state === "reserved" ? latest.batchId : null,
      },
      money,
      clock,
    );
    if (
      out.action.state === "confirmed" &&
      (await bookConfirmedPayout(db, session.tenantId, read.party.settlementId, clock)) !== "booked"
    ) {
      return { ok: false, category: "not_booked" };
    }
    return { ok: true, state: out.action.state, moneyActionId: out.action.id };
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    if (err.category === "disabled" || err.category === "not_connected" || err.category === "not_configured") {
      return { ok: false, category: err.category };
    }
    // Nobody knows whether anything was sent: the reconcile pass settles it.
    if (err.category === "unknown") throw err;
    return { ok: false, category: "failed" };
  }
}
