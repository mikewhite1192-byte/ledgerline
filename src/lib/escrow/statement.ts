import type { Queryable } from "../db";
import { sum } from "../rules-engine/money";
import { isLocalDate, localDateOf, type LocalDate } from "../time/local-date";
import { isTerminated, readDriverEscrow, readDriverReleases, type ReleaseStatus } from "./read";

// A driver's final escrow statement (design 3): an opening balance of zero at the first active
// day, one line per paid week that withheld escrow (or charged it), one line per release sent,
// the closing sum, and the driver's stored balance beside it. A difference is reported as
// matches: false, never corrected. Reads only; integer cents, no division, so no rounding.

// A driver has one paystub a week at most, so this is decades; more rows than this is a statement
// that cannot be read whole, and it throws rather than sum a part.
export const STATEMENT_MAX_ROWS = 1_000;

export type StatementLine =
  | {
      kind: "withheld";
      settlementId: string;
      periodStart: LocalDate;
      periodEnd: LocalDate;
      withheldCents: number;
      chargesCents: number;
    }
  | { kind: "released"; releaseId: string; releasedOn: LocalDate; amountCents: number };

export type EscrowStatement = {
  driverId: string;
  driverCode: string;
  activeFrom: LocalDate;
  activeTo: LocalDate | null;
  terminated: boolean;
  asOf: LocalDate;
  openingCents: 0;
  withheldCents: number;
  chargesCents: number;
  releasedCents: number;
  closingCents: number;
  balanceCents: number;
  matches: boolean;
  lines: StatementLine[];
  // A release still being sent or not known yet: its money may be on the way, so the balance has
  // not moved for it.
  openRelease: { id: string; status: ReleaseStatus; amountCents: number } | null;
};

type WeekRaw = {
  id: string;
  period_start: string;
  period_end: string;
  escrow_withheld_cents: number | string;
  escrow_charges_cents: number | string;
};

const centsOf = (v: number | string, what: string): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} is not cents`);
  return n;
};

// $1 the driver, $2 the row limit. Exported so a test's fake database can match the statement whole.
export const STATEMENT_WEEKS_SQL = `SELECT CAST(s.id AS text) AS id, CAST(p.period_start AS text) AS period_start,
            CAST(p.period_end AS text) AS period_end, s.escrow_withheld_cents, s.escrow_charges_cents
       FROM settlements s
       JOIN settlement_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
      WHERE s.tenant_id = current_tenant_id() AND s.driver_id = CAST($1 AS uuid) AND s.status = 'paid'
        AND (s.escrow_withheld_cents > 0 OR s.escrow_charges_cents > 0)
      ORDER BY p.period_start, s.id
      LIMIT $2`;

// The statement as of now (the carrier's local date of nowIso), or null when there is no such
// driver here. A read or a row that does not read whole throws.
export async function readEscrowStatement(
  q: Queryable,
  driverId: string,
  nowIso: string,
  zone: string,
): Promise<EscrowStatement | null> {
  const driver = await readDriverEscrow(q, driverId);
  if (!driver) return null;
  const asOf = localDateOf(nowIso, zone);
  const weeks = await q.query<WeekRaw>(STATEMENT_WEEKS_SQL, [driverId, STATEMENT_MAX_ROWS + 1]);
  const releases = await readDriverReleases(q, driverId);
  if (weeks.length + releases.length > STATEMENT_MAX_ROWS) throw new RangeError("statement too long to read whole");

  const lines: StatementLine[] = [];
  for (const w of weeks) {
    if (!isLocalDate(w.period_start) || !isLocalDate(w.period_end)) throw new RangeError("period dates are not dates");
    lines.push({
      kind: "withheld",
      settlementId: w.id,
      periodStart: w.period_start,
      periodEnd: w.period_end,
      withheldCents: centsOf(w.escrow_withheld_cents, "escrow withheld"),
      chargesCents: centsOf(w.escrow_charges_cents, "escrow charges"),
    });
  }
  const released = releases.filter((r) => r.status === "released");
  for (const r of released) {
    if (r.releasedAt === null) throw new RangeError("a released row has no release time");
    lines.push({ kind: "released", releaseId: r.id, releasedOn: localDateOf(r.releasedAt, zone), amountCents: r.amountCents });
  }

  const withheld = sum(lines.map((l) => (l.kind === "withheld" ? l.withheldCents : 0)));
  const charges = sum(lines.map((l) => (l.kind === "withheld" ? l.chargesCents : 0)));
  const releasedCents = sum(released.map((r) => r.amountCents));
  // Opening zero, plus what was withheld, less what was charged and what went back to the driver.
  const closing = withheld - charges - releasedCents;
  if (!Number.isSafeInteger(closing)) throw new RangeError("closing balance is not cents");
  const open = releases.find((r) => r.status === "issuing" || r.status === "unknown") ?? null;
  return {
    driverId: driver.id,
    driverCode: driver.code,
    activeFrom: driver.activeFrom,
    activeTo: driver.activeTo,
    terminated: isTerminated(driver, asOf),
    asOf,
    openingCents: 0,
    withheldCents: withheld,
    chargesCents: charges,
    releasedCents,
    closingCents: closing,
    balanceCents: driver.balanceCents,
    matches: closing === driver.balanceCents,
    lines,
    openRelease: open ? { id: open.id, status: open.status, amountCents: open.amountCents } : null,
  };
}
