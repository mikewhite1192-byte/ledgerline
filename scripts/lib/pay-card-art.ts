import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { flags } from "../../src/config/flags";
import { AiError, complete, generateImage, type AiDeps, type AiErrorCategory, type AiFormat } from "../../src/lib/ai";
import { NANOCENTS_PER_CENT } from "../../src/lib/ai/prices";
import type { Session } from "../../src/lib/auth/claims";
import { PAY_CARD_ART, type PayCardArt } from "../../src/lib/pay-cards/art";
import { plainWebp, toRgba } from "../../src/lib/seed/docs/stamp";

// The pay card's three background pictures, made from scratch by Muse Image and kept only when a
// Spark read finds no text and no digits on them, so the art can never put a figure on a card.
// The CLI is scripts/make-pay-card-art.ts; this file holds the run so tests can pass fakes.

export const ART_WIDTH = 1080;
export const ART_HEIGHT = 1350;
export const ART_MAX_BYTES = 200_000;
export const IMAGE_MAX_CENTS = 2;
export const READ_MAX_CENTS = 2;
export const DEFAULT_CAP_CENTS = 20;
const MAX_ATTEMPTS = 2;
const READ_OUTPUT_TOKENS = 300;
const QUALITIES = [80, 70, 60, 50, 40] as const;

// One theme per picture: soft abstract shapes in the app's own greens and warm grays.
export const ART_THEMES: Record<PayCardArt, string> = {
  "art-01": "large overlapping soft rounded shapes, like gentle rolling hills at dawn",
  "art-02": "flowing wide ribbons of color crossing diagonally, like a quiet open road seen from above",
  "art-03": "loose soft circles and arcs drifting across the frame, like light through leaves",
};

export function artPrompt(art: PayCardArt): string {
  return [
    `A calm abstract background illustration: ${ART_THEMES[art]}.`,
    "Palette: deep green #0e6b4d, fresh green #3fb984, pale mint #dcefe5, warm off-white #eeefea and",
    "soft warm gray. Smooth flat gradients, gentle grain, no hard edges, portrait orientation.",
    "No text, no letters, no numbers, no symbols, no logos, no signs, no people, no vehicles.",
  ].join(" ");
}

export const ART_READ_FORMAT: AiFormat = {
  name: "pay_card_art_read",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["has_text", "digits"],
    properties: {
      has_text: { type: "boolean" },
      digits: { type: "array", items: { type: "string" } },
    },
  },
};

export const ART_READ_PROMPT = [
  "Look at this picture closely, edge to edge.",
  "has_text: true if any letter, word, character or text-like mark appears anywhere, even faint or tiny.",
  "digits: every digit 0 to 9 you can see anywhere, each as its own string; an empty list if there are none.",
].join(" ");

export type ArtRead = { has_text: boolean; digits: string[] };

// The read, or null when it is not exactly the schema.
export function parseArtRead(text: string): ArtRead | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== "digits" || keys[1] !== "has_text") return null;
  if (typeof o.has_text !== "boolean") return null;
  if (!Array.isArray(o.digits) || !o.digits.every((d) => typeof d === "string")) return null;
  return { has_text: o.has_text, digits: o.digits as string[] };
}

// Kept only with no text and no digits at all.
export function isClean(read: ArtRead | null): boolean {
  return read !== null && read.has_text === false && read.digits.length === 0;
}

// The kept file: webp with no metadata, stepping the quality down until it fits.
export async function encodeArt(bytes: Uint8Array, maxBytes: number = ART_MAX_BYTES): Promise<Buffer> {
  const img = await toRgba(bytes, { width: ART_WIDTH, height: ART_HEIGHT });
  for (const quality of QUALITIES) {
    const out = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
      .removeAlpha()
      .webp({ quality })
      .toBuffer();
    if (out.length <= maxBytes) return out;
  }
  throw new Error(`the picture does not fit in ${maxBytes} bytes`);
}

export type ArtMode = "dry" | "go";
export type ArtIo = { outDir: string; log: (line: string) => void };
export type ArtCalls = { session: Session; ai: AiDeps };
export type ArtResult = { kept: PayCardArt[]; spentNanocents: number; stopped: boolean };

const NANO_PER_CENT = NANOCENTS_PER_CENT;

// Errors that will not go away by trying again: the run stops.
const FATAL: readonly AiErrorCategory[] = ["disabled", "not_configured", "cap", "job_cap", "too_expensive", "auth", "billing", "bad_request"];

class StopRun extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}

// Refused here before any call went out: nothing was spent upstream.
const LOCAL_REFUSAL: readonly AiErrorCategory[] = ["disabled", "not_configured", "cap", "job_cap", "too_expensive"];

// What a failed call may have cost: its reserve, unless the wrapper refused it locally.
function failCost(err: unknown, maxCents: number): number {
  if (err instanceof AiError && LOCAL_REFUSAL.includes(err.category)) return 0;
  return maxCents * NANO_PER_CENT;
}

function category(err: unknown): string {
  if (err instanceof AiError) {
    if (FATAL.includes(err.category)) throw new StopRun(err.category);
    return err.category;
  }
  return "error";
}

export function parseArtArgs(argv: string[]): { mode: ArtMode; capCents: number } {
  let mode: ArtMode = "dry";
  let capCents = DEFAULT_CAP_CENTS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--go") mode = "go";
    else if (a === "--cap") {
      const raw = argv[++i] ?? "";
      if (!/^[1-9][0-9]{0,2}$/.test(raw)) throw new Error("--cap takes whole cents, 1 to 999");
      capCents = Number(raw);
    } else throw new Error(`unknown argument ${a}`);
  }
  return { mode, capCents };
}

// Every picture: generate, read back, keep only a clean one. The dry run lists what it would do
// and calls nothing. The go run stops at the cap, counting each call's reserve before it is made.
export async function runArt(
  options: { mode: ArtMode; capCents: number },
  io: ArtIo,
  calls?: ArtCalls,
): Promise<ArtResult> {
  const perAttempt = IMAGE_MAX_CENTS + READ_MAX_CENTS;
  if (options.mode === "dry") {
    for (const art of PAY_CARD_ART) io.log(`${art}: would make one picture (prompt ${artPrompt(art).length} chars) and read it back`);
    io.log(`at most ${PAY_CARD_ART.length * MAX_ATTEMPTS * perAttempt} cents reserved, cap ${options.capCents} cents; nothing called`);
    return { kept: [], spentNanocents: 0, stopped: false };
  }
  if (!calls) throw new Error("the go run needs a session and the wrapper");
  const capNano = options.capCents * NANO_PER_CENT;
  let spent = 0;
  const kept: PayCardArt[] = [];
  const before = flags.aiEnabled;
  flags.aiEnabled = true;
  try {
    for (const art of PAY_CARD_ART) {
      let done = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
        if (spent + perAttempt * NANO_PER_CENT > capNano) {
          io.log(`${art}: run cap reached`);
          return { kept, spentNanocents: spent, stopped: true };
        }
        let image: Uint8Array;
        try {
          const out = await generateImage(
            { purpose: "pay_card_art", prompt: artPrompt(art), n: 1, size: "4x5", outputFormat: "png", maxCostCents: IMAGE_MAX_CENTS },
            calls.session,
            calls.ai,
          );
          spent += out.costNanocents;
          io.log(`${art} attempt ${attempt}: picture made (${(out.costNanocents / NANO_PER_CENT).toFixed(3)} cents)`);
          image = out.images[0].bytes;
        } catch (err) {
          spent += failCost(err, IMAGE_MAX_CENTS);
          io.log(`${art} attempt ${attempt}: picture call failed (${category(err)})`);
          continue;
        }
        let check: Buffer;
        try {
          check = await plainWebp(await toRgba(image, { width: ART_WIDTH, height: ART_HEIGHT }));
        } catch {
          io.log(`${art} attempt ${attempt}: picture unreadable`);
          continue;
        }
        let read: ArtRead | null = null;
        try {
          const out = await complete(
            "spark",
            {
              purpose: "pay_card_art_check",
              messages: [{ role: "user", content: ART_READ_PROMPT, attachments: [{ kind: "image", mime: "image/webp", bytes: check }] }],
              format: ART_READ_FORMAT,
              maxOutputTokens: READ_OUTPUT_TOKENS,
              reasoningEffort: "low",
              maxCostCents: READ_MAX_CENTS,
            },
            calls.session,
            calls.ai,
          );
          spent += out.costNanocents;
          if (out.status === "ok") read = parseArtRead(out.text);
          io.log(`${art} attempt ${attempt}: read ${out.status} (${(out.costNanocents / NANO_PER_CENT).toFixed(3)} cents)`);
        } catch (err) {
          spent += failCost(err, READ_MAX_CENTS);
          io.log(`${art} attempt ${attempt}: read failed (${category(err)})`);
          continue;
        }
        if (!isClean(read)) {
          io.log(`${art} attempt ${attempt}: not kept (${read ? "text or digits seen" : "read off schema"})`);
          continue;
        }
        let file: Buffer;
        try {
          file = await encodeArt(image);
          mkdirSync(io.outDir, { recursive: true });
          writeFileSync(join(io.outDir, `${art}.webp`), file);
        } catch {
          io.log(`${art} attempt ${attempt}: picture could not be saved`);
          continue;
        }
        const sha = createHash("sha256").update(file).digest("hex");
        io.log(`${art}: kept, ${file.length} bytes, sha256 ${sha}`);
        kept.push(art);
        done = true;
      }
      if (!done) io.log(`${art}: no clean picture in ${MAX_ATTEMPTS} attempts`);
    }
    return { kept, spentNanocents: spent, stopped: kept.length !== PAY_CARD_ART.length };
  } catch (err) {
    if (err instanceof StopRun) {
      io.log(`run stopped (${err.category})`);
      return { kept, spentNanocents: spent, stopped: true };
    }
    throw err;
  } finally {
    flags.aiEnabled = before;
    io.log(`spent ${(spent / NANO_PER_CENT).toFixed(3)} cents`);
  }
}
