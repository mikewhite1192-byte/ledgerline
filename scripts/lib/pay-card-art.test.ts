import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../src/config/flags";
import type { FetchFn } from "../../src/lib/ai/providers/http";
import { QUIET_JOB } from "../../src/lib/ai/test-fixtures";
import type { Session } from "../../src/lib/auth/claims";
import type { Param, Queryable, TenantDb } from "../../src/lib/db";
import { PAY_CARD_ART } from "../../src/lib/pay-cards/art";
import {
  ART_HEIGHT,
  ART_READ_FORMAT,
  ART_WIDTH,
  artPrompt,
  isClean,
  parseArtArgs,
  parseArtRead,
  runArt,
  type ArtIo,
  type ArtRead,
} from "./pay-card-art";

// The pay card art run against a fake provider and a fake ledger, through the real wrapper: the
// fetch is injected, so nothing reaches the network. Making the real art is a development step
// (npm run cards:art -- --go), never a test.

const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: "11111111-1111-4111-8111-111111111111" };
const ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  DB_CLUSTER_ARN: "",
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_IMAGE: "muse-image-1.0",
  AI_SPEND_CAP_CENTS: "12000",
  META_CONTRIBUTOR_MODE: undefined,
  META_API_KEY: "test-key-abcdefghijklmnop",
};
const CLEAN: ArtRead = { has_text: false, digits: [] };

function fakeLedger(job: Record<string, unknown> = QUIET_JOB): TenantDb {
  const counter = { spent: 0, reserved: 0, calls: 0 };
  const rows = new Map<string, { reserved: number; status: string }>();
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      if (sql.includes("FROM memberships")) return [{ ok: 1 }] as T[];
      if (sql.includes("FROM spend_alerts")) return [job] as T[];
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
        return (row?.status === "reserved" ? [{ reserved_nanocents: row.reserved, target: "x" }] : []) as T[];
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

// Per image call: an HTTP status, or 200 with a picture. Per read: an HTTP status, raw text, or a read.
function provider(script: { image?: (n: number) => number; read?: (n: number) => ArtRead | string | number }) {
  const counts = { image: 0, read: 0 };
  const bodies: unknown[] = [];
  const fetch = vi.fn<FetchFn>(async (url, init) => {
    if (String(url).endsWith("/v1/images/generations")) {
      const n = counts.image++;
      const status = script.image?.(n) ?? 200;
      if (status !== 200) return new Response("{}", { status });
      return Response.json({ output_format: "png", data: [{ b64_json: png.toString("base64") }] });
    }
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const n = counts.read++;
    const read = script.read?.(n) ?? CLEAN;
    if (typeof read === "number") return new Response("{}", { status: read });
    return Response.json({
      id: "resp_test1",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: typeof read === "string" ? read : JSON.stringify(read) }] },
      ],
      usage: {
        input_tokens: 1500,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  });
  return { fetch, counts, bodies };
}

let dir: string;
let printed: string[];
let io: ArtIo;

beforeEach(async () => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  flags.aiEnabled = false;
  dir = mkdtempSync(join(tmpdir(), "pay-card-art-"));
  printed = [];
  io = { outDir: join(dir, "out"), log: (l) => printed.push(l) };
  png ??= await sharp({ create: { width: 40, height: 50, channels: 3, background: { r: 220, g: 239, b: 229 } } })
    .png()
    .toBuffer();
});

afterEach(() => {
  flags.aiEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("the art read", () => {
  it("is exactly two fields, and keeps a picture only with no text and no digits", () => {
    expect(ART_READ_FORMAT.strict).toBe(true);
    expect(parseArtRead(JSON.stringify(CLEAN))).toEqual(CLEAN);
    expect(isClean(parseArtRead(JSON.stringify(CLEAN)))).toBe(true);
    expect(isClean({ has_text: true, digits: [] })).toBe(false);
    expect(isClean({ has_text: false, digits: ["7"] })).toBe(false);
    expect(isClean(null)).toBe(false);
    expect(parseArtRead("not json")).toBeNull();
    expect(parseArtRead(JSON.stringify({ has_text: false }))).toBeNull();
    expect(parseArtRead(JSON.stringify({ ...CLEAN, has_logo: false }))).toBeNull();
    expect(parseArtRead(JSON.stringify({ has_text: "no", digits: [] }))).toBeNull();
    expect(parseArtRead(JSON.stringify({ has_text: false, digits: [1] }))).toBeNull();
  });

  it("asks for pictures with no text, numbers or logos", () => {
    for (const art of PAY_CARD_ART) expect(artPrompt(art)).toMatch(/No text, no letters, no numbers, no symbols, no logos/);
  });

  it("takes --go and whole-cent caps only", () => {
    expect(parseArtArgs([])).toEqual({ mode: "dry", capCents: 20 });
    expect(parseArtArgs(["--go", "--cap", "12"])).toEqual({ mode: "go", capCents: 12 });
    expect(() => parseArtArgs(["--cap", "0.5"])).toThrow();
    expect(() => parseArtArgs(["--cap"])).toThrow();
    expect(() => parseArtArgs(["--force"])).toThrow();
  });
});

describe("the art run", () => {
  it("calls nothing and leaves the switch alone without --go", async () => {
    const { fetch } = provider({});
    const out = await runArt({ mode: "dry", capCents: 20 }, io, { session: SESSION, ai: { fetch, db: fakeLedger() } });
    expect(fetch).not.toHaveBeenCalled();
    expect(flags.aiEnabled).toBe(false);
    expect(out).toEqual({ kept: [], spentNanocents: 0, stopped: false });
    expect(existsSync(io.outDir)).toBe(false);
  });

  it("keeps a clean picture per name, at the card's size, and turns the switch back off", async () => {
    const { fetch, bodies } = provider({});
    const out = await runArt({ mode: "go", capCents: 20 }, io, { session: SESSION, ai: { fetch, db: fakeLedger() } });
    expect(out.stopped).toBe(false);
    expect(out.kept).toEqual([...PAY_CARD_ART]);
    expect(out.spentNanocents).toBeGreaterThan(0);
    expect(flags.aiEnabled).toBe(false);
    expect(readdirSync(io.outDir).sort()).toEqual(["art-01.webp", "art-02.webp", "art-03.webp"]);
    const meta = await sharp(readFileSync(join(io.outDir, "art-01.webp"))).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", ART_WIDTH, ART_HEIGHT]);
    // Every read went out under the strict schema.
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[0])).toContain("pay_card_art_read");
  });

  it("tries again after a picture with text or digits, and writes nothing for a name with no clean picture", async () => {
    const reads: (ArtRead | string)[] = [
      { has_text: true, digits: [] },
      CLEAN,
      { has_text: false, digits: ["4"] },
      "{}",
      CLEAN,
    ];
    const { fetch, counts } = provider({ read: (n) => reads[n] });
    const out = await runArt({ mode: "go", capCents: 40 }, io, { session: SESSION, ai: { fetch, db: fakeLedger() } });
    expect(out.kept).toEqual(["art-01", "art-03"]);
    expect(out.stopped).toBe(true);
    expect(counts).toEqual({ image: 5, read: 5 });
    expect(readdirSync(io.outDir).sort()).toEqual(["art-01.webp", "art-03.webp"]);
    expect(printed).toContain("art-02: no clean picture in 2 attempts");
  });

  it("stops before a call that would pass the run cap", async () => {
    const { fetch, counts } = provider({});
    const out = await runArt({ mode: "go", capCents: 5 }, io, { session: SESSION, ai: { fetch, db: fakeLedger() } });
    expect(out).toMatchObject({ kept: ["art-01"], stopped: true });
    expect(counts.image).toBe(1);
    expect(printed).toContain("art-02: run cap reached");
  });

  it("stops on a job cap refusal and counts nothing spent, since no call went out", async () => {
    const { fetch, counts } = provider({});
    const ledger = fakeLedger({ ...QUIET_JOB, open_alerts: 1 });
    const out = await runArt({ mode: "go", capCents: 20 }, io, { session: SESSION, ai: { fetch, db: ledger } });
    expect(out).toMatchObject({ kept: [], spentNanocents: 0, stopped: true });
    expect(counts.image).toBe(0);
    expect(printed).toContain("run stopped (job_cap)");
  });

  it("logs a failed save and goes on to the next attempt instead of crashing", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const bad: ArtIo = { outDir: join(blocker, "out"), log: io.log };
    const { fetch } = provider({});
    const out = await runArt({ mode: "go", capCents: 40 }, bad, { session: SESSION, ai: { fetch, db: fakeLedger() } });
    expect(out.kept).toEqual([]);
    expect(printed).toContain("art-01 attempt 1: picture could not be saved");
    expect(printed.some((l) => l.includes("sha256"))).toBe(false);
  });

  it("stops the run on an error that will not go away", async () => {
    const { fetch, counts } = provider({ image: () => 401 });
    const out = await runArt({ mode: "go", capCents: 20 }, io, { session: SESSION, ai: { fetch, db: fakeLedger() } });
    expect(out).toMatchObject({ kept: [], stopped: true });
    expect(counts.image).toBe(1);
    expect(printed).toContain("run stopped (auth)");
    expect(flags.aiEnabled).toBe(false);
  });
});
