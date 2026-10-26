import { describe, expect, it } from "vitest";
import {
  META_TRANSCRIBE_ACCEPT,
  META_TRANSCRIBE_URL,
  parseVoice,
  voiceBody,
  voiceRequest,
} from "./meta-voice";

const OPTIONS = { mode: "PUSH_TO_TALK" as const, languageBias: [], keywords: [] };

describe("voiceRequest and voiceBody", () => {
  it("sends the documented request JSON, leaving out empty hints", () => {
    expect(META_TRANSCRIBE_URL).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(META_TRANSCRIBE_ACCEPT).toBe("application/json");
    expect(voiceRequest("muse-voice-transcribe-1.0", OPTIONS)).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
    });
    expect(
      voiceRequest("muse-voice-transcribe-1.0", {
        mode: "ENDPOINTING",
        languageBias: ["English", "Spanish"],
        keywords: ["Dallas", "lumper"],
      }),
    ).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "ENDPOINTING",
      languageBias: ["English", "Spanish"],
      keywords: ["Dallas", "lumper"],
    });
  });

  it("sends two parts: the request as JSON and the audio as a WAV file", async () => {
    const wav = new Uint8Array([1, 2, 3, 4]);
    const form = voiceBody("muse-voice-transcribe-1.0", wav.subarray(1, 3), OPTIONS);
    expect([...form.keys()]).toEqual(["request", "audio"]);
    const request = form.get("request") as Blob;
    expect(request.type).toBe("application/json");
    expect(JSON.parse(await request.text())).toEqual(
      voiceRequest("muse-voice-transcribe-1.0", OPTIONS),
    );
    const audio = form.get("audio") as File;
    expect(audio.type).toBe("audio/wav");
    expect(audio.name).toBe("audio.wav");
    // Only the view's own bytes.
    expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([2, 3]);
  });
});

describe("parseVoice", () => {
  it("reads the measured answer and meters whole seconds, rounded down", () => {
    const outcome = parseVoice(
      {
        sessionId: "asr/2026-10-26:ab12",
        transcript: " load 421 delivered in Dallas.",
        audioDurationMs: 2240,
        turns: [],
      },
      200,
    );
    expect(outcome).toEqual({
      kind: "answered",
      status: "ok",
      httpStatus: 200,
      upstreamId: "asr/2026-10-26:ab12",
      metered: { unit: "audio_seconds", seconds: 2 },
      value: { transcript: " load 421 delivered in Dallas.", turns: [], audioDurationMs: 2240 },
    });
  });

  it("keeps well-formed turns and drops the rest", () => {
    const outcome = parseVoice(
      {
        transcript: "a b",
        audioDurationMs: 999,
        turns: [
          { startMs: 0, endMs: 400, transcript: "a" },
          { startMs: -1, endMs: 400, transcript: "x" },
          { startMs: 500, endMs: 999, transcript: 7 },
          null,
        ],
      },
      200,
    );
    expect(outcome).toMatchObject({
      kind: "answered",
      upstreamId: null,
      metered: { unit: "audio_seconds", seconds: 0 },
      value: { turns: [{ startMs: 0, endMs: 400, transcript: "a" }] },
    });
  });

  it("is unknown without a whole audioDurationMs or a transcript", () => {
    for (const json of [
      null,
      { transcript: "x" },
      { transcript: "x", audioDurationMs: "2240" },
      { transcript: "x", audioDurationMs: 22.5 },
      { transcript: "x", audioDurationMs: -1 },
      { audioDurationMs: 2240 },
    ]) {
      expect(parseVoice(json, 200), JSON.stringify(json)).toEqual({
        kind: "unknown",
        category: "unknown",
        httpStatus: 200,
      });
    }
  });
});
