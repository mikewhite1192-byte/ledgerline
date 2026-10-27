import type { AiFormat } from "../ai/types";

// What the reading model is asked to return from a redacted dock clip, and the only shape the app
// keeps from it. Every field is a printed value bounded by a pattern; there is no field for a
// person and no free text, so a name cannot be stored even if one were read.

export type Confidence = "low" | "medium" | "high";

export type ClockReading = {
  // "4:05 AM", "04:05", "16:05:12": hour and minute, seconds and AM or PM when shown.
  clockText: string;
  dateText: string | null;
  // Seconds into the clip where it was read.
  atSeconds: number;
  confidence: Confidence;
};

export type PrintedValue = { value: string; atSeconds: number; confidence: Confidence };

export type ClipReading = {
  arrival: ClockReading | null;
  departure: ClockReading | null;
  bolNumber: PrintedValue | null;
  sealNumber: PrintedValue | null;
  doorText: string | null;
};

export const CLOCK_TEXT = /^\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?$/;
export const DATE_TEXT = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
export const PRINTED_VALUE = /^[A-Z0-9-]{3,20}$/;
export const DOOR_TEXT = /^[A-Z0-9 -]{1,24}$/;
const CONFIDENCES: readonly string[] = ["low", "medium", "high"];

const confidence = { type: "string", enum: ["low", "medium", "high"] };
const at = { type: "number", minimum: 0 };
const clock = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["clockText", "dateText", "atSeconds", "confidence"],
  properties: {
    clockText: { type: "string", pattern: CLOCK_TEXT.source },
    dateText: { type: ["string", "null"], pattern: DATE_TEXT.source },
    atSeconds: at,
    confidence,
  },
};
const printed = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["value", "atSeconds", "confidence"],
  properties: { value: { type: "string", pattern: PRINTED_VALUE.source }, atSeconds: at, confidence },
};

export const CLIP_FORMAT: AiFormat = {
  name: "dock_clip_reading",
  strict: false,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["arrival", "departure", "bolNumber", "sealNumber", "doorText"],
    properties: {
      arrival: clock,
      departure: clock,
      bolNumber: printed,
      sealNumber: printed,
      doorText: { type: ["string", "null"], pattern: DOOR_TEXT.source },
    },
  },
};

export const CLIP_PROMPT = [
  "This is a short loading-dock camera clip. Faces and license plates in it are blurred on purpose.",
  "Read only what is printed or burned into the picture: the camera's clock, the paperwork's",
  "numbers and the dock's signs. Ignore people; never report a person or a name.",
  "Return JSON with these fields:",
  "- arrival: the camera clock in the first part of the clip (the truck at the door), or null.",
  "- departure: the camera clock in the last part of the clip, when it shows a later time, or null.",
  "  For each clock: clockText is the hour and minute as shown (keep AM or PM when shown),",
  "  dateText is the date as shown (MM/DD/YYYY) or null, atSeconds is where in the clip you read it,",
  "  confidence is low, medium or high.",
  "- bolNumber: the bill of lading number printed on the paperwork (value in capitals, digits and",
  "  hyphens exactly as printed), with atSeconds and confidence, or null.",
  "- sealNumber: the seal number printed on the paperwork, the same way, or null.",
  "- doorText: the dock door sign's text in capitals (for example RECEIVING DOOR 7), or null.",
  "Use null for anything you cannot read with certainty. Never guess a digit.",
].join("\n");

export type ClipReadingParse =
  | { ok: true; reading: ClipReading }
  | { ok: false; category: "not_json" | "shape" | "value" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(v: Record<string, unknown>, keys: string[]): boolean {
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
}

class Refused extends Error {
  constructor(readonly category: "shape" | "value") {
    super(category);
  }
}

function atSeconds(v: unknown, maxSeconds: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Refused("shape");
  if (v < 0 || v > maxSeconds) throw new Refused("value");
  return Math.round(v * 10) / 10;
}

function confidenceOf(v: unknown): Confidence {
  if (typeof v !== "string" || !CONFIDENCES.includes(v)) throw new Refused("value");
  return v as Confidence;
}

function clockOf(v: unknown, maxSeconds: number): ClockReading | null {
  if (v === null) return null;
  if (!isRecord(v) || !exactKeys(v, ["clockText", "dateText", "atSeconds", "confidence"])) {
    throw new Refused("shape");
  }
  if (typeof v.clockText !== "string" || !CLOCK_TEXT.test(v.clockText)) throw new Refused("value");
  if (v.dateText !== null && (typeof v.dateText !== "string" || !DATE_TEXT.test(v.dateText))) {
    throw new Refused("value");
  }
  return {
    clockText: v.clockText,
    dateText: v.dateText,
    atSeconds: atSeconds(v.atSeconds, maxSeconds),
    confidence: confidenceOf(v.confidence),
  };
}

function printedOf(v: unknown, maxSeconds: number): PrintedValue | null {
  if (v === null) return null;
  if (!isRecord(v) || !exactKeys(v, ["value", "atSeconds", "confidence"])) throw new Refused("shape");
  if (typeof v.value !== "string" || !PRINTED_VALUE.test(v.value)) throw new Refused("value");
  return { value: v.value, atSeconds: atSeconds(v.atSeconds, maxSeconds), confidence: confidenceOf(v.confidence) };
}

// The model's text as a reading, or the category of why not. An extra property, a missing one or
// a value outside its pattern refuses the whole reading: a person reads the clip instead. The
// text itself is never returned or kept.
export function parseClipReading(text: string, durationMs: number): ClipReadingParse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, category: "not_json" };
  }
  if (!isRecord(json) || !exactKeys(json, ["arrival", "departure", "bolNumber", "sealNumber", "doorText"])) {
    return { ok: false, category: "shape" };
  }
  const maxSeconds = durationMs / 1000;
  try {
    const doorText = json.doorText;
    if (doorText !== null && (typeof doorText !== "string" || !DOOR_TEXT.test(doorText))) {
      throw new Refused("value");
    }
    return {
      ok: true,
      reading: {
        arrival: clockOf(json.arrival, maxSeconds),
        departure: clockOf(json.departure, maxSeconds),
        bolNumber: printedOf(json.bolNumber, maxSeconds),
        sealNumber: printedOf(json.sealNumber, maxSeconds),
        doorText,
      },
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, category: err.category };
    throw err;
  }
}
