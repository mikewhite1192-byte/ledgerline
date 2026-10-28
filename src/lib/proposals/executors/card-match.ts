import { flags } from "../../../config/flags";
import type { Session } from "../../auth/claims";
import type { Queryable, TenantDb } from "../../db";
import { assertMembership } from "../../tenant/context";
import { isUuid } from "../../uuid";
import type {
  ApproveOptions,
  ExecuteDeps,
  Executor,
  Precheck,
  ProposalRefused,
  ProposalResult,
  ProposalRow,
} from "../execute";

// The card_match executor (design 4.3, owner decision D3 on its default). A match card says "the
// card ending 4417 on the statement is driver X's". Approving it, in one transaction under the
// tenant's row-level security:
//   a. re-read the proposal FOR UPDATE: approved or executing (a resume), kind card_match, args
//      that still say what the row says (the transaction, its whole cents);
//   b. re-check the facts, because time passed: the statement row is the one the card named (its
//      reference and amount), its card is on no driver's file, its purchase is not recorded, the
//      driver is active on the posting day, and a person has not dismissed the card check's "card
//      not on file" difference on that row (its break is locked first, so a dismissal at the same
//      moment either lands before this read or waits for this approval to finish). Any failure
//      marks the proposal failed with the note "stale" and writes nothing;
//   c. approved -> executing;
//   d. the card on the driver's file (source 'recon', a generic pool card under its portal name,
//      never the default card, so no payout changes where it goes), and the purchase recorded for
//      the driver (purchase_ref = the statement row's reference, paid with the company card, the
//      driver's one load that day or none). Both ON CONFLICT DO NOTHING and read back: a card or a
//      purchase that reached the records in between rolls the whole transaction back, and the
//      proposal is failed as stale in a fresh one;
//   e. the card check's open "card not on file" break on that row resolved;
//   f. executing -> done.
// Money never moves here. The card token is read from the statement row inside the INSERT; it is
// never in the proposal's args.
//
// The switch: cardRecon.enabled off refuses as not_executable before anything is read or written,
// here and in the precheck, even when a caller reaches this executor directly.

type Row = {
  id: string;
  kind: string;
  status: string;
  subject_id: string;
  amount_cents: number | string;
  args: string;
};

type Args = {
  transactionId: string;
  providerRef: string;
  amountCents: number;
  driverId: string;
};

const refused = (category: string): ProposalRefused => ({ ok: false, category, retryable: false });

class Conflict extends Error {
  constructor() {
    super("the card or the purchase reached the records first");
    this.name = "Conflict";
  }
}

function argsFrom(v: unknown): Args | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.transactionId !== "string" || !isUuid(a.transactionId)) return null;
  if (typeof a.driverId !== "string" || !isUuid(a.driverId)) return null;
  if (typeof a.providerRef !== "string" || !/^[a-z0-9_-]{3,64}$/.test(a.providerRef)) return null;
  const cents = a.amountCents;
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) return null;
  return {
    transactionId: a.transactionId.toLowerCase(),
    providerRef: a.providerRef,
    amountCents: cents,
    driverId: a.driverId.toLowerCase(),
  };
}

function argsOf(text: string): Args | null {
  try {
    return argsFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

// The args say what the row says: the same statement row and the same whole cents.
function argsMatchRow(a: Args | null, subjectId: string, amountCents: number): a is Args {
  return a !== null && a.transactionId === subjectId.toLowerCase() && a.amountCents === amountCents;
}

// True when every fact the card was made on still holds.
async function factsHold(q: Queryable, a: Args): Promise<boolean> {
  const rows = await q.query<{ ok: number }>(
    `SELECT 1 AS ok FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid) AND t.kind = 'fuel'
        AND t.provider_ref = $2 AND t.amount_cents = $3
        AND NOT EXISTS (SELECT 1 FROM driver_cards c
                         WHERE c.tenant_id = t.tenant_id AND c.provider = t.provider
                           AND c.provider_token = t.card_token)
        AND NOT EXISTS (SELECT 1 FROM fuel_purchases p
                         WHERE p.tenant_id = t.tenant_id AND p.purchase_ref = t.provider_ref)
        AND EXISTS (SELECT 1 FROM drivers d
                     WHERE d.tenant_id = t.tenant_id AND d.id = CAST($4 AS uuid)
                       AND d.active_from <= t.posted_on AND (d.active_to IS NULL OR d.active_to >= t.posted_on))
        AND NOT EXISTS (SELECT 1 FROM card_recon_breaks b
                         WHERE b.tenant_id = t.tenant_id AND b.card_transaction_id = t.id
                           AND b.category = 'card_unknown' AND b.status = 'dismissed')`,
    [a.transactionId, a.providerRef, a.amountCents, a.driverId],
  );
  return rows.length === 1;
}

// The row's "card not on file" difference, locked until this transaction ends, before the facts
// are read: a dismissal of it cannot slip in between the read and the writes.
async function lockBreak(q: Queryable, transactionId: string): Promise<void> {
  await q.query(
    `SELECT 1 AS ok FROM card_recon_breaks
      WHERE tenant_id = current_tenant_id() AND card_transaction_id = CAST($1 AS uuid) AND category = 'card_unknown'
      FOR UPDATE`,
    [transactionId],
  );
}

// Both records already written for this driver: a resume after the inserts landed.
async function landed(q: Queryable, a: Args): Promise<boolean> {
  const rows = await q.query<{ ok: number }>(
    `SELECT 1 AS ok FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid)
        AND EXISTS (SELECT 1 FROM driver_cards c
                     WHERE c.tenant_id = t.tenant_id AND c.provider = t.provider
                       AND c.provider_token = t.card_token AND c.driver_id = CAST($2 AS uuid))
        AND EXISTS (SELECT 1 FROM fuel_purchases p
                     WHERE p.tenant_id = t.tenant_id AND p.purchase_ref = t.provider_ref
                       AND p.driver_id = CAST($2 AS uuid))`,
    [a.transactionId, a.driverId],
  );
  return rows.length === 1;
}

async function markStale(q: Queryable, id: string, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = 'stale', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status IN ('approved', 'executing')`,
    [id, nowIso],
  );
}

async function resolveBreak(q: Queryable, transactionId: string, nowIso: string): Promise<void> {
  await q.execute(
    `UPDATE card_recon_breaks
        SET status = 'resolved', resolved_at = CAST($2 AS timestamptz), updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND card_transaction_id = CAST($1 AS uuid)
        AND category = 'card_unknown' AND status = 'open'`,
    [transactionId, nowIso],
  );
}

async function finish(q: Queryable, id: string, from: string, nowIso: string): Promise<void> {
  if (from === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [id, nowIso],
    );
  }
  const n = await q.execute(
    `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
    [id, nowIso],
  );
  if (n !== 1) throw new Error("the match card's proposal did not move to done");
}

async function apply(q: Queryable, session: Session, proposalId: string, now: Date): Promise<ProposalResult> {
  await assertMembership(q, session);
  const rows = await q.query<Row>(
    `SELECT CAST(id AS text) AS id, kind, status, CAST(subject_id AS text) AS subject_id, amount_cents,
            CAST(args AS text) AS args
       FROM proposals WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
    [proposalId],
  );
  if (rows.length !== 1) return refused("not_found");
  const p = rows[0];
  if (p.kind !== "card_match") return refused("not_executable");
  if (p.status === "done") return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
  if (p.status !== "approved" && p.status !== "executing") return refused("already_decided");
  const nowIso = now.toISOString();
  const a = argsOf(p.args);
  const whole = argsMatchRow(a, p.subject_id, Number(p.amount_cents));
  if (whole) await lockBreak(q, a.transactionId);
  if (whole && (await landed(q, a))) {
    await resolveBreak(q, a.transactionId, nowIso);
    await finish(q, p.id, p.status, nowIso);
    return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
  }
  if (!whole || !(await factsHold(q, a))) {
    await markStale(q, p.id, nowIso);
    console.info(`proposal ${p.id} card_match refused=stale`);
    return refused("stale");
  }
  if (p.status === "approved") {
    await q.execute(
      `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
      [p.id, nowIso],
    );
  }
  // The driver's one load that day, or none when there is none or more than one.
  const loads = await q.query<{ id: string }>(
    `SELECT DISTINCT CAST(d.load_id AS text) AS id
       FROM driver_days d
       JOIN card_transactions t ON t.tenant_id = d.tenant_id AND t.id = CAST($2 AS uuid)
      WHERE d.tenant_id = current_tenant_id() AND d.driver_id = CAST($1 AS uuid)
        AND d.day = t.posted_on AND d.load_id IS NOT NULL`,
    [a.driverId, a.transactionId],
  );
  const loadId = loads.length === 1 ? loads[0].id : null;
  const card = await q.execute(
    `INSERT INTO driver_cards (id, tenant_id, driver_id, provider, provider_token, last4, status, sim_behavior,
                               source, is_default, holder_kind, portal_name)
     SELECT gen_random_uuid(), t.tenant_id, CAST($2 AS uuid), t.provider, t.card_token, t.card_last4, 'active',
            'ok', 'recon', false, 'generic', t.portal_name
       FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid)
     ON CONFLICT DO NOTHING`,
    [a.transactionId, a.driverId],
  );
  const purchase = await q.execute(
    `INSERT INTO fuel_purchases (id, tenant_id, driver_id, load_id, purchased_at, purchased_on, state,
                                 gallons_milli, amount_cents, paid_with, purchase_ref)
     SELECT gen_random_uuid(), t.tenant_id, CAST($2 AS uuid), CAST($3 AS uuid), t.posted_at, t.posted_on,
            t.state, t.gallons_milli, t.amount_cents, 'company_card', t.provider_ref
       FROM card_transactions t
      WHERE t.tenant_id = current_tenant_id() AND t.id = CAST($1 AS uuid) AND t.kind = 'fuel'
     ON CONFLICT DO NOTHING`,
    [a.transactionId, a.driverId, loadId],
  );
  // One of each, or the whole transaction rolls back (the caller marks the card stale).
  if (card !== 1 || purchase !== 1 || !(await landed(q, a))) throw new Conflict();
  await resolveBreak(q, a.transactionId, nowIso);
  await finish(q, p.id, "executing", nowIso);
  console.info(`proposal ${p.id} card_match done`);
  return { ok: true, proposalId: p.id, status: "done", moneyActionId: null };
}

// The gate's early refusal (see Precheck in execute.ts): inside the gate's transaction, with the
// proposal still proposed and locked. Reads only.
export const precheckCardMatch: Precheck = async (q, proposal: ProposalRow) => {
  if (!flags.cardRecon.enabled) return refused("not_executable");
  if (proposal.kind !== "card_match") return refused("not_executable");
  const a = argsFrom(proposal.args);
  if (argsMatchRow(a, proposal.subjectId, proposal.amountCents) && (await factsHold(q, a))) return null;
  console.info(`proposal ${proposal.id} card_match precheck=stale`);
  return refused("stale");
};

async function runCardMatch(
  db: TenantDb,
  session: Session,
  proposal: ProposalRow,
  _opts: ApproveOptions,
  deps: ExecuteDeps,
): Promise<ProposalResult> {
  if (!flags.cardRecon.enabled) return refused("not_executable");
  const now = (deps.clock ?? (() => new Date()))();
  try {
    return await db.withTenant(session.tenantId, (q) => apply(q, session, proposal.id, now));
  } catch (err) {
    if (!(err instanceof Conflict)) throw err;
    await db.withTenant(session.tenantId, (q) => markStale(q, proposal.id, now.toISOString()));
    console.info(`proposal ${proposal.id} card_match refused=stale conflict`);
    return refused("stale");
  }
}

export const cardMatchExecutor: Executor = Object.assign(runCardMatch, { precheck: precheckCardMatch });
