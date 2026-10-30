import type { Queryable } from "../db";
import { readRowsWhereId } from "../data/read";
import type { DriverRow, SettlementLineRow, SettlementPeriodRow, SettlementRow } from "../data/rows";
import { formatPeriod } from "../format/dates";
import { codeToWords, lineKindLabel } from "../format/labels";
import { formatCents } from "../format/money";
import { MODEL_LANGUAGE, normalizeNumber, verifyNote, type NoteCheck } from "./verify";

// The paystub pack: everything a note may say, read from stored rows only. The model sees the
// driver's first name and the paystub's lines and totals, never a record id, an email or a last
// name. Every amount and number in the pack goes on the check's allowed lists, so a note can
// repeat anything the paystub shows and nothing else. The deltas are worked out here, in code.

export type PackLine = {
  seq: number;
  kind: string;
  label: string;
  amountCents: number;
  details: string[];
};

export type NotePack = NoteCheck & {
  settlementId: string;
  firstName: string;
  workerType: DriverRow["worker_type"];
  periodStart: string;
  periodEnd: string;
  lines: PackLine[];
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  carryForwardCents: number;
  previousNetCents: number | null;
  netChangeCents: number | null;
  loadCount: number;
};

export type PackInput = {
  settlement: Pick<
    SettlementRow,
    "id" | "gross_cents" | "deductions_cents" | "net_cents" | "carry_forward_cents"
  >;
  period: Pick<SettlementPeriodRow, "period_start" | "period_end">;
  driver: Pick<DriverRow, "first_name" | "worker_type" | "preferred_language">;
  lines: Pick<SettlementLineRow, "seq" | "kind" | "label" | "amount_cents" | "sources" | "meta">[];
  previousNetCents: number | null;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "perMileCents" reads "per mile"; "loadedMiles" reads "loaded miles".
function keyWords(key: string, suffix: string): string {
  const stem = suffix && key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
  return stem.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
}

function percentOf(bps: number): string {
  return normalizeNumber((bps / 100).toFixed(2));
}

export function buildPack(input: PackInput): NotePack {
  const cents = new Set<number>();
  const numbers = new Set<string>();
  const addCents = (c: number) => {
    if (Number.isSafeInteger(c)) cents.add(Math.abs(c));
  };
  const addNumber = (n: number | string) => {
    const s = String(n);
    if (/^\d+(\.\d+)?$/.test(s)) numbers.add(normalizeNumber(s));
  };

  for (const value of [input.period.period_start, input.period.period_end]) {
    const m = DATE.exec(value);
    if (!m) throw new RangeError("a period date must be YYYY-MM-DD");
    for (const part of m.slice(1)) addNumber(part);
  }

  const lines = [...input.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((l): PackLine => {
      addCents(l.amount_cents);
      addNumber(l.seq);
      for (const run of l.label.match(/\d+/g) ?? []) addNumber(run);
      const details: string[] = [];
      let miles = 0;
      for (const [key, value] of Object.entries(l.meta ?? {})) {
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
          if (key.endsWith("Cents")) {
            addCents(value);
            details.push(`${keyWords(key, "Cents")} ${formatCents(value)}`);
          } else if (key.endsWith("Bps")) {
            const pct = percentOf(value);
            addNumber(pct);
            details.push(`${keyWords(key, "Bps")} ${pct}%`);
          } else if (key.endsWith("Miles") || key === "days") {
            addNumber(value);
            if (key.endsWith("Miles")) miles += value;
            details.push(`${keyWords(key, "")} ${value}`);
          }
        } else if (typeof value === "string" && /^[a-z_]{1,30}$/.test(value) && key !== "exception") {
          details.push(`${keyWords(key, "")}: ${codeToWords(value).toLowerCase()}`);
        }
      }
      if (miles > 0) addNumber(miles);
      return { seq: l.seq, kind: l.kind, label: l.label, amountCents: l.amount_cents, details };
    });

  const s = input.settlement;
  for (const c of [s.gross_cents, s.deductions_cents, s.net_cents, s.carry_forward_cents]) addCents(c);
  const netChangeCents = input.previousNetCents === null ? null : s.net_cents - input.previousNetCents;
  if (input.previousNetCents !== null) addCents(input.previousNetCents);
  if (netChangeCents !== null) addCents(netChangeCents);

  const loads = new Set<string>();
  for (const l of input.lines) {
    if (l.kind !== "load_pay") continue;
    for (const src of l.sources) if (src.table === "loads") loads.add(src.id);
  }
  addNumber(loads.size);
  addNumber(lines.length);

  return {
    settlementId: s.id,
    firstName: input.driver.first_name,
    workerType: input.driver.worker_type,
    language: input.driver.preferred_language,
    periodStart: input.period.period_start,
    periodEnd: input.period.period_end,
    lines,
    grossCents: s.gross_cents,
    deductionsCents: s.deductions_cents,
    netCents: s.net_cents,
    carryForwardCents: s.carry_forward_cents,
    previousNetCents: input.previousNetCents,
    netChangeCents,
    loadCount: loads.size,
    allowedCents: [...cents].sort((a, b) => a - b),
    allowedNumbers: [...numbers].sort(),
    seqs: lines.map((l) => l.seq),
  };
}

// The pack as the compact table the model reads. Field names are fixed strings; the values are
// the paystub's own.
export function packText(pack: NotePack): string {
  const rows = pack.lines.map((l) =>
    [
      l.seq,
      lineKindLabel(l.kind).toLowerCase(),
      l.label,
      formatCents(l.amountCents),
      l.details.join("; ") || "-",
    ].join(" | "),
  );
  const out = [
    `Driver first name: ${pack.firstName}`,
    `Driver type: ${pack.workerType === "owner_operator" ? "owner-operator" : "company driver"}`,
    `Pay period: ${formatPeriod(pack.periodStart, pack.periodEnd)}`,
    "Paystub lines (line number | kind | label | amount | details):",
    ...rows,
    `Gross pay: ${formatCents(pack.grossCents)}`,
    `Total deductions: ${formatCents(pack.deductionsCents)}`,
    `Net pay: ${formatCents(pack.netCents)}`,
  ];
  if (pack.carryForwardCents !== 0) {
    out.push(`Shortfall carried to next period: ${formatCents(pack.carryForwardCents)}`);
  }
  if (pack.previousNetCents !== null && pack.netChangeCents !== null) {
    out.push(`Last period's net pay: ${formatCents(pack.previousNetCents)}`);
    const change = pack.netChangeCents;
    out.push(
      change === 0
        ? "Change from last period: none"
        : `Change from last period: ${change > 0 ? "up" : "down"} ${formatCents(Math.abs(change))}`,
    );
  }
  out.push(`Loads this period: ${pack.loadCount}`);
  return out.join("\n");
}

// A stored note as the recheck reads it: cited_seqs is the jsonb column cast to text.
export type StoredNote = { language: string; body: string | null; cited_seqs: string | null };

// The check a note passed when it was drafted, run again on its settlement as it is now: the same
// pack drafting builds, in the note's own language, and the same reply shape drafting verified.
// False when the settlement is no longer settled, the stored note cannot be read, or any number or
// line the note names is no longer on the paystub. Approval and the driver view both run it, so a
// note is never approved or shown against a paystub that changed after it was drafted.
export function recheckNote(
  source: PackInput & { settlement: PackInput["settlement"] & Pick<SettlementRow, "status"> },
  note: StoredNote,
): boolean {
  if (source.settlement.status !== "approved" && source.settlement.status !== "paid") return false;
  const { language, body } = note;
  if (body === null || note.cited_seqs === null) return false;
  if (language !== "en" && language !== "es") return false;
  let citedSeqs: unknown;
  try {
    citedSeqs = JSON.parse(note.cited_seqs);
  } catch {
    return false;
  }
  const pack: NotePack = { ...buildPack(source), language };
  const reply = JSON.stringify({ language: MODEL_LANGUAGE[language], body, cited_seqs: citedSeqs });
  return verifyNote(reply, pack).ok;
}

export type StoredNoteSource = PackInput & {
  settlement: PackInput["settlement"] & Pick<SettlementRow, "status" | "period_id" | "driver_id">;
  driver: PackInput["driver"] & Pick<DriverRow, "id" | "code" | "last_name" | "email">;
  period: PackInput["period"] & Pick<SettlementPeriodRow, "id">;
};

// Inside a tenant transaction: the stored rows behind one settlement's pack, or null when the
// settlement is not this tenant's. Every read names the tenant (readRowsWhereId does).
export async function readNoteSource(q: Queryable, settlementId: string): Promise<StoredNoteSource | null> {
  return (await readSource(q, settlementId))?.source ?? null;
}

// A pay card's rows (src/lib/pay-cards): the note's source plus the previous settled week's lines,
// for the card's biggest change. previousLines is null exactly when previousNetCents is.
export type StoredCardSource = StoredNoteSource & {
  previousLines: Pick<SettlementLineRow, "kind" | "amount_cents">[] | null;
};

export async function readCardSource(q: Queryable, settlementId: string): Promise<StoredCardSource | null> {
  const read = await readSource(q, settlementId);
  if (!read) return null;
  const previousLines = read.previousId
    ? (await readRowsWhereId(q, "settlement_lines", "settlement_id", read.previousId)).map((l) => ({
        kind: l.kind,
        amount_cents: l.amount_cents,
      }))
    : null;
  return { ...read.source, previousLines };
}

async function readSource(
  q: Queryable,
  settlementId: string,
): Promise<{ source: StoredNoteSource; previousId: string | null } | null> {
  const [settlement] = await readRowsWhereId(q, "settlements", "id", settlementId);
  if (!settlement) return null;
  const [period] = await readRowsWhereId(q, "settlement_periods", "id", settlement.period_id);
  const [driver] = await readRowsWhereId(q, "drivers", "id", settlement.driver_id);
  if (!period || !driver) return null;
  const lines = await readRowsWhereId(q, "settlement_lines", "settlement_id", settlement.id);
  // The same driver's latest settled pay before this period, for the week-over-week change.
  const previous = await q.query<{ id: string; net_cents: number }>(
    `SELECT CAST(s.id AS text) AS id, s.net_cents
       FROM settlements s
       JOIN settlement_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
      WHERE s.tenant_id = current_tenant_id() AND p.tenant_id = current_tenant_id()
        AND s.driver_id = CAST($1 AS uuid) AND s.status IN ('approved', 'paid')
        AND p.period_start < CAST($2 AS date)
      ORDER BY p.period_start DESC
      LIMIT 1`,
    [settlement.driver_id, period.period_start],
  );
  return {
    source: {
      settlement,
      period,
      driver,
      lines,
      previousNetCents: previous.length === 1 ? Number(previous[0].net_cents) : null,
    },
    previousId: previous.length === 1 ? previous[0].id : null,
  };
}
