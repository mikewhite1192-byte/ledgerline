import { receiptLines } from "./documents";
import type { PhotoDoc } from "./manifest";

// The image prompts: a fixed template around the receipt's exact lines. Nothing else goes in,
// so a prompt holds only manifest strings (prompts.test.ts strips the template and checks).

// Where the receipt sits in the frame.
export const PLACEMENT = {
  cab:
    "Photo-realistic smartphone photo taken inside a truck cab: a printed paper receipt lying " +
    "on the passenger seat, seen at an angle, filling about a third of the frame and slightly " +
    "skewed, with seat fabric and part of the dashboard around it, uneven daylight from the " +
    "windshield.",
  flat:
    "Photo-realistic smartphone photo of a printed paper receipt lying flat on a desk, seen " +
    "from directly above and close up, filling most of the frame, slight paper curl and soft " +
    "even light.",
} as const;

export const LINES_INTRO =
  "The receipt is printed in plain black thermal-printer text and reads exactly these lines, " +
  "top to bottom, one per line, every character sharp and legible:";

export const PROMPT_END = "No logos, no brand names, no other text.";

export const BACKGROUND_PROMPT =
  "Photo-realistic top-down photo of a blank sheet of off-white paper filling the whole frame, " +
  "faint paper grain, soft even daylight, nothing printed or written on it. " +
  PROMPT_END;

export function imagePrompt(doc: PhotoDoc): string {
  const placement = doc.cabAngle ? PLACEMENT.cab : PLACEMENT.flat;
  return [placement, LINES_INTRO, ...receiptLines(doc), PROMPT_END].join("\n");
}
