import { IFTA_SAMPLE_LABEL } from "../../config/ifta-sample-rates";
import { formatCents } from "../format/money";
import { perGallonText } from "../rates/format";
import { iftaQuarter, sum, type IftaGap, type IftaInput, type IftaQuarter, type Period } from "../rules-engine";
import { reportOf } from "./build";
import type { ReportResult, ReportRow } from "./types";

// The IFTA quarter summary (design-ifta 5): one row per state from the engine's iftaQuarter, at
// the SAMPLE rates, with fixed notes that say how each figure was worked out and what the totals
// leave out. Every number is the engine's; this file only lays them out and writes the sentences.

// Load numbers a note names before it says "and N more".
export const IFTA_NOTE_LOADS = 8;

// 450500 is "450.500", the integer part grouped, the sign kept; no floating point.
export function milliText(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError("not a whole number of thousandths");
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 1000).toLocaleString("en-US");
  return `${n < 0 ? "-" : ""}${whole}.${String(abs % 1000).padStart(3, "0")}`;
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function named(items: readonly string[]): string {
  const shown = items.slice(0, IFTA_NOTE_LOADS).join(", ");
  const rest = items.length - IFTA_NOTE_LOADS;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

const LOAD_GAP_WORDS = {
  no_state_split: "with no state split",
  state_miles_mismatch: "whose state miles do not add up to its miles",
} as const;

function gapNotes(q: IftaQuarter): string[] {
  const out: string[] = [];
  for (const kind of ["no_state_split", "state_miles_mismatch"] as const) {
    const loads = q.gaps.filter((g): g is Extract<IftaGap, { loadId: string }> => g.kind === kind);
    if (loads.length === 0) continue;
    const miles = sum(loads.map((g) => g.miles));
    out.push(
      `Excluded from the totals: ${count(loads.length, "load", "loads")} ${LOAD_GAP_WORDS[kind]} ` +
        `(${count(miles, "mile", "miles")}): ${named(loads.map((g) => g.loadNumber))}.`,
    );
  }
  const noRate = q.gaps.filter((g): g is Extract<IftaGap, { state: string }> => g.kind === "state_not_in_rates");
  if (noRate.length > 0) {
    out.push(
      `Excluded from the tax total: ${count(noRate.length, "state", "states")} with no ${IFTA_SAMPLE_LABEL} ` +
        `rate (${named(noRate.map((g) => g.state))}).`,
    );
  }
  return out;
}

function mpgNote(q: IftaQuarter): string {
  if (q.fleetMpgMilli === null) {
    return q.totalGallonsMilli === 0
      ? "Fleet MPG unknown: no fuel purchases in the quarter, so taxable gallons and tax are not computed."
      : "Fleet MPG unknown: no miles with a state split in the quarter, so taxable gallons and tax are not computed.";
  }
  return (
    `Fleet MPG ${milliText(q.fleetMpgMilli)}: ${count(q.totalMiles, "mile", "miles")} / ` +
    `${milliText(q.totalGallonsMilli)} gallons, rounded half up to thousandths. Taxable gallons per state = ` +
    "state miles / fleet MPG, rounded half up to thousandths; their total is a sum of rounded figures, so it " +
    "can differ from the gallons bought by a few thousandths. Tax = net gallons x rate, rounded half away " +
    "from zero to cents. Every recorded mile is counted as taxable."
  );
}

export function iftaNotes(q: IftaQuarter): string[] {
  const notes = [
    `${IFTA_SAMPLE_LABEL} rates: placeholders from the app's own sample table, not official or current IFTA ` +
      "rates. The numbers are not for filing.",
    mpgNote(q),
  ];
  if (q.largestTaxDue) notes.push(`Largest tax due: ${q.largestTaxDue.state}, ${formatCents(q.largestTaxDue.taxCents)}.`);
  const gaps = gapNotes(q);
  notes.push(
    ...(gaps.length > 0
      ? gaps
      : ["No data gaps: every load has a state split that adds up and every fuel purchase has a state."]),
  );
  return notes;
}

export function computeIftaQuarter(input: IftaInput, asOf: string, quarter: Period): ReportResult {
  const q = iftaQuarter(input, quarter);
  const rows: ReportRow[] = q.states.map((s) => ({
    state: s.state,
    miles: s.miles,
    taxPaidGallonsMilli: s.taxPaidGallonsMilli,
    taxableGallonsMilli: s.taxableGallonsMilli,
    netGallonsMilli: s.netGallonsMilli,
    sampleRate: s.rateMcents === null ? "" : perGallonText("ifta_rate", s.rateMcents),
    taxDueCents: s.taxCents,
  }));
  const totals: Record<string, number> = { miles: q.totals.miles, taxPaidGallonsMilli: q.totals.taxPaidGallonsMilli };
  if (q.totals.taxableGallonsMilli !== null) totals.taxableGallonsMilli = q.totals.taxableGallonsMilli;
  if (q.totals.netGallonsMilli !== null) totals.netGallonsMilli = q.totals.netGallonsMilli;
  if (q.totals.taxCents !== null) totals.taxDueCents = q.totals.taxCents;
  // With no rows and nothing left out there is nothing to explain; a gap is always said.
  const notes = rows.length > 0 || q.gaps.length > 0 ? iftaNotes(q) : [];
  const result = reportOf("ifta_quarter", {
    asOf,
    args: { asOf },
    period: { start: q.quarter.start, end: q.quarter.end },
    rows,
    totals,
    notes,
  });
  // Rows run A to Z and a tool result loses them from the end, so the largest tax due also rides
  // whole at the top level, under a cents key the agent's figure check reads.
  return q.largestTaxDue ? { ...result, largestTaxDue: { ...q.largestTaxDue } } : result;
}
