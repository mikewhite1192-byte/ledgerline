import { formatPeriod } from "../format/dates";
import { formatCents } from "../format/money";
import type { NoteLanguage } from "./verify";

// The words the notes pages and the email show, in code: no database, safe for a client
// component. The fallback line is built from the settlement's own net pay: it is what the driver
// sees when no approved note exists for a settlement whose note failed the check or was rejected.

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function partsOf(value: string): { year: number; month: number; day: number } {
  const m = DATE.exec(value);
  if (!m) throw new RangeError("a date must be YYYY-MM-DD");
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new RangeError("a date must be YYYY-MM-DD");
  return { year: Number(m[1]), month, day: Number(m[3]) };
}

// "Oct 26 to Nov 1, 2026" in English; "del 26 de octubre al 1 de noviembre de 2026" in Spanish.
export function periodWords(language: NoteLanguage, start: string, end: string): string {
  if (language === "en") return formatPeriod(start, end);
  const a = partsOf(start);
  const b = partsOf(end);
  if (end < start) throw new RangeError("a period cannot end before it starts");
  const head = `${a.day} de ${MONTHS_ES[a.month - 1]}${a.year === b.year ? "" : ` de ${a.year}`}`;
  return `del ${head} al ${b.day} de ${MONTHS_ES[b.month - 1]} de ${b.year}`;
}

export function fallbackLine(language: NoteLanguage, start: string, end: string, netCents: number): string {
  const net = formatCents(netCents);
  return language === "es"
    ? `Su pago ${periodWords("es", start, end)} es ${net}. Su recibo de pago muestra cada línea.`
    : `Your pay for ${periodWords("en", start, end)} is ${net}. Your paystub lists every line.`;
}

export const LANGUAGE_WORDS: Record<NoteLanguage, string> = { en: "English", es: "Spanish" };

export const NOTE_STATUS_WORDS: Record<string, string> = {
  drafting: "Drafting",
  drafted: "Waiting for approval",
  refused: "Failed the check",
  over_cap: "Not drafted",
  approved: "Approved",
  rejected: "Rejected",
};

const REFUSAL_WORDS: Record<string, string> = {
  number_mismatch: "the draft had a number that is not on the paystub.",
  line_mismatch: "the draft cited a line that is not on the paystub.",
  language: "the draft was not in the driver's language.",
  format: "the draft was not a readable note.",
  incomplete: "the draft was cut short.",
  interrupted: "drafting stopped before it finished.",
  disabled: "the models were switched off.",
  not_configured: "the model connection is not set up.",
  cap: "the model spending cap was reached.",
  too_expensive: "the note would have cost more than its limit.",
  rate_limited: "the model was busy.",
  unavailable: "the model did not answer.",
  timeout: "the model did not answer in time.",
  network: "the model could not be reached.",
};

// "Not shown to the driver: the draft had a number that is not on the paystub."
export function refusalWords(category: string | null): string {
  const reason = (category && REFUSAL_WORDS[category]) || "the model call failed.";
  return `Not shown to the driver: ${reason}`;
}
