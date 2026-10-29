import type { BadgeTone } from "../../components/ui/badge";
import { centsToDisplay } from "../ai/prices";
import { codeToWords } from "../format/labels";
import type { VoiceStatus } from "./pipeline";

// The voice pages' fixed words: a label and a tone per status, a sentence per stop or refusal
// category, the model behind each step. Nothing a model or an upstream service wrote is shown
// through these.

export const VOICE_STATUS_WORDS: Readonly<Record<VoiceStatus, { label: string; tone: BadgeTone }>> = {
  transcribed: { label: "Transcribed", tone: "neutral" },
  blocked: { label: "Held for a person to read", tone: "warning" },
  ready: { label: "Ready for the agent", tone: "info" },
  handed_off: { label: "With the agent", tone: "info" },
  replied: { label: "Reply drafted", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
};

export function statusWords(status: string): { label: string; tone: BadgeTone } {
  return Object.hasOwn(VOICE_STATUS_WORDS, status)
    ? VOICE_STATUS_WORDS[status as VoiceStatus]
    : { label: codeToWords(status), tone: "neutral" };
}

// One sentence per category a step or a stored note can carry. Unknown categories get the
// fallback, never their own text.
const NOTICES: Readonly<Record<string, string>> = {
  disabled: "Voice notes are switched off.",
  ai_off: "The models are switched off, so voice notes cannot be read right now.",
  agent_off: "The agent is switched off, so the note cannot be handed over right now.",
  bad_request: "Pick a driver and a clip, then try again.",
  unauthenticated: "Your sign-in ended. Sign in again, then retry.",
  forbidden: "This login cannot add voice notes for this carrier.",
  not_found: "That driver or note is not on file for your carrier.",
  too_large: "That clip is too big. Keep it under about 60 seconds and 700 KB.",
  too_long: "That clip is too long. Keep it under 60 seconds.",
  bad_audio: "That file type is not supported. Use a WAV, MP3, M4A, WebM or Ogg clip.",
  bad_wav: "That clip could not be read as audio. Try another file.",
  limit: "Today's voice note limit for your carrier is reached. Try again tomorrow.",
  no_speech: "No speech was heard in that clip.",
  cap: "Demo budget reached. The models pause until the budget is raised; nothing was lost.",
  too_expensive: "That clip would cost more than one note is allowed. Try a shorter clip.",
  timeout: "The model took too long. Try again in a moment; the note keeps its place.",
  unavailable: "The model service is not answering. Try again in a moment.",
  rate_limited: "The model service is busy. Try again in a moment.",
  network: "The model service could not be reached. Try again in a moment.",
  out_of_time: "This step ran out of time. Press it again; the note keeps its place.",
  not_configured: "The models are not set up for this carrier yet.",
  bad_answer: "The model's answer could not be used, so the note stopped here.",
  busy: "The agent is answering another question. Try again in a moment.",
  not_ready: "That note is not at this step yet.",
  screen_flagged: "The safety screen flagged this note.",
  screen_error: "The safety screen could not check this note, so it was held. Ask the driver to send it again.",
  budget: "The safety screen's budget is used up, so the note was held.",
};
const FALLBACK = "That did not finish. Reload the page to see where the note is before trying again.";

export function noticeFor(category: string | null | undefined): string {
  return typeof category === "string" && Object.hasOwn(NOTICES, category) ? NOTICES[category] : FALLBACK;
}

// Why a note stopped, as stored: the screen's reason or a model failure's category.
export function stoppedWords(status: string, category: string | null): string {
  if (status === "blocked") {
    return category === "screen_error" || category === "budget"
      ? noticeFor(category)
      : "The safety screen held this note, so no model read it and the agent cannot see it.";
  }
  return noticeFor(category);
}

const TARGETS: Readonly<Record<string, string>> = {
  voice: "Muse Voice Transcribe",
  spark: "Muse Spark",
  spark_open: "Muse Spark Open",
  wonder: "Muse Wonder",
  image: "Muse Image",
  sam: "SAM 3.1",
};

const PURPOSES: Readonly<Record<string, string>> = {
  voice_note_transcribe: "Transcribed the clip",
  screen_untrusted_input: "Screened the words",
  voice_note_prepare: "Found the language, wrote the English copy",
  voice_note_triage: "Sorted the note",
  voice_note_reply: "Translated the reply",
  document_markup: "Marked the line on the photo",
  document_markup_check: "Read the marked copy back",
  pay_card_check: "Read the pay card back",
  pay_card_art: "Made a pay card background",
  pay_card_art_check: "Checked the background for words",
};

export function targetLabel(target: string): string {
  return Object.hasOwn(TARGETS, target) ? TARGETS[target] : codeToWords(target);
}

export function purposeLabel(purpose: string): string {
  return Object.hasOwn(PURPOSES, purpose) ? PURPOSES[purpose] : codeToWords(purpose);
}

export function costWords(nanocents: number): string {
  return `${centsToDisplay(nanocents, 2)}¢`;
}

const LANGUAGES: Readonly<Record<string, string>> = { en: "English", es: "Spanish", other: "Another language", unknown: "Not known" };
export function languageLabel(language: string | null): string {
  return language && Object.hasOwn(LANGUAGES, language) ? LANGUAGES[language] : "Not known yet";
}

export function categoryLabel(category: string | null): string {
  return category ? codeToWords(category) : "Not sorted yet";
}

export function durationWords(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} s`;
}
