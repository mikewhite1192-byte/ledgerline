// The recording types a voice note keeps for playback, and a browser's type for a clip as one of
// ours. Pure, so the browser and the server check the same list.

export const VOICE_MIMES = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg"] as const;
export type VoiceMime = (typeof VOICE_MIMES)[number];

// Parameters dropped (anything after ";"), the common aliases folded in. Anything else comes
// back as given and is refused by the upload check.
const MIME_ALIASES: Readonly<Record<string, VoiceMime>> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/mp3": "audio/mpeg",
};

export function voiceMime(type: string): string {
  const plain = type.split(";")[0].trim().toLowerCase();
  return Object.hasOwn(MIME_ALIASES, plain) ? MIME_ALIASES[plain] : plain;
}

export function isVoiceMime(type: string): type is VoiceMime {
  return (VOICE_MIMES as readonly string[]).includes(type);
}
