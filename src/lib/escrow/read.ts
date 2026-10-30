import type { Queryable } from "../db";
import { isLocalDate, type LocalDate } from "../time/local-date";

// The escrow release readers for the agent's read tools, the propose tool, the route and the
// executor. Reads only, in the caller's tenant transaction (every statement also names the
// tenant). A driver is named by id and code only: no name, email or bank detail is read here.

export const RELEASE_STATUSES = ["issuing", "released", "failed", "unknown"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
// A release that holds the driver's balance (escrow_releases_one_live_per_driver): being sent,
// sent, or not known yet. A failed one is the record of a try and holds nothing.
export const LIVE_RELEASE_STATUSES: readonly ReleaseStatus[] = ["issuing", "released", "unknown"];

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type DriverEscrow = {
  id: string;
  code: string;
  activeFrom: LocalDate;
  activeTo: LocalDate | null;
  balanceCents: number;
};

type DriverRaw = {
  id: string;
  code: string;
  active_from: string;
  active_to: string | null;
  escrow_balance_cents: number | string;
};

// A row the reader cannot read whole is unknown, never a zero or an active driver: it throws.
function driverOf(r: DriverRaw): DriverEscrow {
  const balance = Number(r.escrow_balance_cents);
  if (!Number.isSafeInteger(balance) || balance < 0) throw new RangeError("escrow balance is not cents");
  if (!isLocalDate(r.active_from) || (r.active_to !== null && !isLocalDate(r.active_to))) {
    throw new RangeError("driver dates are not dates");
  }
  return { id: r.id, code: r.code, activeFrom: r.active_from, activeTo: r.active_to, balanceCents: balance };
}

// Exported so a test's fake database can match the statement whole.
export const DRIVER_ESCROW_SQL = `SELECT CAST(id AS text) AS id, code, CAST(active_from AS text) AS active_from,
            CAST(active_to AS text) AS active_to, escrow_balance_cents
       FROM drivers WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`;

// One driver's escrow facts, or null when there is no such driver here. lock takes the driver's
// row lock, so the balance cannot move between this read and the commit.
export async function readDriverEscrow(q: Queryable, driverId: string, lock = false): Promise<DriverEscrow | null> {
  const rows = await q.query<DriverRaw>(`${DRIVER_ESCROW_SQL}${lock ? " FOR UPDATE" : ""}`, [driverId]);
  return rows.length === 1 ? driverOf(rows[0]) : null;
}

// Terminated: a last active day that is set and before today, on the carrier's local dates.
export function isTerminated(driver: Pick<DriverEscrow, "activeTo">, today: LocalDate): boolean {
  return driver.activeTo !== null && driver.activeTo < today;
}

export type ReleaseRow = {
  id: string;
  driverId: string;
  proposalId: string;
  moneyActionId: string | null;
  openingBalanceCents: number;
  amountCents: number;
  status: ReleaseStatus;
  releasedAt: string | null;
  createdAt: string;
};

type ReleaseRaw = {
  id: string;
  driver_id: string;
  proposal_id: string;
  money_action_id: string | null;
  opening_balance_cents: number | string;
  amount_cents: number | string;
  status: string;
  released_at: string | null;
  created_at: string;
};

function releaseOf(r: ReleaseRaw): ReleaseRow {
  const opening = Number(r.opening_balance_cents);
  const amount = Number(r.amount_cents);
  if (!Number.isSafeInteger(opening) || !Number.isSafeInteger(amount)) throw new RangeError("release is not cents");
  if (!(RELEASE_STATUSES as readonly string[]).includes(r.status)) throw new RangeError("release status is unknown");
  return {
    id: r.id,
    driverId: r.driver_id,
    proposalId: r.proposal_id,
    moneyActionId: r.money_action_id,
    openingBalanceCents: opening,
    amountCents: amount,
    status: r.status as ReleaseStatus,
    releasedAt: r.released_at,
    createdAt: r.created_at,
  };
}

const RELEASE_COLUMNS = `CAST(id AS text) AS id, CAST(driver_id AS text) AS driver_id,
  CAST(proposal_id AS text) AS proposal_id, CAST(money_action_id AS text) AS money_action_id,
  opening_balance_cents, amount_cents, status, ${ISO("released_at")} AS released_at,
  ${ISO("created_at")} AS created_at`;

// One release by its id or by the proposal it carries out (one per proposal). lock takes the
// release's row lock.
export async function readRelease(
  q: Queryable,
  column: "id" | "proposal_id",
  id: string,
  lock = false,
): Promise<ReleaseRow | null> {
  const rows = await q.query<ReleaseRaw>(
    `SELECT ${RELEASE_COLUMNS} FROM escrow_releases
      WHERE tenant_id = current_tenant_id() AND ${column} = CAST($1 AS uuid)${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? releaseOf(rows[0]) : null;
}

export const DRIVER_RELEASES_SQL = `SELECT ${RELEASE_COLUMNS} FROM escrow_releases
      WHERE tenant_id = current_tenant_id() AND driver_id = CAST($1 AS uuid)
      ORDER BY created_at, id`;

// Every release of one driver, oldest first.
export async function readDriverReleases(q: Queryable, driverId: string): Promise<ReleaseRow[]> {
  const rows = await q.query<ReleaseRaw>(DRIVER_RELEASES_SQL, [driverId]);
  return rows.map(releaseOf);
}

export const liveReleaseOf = (releases: readonly ReleaseRow[]): ReleaseRow | null =>
  releases.find((r) => LIVE_RELEASE_STATUSES.includes(r.status)) ?? null;

// Why a release of amountCents for this driver cannot be proposed now, or null. The order is the
// card's: no driver, still active, a live release already, nothing held, a different amount.
export type ReleaseFactRefusal =
  | "driver_not_found"
  | "driver_active"
  | "release_exists"
  | "zero_balance"
  | "amount_mismatch";

export function releaseFactRefusal(
  driver: DriverEscrow | null,
  live: ReleaseRow | null,
  amountCents: number,
  today: LocalDate,
): ReleaseFactRefusal | null {
  if (!driver) return "driver_not_found";
  if (!isTerminated(driver, today)) return "driver_active";
  if (live) return "release_exists";
  if (driver.balanceCents <= 0) return "zero_balance";
  if (!Number.isSafeInteger(amountCents) || amountCents !== driver.balanceCents) return "amount_mismatch";
  return null;
}
