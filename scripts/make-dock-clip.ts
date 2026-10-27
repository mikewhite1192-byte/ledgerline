import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import sharp from "sharp";
import { flags } from "../src/config/flags";
import { generateImage, type AiDeps } from "../src/lib/ai";
import type { Session } from "../src/lib/auth/claims";
import { readMp4Header } from "../src/lib/clips/mp4";
import { createPgDb } from "../src/lib/db/pg";
import type { Db } from "../src/lib/db/types";
import { carrierBySlug } from "../src/lib/seed/carriers";
import { findDemoTenant } from "../src/lib/seed/run";
import {
  CLIP_FPS,
  CLIP_FRAMES,
  CLIP_HEIGHT,
  CLIP_MAX_BYTES,
  CLIP_WIDTH,
  STILL_PROMPTS,
  ZOOM_ROOM,
  clockSvg,
  cropFor,
  dockPlant,
  frameSpecs,
  sceneOverlaySvg,
  type DockPlant,
  type Scene,
} from "./lib/dock-clip";
import { localDatabaseUrl } from "./lib/local-db";

// npm run clips:demo -- [--stills <dir>] [--ffmpeg <path>]
//
// Makes the synthetic dock clip the evidence-clip demo uploads, from nothing real: three stills
// from Muse Image (a dock door with one invented worker, a trailer's rear, a hand holding a blank
// form), with our own overlays drawn on them (the seed customer's sign, the invented plate
// SYN 4Q21, the plant load's number and an invented seal on the form) and a camera clock that
// runs from the seeded BR-L10216 delivery instants in the carrier's zone. Writes
// public/demo/dock-clip-br-l10216.mp4 (640 x 360, 8 fps, 18 s, H.264 baseline, no audio, under
// 550,000 bytes) and the two-frame test fixture src/lib/clips/fixtures/tiny.mp4.
//
// Development only. Needs a local database with the blue-ridge demo tenant and an admin login
// (the wrapper's ledger), AI_SPEND_CAP_CENTS and META_MODEL_IMAGE set, the Meta key (from
// META_API_KEY or the payday-copilot/meta-api-key secret, read into this process only), and
// ffmpeg with libx264. --stills reuses still-<scene>.jpg files from a folder and saves new ones
// there; without it the stills live in a temporary folder removed at the end. Three images cost
// 3 cents; nothing is printed but file names, sizes, hashes and cents.

const ANCHOR = "2026-11-02";
const LOAD = "BR-L10216";
const STOP = "delivery";
const OUT = join(process.cwd(), "public", "demo", "dock-clip-br-l10216.mp4");
const FIXTURE = join(process.cwd(), "src", "lib", "clips", "fixtures", "tiny.mp4");
const DEFAULT_SECRET = "payday-copilot/meta-api-key";
const IMAGE_MAX_CENTS = 2;
const SCENES: Scene[] = ["dock", "trailer", "form"];
const BASE_WIDTH = Math.round(CLIP_WIDTH * ZOOM_ROOM);
const BASE_HEIGHT = Math.round(CLIP_HEIGHT * ZOOM_ROOM);

type Args = { stills: string | null; ffmpeg: string };

function parseArgs(argv: string[]): Args {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return { stills: value("--stills") ?? null, ffmpeg: value("--ffmpeg") ?? "ffmpeg" };
}

async function loadKey(): Promise<void> {
  if (process.env.META_API_KEY?.trim()) return;
  const name = process.env.META_API_KEY_SECRET_NAME?.trim() || DEFAULT_SECRET;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  let value: string | undefined;
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: name }));
    value = out.SecretString?.trim();
  } catch (err) {
    throw new Error(`the key secret is unreadable (${err instanceof Error ? err.name : "error"})`);
  }
  if (!value) throw new Error("the key secret is empty");
  process.env.META_API_KEY = value;
}

async function localSession(admin: Db): Promise<Session> {
  const carrier = carrierBySlug("blue-ridge");
  if (!carrier) throw new Error("no blue-ridge carrier");
  const tenantId = await findDemoTenant(admin, carrier);
  const rows = await admin.withoutTenant((q) =>
    q.query<{ cognito_sub: string; email: string }>(
      "SELECT cognito_sub, email FROM memberships WHERE tenant_id = $1 AND role = 'admin' " +
        "ORDER BY created_at, cognito_sub LIMIT 1",
      [tenantId],
    ),
  );
  if (rows.length !== 1) throw new Error("no admin login for blue-ridge: run the demo users first");
  return { sub: rows[0].cognito_sub, email: rows[0].email, tenantId };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// The stills, generated through the wrapper only when the folder does not already hold them.
const missingStills = (dir: string) => SCENES.filter((s) => !existsSync(join(dir, `still-${s}.jpg`)));

async function stills(
  dir: string,
  ai: { session: Session; deps: AiDeps } | null,
): Promise<Record<Scene, Buffer>> {
  const out = {} as Record<Scene, Buffer>;
  const missing = missingStills(dir);
  if (missing.length > 0) {
    if (!ai) throw new Error("stills are missing and no model access was set up");
    // The switch is turned on in this process only, for these calls, and always turned back off.
    const before = flags.aiEnabled;
    flags.aiEnabled = true;
    try {
      for (const scene of missing) {
        const result = await generateImage(
          {
            purpose: "dock_clip_still",
            prompt: STILL_PROMPTS[scene],
            size: "16x9",
            outputFormat: "jpeg",
            maxCostCents: IMAGE_MAX_CENTS,
          },
          ai.session,
          ai.deps,
        );
        const image = result.images[0];
        if (!image) throw new Error(`no image for ${scene}`);
        writeFileSync(join(dir, `still-${scene}.jpg`), image.bytes);
        console.log(`still ${scene}: generated bytes=${image.bytes.length} call=${result.callId}`);
      }
    } finally {
      flags.aiEnabled = before;
    }
  }
  for (const scene of SCENES) out[scene] = readFileSync(join(dir, `still-${scene}.jpg`));
  return out;
}

// Each scene's base: the still covering the zoom room, with its overlay drawn on.
async function bases(raw: Record<Scene, Buffer>, plant: DockPlant): Promise<Record<Scene, Buffer>> {
  const out = {} as Record<Scene, Buffer>;
  for (const scene of SCENES) {
    const overlay = Buffer.from(sceneOverlaySvg(scene, plant, BASE_WIDTH, BASE_HEIGHT));
    out[scene] = await sharp(raw[scene])
      .resize(BASE_WIDTH, BASE_HEIGHT, { fit: "cover" })
      .composite([{ input: overlay, top: 0, left: 0 }])
      .png()
      .toBuffer();
  }
  return out;
}

async function frames(dir: string, base: Record<Scene, Buffer>, plant: DockPlant): Promise<void> {
  for (const spec of frameSpecs(plant)) {
    const crop = cropFor(spec.zoom, BASE_WIDTH, BASE_HEIGHT);
    const picture = await sharp(base[spec.scene])
      .extract(crop)
      .resize(CLIP_WIDTH, CLIP_HEIGHT)
      .toBuffer();
    await sharp(picture)
      .composite([{ input: Buffer.from(clockSvg(spec.clock)), top: 0, left: 0 }])
      .png()
      .toFile(join(dir, `f${String(spec.index).padStart(3, "0")}.png`));
  }
}

const X264 = ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-an"];

function encode(ffmpeg: string, dir: string, out: string): void {
  execFileSync(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-framerate", String(CLIP_FPS), "-i", join(dir, "f%03d.png"),
      ...X264,
      "-g", String(CLIP_FPS * 2), "-keyint_min", String(CLIP_FPS * 2), "-sc_threshold", "0",
      "-crf", "30", "-maxrate", "220k", "-bufsize", "440k",
      "-fps_mode", "cfr", "-map_metadata", "-1", "-movflags", "+faststart",
      out,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

// Two frames of flat color, 64 x 64 at 2 fps: the smallest clip the header reader accepts
// (64 pixels a side and one second are the table's minimums).
function fixture(ffmpeg: string, out: string): void {
  execFileSync(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x336699:s=64x64:r=2",
      "-frames:v", "2", ...X264, "-fps_mode", "cfr", "-map_metadata", "-1",
      "-movflags", "+faststart", out,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function check(path: string, frameCount: number, maxBytes: number): void {
  const bytes = new Uint8Array(readFileSync(path));
  const read = readMp4Header(bytes);
  if (!read.ok) throw new Error(`${path} does not read as a clip (${read.reason})`);
  if (read.header.frameCount !== frameCount) throw new Error(`${path} has ${read.header.frameCount} frames`);
  if (bytes.length > maxBytes) throw new Error(`${path} is ${bytes.length} bytes, over ${maxBytes}`);
  const h = read.header;
  console.log(
    `${path.slice(process.cwd().length + 1)}: bytes=${bytes.length} sha256=${sha(bytes)} ` +
      `${h.codec} ${h.width}x${h.height} fps=${h.fps} frames=${h.frameCount} ms=${h.durationMs}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.DB_CLUSTER_ARN) throw new Error("DB_CLUSTER_ARN is set: run this locally only");
  const carrier = carrierBySlug("blue-ridge");
  if (!carrier) throw new Error("no blue-ridge carrier");
  const plant = dockPlant(carrier, ANCHOR, LOAD, STOP);

  const work = mkdtempSync(join(tmpdir(), "dock-clip-"));
  const stillDir = args.stills ?? join(work, "stills");
  mkdirSync(stillDir, { recursive: true });
  const frameDir = join(work, "frames");
  mkdirSync(frameDir);
  try {
    let raw: Record<Scene, Buffer>;
    if (missingStills(stillDir).length > 0) {
      await loadKey();
      const adminUrl = localDatabaseUrl();
      const appUrl = new URL(adminUrl);
      appUrl.username = "payday_app";
      appUrl.password = "";
      const admin = createPgDb({ connectionString: adminUrl.toString(), max: 1 });
      const app = createPgDb({ connectionString: appUrl.toString(), max: 1 });
      try {
        raw = await stills(stillDir, { session: await localSession(admin), deps: { db: app } });
      } finally {
        await admin.close();
        await app.close();
      }
    } else {
      raw = await stills(stillDir, null);
    }
    await frames(frameDir, await bases(raw, plant), plant);
    mkdirSync(join(process.cwd(), "public", "demo"), { recursive: true });
    encode(args.ffmpeg, frameDir, OUT);
    check(OUT, CLIP_FRAMES, CLIP_MAX_BYTES);
    mkdirSync(join(process.cwd(), "src", "lib", "clips", "fixtures"), { recursive: true });
    fixture(args.ffmpeg, FIXTURE);
    check(FIXTURE, 2, 10_000);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
