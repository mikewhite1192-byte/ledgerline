import { formatCents } from "../format/money";
import type { DocumentMime, DocumentRead, FieldCheck, MatchResult } from "./types";

// What a marked copy of a document photo would show, worked out by code from the stored reading
// and its comparison with the records: which field, the callout written beside it, and the
// printed line the image model circles. Pure: no model, no database. The callout's words and
// numbers are ours (the records' values through formatCents); the model only draws them.
//
// The target, in order: the first field whose value differs from the record and whose claim is
// printed on one line the reading transcribed; else the field a proposal rests on (the receipt's
// total for a missing reimbursement; the linehaul, then the fuel surcharge, for a load's missing
// rate); else nothing to mark. A line is found by whole tokens only, never by a part of a value.

export const MARKUP_CALLOUT_MAX = 80;

export type MarkupLanguage = "en" | "es";

// Why a document has nothing to mark. not_image: a PDF. not_read: no reading to work from.
// not_matched: no record to compare with. agrees: nothing differs and nothing is proposed.
// no_anchor_line: the value is not on any line the reading transcribed, so no circle is asked for.
export type MarkupBlocked = "not_image" | "not_read" | "not_matched" | "agrees" | "no_anchor_line";

export type MarkupPlan =
  | {
      ok: true;
      // The compared field's name ("total_cents"), stored as markup_target.
      target: string;
      callout: string;
      // The transcribed line the circle goes around, verbatim.
      anchor: string;
      // The document's value for the target when it is an amount, else null.
      claimCents: number | null;
      // True when the reading saw the SAMPLE band, so the edit keeps it rather than adds one.
      hasSampleBand: boolean;
    }
  | { ok: false; reason: MarkupBlocked };

const IMAGE_MIMES: readonly DocumentMime[] = ["image/jpeg", "image/png", "image/webp"];

const CENTS_FIELDS = new Set(["total_cents", "linehaul_cents", "fuel_surcharge_cents", "price_cents", "rate_per_mile_cents"]);

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// One value as the callout writes it. Null when it cannot be written (not the expected type).
export function calloutValue(name: string, value: string | number | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") {
    const text = value.trim().replace(/\s+/g, " ");
    return text === "" ? null : text;
  }
  if (!isCount(value)) return null;
  if (CENTS_FIELDS.has(name)) return formatCents(value);
  if (name === "gallons_milli") return `${(value / 1000).toFixed(3)} gal`;
  if (name === "loaded_miles") return `${value.toLocaleString("en-US")} mi`;
  return String(value);
}

const WORDS = {
  en: {
    differs: (record: string, claim: string) => `Record says ${record}. Document says ${claim}.`,
    missing: (total: string) => `Not on the paystub yet: ${total}`,
    rate: (linehaul: string, fsc: string) => `Load has no rate yet. This page sets ${linehaul} plus ${fsc} fuel.`,
  },
  es: {
    differs: (record: string, claim: string) => `El registro dice ${record}. El documento dice ${claim}.`,
    missing: (total: string) => `Aún no está en el talón de pago: ${total}`,
    rate: (linehaul: string, fsc: string) =>
      `La carga aún no tiene tarifa. Esta hoja fija ${linehaul} más ${fsc} de combustible.`,
  },
} as const;

// The callout in the driver's language when it fits, else in English; null when neither fits.
function fitted(build: (lang: MarkupLanguage) => string, language: MarkupLanguage): string | null {
  for (const lang of language === "es" ? (["es", "en"] as const) : (["en"] as const)) {
    const text = build(lang);
    if (text.length <= MARKUP_CALLOUT_MAX) return text;
  }
  return null;
}

// A token as compared: edge punctuation off (a leading dollar sign stays), upper case.
function tokenOf(raw: string): string {
  return raw.replace(/^[^\w$]+/, "").replace(/[^\w]+$/, "").toUpperCase();
}

function tokensOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map(tokenOf)
    .filter((t) => t !== "");
}

// The ways a claim may be printed: an amount with or without the dollar sign and the thousands
// commas, a count with or without commas, gallons to three places, a string as it was read.
export function printedForms(name: string, claim: string | number): string[] {
  if (typeof claim === "string") return [claim];
  if (!isCount(claim)) return [];
  if (CENTS_FIELDS.has(name)) {
    const money = formatCents(claim);
    const plain = money.replace(/,/g, "");
    return [money, money.slice(1), plain, plain.slice(1)];
  }
  if (name === "gallons_milli") return [(claim / 1000).toFixed(3), String(claim / 1000)];
  return [claim.toLocaleString("en-US"), String(claim)];
}

function containsRun(line: string[], run: string[]): boolean {
  if (run.length === 0 || run.length > line.length) return false;
  for (let i = 0; i + run.length <= line.length; i++) {
    if (run.every((t, j) => line[i + j] === t)) return true;
  }
  return false;
}

// A line the edit prompt may quote: short, and only letters, digits, spaces and the punctuation a
// receipt prints. The line is the document's own text, so anything longer or stranger is never
// put in front of the image model.
export const MARKUP_ANCHOR_MAX = 80;
const QUOTABLE = /^[A-Za-z0-9 $.,:;/#&'()%+-]+$/;

// The first transcribed line, top to bottom, that holds one printed form of the claim as whole
// tokens in a row and may be quoted. Null when no line does.
export function anchorLine(textLines: readonly string[], name: string, claim: string | number): string | null {
  const forms = printedForms(name, claim)
    .map(tokensOf)
    .filter((f) => f.length > 0);
  if (forms.length === 0) return null;
  for (const line of textLines) {
    if (line.length > MARKUP_ANCHOR_MAX || !QUOTABLE.test(line)) continue;
    const tokens = tokensOf(line);
    if (forms.some((f) => containsRun(tokens, f))) return line;
  }
  return null;
}

// Every amount written with cents ("$1,234.50", "1234.50") or a dollar sign ("$175"), in cents.
// A longer number ("52.418", "$3.899") is not an amount and is skipped whole.
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  const pattern = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{2})?(?![\d,.]*\d)/g;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > 0 && /[\w.,]/.test(text[start - 1])) continue;
    if (!m[1] && !m[3]) continue;
    const dollars = Number(m[2].replace(/,/g, ""));
    const cents = m[3] ? Number(m[3].slice(1)) : 0;
    const total = dollars * 100 + cents;
    if (Number.isSafeInteger(total)) out.push(total);
  }
  return out;
}

function claimOf(match: { fields: FieldCheck[] }, name: string): string | number | null {
  return match.fields.find((f) => f.name === name)?.claim ?? null;
}

export function planMarkup(
  doc: { mime: DocumentMime; read: DocumentRead | null; match: MatchResult | null },
  language: MarkupLanguage = "en",
): MarkupPlan {
  if (!IMAGE_MIMES.includes(doc.mime)) return { ok: false, reason: "not_image" };
  const read = doc.read;
  if (!read) return { ok: false, reason: "not_read" };
  const match = doc.match;
  if (!match || !match.found) return { ok: false, reason: "not_matched" };
  const hasSampleBand = read.fields.sampleWord;
  const lines = read.textLines;
  const plan = (target: string, callout: string, anchor: string, claim: string | number | null): MarkupPlan => ({
    ok: true,
    target,
    callout,
    anchor,
    claimCents: CENTS_FIELDS.has(target) && isCount(claim) ? claim : null,
    hasSampleBand,
  });

  const differs = match.fields.filter((f) => f.status === "differs");
  if (differs.length > 0) {
    for (const f of differs) {
      const record = calloutValue(f.name, f.record);
      const claim = calloutValue(f.name, f.claim);
      if (record === null || claim === null || f.claim === null) continue;
      const callout = fitted((lang) => WORDS[lang].differs(record, claim), language);
      if (callout === null) continue;
      const anchor = anchorLine(lines, f.name, f.claim);
      if (anchor !== null) return plan(f.name, callout, anchor, f.claim);
    }
    return { ok: false, reason: "no_anchor_line" };
  }

  if (match.supports === "missing_reimbursement") {
    const total = claimOf(match, "total_cents") ?? read.fields.totalCents;
    const shown = calloutValue("total_cents", total);
    if (total === null || shown === null) return { ok: false, reason: "no_anchor_line" };
    const callout = fitted((lang) => WORDS[lang].missing(shown), language);
    const anchor = anchorLine(lines, "total_cents", total);
    if (callout === null || anchor === null) return { ok: false, reason: "no_anchor_line" };
    return plan("total_cents", callout, anchor, total);
  }

  if (match.supports === "load_rate_fill") {
    const linehaul = claimOf(match, "linehaul_cents") ?? read.fields.linehaulCents;
    const fsc = claimOf(match, "fuel_surcharge_cents") ?? read.fields.fuelSurchargeCents;
    const linehaulShown = calloutValue("linehaul_cents", linehaul);
    const fscShown = calloutValue("fuel_surcharge_cents", fsc);
    if (linehaul === null || fsc === null || linehaulShown === null || fscShown === null) {
      return { ok: false, reason: "no_anchor_line" };
    }
    const callout = fitted((lang) => WORDS[lang].rate(linehaulShown, fscShown), language);
    if (callout === null) return { ok: false, reason: "no_anchor_line" };
    for (const [name, claim] of [
      ["linehaul_cents", linehaul],
      ["fuel_surcharge_cents", fsc],
    ] as const) {
      const anchor = anchorLine(lines, name, claim);
      if (anchor !== null) return plan(name, callout, anchor, claim);
    }
    return { ok: false, reason: "no_anchor_line" };
  }

  return { ok: false, reason: "agrees" };
}

// The edit instruction. The line and the callout are the only variable parts; both come from
// this file (the line is the reading's own transcription, at most 80 characters, MARKUP_ANCHOR_MAX).
export function markupPrompt(plan: Extract<MarkupPlan, { ok: true }>): string {
  const band = plan.hasSampleBand
    ? "Keep every other letter, number and part of the photo exactly as it is, including the SAMPLE band."
    : "Keep every other letter, number and part of the photo exactly as it is, and add one dark band along the bottom edge with the word SAMPLE in large white letters.";
  return (
    `On this photo draw one red oval around the printed line that reads exactly: ${plan.anchor}. ` +
    `Next to it add one white box with a red border containing exactly this text: ${plan.callout}. ` +
    band
  );
}
