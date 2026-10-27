import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { segmentVideo } from "../ai";
import { readSpend, type Spend } from "../ai/spend";
import type { FetchFn } from "../ai/providers/http";
import { createPgDb } from "../db/pg";
import { adminUrl, appUrl } from "../db/test-urls";
import type { Db, Queryable, TenantDb } from "../db/types";
import { dropTenant, makeTenant, sqlStateOf, type Fixture } from "../money/test-db";
import { muxAvc } from "./mux";
import { getClip, listClips, readClip, readRedactedFile, storeRedacted, uploadClip, type ClipDeps } from "./service";

// The dock clip pipeline against the real tables, as the app role, with the model calls answered
// by a fake fetch: the raw file is never written, the blurred file is checked before it is kept,
// the reading is given only the blurred file, a failed write loses nothing paid for, and a clip
// cannot be deleted by the app or seen by another carrier. The spend counter is global, so this
// file puts it back as it found it.

const RAW = new Uint8Array(readFileSync(join(__dirname, "fixtures/tiny.mp4")));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// A clip with the raw file's size and length but other bytes: what the browser sends back.
function blurred(seed: number, frames = 2): Uint8Array {
  const bytes = muxAvc({
    width: 64,
    height: 64,
    timescale: 2000,
    frameTicks: 1000,
    avcC: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe0, 0),
    samples: Array.from({ length: frames }, (_, i) => ({ data: Uint8Array.of(0, 0, 0, 2, seed, i), key: i === 0 })),
  });
  if (!bytes) throw new Error("mux");
  return bytes;
}

const SAM_LINE = "<0f>0<|box;x1=10;y1=12;x2=30;y2=40;w=64;h=64;c=0.9|><|mask;x=0;y=0;c=0.9;data=28,20,!ab|>\n";
// 3:05 AM and 10:31 AM in Chicago on 10/22/2026: the arrival matches, the departure is 6 minutes off.
const READING = {
  arrival: { clockText: "3:05 AM", dateText: "10/22/2026", atSeconds: 0.2, confidence: "high" },
  departure: { clockText: "10:31 AM", dateText: "10/22/2026", atSeconds: 0.9, confidence: "high" },
  bolNumber: { value: "BOL-100", atSeconds: 0.5, confidence: "high" },
  sealNumber: null,
  doorText: "DOOR 7",
};

type Sent = { model: string; prompt: string | null; videoHash: string };

// Answers each model by the body it was sent, and records which video each call carried.
function fakeAi(options: { failPlate?: number; readingText?: string } = {}) {
  const sent: Sent[] = [];
  let plateFailures = options.failPlate ?? 0;
  const fetch = vi.fn<FetchFn>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const content = body.input[0].content as { type: string; text?: string; video_url?: string }[];
    const video = content.find((c) => c.type === "input_video")!.video_url!;
    const bytes = Buffer.from(video.slice(video.indexOf(",") + 1), "base64");
    const prompt = content.find((c) => c.type === "input_text")?.text ?? null;
    sent.push({ model: body.model, prompt: body.model === "sam-3.1" ? prompt : null, videoHash: sha(bytes) });
    if (body.model === "sam-3.1") {
      if (prompt === "license plate" && plateFailures > 0) {
        plateFailures -= 1;
        return Response.json({ error: { message: "overloaded" } }, { status: 503 });
      }
      return Response.json({
        id: "resp_sam",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: SAM_LINE }] }],
        usage: { video_frames_processed: 50 },
      });
    }
    return Response.json({
      id: "resp_read",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: options.readingText ?? JSON.stringify(READING) }],
        },
      ],
      usage: {
        input_tokens: 900,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 120,
        output_tokens_details: { reasoning_tokens: 40 },
      },
    });
  });
  return { fetch, sent };
}

let admin: Db;
let app: Db;
let A: Fixture;
let B: Fixture;
let before: Spend;
const loadId = randomUUID();
const otherLoadId = randomUUID();
let logged: string[];

const deps = (ai: ReturnType<typeof fakeAi>, db: TenantDb = app): ClipDeps => ({ db, ai: { fetch: ai.fetch, db: app } });

const row = (id: string) =>
  admin.withTenant(A.tenantId, async (q) => {
    const [r] = await q.query<Record<string, unknown>>(
      `SELECT status, CAST(face_call_id AS text) AS face_call_id, CAST(plate_call_id AS text) AS plate_call_id,
              CAST(redact_attempts AS integer) AS redact_attempts, redact_started_at IS NULL AS lease_free,
              raw_hash, redacted_hash, redacted_byte_length, CAST(row_to_json(c) AS text) AS whole
         FROM evidence_clips c WHERE id = CAST($1 AS uuid)`,
      [id],
    );
    return r;
  });

async function addLoad(f: Fixture, id: string, number: string) {
  await admin.withTenant(f.tenantId, (q) =>
    q.execute(
      `INSERT INTO loads (id, tenant_id, load_number, customer_id, driver_id, status, origin_city,
         origin_state, dest_city, dest_state, pickup_on, delivered_on, delivered_at, loaded_miles,
         linehaul_cents, delivery_arrived_at, delivery_departed_at)
       VALUES (CAST($1 AS uuid), current_tenant_id(), $2, CAST($3 AS uuid), CAST($4 AS uuid),
         'delivered', 'Joliet', 'IL', 'Gary', 'IN', CAST('2026-10-21' AS date),
         CAST('2026-10-22' AS date), CAST('2026-10-22T15:25:00Z' AS timestamptz), 410, 123456,
         CAST('2026-10-22T08:05:00Z' AS timestamptz), CAST('2026-10-22T15:25:00Z' AS timestamptz))`,
      [id, number, f.customerId, f.driverId],
    ),
  );
}

beforeAll(async () => {
  admin = createPgDb({ connectionString: adminUrl() });
  app = createPgDb({ connectionString: appUrl() });
  const tag = randomUUID().slice(0, 8);
  A = await makeTenant(admin, `clip-a-${tag}`);
  B = await makeTenant(admin, `clip-b-${tag}`);
  await addLoad(A, loadId, "L-CLIP-1");
  await addLoad(A, otherLoadId, "L-CLIP-2");
  before = await app.withTenant(A.tenantId, (q) => readSpend(q));
});

afterAll(async () => {
  if (before) {
    await admin.withoutTenant((q) =>
      q.execute(
        `UPDATE ops.ai_spend
            SET spent_nanocents = CAST($1 AS bigint), reserved_nanocents = CAST($2 AS bigint),
                calls = CAST($3 AS bigint), wonder_spent_nanocents = CAST($4 AS bigint),
                wonder_reserved_nanocents = CAST($5 AS bigint)
          WHERE id = 1`,
        [
          before.spentNanocents,
          before.reservedNanocents,
          before.calls,
          before.wonderSpentNanocents,
          before.wonderReservedNanocents,
        ],
      ),
    );
  }
  // The app role cannot delete a clip; the admin login clears them before the tenants go.
  for (const f of [A, B]) {
    if (!f) continue;
    await admin.withTenant(f.tenantId, (q) => q.execute("DELETE FROM evidence_clips WHERE tenant_id = current_tenant_id()"));
    await dropTenant(admin, f);
  }
  await app?.close();
  await admin?.close();
});

beforeEach(() => {
  flags.clipsEnabled = true;
  flags.aiEnabled = true;
  vi.stubEnv("DB_CLUSTER_ARN", "");
  vi.stubEnv("META_MODEL_SAM", "sam-3.1");
  vi.stubEnv("META_MODEL_SPARK", "muse-spark-1.3");
  vi.stubEnv("META_CONTRIBUTOR_MODE", undefined);
  vi.stubEnv("META_API_KEY", "test-key-abcdefghijklmnop");
  vi.stubEnv("AI_SPEND_CAP_CENTS", "40000");
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
});

afterEach(async () => {
  flags.clipsEnabled = false;
  flags.aiEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // Each test starts with no clips, so the duplicate and daily-limit checks see only its own.
  await admin.withTenant(A.tenantId, (q) => q.execute("DELETE FROM evidence_clips WHERE tenant_id = current_tenant_id()"));
});

const upload = (ai: ReturnType<typeof fakeAi>, bytes: Uint8Array = RAW, over: object = {}, db?: TenantDb) =>
  uploadClip(A.session, { loadId, stop: "delivery", filename: "../dock cam #1.mp4", bytes, ...over }, deps(ai, db));

describe("dock clip pipeline", () => {
  it("runs upload, store and read: the raw file is never kept and the reading sees only the blurred file", async () => {
    const ai = fakeAi();
    const up = await upload(ai);
    if (!up.ok) throw new Error(`upload ${up.category}`);
    expect(up.clip).toMatchObject({ status: "redacting", planReady: true, filename: "dock cam 1.mp4", frameCount: 2 });
    expect(up.plan.frames[0]).toEqual([[4, 6, 36, 46]]);
    expect(ai.sent.map((s) => s.prompt).sort()).toEqual(["face", "license plate"]);
    expect(ai.sent.every((s) => s.videoHash === sha(RAW))).toBe(true);

    const rawHex = Buffer.from(RAW).toString("hex");
    const rawB64 = Buffer.from(RAW).toString("base64");
    const afterUpload = await row(up.clip.id);
    expect(afterUpload).toMatchObject({ status: "redacting", raw_hash: sha(RAW), redacted_hash: null });
    // No column holds any run of the raw bytes, in hex or base64.
    for (const at of [0, 400, RAW.length - 64]) {
      expect(String(afterUpload.whole)).not.toContain(rawHex.slice(at * 2, at * 2 + 64));
      expect(String(afterUpload.whole)).not.toContain(rawB64.slice(at, at + 40));
    }

    const file = blurred(7);
    const stored = await storeRedacted(A.session, up.clip.id, file, deps(ai));
    expect(stored).toMatchObject({ ok: true, clip: { status: "redacted", redactedByteLength: file.length } });
    expect(await row(up.clip.id)).toMatchObject({ redacted_hash: sha(file) });

    const read = await readClip(A.session, up.clip.id, deps(ai));
    if (!read.ok) throw new Error(`read ${read.category}`);
    expect(read.clip.status).toBe("read");
    expect(read.clip.reading).toMatchObject({
      bolNumber: { value: "BOL-100" },
      agreement: { result: "differs", arrivalMinutesOff: 0, departureMinutesOff: 6 },
    });
    // Three calls: two on the raw file, one on the blurred file, never the raw one.
    expect(ai.sent).toHaveLength(3);
    expect(ai.sent[2]).toMatchObject({ model: "muse-spark-1.3", videoHash: sha(file) });

    // A second read answers with what was kept and makes no call.
    expect(await readClip(A.session, up.clip.id, deps(ai))).toMatchObject({ ok: true, clip: { status: "read" } });
    expect(ai.sent).toHaveLength(3);

    const served = await readRedactedFile(A.session, up.clip.id, deps(ai));
    expect(served.ok && sha(served.bytes)).toBe(sha(file));
    const listed = await listClips(A.session, loadId, deps(ai));
    expect(listed.ok && listed.clips.map((c) => c.id)).toEqual([up.clip.id]);
    expect(JSON.stringify(listed)).not.toContain(sha(RAW));
    expect(logged.join("\n")).not.toContain(rawB64.slice(0, 40));
    expect(logged.join("\n")).not.toContain("test-key-abcdefghijklmnop");
  });

  it("refuses a blurred file that is the raw file, another size or length, or not an MP4", async () => {
    const ai = fakeAi();
    const up = await upload(ai);
    if (!up.ok) throw new Error(`upload ${up.category}`);
    const id = up.clip.id;
    expect(await storeRedacted(A.session, id, RAW, deps(ai))).toMatchObject({ ok: false, category: "unchanged" });
    expect(await storeRedacted(A.session, id, blurred(1, 6), deps(ai))).toMatchObject({ ok: false, category: "mismatch" });
    expect(await storeRedacted(A.session, id, Uint8Array.of(1, 2, 3), deps(ai))).toMatchObject({
      ok: false,
      category: "unsupported",
    });
    expect((await row(id)).status).toBe("redacting");
    // Kept once; the same file again is fine, a different one is a conflict.
    const file = blurred(2);
    expect(await storeRedacted(A.session, id, file, deps(ai))).toMatchObject({ ok: true });
    expect(await storeRedacted(A.session, id, file, deps(ai))).toMatchObject({ ok: true });
    expect(await storeRedacted(A.session, id, blurred(3), deps(ai))).toMatchObject({ ok: false, category: "conflict" });
    expect((await row(id)).redacted_hash).toBe(sha(file));
  });

  it("keeps both answers when the write of the blurred file fails, and a retry makes no model call", async () => {
    const ai = fakeAi();
    const up = await upload(ai);
    if (!up.ok) throw new Error(`upload ${up.category}`);
    // The write itself fails (as a too-large parameter would): nothing lands.
    const breaking: TenantDb = {
      withTenant: (tenantId, fn) =>
        app.withTenant(tenantId, (q) =>
          fn({
            query: (sql, params) => q.query(sql, params),
            execute: (sql, params) => (sql.includes("decode(") ? Promise.reject(new Error("payload too large")) : q.execute(sql, params)),
          } as Queryable),
        ),
    };
    const file = blurred(4);
    expect(await storeRedacted(A.session, up.clip.id, file, deps(ai, breaking))).toEqual({
      ok: false,
      category: "store_failed",
      retryable: true,
      clipId: up.clip.id,
    });
    expect(await row(up.clip.id)).toMatchObject({ status: "redacting", redacted_hash: null });
    expect((await row(up.clip.id)).face_call_id).not.toBeNull();
    expect((await row(up.clip.id)).plate_call_id).not.toBeNull();
    expect(logged.join("\n")).not.toContain("payload too large");

    // The write lands but its reply is lost: read back, it is kept.
    let wrote = false;
    const lostReply: TenantDb = {
      withTenant: async (tenantId, fn) => {
        const result = await app.withTenant(tenantId, (q) =>
          fn({
            query: (sql, params) => q.query(sql, params),
            execute: async (sql, params) => {
              const n = await q.execute(sql, params);
              if (sql.includes("decode(")) wrote = true;
              return n;
            },
          } as Queryable),
        );
        if (wrote) {
          wrote = false;
          throw new Error("connection reset");
        }
        return result;
      },
    };
    expect(await storeRedacted(A.session, up.clip.id, file, deps(ai, lostReply))).toMatchObject({
      ok: true,
      clip: { status: "redacted" },
    });
    expect(ai.sent).toHaveLength(2);
  });

  it("runs only the missing concept on a retry, and refuses a duplicate and a busy clip", async () => {
    const ai = fakeAi({ failPlate: 1 });
    const first = await upload(ai);
    expect(first).toMatchObject({ ok: false, category: "failed", retryable: true });
    const id = (first as { clipId: string }).clipId;
    expect(await row(id)).toMatchObject({ redact_attempts: 1, plate_call_id: null, lease_free: true });
    expect((await row(id)).face_call_id).not.toBeNull();

    const second = await upload(ai);
    expect(second).toMatchObject({ ok: true, clip: { id, planReady: true } });
    expect(ai.sent.map((s) => s.prompt)).toEqual(expect.arrayContaining(["face", "license plate", "license plate"]));
    expect(ai.sent).toHaveLength(3);
    expect((await row(id)).redact_attempts).toBe(2);

    // The page closed before sending the blurred file: the same upload hands back the plan, free.
    expect(await upload(ai)).toMatchObject({ ok: true, clip: { id } });
    expect(ai.sent).toHaveLength(3);
    // The same file for another stop is a duplicate, not a second clip.
    expect(await upload(ai, RAW, { stop: "pickup" })).toMatchObject({ ok: false, category: "duplicate", clipId: id });

    await storeRedacted(A.session, id, blurred(5), deps(ai));
    expect(await upload(ai)).toMatchObject({ ok: false, category: "duplicate", clipId: id });
  });

  it("stops at three failed tries and at the daily limit", async () => {
    const ai = fakeAi({ failPlate: 3 });
    expect(await upload(ai)).toMatchObject({ ok: false, category: "failed", retryable: true });
    expect(await upload(ai)).toMatchObject({ ok: false, category: "failed", retryable: true });
    expect(await upload(ai)).toMatchObject({ ok: false, category: "failed", retryable: false });
    expect(await upload(ai)).toMatchObject({ ok: false, category: "failed", retryable: false });
    // One face call (kept the first time) and three plate calls, never a fourth.
    expect(ai.sent).toHaveLength(4);

    const limit = flags.clipLimits.perTenantPerDay;
    flags.clipLimits.perTenantPerDay = 1;
    try {
      expect(await upload(ai, blurred(9))).toMatchObject({ ok: false, category: "limit" });
    } finally {
      flags.clipLimits.perTenantPerDay = limit;
    }
    expect(ai.sent).toHaveLength(4);
  });

  it("marks a reading refused by the spend cap as budget, and reads it later", async () => {
    const ai = fakeAi();
    const up = await upload(ai);
    if (!up.ok) throw new Error(`upload ${up.category}`);
    await storeRedacted(A.session, up.clip.id, blurred(6), deps(ai));
    // Two segmentation calls have already spent more than a one-cent cap.
    vi.stubEnv("AI_SPEND_CAP_CENTS", "1");
    expect(await readClip(A.session, up.clip.id, deps(ai))).toEqual({ ok: false, category: "budget", retryable: true });
    expect((await row(up.clip.id)).status).toBe("budget");
    vi.stubEnv("AI_SPEND_CAP_CENTS", "40000");
    expect(await readClip(A.session, up.clip.id, deps(ai))).toMatchObject({ ok: true, clip: { status: "read" } });
  });

  it("keeps a reading outside its format as unreadable, with no text from the model", async () => {
    const ai = fakeAi({ readingText: JSON.stringify({ ...READING, driverName: "Someone" }) });
    const up = await upload(ai);
    if (!up.ok) throw new Error(`upload ${up.category}`);
    await storeRedacted(A.session, up.clip.id, blurred(8), deps(ai));
    expect(await readClip(A.session, up.clip.id, deps(ai))).toMatchObject({
      ok: true,
      clip: { status: "unreadable", reading: null },
    });
    expect(String((await row(up.clip.id)).whole)).not.toContain("Someone");
  });

  it("refuses everything with the switch off, before any read or call", async () => {
    const ai = fakeAi();
    flags.clipsEnabled = false;
    const id = randomUUID();
    expect(await upload(ai)).toEqual({ ok: false, category: "disabled", retryable: false });
    expect(await storeRedacted(A.session, id, blurred(1), deps(ai))).toMatchObject({ category: "disabled" });
    expect(await readClip(A.session, id, deps(ai))).toMatchObject({ category: "disabled" });
    expect(await getClip(A.session, id, deps(ai))).toMatchObject({ category: "disabled" });
    expect(await listClips(A.session, null, deps(ai))).toMatchObject({ category: "disabled" });
    expect(await readRedactedFile(A.session, id, deps(ai))).toMatchObject({ category: "disabled" });
    flags.clipsEnabled = true;
    flags.aiEnabled = false;
    expect(await upload(ai)).toMatchObject({ category: "disabled" });
    expect(ai.fetch).not.toHaveBeenCalled();
  });

  it("keeps clips inside their carrier and out of the app's reach to delete", async () => {
    const ai = fakeAi();
    const up = await upload(ai);
    if (!up.ok) throw new Error(`upload ${up.category}`);
    expect(await getClip(B.session, up.clip.id, deps(ai))).toMatchObject({ ok: false, category: "not_found" });
    expect(await readRedactedFile(B.session, up.clip.id, deps(ai))).toMatchObject({ ok: false, category: "not_found" });
    expect(await listClips(B.session, null, deps(ai))).toEqual({ ok: true, clips: [] });
    // A load of another carrier is not found, so no call is made for it.
    const sentBefore = ai.sent.length;
    expect(await uploadClip(B.session, { loadId, stop: "delivery", filename: "x.mp4", bytes: blurred(3) }, deps(ai))).toMatchObject({
      ok: false,
      category: "not_found",
    });
    expect(ai.sent).toHaveLength(sentBefore);
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) => q.execute("DELETE FROM evidence_clips WHERE id = CAST($1 AS uuid)", [up.clip.id])),
      ),
    ).toBe("42501");
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute("UPDATE evidence_clips SET raw_hash = $2 WHERE id = CAST($1 AS uuid)", [up.clip.id, "0".repeat(64)]),
        ),
      ),
    ).toBe("42501");
  });

  it("refuses a model call id that is not one of the carrier's own calls", async () => {
    const ai = fakeAi({ failPlate: 1 });
    // A real call of the other carrier, written to model_calls by the wrapper.
    const other = await segmentVideo(
      { purpose: "clip_redact_face", video: { mime: "video/mp4", bytes: RAW, frameCount: 2 }, prompt: "face" },
      B.session,
      { fetch: ai.fetch, db: app },
    );
    const first = await upload(ai);
    expect(first).toMatchObject({ ok: false, category: "failed", retryable: true });
    const id = (first as { clipId: string }).clipId;
    const setPlate = (db: Db, callId: string) =>
      sqlStateOf(
        db.withTenant(A.tenantId, (q) =>
          q.execute(
            `UPDATE evidence_clips SET redaction = redaction || CAST('{"plate": []}' AS jsonb),
                    plate_call_id = CAST($2 AS uuid)
              WHERE id = CAST($1 AS uuid)`,
            [id, callId],
          ),
        ),
      );
    // The admin login skips row security, so its refusal is the key's own, not the policy's.
    for (const db of [app, admin]) {
      expect(await setPlate(db, other.callId)).toBe("23503");
      expect(await setPlate(db, randomUUID())).toBe("23503");
    }
    expect(await row(id)).toMatchObject({ status: "redacting", plate_call_id: null });

    // The carrier's own calls pass: the retry keeps the plate answer, then the reading is checked too.
    const second = await upload(ai);
    if (!second.ok) throw new Error(`upload ${second.category}`);
    await storeRedacted(A.session, id, blurred(2), deps(ai));
    expect(
      await sqlStateOf(
        app.withTenant(A.tenantId, (q) =>
          q.execute(
            `UPDATE evidence_clips SET status = 'unreadable', read_call_id = CAST($2 AS uuid), read_at = now()
              WHERE id = CAST($1 AS uuid)`,
            [id, other.callId],
          ),
        ),
      ),
    ).toBe("23503");
    expect((await row(id)).status).toBe("redacted");
    expect(await readClip(A.session, id, deps(ai))).toMatchObject({ ok: true, clip: { status: "read" } });
  });
});
