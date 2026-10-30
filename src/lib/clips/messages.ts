import { STAFF_ONLY_NOTE } from "../../components/app/staff-only";
import { AGREEMENT_TOLERANCE_MINUTES, type Agreement } from "./agreement";
import type { ClipStatus } from "./types";

// What a person reads for each clip category and state. Pure, so the browser and tests share it.

const MESSAGES: Readonly<Record<string, string>> = {
  disabled: "Dock clips are turned off.",
  too_large: "That file is over 700 KB. Trim it to 20 seconds or less and try again.",
  unsupported:
    "That file is not a clip this page can take: an MP4 video saved as H.264 or H.265, with a steady frame rate and an even width and height.",
  too_long: "A clip can be at most 20 seconds.",
  limit: "This carrier has reached today's clip limit. Try again tomorrow.",
  duplicate: "That clip was already uploaded.",
  not_found: "That load or clip was not found.",
  busy: "That clip is already being worked on. Try again in about two minutes.",
  failed: "Faces and plates could not be found after three tries, so this clip cannot be kept.",
  budget: "The AI spending cap was reached. Try again later.",
  store_failed: "The blurred clip could not be saved. Try again: nothing is paid for twice.",
  not_ready: "The clip is not ready for that yet.",
  mismatch: "The blurred clip does not match the clip that was uploaded.",
  unchanged: "The blurred clip came back unchanged, so it was not saved.",
  conflict: "A different blurred clip is already saved for this upload.",
  read_failed: "The clip could not be read this time. Try again.",
  read_spent: "The clip could not be read after three tries, so a person needs to watch it and check the times.",
  no_webcodecs: "This browser cannot blur video. Use a current Chrome, Edge or Safari.",
  decode: "Your browser could not play this file to blur it.",
  encode: "Your browser could not write the blurred clip.",
  forbidden: "You do not have access to this carrier.",
  judge: STAFF_ONLY_NOTE,
  unauthenticated: "Your session ended. Sign in again.",
  bad_request: "That request was not complete. Pick the load, the stop and the file again.",
  unavailable: "Something went wrong on our side. Try again.",
};

export function clipMessage(category: string): string {
  return Object.hasOwn(MESSAGES, category) ? MESSAGES[category] : MESSAGES.unavailable;
}

const STATUS_TEXT: Readonly<Record<ClipStatus, string>> = {
  redacting: "Waiting for the blurred clip",
  redacted: "Blurred, not read yet",
  read: "Read",
  unreadable: "Needs a person to read it",
  budget: "Waiting for budget",
};

export function clipStatusText(status: ClipStatus): string {
  return STATUS_TEXT[status];
}

const minutes = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);

// The agreement in words, with how far off each side is when it differs.
export function agreementText(agreement: Agreement): string {
  if (agreement.result === "no_clock") return "No camera clock was read";
  if (agreement.result === "no_times") return "No stored stop time to compare with";
  if (agreement.result === "matches") return "Matches the stored stop times";
  const parts: string[] = [];
  if (agreement.arrivalMinutesOff !== null && agreement.arrivalMinutesOff > AGREEMENT_TOLERANCE_MINUTES) {
    parts.push(`arrival ${minutes(agreement.arrivalMinutesOff)} off`);
  }
  if (agreement.departureMinutesOff !== null && agreement.departureMinutesOff > AGREEMENT_TOLERANCE_MINUTES) {
    parts.push(`departure ${minutes(agreement.departureMinutesOff)} off`);
  }
  return parts.length > 0 ? `Differs from the stored stop times (${parts.join(", ")})` : "Differs from the stored stop times";
}

// 4.2 seconds as "0:04".
export function clipTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
