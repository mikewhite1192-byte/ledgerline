import { verifyNote, type Verification } from "../driver-notes/verify";
import type { ReminderPack } from "./pack";

// The check every drafted reminder passes before a person sees it. Pure: no database, no clock, no
// model. The reply must parse exactly ({subject, body}, both strings, nothing else). Then:
//   1. subject: one line, 1 to 120 characters, naming the invoice number as a whole word.
//   2. banned words: no interest, fees, penalties, legal action, lawyers, courts, collection
//      agencies or "immediately". A reminder asks; it never threatens or adds a charge.
//   3. numbers: the subject and body together pass the driver-note number check (verifyNote): every
//      amount is the invoice total or the balance, the first amount is the balance due, every
//      other number is one of the pack's own (days late, the invoice number's digits, the due
//      date's day and year), no link, no hidden characters, at least one sentence.
// A reminder that fails is never shown as approvable: the caller stores the category and the
// amounts compared, never the text.

export const REMINDER_CATEGORIES = ["format", "subject", "banned_phrase", "number_mismatch", "language", "line_mismatch"] as const;
export type ReminderCategory = (typeof REMINDER_CATEGORIES)[number];

export const MAX_SUBJECT_CHARS = 120;

export type ReminderReply = { subject: string; body: string };

export type ReminderVerification = Omit<Verification, "category"> & { category: ReminderCategory | null };

export type ReminderResult =
  | { ok: true; subject: string; body: string; verification: ReminderVerification }
  | { ok: false; category: ReminderCategory; verification: ReminderVerification };

const REPLY_KEYS = ["body", "subject"];

export function parseReminder(text: string): ReminderReply | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== REPLY_KEYS.length || keys.some((k, i) => k !== REPLY_KEYS[i])) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.subject !== "string" || typeof v.body !== "string") return null;
  return { subject: v.subject, body: v.body };
}

// Whole words only: "feedback" is not "fee", "interested" is not "interest".
export const BANNED =
  /\b(?:interest|fees?|penalt(?:y|ies)|legal(?:ly)?|lawsuits?|attorneys?|lawyers?|courts?|collection agenc(?:y|ies)|immediately)\b/i;

// A character that would make the invoice number part of a longer token.
const TOKEN_CHAR = /^[A-Za-z0-9-]$/;

// The invoice number as a whole token: "INV-10030" matches "Invoice INV-10030 is past due" but not
// "INV-100301". A plain search, so the number is never compiled into a pattern.
export function namesInvoice(subject: string, invoiceNumber: string): boolean {
  if (invoiceNumber.length === 0) return false;
  for (let at = subject.indexOf(invoiceNumber); at !== -1; at = subject.indexOf(invoiceNumber, at + 1)) {
    const before = at === 0 ? "" : subject[at - 1];
    const after = subject.slice(at + invoiceNumber.length, at + invoiceNumber.length + 1);
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) return true;
  }
  return false;
}

export function verifyReminder(text: string, pack: ReminderPack): ReminderResult {
  const empty: ReminderVerification = {
    allowed: [...new Set(pack.allowedCents.map((c) => Math.abs(c)))].sort((a, b) => a - b),
    found: [],
    numbers: [],
    category: null,
  };
  const fail = (category: ReminderCategory, from: Omit<Verification, "category"> = empty): ReminderResult => ({
    ok: false,
    category,
    verification: { allowed: from.allowed, found: from.found, numbers: from.numbers, category },
  });

  const reply = parseReminder(text);
  if (!reply) return fail("format");
  const subject = reply.subject.trim();
  const body = reply.body.trim();
  if (subject.length === 0 || subject.length > MAX_SUBJECT_CHARS || /[\r\n]/.test(subject)) return fail("subject");
  if (!namesInvoice(subject, pack.invoiceNumber)) return fail("subject");
  if (BANNED.test(subject) || BANNED.test(body)) return fail("banned_phrase");

  const checked = verifyNote(JSON.stringify({ language: "English", body: `${subject}\n${body}`, cited_seqs: [] }), pack);
  if (!checked.ok) return fail(checked.category, checked.verification);
  return { ok: true, subject, body, verification: { ...checked.verification, category: null } };
}
