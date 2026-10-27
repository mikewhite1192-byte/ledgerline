import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { DbError, type Param, type Queryable } from "../db";
import { readVoiceAudio } from "./read";

// The recording read: a missing or oversized clip answers nothing (the route says not found), a
// stored size that does not match the bytes is a failed read (the route says unavailable), and
// the cap is sent with the query so an oversized clip is never pulled through the database.

const NOTE = "33333333-3333-4333-8333-333333333333";
const saved = structuredClone(flags.voiceLimits);

function fakeQ(row: Record<string, unknown> | null) {
  const seen: { sql: string; params: Param[] }[] = [];
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      seen.push({ sql, params });
      return (row ? [row] : []) as T[];
    },
    async execute(): Promise<number> {
      throw new Error("no writes here");
    },
  };
  return { q, seen };
}

afterEach(() => {
  Object.assign(flags.voiceLimits, structuredClone(saved));
});

describe("readVoiceAudio", () => {
  it("returns the clip and sends the cap with the query", async () => {
    const { q, seen } = fakeQ({ audio_mime: "audio/webm", audio_bytes: 3, audio_b64: Buffer.from([9, 8, 7]).toString("base64") });
    const clip = await readVoiceAudio(q, NOTE.toUpperCase());
    expect(clip?.mime).toBe("audio/webm");
    expect(Array.from(clip!.bytes)).toEqual([9, 8, 7]);
    expect(seen[0].sql).toContain("FROM voice_note_audio");
    expect(seen[0].params).toEqual([NOTE, flags.voiceLimits.maxOriginalBytes]);
  });

  it("answers nothing for a note with no recording or one over the cap", async () => {
    expect(await readVoiceAudio(fakeQ(null).q, NOTE)).toBeNull();
    expect(await readVoiceAudio(fakeQ({ audio_mime: "audio/webm", audio_bytes: 800_000, audio_b64: null }).q, NOTE)).toBeNull();
  });

  it("treats a stored size that does not match the bytes as a failed read", async () => {
    const { q } = fakeQ({ audio_mime: "audio/webm", audio_bytes: 4, audio_b64: Buffer.from([9, 8, 7]).toString("base64") });
    await expect(readVoiceAudio(q, NOTE)).rejects.toBeInstanceOf(DbError);
  });

  it("never queries for an id that is not one", async () => {
    const { q, seen } = fakeQ(null);
    expect(await readVoiceAudio(q, "nope")).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
