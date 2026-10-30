import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { GET as audio } from "./[id]/audio/route";
import { POST as prepare } from "./[id]/prepare/route";
import { POST as upload } from "./route";

// The voice routes' own checks, in order: a cross-site post is refused before the session is
// read, then the switch, the login, the body cap and the fields, each before the pipeline runs.
// Replies carry a category only, never an error's text, and are never cached.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const DRIVER = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  uploadVoiceNote: vi.fn(),
  prepareVoiceNote: vi.fn(),
  readVoiceAudio: vi.fn(),
  member: true,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/voice/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voice/pipeline")>()),
  uploadVoiceNote: mocks.uploadVoiceNote,
  prepareVoiceNote: mocks.prepareVoiceNote,
}));
vi.mock("@/lib/voice/read", () => ({ readVoiceAudio: mocks.readVoiceAudio }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => ({
    withTenant: async (_tenant: string, fn: (q: unknown) => Promise<unknown>) =>
      fn({
        query: async () => (mocks.member ? [{ ok: 1 }] : []),
        execute: async () => 0,
      }),
  }),
}));

const saved = structuredClone(flags);

beforeEach(() => {
  Object.assign(flags, structuredClone(saved));
  flags.voiceIntakeEnabled = true;
  mocks.member = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.uploadVoiceNote.mockReset().mockResolvedValue({ ok: true, voiceNoteId: NOTE, status: "transcribed" });
  mocks.prepareVoiceNote.mockReset().mockResolvedValue({ ok: true, voiceNoteId: NOTE, status: "ready", category: null });
  mocks.readVoiceAudio.mockReset().mockResolvedValue({ mime: "audio/webm", bytes: Buffer.from([9, 8, 7]) });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(flags, structuredClone(saved));
  vi.restoreAllMocks();
});

async function post(fields: Record<string, string | Blob>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return upload(
    new Request("https://app.example/api/voice-notes", {
      method: "POST",
      headers: { "content-type": encoded.headers.get("content-type") ?? "", ...headers },
      body,
    }),
  );
}

const wav = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" });

describe("POST /api/voice-notes", () => {
  it("refuses a cross-site post before reading the session", async () => {
    const response = await post({ driverId: DRIVER, wav: wav() }, { "Sec-Fetch-Site": "cross-site" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", retryable: false });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses when switched off, then without a login", async () => {
    flags.voiceIntakeEnabled = false;
    expect((await post({ driverId: DRIVER, wav: wav() })).status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
    flags.voiceIntakeEnabled = true;
    mocks.getSession.mockResolvedValue(null);
    const response = await post({ driverId: DRIVER, wav: wav() });
    expect(response.status).toBe(401);
    expect(mocks.uploadVoiceNote).not.toHaveBeenCalled();
  });

  it("refuses an upload past the cap by its declared length", async () => {
    const response = await post({ driverId: DRIVER, wav: wav() }, { "content-length": "99999999" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large", retryable: false });
    expect(mocks.uploadVoiceNote).not.toHaveBeenCalled();
  });

  it("refuses a recording or an original past its own cap before copying its bytes", async () => {
    flags.voiceLimits.maxWavBytes = 3;
    const wavTooBig = await post({ driverId: DRIVER, wav: wav() });
    expect(wavTooBig.status).toBe(413);
    expect(await wavTooBig.json()).toEqual({ error: "too_large", retryable: false });

    Object.assign(flags, structuredClone(saved));
    flags.voiceIntakeEnabled = true;
    flags.voiceLimits.maxOriginalBytes = 1;
    const original = new Blob([new Uint8Array([5, 6])], { type: "audio/webm" });
    const originalTooBig = await post({ driverId: DRIVER, wav: wav(), original });
    expect(originalTooBig.status).toBe(413);
    expect(await originalTooBig.json()).toEqual({ error: "too_large", retryable: false });
    expect(mocks.uploadVoiceNote).not.toHaveBeenCalled();
  });

  it("refuses missing fields", async () => {
    expect((await post({ wav: wav() })).status).toBe(400);
    expect((await post({ driverId: DRIVER })).status).toBe(400);
    expect((await post({ driverId: DRIVER, wav: "RIFF" })).status).toBe(400);
    expect((await post({ driverId: DRIVER, wav: wav(), original: "text" })).status).toBe(400);
    expect(mocks.uploadVoiceNote).not.toHaveBeenCalled();
  });

  it("hands the pipeline the bytes and a folded recording type", async () => {
    const original = new Blob([new Uint8Array([5, 6])], { type: "audio/x-m4a" });
    const response = await post({ driverId: DRIVER, wav: wav(), original });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, voiceNoteId: NOTE, status: "transcribed" });
    const [session, input] = mocks.uploadVoiceNote.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(input.driverId).toBe(DRIVER);
    expect(Array.from(input.wav)).toEqual([1, 2, 3, 4]);
    expect(input.original.mime).toBe("audio/mp4");
    expect(Array.from(input.original.bytes)).toEqual([5, 6]);
  });

  it("answers a refusal and a crash with categories only", async () => {
    mocks.uploadVoiceNote.mockResolvedValue({ ok: false, category: "limit", retryable: false });
    const limited = await post({ driverId: DRIVER, wav: wav() });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "limit", retryable: false });

    mocks.uploadVoiceNote.mockResolvedValue({ ok: false, category: "timeout", retryable: true, voiceNoteId: NOTE });
    const timedOut = await post({ driverId: DRIVER, wav: wav() });
    expect(await timedOut.json()).toEqual({ error: "timeout", retryable: true, voiceNoteId: NOTE });

    mocks.uploadVoiceNote.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1"));
    const crashed = await post({ driverId: DRIVER, wav: wav() });
    expect(crashed.status).toBe(503);
    const text = await crashed.text();
    expect(text).not.toContain("ECONNREFUSED");
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
  });
});

describe("a voice note's step routes", () => {
  const press = (id = NOTE, site?: string) =>
    prepare(
      new Request(`https://app.example/api/voice-notes/${id}/prepare`, { method: "POST", headers: site ? { "Sec-Fetch-Site": site } : {} }),
      { params: Promise.resolve({ id }) },
    );

  it("checks the site, the switch, the login and the id before the step", async () => {
    expect((await press(NOTE, "cross-site")).status).toBe(403);
    expect((await press("not-an-id")).status).toBe(400);
    mocks.getSession.mockResolvedValue(null);
    expect((await press()).status).toBe(401);
    expect(mocks.prepareVoiceNote).not.toHaveBeenCalled();
  });

  it("runs the step with the lowercased id", async () => {
    const response = await press(NOTE.toUpperCase());
    expect(await response.json()).toEqual({ ok: true, voiceNoteId: NOTE, status: "ready", category: null });
    expect(mocks.prepareVoiceNote).toHaveBeenCalledWith(SESSION, NOTE);
  });

  it("answers a membership failure as forbidden", async () => {
    const err = new Error("no");
    err.name = "ForbiddenError";
    mocks.prepareVoiceNote.mockRejectedValue(err);
    expect((await press()).status).toBe(403);
  });
});

describe("GET /api/voice-notes/:id/audio", () => {
  const get = (id = NOTE, headers: Record<string, string> = {}) =>
    audio(new Request(`https://app.example/api/voice-notes/${id}/audio`, { headers }), { params: Promise.resolve({ id }) });
  const ranged = (range: string, more: Record<string, string> = {}) => get(NOTE, { range, ...more });
  const bytesOf = async (response: Response) => Array.from(new Uint8Array(await response.arrayBuffer()));

  it("serves the recording privately, never cached or sniffed, and says it takes ranges", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/webm");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bytesOf(response)).toEqual([9, 8, 7]);
  });

  it.each([
    ["bytes=0-1", "bytes 0-1/3", [9, 8]],
    ["bytes=1-", "bytes 1-2/3", [8, 7]],
    ["bytes=-2", "bytes 1-2/3", [8, 7]],
    ["bytes=-9", "bytes 0-2/3", [9, 8, 7]],
    ["bytes=1-99", "bytes 1-2/3", [8, 7]],
    ["bytes=2-2", "bytes 2-2/3", [7]],
  ])("answers the single range %s as 206 with %s", async (range, contentRange, body) => {
    const response = await ranged(range);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("content-type")).toBe("audio/webm");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bytesOf(response)).toEqual(body);
  });

  it.each(["bytes=3-", "bytes=9-12", "bytes=-0"])("answers the range %s that cannot be met as 416", async (range) => {
    const response = await ranged(range);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */3");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bytesOf(response)).toEqual([]);
  });

  it.each(["bytes=0-0,1-1", "bytes=abc", "items=0-1", "bytes=2-1", "bytes=-"])(
    "answers %s, several ranges or a malformed one, with the whole clip",
    async (range) => {
      const response = await ranged(range);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-length")).toBe("3");
      expect(await bytesOf(response)).toEqual([9, 8, 7]);
    },
  );

  it("answers a range sent with If-Range with the whole clip, since it sends no validator", async () => {
    const response = await ranged("bytes=0-1", { "if-range": '"abc"' });
    expect(response.status).toBe(200);
    expect(await bytesOf(response)).toEqual([9, 8, 7]);
  });

  it("still checks membership and the switch before serving a range", async () => {
    mocks.member = false;
    expect((await ranged("bytes=0-1")).status).toBe(403);
    mocks.member = true;
    flags.voiceIntakeEnabled = false;
    expect((await ranged("bytes=0-1")).status).toBe(403);
    expect(mocks.readVoiceAudio).not.toHaveBeenCalled();
  });

  it("answers a failed read with its category, never the error", async () => {
    mocks.readVoiceAudio.mockRejectedValue(new Error("Database returned more than the allowed response size limit"));
    const response = await get();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("response size");
    expect(JSON.parse(text)).toEqual({ error: "unavailable", retryable: true });
  });

  it("refuses an empty recording as missing", async () => {
    mocks.readVoiceAudio.mockResolvedValue({ mime: "audio/webm", bytes: Buffer.alloc(0) });
    expect((await get()).status).toBe(404);
  });

  it("refuses a missing recording, a bad id, a non-member and no login", async () => {
    mocks.readVoiceAudio.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect((await get("x")).status).toBe(400);
    mocks.member = false;
    expect((await get()).status).toBe(403);
    mocks.getSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });
});
