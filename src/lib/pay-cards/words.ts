import { formatPeriod } from "../format/dates";
import { lineKindLabel } from "../format/labels";
import { formatCents } from "../format/money";
import { periodWords } from "../driver-notes/words";

// The words a pay card prints, in the driver's language, and the words the cards page shows. In
// code with no database, so a client component may use it. Every amount goes through
// formatCents, so a card prints cents the way the paystub does ("$1,412.00").

export type CardLanguage = "en" | "es";

type CardWords = {
  title: string;
  week: (start: string, end: string) => string;
  netLabel: string;
  earned: (cents: number) => string;
  takenOut: (cents: number) => string;
  loads: (n: number) => string;
  miles: (n: number) => string;
  up: (cents: number) => string;
  down: (cents: number) => string;
  same: string;
  firstWeek: string;
  topChange: (label: string, deltaCents: number) => string;
  carried: (cents: number) => string;
  approved: string;
  paid: string;
  testMode: string;
  kind: (kind: string) => string;
};

const count = (n: number) => n.toLocaleString("en-US");

// Spanish names for the paystub's line kinds; a kind not listed reads as the English label.
const KINDS_ES: Record<string, string> = {
  load_pay: "Pago por cargas",
  accessorial_pay: "Pago extra",
  reimbursement: "Reembolso",
  fuel: "Combustible",
  other_deduction: "Otro descuento",
  carried_shortfall: "Saldo de la semana pasada",
  lease: "Renta del camión",
  insurance: "Seguro",
  escrow: "Fondo de reserva",
  advance_recovery: "Adelanto pagado",
};

export const CARD_WORDS: Record<CardLanguage, CardWords> = {
  en: {
    title: "Pay card",
    week: (start, end) => `Week of ${formatPeriod(start, end)}`,
    netLabel: "Take-home pay",
    earned: (c) => `Earned ${formatCents(c)}`,
    takenOut: (c) => `Taken out ${formatCents(c)}`,
    loads: (n) => `${count(n)} ${n === 1 ? "load" : "loads"}`,
    miles: (n) => `${count(n)} ${n === 1 ? "mile" : "miles"}`,
    up: (c) => `Up ${formatCents(c)} from last week`,
    down: (c) => `Down ${formatCents(c)} from last week`,
    same: "Same as last week",
    firstWeek: "First week on record",
    topChange: (label, d) => `Biggest change: ${label}, ${d > 0 ? "up" : "down"} ${formatCents(Math.abs(d))}`,
    carried: (c) => `Carried shortfall ${formatCents(c)}`,
    approved: "Approved",
    paid: "Paid",
    testMode: "Test mode",
    kind: (kind) => lineKindLabel(kind),
  },
  es: {
    title: "Tarjeta de pago",
    week: (start, end) => `Semana ${periodWords("es", start, end)}`,
    netLabel: "Pago neto",
    earned: (c) => `Ganado ${formatCents(c)}`,
    takenOut: (c) => `Descontado ${formatCents(c)}`,
    loads: (n) => `${count(n)} ${n === 1 ? "carga" : "cargas"}`,
    miles: (n) => `${count(n)} ${n === 1 ? "milla" : "millas"}`,
    up: (c) => `${formatCents(c)} más que la semana pasada`,
    down: (c) => `${formatCents(c)} menos que la semana pasada`,
    same: "Igual que la semana pasada",
    firstWeek: "Primera semana registrada",
    topChange: (label, d) => `Mayor cambio: ${label}, ${d > 0 ? "sube" : "baja"} ${formatCents(Math.abs(d))}`,
    carried: (c) => `Faltante que pasa a la próxima semana ${formatCents(c)}`,
    approved: "Aprobado",
    paid: "Pagado",
    testMode: "Modo de prueba",
    kind: (kind) => (Object.hasOwn(KINDS_ES, kind) ? KINDS_ES[kind] : lineKindLabel(kind)),
  },
};

// The pill on each row of the cards page. Text is the signal; the tone is the echo.
export type CardPill = "none" | "checking" | "checked" | "mismatch" | "unavailable" | "budget" | "stale";

export const CARD_PILL_WORDS: Record<CardPill, string> = {
  none: "Not made yet",
  checking: "Checking now",
  checked: "Checked",
  mismatch: "Did not match, not saved",
  unavailable: "Could not check",
  budget: "Waiting for budget",
  stale: "Out of date, make it again",
};

export const CARD_PILL_TONES: Record<CardPill, "neutral" | "info" | "success" | "warning" | "destructive"> = {
  none: "neutral",
  checking: "info",
  checked: "success",
  mismatch: "destructive",
  unavailable: "warning",
  budget: "warning",
  stale: "neutral",
};

// What one failed card says under its pill: a category only, never what the model read.
export const CARD_REASON_WORDS: Record<string, string> = {
  number_mismatch: "A figure on the card did not match the paystub.",
  text_mismatch: "The name or the week on the card did not match the paystub.",
  off_schema: "The check could not read the card.",
  timeout: "The check did not answer in time.",
  budget: "The model budget is used up for now.",
  unknown: "The check did not finish.",
};

// The route's refusal codes, in words. The raw reply never reaches the page.
export const CARD_ERROR_WORDS: Record<string, string> = {
  cards_off: "Pay cards are switched off.",
  ai_off: "The models are switched off, so no card can be checked right now.",
  not_found: "This paystub is not here.",
  not_approved: "Only an approved paystub gets a pay card.",
  bad_image: "The card picture was not the right size. Reload the page and try again.",
  attempts: "This paystub has used all three tries.",
  day_cap: "This carrier made the most pay cards allowed today. Try again tomorrow.",
  batch_cap: "This run reached its spending limit. Make pay cards again to go on.",
  budget: "The model budget is used up for now.",
  busy: "Another card for this paystub is being checked. Wait a moment.",
  already_checked: "This card is already checked.",
  forbidden: "This login cannot make pay cards for this carrier.",
  unauthenticated: "Your session ended. Sign in again.",
};

export const CARD_ERROR_FALLBACK = "Nothing was lost or sent. The card was not saved. Try again.";
