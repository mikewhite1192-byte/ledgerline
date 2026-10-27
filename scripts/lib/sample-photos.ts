import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { flags } from "../../src/config/flags";
import { AiError, complete, generateImage, type AiDeps, type AiErrorCategory } from "../../src/lib/ai";
import type { Session } from "../../src/lib/auth/claims";
import { DbError } from "../../src/lib/db";
import { composeReceipt, turnRgba } from "../../src/lib/seed/docs/compose";
import { receiptLines } from "../../src/lib/seed/docs/documents";
import type { Rgba } from "../../src/lib/seed/docs/font";
import {
  BACKGROUND_SAMPLE_SENTENCE,
  PHOTO_HEIGHT,
  PHOTO_SAMPLE_SENTENCE,
  PHOTO_WIDTH,
  isPhoto,
  type Manifest,
  type PhotoDoc,
} from "../../src/lib/seed/docs/manifest";
import { BACKGROUND_PROMPT, imagePrompt } from "../../src/lib/seed/docs/prompts";
import { TooLargeError, encodeWebp, plainWebp, stampRgba, toRgba } from "../../src/lib/seed/docs/stamp";
import {
  VERIFY_FORMAT,
  VERIFY_PROMPT,
  mismatches,
  parseRead,
} from "../../src/lib/seed/docs/verify";
import { ForbiddenError } from "../../src/lib/tenant/context";

// The logic behind npm run docs:photos (scripts/generate-sample-photos.ts is the thin entry).
//
// Three modes. dry (the default): prints the photo list, each prompt's length and the cost
// estimate, and calls nothing. compose: draws every photo as the composed fallback, with no key
// and no database. go: per photo, up to three attempts of generate, then a vision read checked
// against the manifest by whole value; a kept image gets the SAMPLE stamp and EXIF, a photo
// that fails three reads (or meets the run cap, or whose kept file does not fit its byte cap) is
// composed instead. Every model call goes through the wrapper, which checks the switch, reserves
// the cost and writes the ledger. Nothing printed holds a key, a prompt, an image or model text:
// file names, counts, field names, bytes, sha256 and cents only.

export const IMAGE_MAX_CENTS = 2;
export const VERIFY_MAX_CENTS = 3;
export const DEFAULT_CAP_CENTS = 60;
export const BACKGROUND_FILE = "samples/docs/bg/paper-flat.webp";
const MAX_ATTEMPTS = 3;
const MAX_IMAGE_ERRORS = 3;
const NANOCENTS_PER_CENT = 1_000_000_000;
const VERIFY_OUTPUT_TOKENS = 2048;

// Errors that will not go away by trying again: the run stops, writes nothing more and exits 1.
const FATAL: readonly AiErrorCategory[] = [
  "disabled",
  "not_configured",
  "cap",
  "too_expensive",
  "auth",
  "billing",
  "bad_request",
];

export type PhotoMode = "dry" | "go" | "compose";
export type PhotoOptions = { mode: PhotoMode; only: string | null; capCents: number };
export type PhotoIo = { publicDir: string; manifestPath: string; log: (line: string) => void };
// go only: who the calls are made as, and the wrapper's dependencies (tests pass fakes).
// maxBytes is the kept photo's byte cap (PHOTO_MAX_BYTES when left out; tests pass a tiny one).
export type PhotoCalls = { session: Session; ai: AiDeps; maxBytes?: number };
export type PhotoArgs = { mode: PhotoMode; only: string | null; cap: string | undefined };

export type DocOutcome = {
  id: string;
  origin: "generated" | "composed";
  attempts: number;
  bytes: number;
  sha256: string;
  // Why it was composed, in a word or two; null when generated.
  reason: string | null;
};

export type RunOutcome = {
  docs: DocOutcome[];
  spentNanocents: number;
  // The category that stopped a go run early, or null.
  stopped: string | null;
};

export class FatalCallError extends Error {
  readonly category: string;
  constructor(category: string) {
    super(`stopped: ${category}`);
    this.name = "FatalCallError";
    this.category = category;
  }
}

export function parseCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CAP_CENTS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new Error("the cap must be 1 to 500 cents");
  return n;
}

// The command line. The cap is --cap, else SEED_DOCS_CAP_CENTS from env.
export function parsePhotoArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): PhotoArgs {
  let mode: PhotoMode = "dry";
  let only: string | null = null;
  let cap: string | undefined = env.SEED_DOCS_CAP_CENTS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--go" || a === "--compose") {
      const next: PhotoMode = a === "--go" ? "go" : "compose";
      if (mode !== "dry" && mode !== next) throw new Error("--go and --compose do not mix");
      mode = next;
    } else if (a === "--only" && argv[i + 1]) {
      only = argv[++i];
    } else if (a === "--cap" && argv[i + 1]) {
      cap = argv[++i];
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { mode, only, cap };
}

// The env file (when there is one) is loaded into this process before the command line is read,
// so a cap set there counts. A variable already set in the shell keeps its value; --cap wins.
export function loadPhotoArgs(argv: readonly string[], envFile: string): PhotoArgs {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return parsePhotoArgs(argv, process.env);
}

export function photosToRun(manifest: Manifest, only: string | null): PhotoDoc[] {
  const photos = manifest.entries.filter(isPhoto);
  if (only === null) return photos;
  const one = photos.find((d) => d.id === only);
  if (!one) throw new Error(`no photo ${only} in the manifest`);
  return [one];
}

function cents(nanocents: number): string {
  return (nanocents / NANOCENTS_PER_CENT).toFixed(2);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeManifest(manifest: Manifest, io: PhotoIo): void {
  writeFileSync(io.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeAsset(io: PhotoIo, file: string, bytes: Uint8Array): void {
  const target = join(io.publicDir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function readBackground(manifest: Manifest, io: PhotoIo): Buffer | null {
  if (!manifest.background) return null;
  const path = join(io.publicDir, manifest.background.file);
  return existsSync(path) ? readFileSync(path) : null;
}

// The category of a failed call, or a FatalCallError when trying again cannot help. Anything
// that is not a call failure (a bug) is thrown as it is.
function failure(err: unknown): string {
  if (err instanceof AiError) {
    if (FATAL.includes(err.category)) throw new FatalCallError(err.category);
    return err.category;
  }
  if (err instanceof ForbiddenError) throw new FatalCallError("forbidden");
  if (err instanceof DbError) throw new FatalCallError(`database ${err.category}`);
  throw err;
}

// The run's own spend, separate from the wrapper's overall cap. A call that failed counts its
// whole reserve, because whether it was charged is not known.
class Spend {
  nanocents = 0;
  constructor(private readonly capCents: number) {}
  add(nanocents: number): void {
    this.nanocents += nanocents;
  }
  addReserve(maxCents: number): void {
    this.nanocents += maxCents * NANOCENTS_PER_CENT;
  }
  affords(maxCents: number): boolean {
    return this.nanocents + maxCents * NANOCENTS_PER_CENT <= this.capCents * NANOCENTS_PER_CENT;
  }
}

// A retake of another entry's receipt is the same lines, turned this many degrees.
export const RETAKE_DEGREES = 3;

async function composed(doc: PhotoDoc, background: Buffer | null): Promise<Buffer> {
  const img = await composeReceipt(receiptLines(doc), background);
  const shot = doc.retakeOf ? await turnRgba(img, RETAKE_DEGREES) : img;
  return encodeWebp(stampRgba(shot), PHOTO_SAMPLE_SENTENCE);
}

function record(
  manifest: Manifest,
  io: PhotoIo,
  doc: PhotoDoc,
  bytes: Buffer,
  origin: "generated" | "composed",
  attempts: number,
  reason: string | null,
): DocOutcome {
  writeAsset(io, doc.file, bytes);
  doc.bytes = bytes.length;
  doc.sha256 = sha256(bytes);
  doc.width = PHOTO_WIDTH;
  doc.height = PHOTO_HEIGHT;
  doc.origin = origin;
  // cabAngle is the design's intent and is left as it is: a composed receipt is flat whatever
  // cabAngle says, so a reader takes origin "composed" as flat.
  writeManifest(manifest, io);
  return { id: doc.id, origin, attempts, bytes: doc.bytes, sha256: doc.sha256, reason };
}

// Up to three attempts of generate and read. Returns the kept pixels, or null and why not.
async function attempt(
  doc: PhotoDoc,
  calls: PhotoCalls,
  spend: Spend,
  io: PhotoIo,
): Promise<{ kept: Rgba | null; attempts: number; reason: string | null }> {
  let attempts = 0;
  let imageErrors = 0;
  while (attempts < MAX_ATTEMPTS) {
    if (!spend.affords(IMAGE_MAX_CENTS + VERIFY_MAX_CENTS)) {
      return { kept: null, attempts, reason: "run cap" };
    }
    let image: Uint8Array;
    try {
      const out = await generateImage(
        {
          purpose: "seed_docs_image",
          prompt: imagePrompt(doc),
          n: 1,
          size: "3x4",
          outputFormat: "png",
          maxCostCents: IMAGE_MAX_CENTS,
        },
        calls.session,
        calls.ai,
      );
      spend.add(out.costNanocents);
      image = out.images[0].bytes;
    } catch (err) {
      const category = failure(err);
      spend.addReserve(IMAGE_MAX_CENTS);
      imageErrors += 1;
      io.log(`${doc.id}: image call failed (${category})`);
      if (imageErrors >= MAX_IMAGE_ERRORS) return { kept: null, attempts, reason: "image errors" };
      continue;
    }
    attempts += 1;

    let pixels: Rgba;
    let check: Buffer;
    try {
      pixels = await toRgba(image, { width: PHOTO_WIDTH, height: PHOTO_HEIGHT });
      check = await plainWebp(pixels);
    } catch {
      io.log(`${doc.id} attempt ${attempts}: image unreadable`);
      continue;
    }

    let text: string | null = null;
    try {
      const out = await complete(
        "spark",
        {
          purpose: "seed_docs_verify",
          messages: [
            {
              role: "user",
              content: VERIFY_PROMPT,
              attachments: [{ kind: "image", mime: "image/webp", bytes: check }],
            },
          ],
          format: VERIFY_FORMAT,
          maxOutputTokens: VERIFY_OUTPUT_TOKENS,
          reasoningEffort: "low",
          maxCostCents: VERIFY_MAX_CENTS,
        },
        calls.session,
        calls.ai,
      );
      spend.add(out.costNanocents);
      if (out.status === "ok") text = out.text;
    } catch (err) {
      const category = failure(err);
      spend.addReserve(VERIFY_MAX_CENTS);
      io.log(`${doc.id} attempt ${attempts}: read failed (${category})`);
      continue;
    }
    const read = text === null ? null : parseRead(text);
    if (!read) {
      io.log(`${doc.id} attempt ${attempts}: read off schema`);
      continue;
    }
    const diff = mismatches(doc, read);
    if (diff.length === 0) return { kept: pixels, attempts, reason: null };
    io.log(`${doc.id} attempt ${attempts}: mismatch on ${diff.join(", ")}`);
  }
  return { kept: null, attempts, reason: "three failed reads" };
}

// The blank paper the composed fallback is drawn on: generated once, kept without a gate (it
// carries no text), described in its EXIF. Null when the cap or a non-fatal error stops it; the
// fallback then uses a plain gradient.
async function ensureBackground(
  manifest: Manifest,
  calls: PhotoCalls,
  spend: Spend,
  io: PhotoIo,
): Promise<void> {
  if (readBackground(manifest, io)) return;
  if (!spend.affords(IMAGE_MAX_CENTS)) {
    io.log("background: skipped (run cap)");
    return;
  }
  let image: Uint8Array;
  try {
    const out = await generateImage(
      {
        purpose: "seed_docs_background",
        prompt: BACKGROUND_PROMPT,
        n: 1,
        size: "3x4",
        outputFormat: "png",
        maxCostCents: IMAGE_MAX_CENTS,
      },
      calls.session,
      calls.ai,
    );
    spend.add(out.costNanocents);
    image = out.images[0].bytes;
  } catch (err) {
    const category = failure(err);
    spend.addReserve(IMAGE_MAX_CENTS);
    io.log(`background: image call failed (${category}); the fallback uses a gradient`);
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await encodeWebp(
      await toRgba(image, { width: PHOTO_WIDTH, height: PHOTO_HEIGHT }),
      BACKGROUND_SAMPLE_SENTENCE,
    );
  } catch {
    io.log("background: image unreadable; the fallback uses a gradient");
    return;
  }
  writeAsset(io, BACKGROUND_FILE, bytes);
  manifest.background = {
    file: BACKGROUND_FILE,
    mime: "image/webp",
    bytes: bytes.length,
    sha256: sha256(bytes),
    width: PHOTO_WIDTH,
    height: PHOTO_HEIGHT,
    origin: "generated",
  };
  writeManifest(manifest, io);
  io.log(`background ${BACKGROUND_FILE} bytes=${bytes.length} sha256=${manifest.background.sha256}`);
}

function summary(io: PhotoIo, d: DocOutcome, spentBefore: number, spentAfter: number): void {
  io.log(
    `${d.id} ${d.origin}${d.reason ? ` (${d.reason})` : ""} attempts=${d.attempts} ` +
      `bytes=${d.bytes} sha256=${d.sha256} cents=${cents(spentAfter - spentBefore)}`,
  );
}

export async function runPhotos(
  manifest: Manifest,
  options: PhotoOptions,
  io: PhotoIo,
  calls?: PhotoCalls,
): Promise<RunOutcome> {
  const docs = photosToRun(manifest, options.only);

  if (options.mode === "dry") {
    io.log(`dry run: ${docs.length} photo(s), nothing is called; add --go to run`);
    for (const d of docs) {
      io.log(
        `  ${d.id} ${d.kind}${d.cabAngle ? " cab angle" : ""} prompt=${imagePrompt(d).length} chars`,
      );
    }
    const background = readBackground(manifest, io) ? 0 : 1;
    const typical = background + docs.length * 2;
    const worst = background * IMAGE_MAX_CENTS + docs.length * MAX_ATTEMPTS * (IMAGE_MAX_CENTS + VERIFY_MAX_CENTS);
    io.log(
      `estimate: about ${typical} cents (1 cent per image, under 1 cent per read), ` +
        `at most ${Math.min(worst, options.capCents)} cents (run cap ${options.capCents})`,
    );
    return { docs: [], spentNanocents: 0, stopped: null };
  }

  if (options.mode === "compose") {
    const background = readBackground(manifest, io);
    const out: DocOutcome[] = [];
    for (const d of docs) {
      const outcome = record(manifest, io, d, await composed(d, background), "composed", 0, "asked");
      summary(io, outcome, 0, 0);
      out.push(outcome);
    }
    return { docs: out, spentNanocents: 0, stopped: null };
  }

  if (!calls) throw new Error("a go run needs a session");
  // The entry script refuses this too; checked here as well so no other caller can reach the
  // calls or the database against Aurora. Before the switch is turned on and before any call.
  if (process.env.DB_CLUSTER_ARN) throw new Error("DB_CLUSTER_ARN is set: run this locally only");
  const spend = new Spend(options.capCents);
  const out: DocOutcome[] = [];
  // The switch is turned on in this process only, for this run, and always turned back off.
  const before = flags.aiEnabled;
  flags.aiEnabled = true;
  try {
    await ensureBackground(manifest, calls, spend, io);
    const background = readBackground(manifest, io);
    for (const d of docs) {
      const start = spend.nanocents;
      const tried = await attempt(d, calls, spend, io);
      let reason = tried.reason;
      let kept: Buffer | null = null;
      if (tried.kept) {
        try {
          kept = await encodeWebp(stampRgba(tried.kept), PHOTO_SAMPLE_SENTENCE, calls.maxBytes);
        } catch (err) {
          // A photo too detailed for its byte cap is composed instead, so the run still finishes.
          if (!(err instanceof TooLargeError)) throw err;
          reason = "too large";
        }
      }
      const bytes = kept ?? (await composed(d, background));
      const origin = kept ? "generated" : "composed";
      const outcome = record(manifest, io, d, bytes, origin, tried.attempts, reason);
      summary(io, outcome, start, spend.nanocents);
      out.push(outcome);
    }
  } catch (err) {
    if (!(err instanceof FatalCallError)) throw err;
    io.log(`stopped (${err.category}); the remaining photos are unchanged`);
    io.log(`total cents=${cents(spend.nanocents)} (run cap ${options.capCents})`);
    return { docs: out, spentNanocents: spend.nanocents, stopped: err.category };
  } finally {
    flags.aiEnabled = before;
  }
  io.log(`total cents=${cents(spend.nanocents)} (run cap ${options.capCents})`);
  return { docs: out, spentNanocents: spend.nanocents, stopped: null };
}
