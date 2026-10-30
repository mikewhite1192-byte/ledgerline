import type { AiLanguage, CallOutcome, TranscribeTurn } from "../types";
import { asArray, asRecord, upstreamIdFrom } from "./http";

// Muse Voice Transcribe, buffered (https://dev.meta.ai/docs/speech-to-text,
// https://dev.meta.ai/docs/api-reference/voice/transcribe): one multipart POST with a JSON
// `request` part and the WAV as the `audio` part. There is no language in the answer.
export const META_TRANSCRIBE_URL = "https://api.meta.ai/v1/asr/transcribe";
export const META_TRANSCRIBE_ACCEPT = "application/json";

export type VoiceOptions = {
  mode: "PUSH_TO_TALK" | "ENDPOINTING";
  languageBias: AiLanguage[];
  keywords: string[];
};

export type VoiceAnswer = { transcript: string; turns: TranscribeTurn[]; audioDurationMs: number };

// The request part as the API takes it. Exported so a test can read it whole.
export function voiceRequest(model: string, options: VoiceOptions) {
  return {
    model,
    audioEncoding: "WAV",
    mode: options.mode,
    // Omitted means the model detects the language.
    ...(options.languageBias.length > 0 ? { languageBias: options.languageBias } : {}),
    ...(options.keywords.length > 0 ? { keywords: options.keywords } : {}),
  };
}

export function voiceBody(model: string, wav: Uint8Array, options: VoiceOptions): FormData {
  const form = new FormData();
  form.append(
    "request",
    new Blob([JSON.stringify(voiceRequest(model, options))], { type: "application/json" }),
  );
  // Copied into a plain ArrayBuffer: a Blob takes nothing else from a typed array's view.
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  return form;
}

const MAX_INT = 2_147_483_647;
const whole = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_INT;

// A 200 answer. The duration decides the cost (whole seconds, rounded down, as Meta meters it),
// so an answer without a usable audioDurationMs or transcript is unknown, its reservation kept.
export function parseVoice(json: unknown, httpStatus: number): CallOutcome<VoiceAnswer> {
  const body = asRecord(json);
  const durationMs = body?.audioDurationMs;
  if (!body || !whole(durationMs) || typeof body.transcript !== "string") {
    return { kind: "unknown", category: "unknown", httpStatus };
  }
  const turns: TranscribeTurn[] = [];
  for (const raw of asArray(body.turns)) {
    const t = asRecord(raw);
    if (t && whole(t.startMs) && whole(t.endMs) && typeof t.transcript === "string") {
      const turn: TranscribeTurn = { startMs: t.startMs, endMs: t.endMs, transcript: t.transcript };
      if (typeof t.turnId === "string") turn.turnId = t.turnId;
      turns.push(turn);
    }
  }
  return {
    kind: "answered",
    status: "ok",
    httpStatus,
    upstreamId: upstreamIdFrom(body.sessionId),
    metered: { unit: "audio_seconds", seconds: Math.floor(durationMs / 1000) },
    value: { transcript: body.transcript, turns, audioDurationMs: durationMs },
  };
}
