import { z } from "zod";
import { normalize } from "./parse";

// A policy's numbered paragraphs, as the read call copied them, and the transcript they make: one
// "<number> <text>" line each, in order. The transcript is the case record (an untrusted_inputs
// row the gateway screens); every quote on the card is checked against it. Pure.

export type Section = { number: string; text: string };

// "6.1", "10.2", "3", "4.1a".
export const SECTION_NUMBER = /^[0-9]{1,3}(?:\.[0-9]{1,3}){0,3}[a-z]?$/;
export const SECTIONS_MAX = 80;
export const SECTION_TEXT_MAX = 1_200;
// One screening chunk (the gateway's CHUNK_CHARS), and the propose call's reserve (format.ts).
export const TRANSCRIPT_MAX = 24_000;

// Control characters other than the line breaks normalize() already folds.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const answerSchema = z.strictObject({
  sections: z.array(z.strictObject({ number: z.string(), text: z.string() })),
});

// The read call's answer, checked: at least one section and at most SECTIONS_MAX, each number
// well formed and used once, each text 1 to SECTION_TEXT_MAX characters once whitespace is
// folded, and the whole transcript at most TRANSCRIPT_MAX. Null otherwise (never a partial read).
export function sectionsFromAnswer(text: string): Section[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) return null;
  const list = parsed.data.sections;
  if (list.length === 0 || list.length > SECTIONS_MAX) return null;
  const out: Section[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const number = s.number.trim().replace(/\.$/, "");
    const body = normalize(s.text.replace(CONTROL, " "));
    if (!SECTION_NUMBER.test(number) || seen.has(number)) return null;
    if (body.length === 0 || body.length > SECTION_TEXT_MAX) return null;
    seen.add(number);
    out.push({ number, text: body });
  }
  if (transcriptOf(out).length > TRANSCRIPT_MAX) return null;
  return out;
}

export function transcriptOf(sections: readonly Section[]): string {
  return sections.map((s) => `${s.number} ${s.text}`).join("\n");
}

// The transcript read back into its sections, by number. Null when a line does not read as one
// (the row was not written by transcriptOf).
export function sectionsOfTranscript(body: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const line of body.split("\n")) {
    const m = /^(\S+) (.+)$/.exec(line);
    if (!m || !SECTION_NUMBER.test(m[1]) || out.has(m[1])) return null;
    out.set(m[1], m[2]);
  }
  return out.size > 0 ? out : null;
}
