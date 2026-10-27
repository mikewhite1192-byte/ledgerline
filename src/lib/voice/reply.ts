import { z } from "zod";
import type { AiFormat } from "../ai";
import { decisionNoteSentence } from "../advances/reasons";
import { dollars } from "../money/format";

// The reply a person can send back to the driver: a fixed English sentence per outcome, filled
// with the engine's own numbers. For a Spanish note one Muse Spark call translates the filled
// sentence (our own text, never the driver's). Nothing is sent from here; the page shows the draft
// with a Copy button.

export const REPLY_MAX_CHARS = 1_200;
export const TRANSLATED_MAX_CHARS = 600;

export type ReplyOutcome =
  // No proposal yet, and nothing more is needed from the driver.
  | { kind: "received" }
  // An advance was asked for with no amount the office could hear.
  | { kind: "need_amount" }
  | { kind: "proposed"; amountCents: number }
  // Approved, the payment not confirmed yet (or it failed and the office is on it).
  | { kind: "approved"; amountCents: number }
  | { kind: "paid"; amountCents: number; feeCents: number }
  | { kind: "rejected"; note: string | null };

export function replyTemplate(outcome: ReplyOutcome): string {
  switch (outcome.kind) {
    case "received":
      return "We got your voice note. The office is looking at it and will get back to you.";
    case "need_amount":
      return "We got your voice note asking for an advance. How much do you need? Reply with the amount in dollars.";
    case "proposed":
      return (
        `We got your request for an advance of ${dollars(outcome.amountCents)}. ` +
        "It is waiting for approval, and we will let you know when it is paid."
      );
    case "approved":
      return (
        `Your advance of ${dollars(outcome.amountCents)} was approved. ` +
        "The payment has not gone through yet; the office will let you know when it does."
      );
    case "paid":
      return (
        `Your advance of ${dollars(outcome.amountCents)} was approved and sent. ` +
        `A fee of ${dollars(outcome.feeCents)} applies, and both are repaid from your settlement pay.`
      );
    case "rejected": {
      const why = decisionNoteSentence(outcome.note);
      return `Your advance request was not approved.${why ? ` ${why}` : ""} Call the office if you have questions.`;
    }
  }
}

export const REPLY_SYSTEM = [
  "Translate the office's message to a truck driver into natural, polite Mexican Spanish.",
  "Keep every dollar amount exactly as written, with its $ sign, digits, commas and cents.",
  "Add nothing and leave nothing out. Answer with JSON only: { \"reply\": \"...\" }.",
].join("\n");

export const REPLY_FORMAT: AiFormat = {
  name: "voice_note_reply",
  schema: {
    type: "object",
    properties: { reply: { type: "string", maxLength: TRANSLATED_MAX_CHARS } },
    required: ["reply"],
    additionalProperties: false,
  },
};

const ReplyAnswer = z.strictObject({ reply: z.string().min(1).max(TRANSLATED_MAX_CHARS) });

// Every dollar figure a template states, as written ("$300.00", "$1,250.00").
export function figuresOf(text: string): string[] {
  return [...text.matchAll(/\$\d{1,3}(?:,\d{3})*\.\d{2}/g)].map((m) => m[0]);
}

// The translation, or null when it is not JSON of the right shape or it lost or changed any of
// the template's dollar figures: a number the engine did not write never reaches a driver.
export function parseTranslated(answer: string, template: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(answer);
  } catch {
    return null;
  }
  const parsed = ReplyAnswer.safeParse(raw);
  if (!parsed.success) return null;
  const reply = parsed.data.reply.trim();
  if (reply.length === 0) return null;
  const want = figuresOf(template);
  const got = figuresOf(reply);
  if (want.length !== got.length || want.some((f, i) => f !== got[i])) return null;
  return reply;
}
