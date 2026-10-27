import { normalizeNumber, type NoteCheck } from "../driver-notes/verify";
import { formatLocalDate } from "../format/dates";
import { formatCents } from "../format/money";
import type { ChaseCandidate, CollectionTone } from "../rules-engine/collections";
import { PAYMENT_LABELS, type PaymentLabel } from "../rules-engine/types";
import { isLocalDate } from "../time/local-date";

// The reminder pack: everything a payment reminder may say, from the invoice's own figures. The
// model sees the customer's name, the carrier's name, the invoice number, its total and balance,
// the due date and how many days late it is, and the tone code picked. Never a record id, an email
// address or another customer's figures. Every amount and number here goes on the check's allowed
// lists, so a reminder can repeat these and nothing else. A digit in the customer's or carrier's
// name is not one of them: it is accepted only inside that exact name (verify.ts), so "Route 66
// Freight" never lets a stray 66 into the reminder.

// What a reminder is written from, stored on the row (collection_drafts.figures) as cents, whole
// days and dates, so the page and the approval check never read them back from the text.
export type ReminderFigures = {
  invoiceNumber: string;
  amountCents: number;
  balanceCents: number;
  dueOn: string;
  daysLate: number;
  // The carrier-local date the figures were read on.
  asOf: string;
  profileLabel: PaymentLabel;
};

export function figuresOf(candidate: ChaseCandidate, asOf: string): ReminderFigures {
  return {
    invoiceNumber: candidate.invoiceNumber,
    amountCents: candidate.amountCents,
    balanceCents: candidate.balanceCents,
    dueOn: candidate.dueOn,
    daysLate: candidate.daysLate,
    asOf,
    profileLabel: candidate.profile.label,
  };
}

const FIGURE_KEYS = ["amountCents", "asOf", "balanceCents", "daysLate", "dueOn", "invoiceNumber", "profileLabel"];
const INVOICE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

const wholeCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// The stored figures read back exactly: every key, no other, each its own type. Anything else is
// null, and the caller treats the reminder as unreadable rather than guessing.
export function parseFigures(value: unknown): ReminderFigures | null {
  let v: unknown = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort();
  if (keys.length !== FIGURE_KEYS.length || keys.some((k, i) => k !== FIGURE_KEYS[i])) return null;
  const f = v as Record<string, unknown>;
  if (typeof f.invoiceNumber !== "string" || !INVOICE_NUMBER.test(f.invoiceNumber)) return null;
  if (!wholeCents(f.amountCents) || !wholeCents(f.balanceCents) || f.balanceCents > f.amountCents) return null;
  if (!isLocalDate(f.dueOn) || !isLocalDate(f.asOf)) return null;
  if (typeof f.daysLate !== "number" || !Number.isSafeInteger(f.daysLate) || f.daysLate < 0) return null;
  if (!(PAYMENT_LABELS as readonly unknown[]).includes(f.profileLabel)) return null;
  return {
    invoiceNumber: f.invoiceNumber,
    amountCents: f.amountCents,
    balanceCents: f.balanceCents,
    dueOn: f.dueOn,
    daysLate: f.daysLate,
    asOf: f.asOf,
    profileLabel: f.profileLabel as PaymentLabel,
  };
}

export type ReminderPack = NoteCheck & {
  invoiceNumber: string;
  amountCents: number;
  balanceCents: number;
  dueOn: string;
  daysLate: number;
  tone: CollectionTone;
  customerName: string;
  carrierName: string;
};

// Every run of digits in a piece of text, normalized the way the check reads a bare figure.
function digitRuns(text: string): string[] {
  return (text.match(/\d+/g) ?? []).map((d) => normalizeNumber(d));
}

export function buildReminderPack(
  figures: ReminderFigures,
  tone: CollectionTone,
  customerName: string,
  carrierName: string,
): ReminderPack {
  const [year, , day] = figures.dueOn.split("-");
  const numbers = new Set<string>([
    normalizeNumber(String(figures.daysLate)),
    ...digitRuns(figures.invoiceNumber),
    normalizeNumber(day),
    normalizeNumber(year),
  ]);
  return {
    language: "en",
    // The first dollar amount in the reminder must be the balance due.
    netCents: figures.balanceCents,
    allowedCents: [...new Set([figures.amountCents, figures.balanceCents])],
    allowedNumbers: [...numbers].sort(),
    seqs: [],
    invoiceNumber: figures.invoiceNumber,
    amountCents: figures.amountCents,
    balanceCents: figures.balanceCents,
    dueOn: figures.dueOn,
    daysLate: figures.daysLate,
    tone,
    customerName,
    carrierName,
  };
}

const TONE_MEANING: Record<CollectionTone, string> = {
  friendly: "friendly: a polite, warm nudge; assume it was missed by accident",
  direct: "direct: clear and businesslike; ask for payment or a payment date",
  firm: "firm: serious and plain; say the balance is well past due and ask for payment now, without threats",
};

// The facts the model writes from, one per line, in the words a person reads them.
export function packText(pack: ReminderPack): string {
  return [
    `Tone: ${TONE_MEANING[pack.tone]}`,
    `From (the carrier): ${pack.carrierName}`,
    `To (the customer): ${pack.customerName}`,
    `Invoice number: ${pack.invoiceNumber}`,
    `Invoice total: ${formatCents(pack.amountCents)}`,
    `Balance due: ${formatCents(pack.balanceCents)}`,
    `Due date: ${formatLocalDate(pack.dueOn)}`,
    `Days past due: ${pack.daysLate}`,
  ].join("\n");
}
