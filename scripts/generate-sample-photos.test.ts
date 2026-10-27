import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../src/config/flags";
import type { FetchFn } from "../src/lib/ai/providers/http";
import type { Session } from "../src/lib/auth/claims";
import type { Param, Queryable, TenantDb } from "../src/lib/db";
import {
  MANIFEST,
  PHOTO_SAMPLE_SENTENCE,
  parseManifest,
  type Manifest,
  type PhotoDoc,
} from "../src/lib/seed/docs/manifest";
import { LINES_INTRO } from "../src/lib/seed/docs/prompts";
import { imageDescription } from "../src/lib/seed/docs/stamp";
import type { ReceiptRead } from "../src/lib/seed/docs/verify";
import {
  DEFAULT_CAP_CENTS,
  parseCap,
  photosToRun,
  runPhotos,
  type PhotoCalls,
  type PhotoIo,
} from "./lib/sample-photos";

// The photo run against a fake provider and a fake ledger, through the real wrapper: the
// fetch is injected as the wrapper's own tests inject it, so nothing reaches the network.

const KEY = "test-key-abcdefghijklmnop";
const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const DOC_ID = "br-fuel-374";
const GOOD_READ: ReceiptRead = {
  sample_word: true,
  vendor: "Roadside Fuel Stop",
  date_mmddyyyy: "10/27/2026",
  total_cents: 28640,
  load_number: null,
  truck_unit: "BR-T105",
  gallons_milli: 71600,
  price_cents: 400,
  other_amounts: [],
};
const ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  DB_CLUSTER_ARN: "",
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_IMAGE: "muse-image-1.0",
  AI_SPEND_CAP_CENTS: "12000",
  META_CONTRIBUTOR_MODE: undefined,
  META_API_KEY: KEY,
};

// A ledger that accepts the wrapper's statements and keeps its counter, enough to run calls.
function fakeLedger(): TenantDb {
  const counter = { spent: 0, reserved: 0, calls: 0 };
  const rows = new Map<string, { reserved: number; status: string }>();
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM ops.ai_spend")) {
        return [
          {
            spent_nanocents: counter.spent,
            reserved_nanocents: counter.reserved,
            calls: counter.calls,
            wonder_spent_nanocents: 0,
            wonder_reserved_nanocents: 0,
          },
        ] as T[];
      }
      if (sql.includes("FROM model_calls") && sql.includes("status = 'reserved'")) {
        const row = rows.get(String(params[0]));
        return (
          row?.status === "reserved" ? [{ reserved_nanocents: row.reserved, target: "x" }] : []
        ) as T[];
      }
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        rows.set(String(params[0]), { reserved: Number(params[8]), status: "reserved" });
        return 1;
      }
      if (sql.includes("reserved_nanocents = reserved_nanocents + ")) {
        counter.reserved += Number(params[0]);
        return 1;
      }
      if (sql.startsWith("UPDATE model_calls")) {
        rows.get(String(params[0]))!.status = String(params[1]);
        return 1;
      }
      if (sql.includes("reserved_nanocents = reserved_nanocents - ")) {
        counter.reserved -= Number(params[0]);
        counter.spent += Number(params[1]);
        counter.calls += 1;
        return 1;
      }
      throw new Error("unexpected statement");
    },
  };
  return { withTenant: async (_tenantId, fn) => fn(q) };
}

let png: Buffer;

type Script = {
  // Per image call: an HTTP status, or 200 with a picture.
  image?: (n: number) => number;
  // Per read: an HTTP status, or the read the model returns.
  read?: (n: number) => ReceiptRead | number;
};

function provider(script: Script) {
  const counts = { image: 0, read: 0 };
  const fetch = vi.fn<FetchFn>(async (url) => {
    if (String(url).endsWith("/v1/images/generations")) {
      const n = counts.image++;
      const status = script.image?.(n) ?? 200;
      if (status !== 200) return new Response("{}", { status });
      return Response.json({ output_format: "png", data: [{ b64_json: png.toString("base64") }] });
    }
    const n = counts.read++;
    const read = script.read?.(n) ?? GOOD_READ;
    if (typeof read === "number") return new Response("{}", { status: read });
    return Response.json({
      id: "resp_test1",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(read) }],
        },
      ],
      usage: {
        input_tokens: 1700,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 300,
        output_tokens_details: { reasoning_tokens: 200 },
      },
    });
  });
  return { fetch, counts };
}

let dir: string;
let printed: string[];
let io: PhotoIo;

function freshManifest(): Manifest {
  const m = parseManifest(JSON.parse(JSON.stringify(MANIFEST)));
  m.background = null;
  return m;
}

function calls(fetch: FetchFn): PhotoCalls {
  return { session: SESSION, ai: { fetch, db: fakeLedger() } };
}

function written(): Manifest {
  return parseManifest(JSON.parse(readFileSync(io.manifestPath, "utf8")));
}

function entry(m: Manifest, id = DOC_ID): PhotoDoc {
  return m.entries.find((e) => e.id === id) as PhotoDoc;
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  flags.aiEnabled = false;
  dir = mkdtempSync(join(tmpdir(), "sample-photos-"));
  printed = [];
  const keep = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  io = { publicDir: join(dir, "public"), manifestPath: join(dir, "manifest.json"), log: keep };
  // A small 3 x 4 picture stands in for the model's frame.
  png ??= await sharp({
    create: { width: 30, height: 40, channels: 3, background: { r: 200, g: 190, b: 170 } },
  })
    .png()
    .toBuffer();
});

afterEach(() => {
  flags.aiEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("the sample photo run", () => {
  it("calls nothing and leaves the switch alone without --go", async () => {
    const { fetch } = provider({});
    const out = await runPhotos(freshManifest(), { mode: "dry", only: null, capCents: 60 }, io, calls(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(flags.aiEnabled).toBe(false);
    expect(out).toEqual({ docs: [], spentNanocents: 0, stopped: null });
    expect(existsSync(io.publicDir) || existsSync(io.manifestPath)).toBe(false);
    expect(printed.filter((l) => /prompt=\d+ chars/.test(l))).toHaveLength(6);
  });

  it("keeps a generated photo whose read matches, stamped and described", async () => {
    const { fetch, counts } = provider({});
    const out = await runPhotos(freshManifest(), { mode: "go", only: DOC_ID, capCents: 60 }, io, calls(fetch));
    expect(out.stopped).toBeNull();
    expect(out.docs).toEqual([
      expect.objectContaining({ id: DOC_ID, origin: "generated", attempts: 1, reason: null }),
    ]);
    // The background, then one image and one read.
    expect(counts).toEqual({ image: 2, read: 1 });
    expect(flags.aiEnabled).toBe(false);
    const m = written();
    const doc = entry(m);
    const file = readFileSync(join(io.publicDir, doc.file));
    expect(doc.origin).toBe("generated");
    expect([doc.bytes, doc.width, doc.height]).toEqual([file.length, 1008, 1344]);
    expect(await imageDescription(file)).toBe(PHOTO_SAMPLE_SENTENCE);
    expect(m.background).toEqual(expect.objectContaining({ file: "samples/docs/bg/paper-flat.webp" }));
    // One image call is 1 cent; the read is a fraction of one.
    expect(out.spentNanocents).toBeGreaterThan(2_000_000_000);
    expect(out.spentNanocents).toBeLessThan(3_000_000_000);
  }, 30_000);

  it("retries a mismatched read and composes after three", async () => {
    const { fetch, counts } = provider({ read: () => ({ ...GOOD_READ, total_cents: 28641 }) });
    const m = freshManifest();
    entry(m).cabAngle = true;
    const out = await runPhotos(m, { mode: "go", only: DOC_ID, capCents: 60 }, io, calls(fetch));
    expect(out.docs).toEqual([
      expect.objectContaining({ origin: "composed", attempts: 3, reason: "three failed reads" }),
    ]);
    expect(counts).toEqual({ image: 4, read: 3 });
    expect(printed.filter((l) => l.includes("mismatch on total_cents"))).toHaveLength(3);
    const doc = entry(written());
    expect([doc.origin, doc.cabAngle]).toEqual(["composed", false]);
    expect(await imageDescription(readFileSync(join(io.publicDir, doc.file)))).toBe(
      PHOTO_SAMPLE_SENTENCE,
    );
  }, 30_000);

  it("stops at the run cap before the next image call", async () => {
    const { fetch, counts } = provider({ read: () => ({ ...GOOD_READ, sample_word: false }) });
    // The background (1 cent) and one attempt fit in 6 cents; a second attempt's worst case does not.
    const out = await runPhotos(freshManifest(), { mode: "go", only: DOC_ID, capCents: 6 }, io, calls(fetch));
    expect(counts).toEqual({ image: 2, read: 1 });
    expect(out.docs).toEqual([
      expect.objectContaining({ origin: "composed", attempts: 1, reason: "run cap" }),
    ]);
    expect(out.spentNanocents).toBeLessThanOrEqual(6_000_000_000);
  }, 30_000);

  it("counts an error answer as a failed attempt and an image error as no attempt", async () => {
    const reads = provider({ read: () => 500 });
    const a = await runPhotos(freshManifest(), { mode: "go", only: DOC_ID, capCents: 60 }, io, calls(reads.fetch));
    expect(a.docs[0]).toEqual(
      expect.objectContaining({ origin: "composed", attempts: 3, reason: "three failed reads" }),
    );
    expect(reads.counts).toEqual({ image: 4, read: 3 });
    expect(printed.filter((l) => l.includes("read failed (unavailable)"))).toHaveLength(3);

    rmSync(io.publicDir, { recursive: true, force: true });
    // The background call succeeds; every photo image call is rate limited.
    const images = provider({ image: (n) => (n === 0 ? 200 : 429) });
    const b = await runPhotos(freshManifest(), { mode: "go", only: DOC_ID, capCents: 60 }, io, calls(images.fetch));
    expect(b.docs[0]).toEqual(
      expect.objectContaining({ origin: "composed", attempts: 0, reason: "image errors" }),
    );
    expect(images.counts).toEqual({ image: 4, read: 0 });
  }, 30_000);

  it("stops the whole run on a refused key and writes nothing more", async () => {
    const { fetch, counts } = provider({ image: () => 401 });
    const out = await runPhotos(freshManifest(), { mode: "go", only: null, capCents: 60 }, io, calls(fetch));
    expect(out).toEqual({ docs: [], spentNanocents: 0, stopped: "auth" });
    expect(counts.image).toBe(1);
    expect(flags.aiEnabled).toBe(false);
    expect(existsSync(join(io.publicDir, "samples", "docs", `${DOC_ID}.webp`))).toBe(false);
  }, 30_000);

  it("never prints the key, a prompt or what the model read", async () => {
    const { fetch } = provider({ read: (n) => (n === 0 ? { ...GOOD_READ, vendor: "Wrong Vendor Name" } : GOOD_READ) });
    await runPhotos(freshManifest(), { mode: "dry", only: null, capCents: 60 }, io);
    await runPhotos(freshManifest(), { mode: "go", only: DOC_ID, capCents: 60 }, io, calls(fetch));
    const all = printed.join("\n");
    expect(printed.length).toBeGreaterThan(5);
    for (const secret of [KEY, LINES_INTRO, "Roadside Fuel Stop", "$286.40", "Wrong Vendor Name", "Gaffney"]) {
      expect(all).not.toContain(secret);
    }
  }, 30_000);

  it("composes with no key and no database when asked", async () => {
    const out = await runPhotos(freshManifest(), { mode: "compose", only: DOC_ID, capCents: 60 }, io);
    expect(out.docs).toEqual([expect.objectContaining({ origin: "composed", reason: "asked" })]);
    expect(entry(written()).origin).toBe("composed");
  }, 30_000);

  it("reads the cap and the photo list strictly", () => {
    expect(parseCap(undefined)).toBe(DEFAULT_CAP_CENTS);
    expect(parseCap("25")).toBe(25);
    for (const bad of ["0", "-1", "2.5", "abc", "501"]) expect(() => parseCap(bad)).toThrow();
    expect(photosToRun(MANIFEST, null)).toHaveLength(6);
    expect(photosToRun(MANIFEST, DOC_ID).map((d) => d.id)).toEqual([DOC_ID]);
    expect(() => photosToRun(MANIFEST, "br-l10259-ratecon")).toThrow();
    expect(() => photosToRun(MANIFEST, "nope")).toThrow();
  });
});
