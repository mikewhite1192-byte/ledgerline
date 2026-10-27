import { createHash, randomUUID } from "node:crypto";
import { flags } from "../../config/flags";
import { AiError, complete, segmentVideo, spendRoom, type AiDeps, type AiRequest } from "../ai";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { isUuid } from "../uuid";
import { agreementOf } from "./agreement";
import { readMp4Header, type Mp4Header, type Mp4Refusal } from "./mp4";
import { planRedaction, storedBoxes, type RedactionPlan } from "./redaction";
import { CLIP_FORMAT, CLIP_PROMPT, parseClipReading, type ClipReading } from "./schema";
import {
  MAX_ATTEMPTS,
  clipFacts,
  clipView,
  countToday,
  exhaustRedactAttempts,
  findByRawHash,
  findLoad,
  findReadState,
  finishRead,
  insertClip,
  listViews,
  lockTenantClips,
  markBudget,
  markBudgetUntried,
  readRedactedBytes,
  redactedFile,
  releaseReadLease,
  releaseRedactLease,
  saveConcept,
  stopTimesFor,
  storeRedactedBytes,
  takeReadLease,
  takeRedactLease,
  type Concept,
  type ReadState,
  type RedactedClip,
} from "./store";
import { CLIP_STOPS, type ClipFailure, type ClipRefusal, type ClipStop, type ClipView } from "./types";

// The dock clip pipeline (design section 4). Three steps, each its own request:
//   upload: the raw file's header and hash, a reserved row, then the two segmentation calls (faces,
//     plates) on the raw bytes in that one request. Only their boxes are kept; the raw bytes are
//     never written anywhere.
//   store: the uploader's browser sends the redacted file; its header and hash are checked, then
//     it is written alone in its own transaction.
//   read: the reading model is given the redacted file (a RedactedClip, which only the store
//     builds from the redacted column) and its answer is kept with how its clocks compare with the
//     stored stop times. The reading never changes a time or a number.
// Every entry checks clipsEnabled itself; the model wrapper checks aiEnabled and the caps again.
// Only a model call uses up a try: a reading the wrapper's spend checks would refuse waits on the
// cap before its lease is taken.

export type ClipDeps = { db?: TenantDb; ai?: AiDeps };

const SAM_PROMPT: Readonly<Record<Concept, string>> = { face: "face", plate: "license plate" };
const PURPOSE: Readonly<Record<Concept, string>> = { face: "clip_redact_face", plate: "clip_redact_plate" };
const READ_OUTPUT_TOKENS = 2048;
// A plain name for the list; the bytes decide what the file is, never its name.
const FILENAME_UNSAFE = /[^A-Za-z0-9._ -]+/g;

const fail = (category: ClipRefusal, retryable = false, clipId?: string): ClipFailure =>
  clipId ? { ok: false, category, retryable, clipId } : { ok: false, category, retryable };

function limits() {
  return {
    maxBytes: flags.clipLimits.bytes,
    minDurationMs: 1_000,
    maxDurationMs: flags.clipLimits.durationMs,
    maxFrames: flags.clipLimits.frames,
    minSide: 64,
    maxSide: 1_920,
    maxFps: 30,
  };
}

function headerRefusal(reason: Mp4Refusal): ClipRefusal {
  if (reason === "too_large") return "too_large";
  if (reason === "too_long" || reason === "too_many_frames") return "too_long";
  return "unsupported";
}

// The clip's header, or the refusal. Odd sizes are refused here, before any money is spent: the
// browser's H.264 encoder cannot write them, so the clip could never be redacted.
function readHeader(bytes: Uint8Array): { ok: true; header: Mp4Header } | ClipFailure {
  if (bytes.length === 0) return fail("unsupported");
  if (bytes.length > flags.clipLimits.bytes) return fail("too_large");
  const read = readMp4Header(bytes, limits());
  if (!read.ok) return fail(headerRefusal(read.reason));
  if (read.header.width % 2 !== 0 || read.header.height % 2 !== 0) return fail("unsupported");
  return read;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function cleanFilename(name: unknown): string {
  const base = typeof name === "string" ? name.split(/[\\/]/).pop() ?? "" : "";
  const clean = base.replace(FILENAME_UNSAFE, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return /^[A-Za-z0-9]/.test(clean) ? clean : "clip.mp4";
}

// One tenant transaction with the membership confirmed first.
function tx<T>(session: Session, deps: ClipDeps, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return (deps.db ?? getDb()).withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

function logFailure(step: string, err: unknown): void {
  const what = err instanceof AiError ? `${err.name}:${err.category}` : err instanceof Error ? err.name : "unknown";
  console.error("clip step failed:", step, what);
}

// A segmentation answer in another size than the clip. The same file gets the same answer, so it
// is refused for good rather than counted as a failure worth paying to retry.
class SegmentationSizeError extends Error {
  constructor() {
    super("segmentation size differs from the clip");
    this.name = "SegmentationSizeError";
  }
}

async function withPlan(session: Session, deps: ClipDeps, id: string): Promise<{ clip: ClipView; plan: RedactionPlan | null } | null> {
  return tx(session, deps, async (q) => {
    const clip = await clipView(q, id);
    if (!clip) return null;
    const facts = await clipFacts(q, id);
    const plan = facts?.redaction ? planRedaction(facts.redaction, facts) : null;
    return { clip, plan };
  });
}

export type UploadInput = { loadId: string; stop: string; filename: string; bytes: Uint8Array };
export type UploadResult = { ok: true; clip: ClipView; plan: RedactionPlan } | ClipFailure;

// Which of two failed concepts the answer names: a switch that is off, then an answer that can
// never fit this clip, then the spend cap, then a failure worth trying again.
type RedactRefusal = "failed" | "budget" | "unsupported" | "disabled";
const RANK: Readonly<Record<RedactRefusal, number>> = { failed: 0, budget: 1, unsupported: 2, disabled: 3 };

type Claim =
  | { kind: "run"; id: string; traceId: string; missing: Concept[] }
  | { kind: "ready"; id: string }
  | { kind: "refused"; failure: ClipFailure };

export async function uploadClip(session: Session, input: UploadInput, deps: ClipDeps = {}): Promise<UploadResult> {
  if (!flags.clipsEnabled || !flags.aiEnabled) return fail("disabled");
  if (!isUuid(input.loadId) || !(CLIP_STOPS as readonly string[]).includes(input.stop)) return fail("unsupported");
  const stop = input.stop as ClipStop;
  const read = readHeader(input.bytes);
  if (!read.ok) return read;
  const header = read.header;
  const rawHash = sha256(input.bytes);

  const claim = await tx<Claim>(session, deps, async (q) => {
    await lockTenantClips(q);
    if (!(await findLoad(q, input.loadId))) return { kind: "refused", failure: fail("not_found") };
    const existing = await findByRawHash(q, rawHash);
    if (existing) {
      // The same file again. Past redacting, or for another load or stop, it is a duplicate. Still
      // redacting with both answers kept, the plan is handed back (the uploader's page closed
      // before it sent the redacted file). Missing an answer, only the missing concept runs.
      if (existing.status !== "redacting" || existing.loadId !== input.loadId || existing.stop !== stop) {
        return { kind: "refused", failure: fail("duplicate", false, existing.id) };
      }
      if (existing.hasFace && existing.hasPlate) return { kind: "ready", id: existing.id };
      const leased = await takeRedactLease(q, existing.id);
      if (!leased) {
        return {
          kind: "refused",
          failure: existing.attempts >= MAX_ATTEMPTS ? fail("failed", false, existing.id) : fail("busy", true, existing.id),
        };
      }
      const missing: Concept[] = [];
      if (!leased.hasFace) missing.push("face");
      if (!leased.hasPlate) missing.push("plate");
      return { kind: "run", id: leased.id, traceId: leased.traceId ?? randomUUID(), missing };
    }
    const today = await countToday(q);
    if (!Number.isInteger(today) || today >= flags.clipLimits.perTenantPerDay) {
      return { kind: "refused", failure: fail("limit") };
    }
    const id = randomUUID();
    const traceId = randomUUID();
    await insertClip(q, {
      id,
      loadId: input.loadId,
      stop,
      uploadedBy: session.sub,
      filename: cleanFilename(input.filename),
      rawHash,
      rawByteLength: input.bytes.length,
      width: header.width,
      height: header.height,
      fps: header.fps,
      frameCount: header.frameCount,
      durationMs: header.durationMs,
      traceId,
    });
    return { kind: "run", id, traceId, missing: ["face", "plate"] };
  });
  if (claim.kind === "refused") return claim.failure;

  let worst: RedactRefusal | null = null;
  if (claim.kind === "run") {
    // Tracked on its own: a higher-ranked refusal for the other concept must not hide it.
    let sizeMismatch = false;
    const size = { width: header.width, height: header.height, frameCount: header.frameCount };
    const settled = await Promise.allSettled(
      claim.missing.map(async (concept) => {
        const result = await segmentVideo(
          {
            purpose: PURPOSE[concept],
            video: { mime: "video/mp4", bytes: input.bytes, frameCount: header.frameCount },
            prompt: SAM_PROMPT[concept],
            maxCostCents: flags.clipLimits.redactMaxCostCents,
            traceId: claim.traceId,
          },
          session,
          deps.ai,
        );
        // Boxes in another size than the clip's are not boxes this clip can use.
        if ((result.width !== null && result.width !== size.width) || (result.height !== null && result.height !== size.height)) {
          throw new SegmentationSizeError();
        }
        // Kept the moment it lands, in its own transaction, so the other concept's failure
        // cannot lose it.
        await tx(session, deps, (q) => saveConcept(q, claim.id, concept, storedBoxes(result.frames, size), result.callId));
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled") continue;
      logFailure("redaction", s.reason);
      if (s.reason instanceof SegmentationSizeError) sizeMismatch = true;
      const category: RedactRefusal =
        s.reason instanceof AiError && s.reason.category === "disabled"
          ? "disabled"
          : s.reason instanceof SegmentationSizeError
            ? "unsupported"
            : s.reason instanceof AiError && (s.reason.category === "cap" || s.reason.category === "too_expensive")
              ? "budget"
              : "failed";
      if (worst === null || RANK[category] > RANK[worst]) worst = category;
    }
    if (sizeMismatch) {
      // The same file gets the same answer, so its remaining tries are spent now, not paid for.
      // In its own transaction, so a failure to free the lease below cannot undo it.
      try {
        await tx(session, deps, (q) => exhaustRedactAttempts(q, claim.id));
      } catch (err) {
        logFailure("exhaust", err);
      }
    }
    try {
      await tx(session, deps, (q) => releaseRedactLease(q, claim.id));
    } catch (err) {
      // The answers are already kept and the lease lapses on its own, so this answers with them.
      logFailure("release", err);
    }
  }

  const kept = await withPlan(session, deps, claim.id);
  if (!kept) return fail("not_found");
  if (!kept.plan) {
    const attempts = await tx(session, deps, (q) => redactAttempts(q, claim.id));
    const final = worst ?? "failed";
    return fail(final, (final === "failed" || final === "budget") && attempts < MAX_ATTEMPTS, claim.id);
  }
  return { ok: true, clip: kept.clip, plan: kept.plan };
}

async function redactAttempts(q: Queryable, id: string): Promise<number> {
  const rows = await q.query<{ n: number }>(
    "SELECT CAST(redact_attempts AS integer) AS n FROM evidence_clips WHERE id = CAST($1 AS uuid)",
    [id],
  );
  return rows.length === 1 ? Number(rows[0].n) : MAX_ATTEMPTS;
}

export type StoreResult = { ok: true; clip: ClipView } | ClipFailure;

export async function storeRedacted(
  session: Session,
  id: string,
  bytes: Uint8Array,
  deps: ClipDeps = {},
): Promise<StoreResult> {
  if (!flags.clipsEnabled) return fail("disabled");
  if (!isUuid(id)) return fail("not_found");
  const read = readHeader(bytes);
  if (!read.ok) return read;
  const header = read.header;
  const hash = sha256(bytes);

  const check = await tx(session, deps, async (q) => {
    const facts = await clipFacts(q, id);
    if (!facts) return fail("not_found");
    if (facts.status !== "redacting") return facts.redactedHash === hash ? null : fail("conflict");
    if (!facts.redaction) return fail("not_ready");
    // The same picture size and, within one frame, the same length: the browser re-encoded this
    // clip, nothing else.
    const frameMs = Math.ceil(facts.durationMs / facts.frameCount);
    if (
      header.width !== facts.width ||
      header.height !== facts.height ||
      Math.abs(header.frameCount - facts.frameCount) > 1 ||
      Math.abs(header.durationMs - facts.durationMs) > frameMs
    ) {
      return fail("mismatch");
    }
    if (hash === facts.rawHash) return fail("unchanged");
    return "store" as const;
  });
  if (check !== null && check !== "store") return check;

  if (check === "store") {
    let stored: number | null = null;
    try {
      stored = await tx(session, deps, (q) => storeRedactedBytes(q, id, bytes, hash));
    } catch (err) {
      // The write may or may not have landed (a lost commit reply is unknown): read it back. The
      // segmentation answers are untouched either way, so a retry repeats no model call.
      logFailure("store", err);
    }
    if (stored !== 1) {
      const after = await tx(session, deps, (q) => clipFacts(q, id)).catch(() => null);
      if (!after || after.status === "redacting") return fail("store_failed", true, id);
      if (after.redactedHash !== hash) return fail("conflict");
    }
  }
  const clip = await tx(session, deps, (q) => clipView(q, id));
  return clip ? { ok: true, clip } : fail("not_found");
}

export type ReadResult = { ok: true; clip: ClipView } | ClipFailure;

// What a read request answers from the clip's read state before any work: the kept answer
// ("done"), a refusal, or null to go on.
function readGate(state: ReadState | null): "done" | ClipFailure | null {
  if (!state) return fail("not_found");
  if (state.status === "redacting") return fail("not_ready", true);
  if (state.status === "read" || state.status === "unreadable") return "done";
  if (state.attempts >= MAX_ATTEMPTS) return fail("read_spent");
  if (!state.leaseFree) return fail("busy", true);
  return null;
}

export async function readClip(session: Session, id: string, deps: ClipDeps = {}): Promise<ReadResult> {
  if (!flags.clipsEnabled || !flags.aiEnabled) return fail("disabled");
  if (!isUuid(id)) return fail("not_found");

  const state = await tx(session, deps, (q) => findReadState(q, id));
  const gate = readGate(state);
  if (gate !== null && gate !== "done") return gate;

  if (gate === null) {
    // The file first, then the attempt. The file is the largest cell the pipeline reads back, so
    // a read of it that fails costs nothing and counts nothing: only a model call uses up a try.
    let clip: RedactedClip | null = null;
    try {
      clip = await tx(session, deps, (q) => readRedactedBytes(q, id));
    } catch (err) {
      logFailure("file read", err);
    }
    if (!clip) return fail("read_failed", true);

    // One request for the spend check and the call, so both see the same reserve.
    const call = readCall(clip, state?.traceId ?? randomUUID());
    const claim = await tx(session, deps, async (q) => {
      // The wrapper's own spend checks, read without a lock: a reading they would refuse now makes
      // no model call, so it waits on the cap with no try counted and reads once there is room.
      const room = await spendRoom("spark", call.request, q);
      if (room === "cap" || room === "too_expensive") {
        if ((await markBudgetUntried(q, id)) === 1) {
          console.error("clip reading waits on the cap:", room);
          return fail("budget", true);
        }
      } else {
        const leased = await takeReadLease(q, id);
        if (leased) return { attempts: leased.attempts };
      }
      // Another request got there between the two reads: answer as it left the clip.
      return readGate(await findReadState(q, id)) ?? fail("busy", true);
    });
    if (claim === "done") return answerView(session, id, deps);
    if ("ok" in claim) return claim;

    const release = () => tx(session, deps, (q) => releaseReadLease(q, id)).catch((err) => logFailure("release", err));
    const outcome = await readRedacted(session, call, deps);
    if (outcome.kind === "error") {
      if (outcome.budget) {
        // Refused after the lease (another call took the room since the check): the try counts,
        // so these stay bounded by MAX_ATTEMPTS.
        await tx(session, deps, (q) => markBudget(q, id));
        return fail("budget", claim.attempts < MAX_ATTEMPTS);
      }
      await release();
      return fail(outcome.disabled ? "disabled" : "read_failed", !outcome.disabled && claim.attempts < MAX_ATTEMPTS);
    }
    let finished = false;
    try {
      await tx(session, deps, async (q) => {
        if (outcome.kind === "unreadable") return finishRead(q, id, { status: "unreadable", callId: outcome.callId });
        const times = await stopTimesFor(q, id);
        // No joined load or carrier row (a stop with no times comes back as a row of nulls).
        if (!times) throw new Error("stop times not found");
        const agreement = agreementOf(outcome.reading, times);
        return finishRead(q, id, { status: "read", reading: { ...outcome.reading, agreement }, callId: outcome.callId });
      });
      finished = true;
    } catch (err) {
      logFailure("finish", err);
    }
    if (!finished) {
      // The write may have landed with its reply lost: read the state back. A kept answer stands.
      // Anything else, or a read-back that fails too, is unknown and refused with no second write:
      // the lease and the counted try stay, so a retry waits out the lease and stays within
      // MAX_ATTEMPTS.
      const after = await tx(session, deps, (q) => findReadState(q, id)).catch((err) => {
        logFailure("finish read-back", err);
        return null;
      });
      if (!after || readGate(after) !== "done") return fail("read_failed", claim.attempts < MAX_ATTEMPTS);
    }
  }
  return answerView(session, id, deps);
}

async function answerView(session: Session, id: string, deps: ClipDeps): Promise<ReadResult> {
  const clip = await tx(session, deps, (q) => clipView(q, id));
  return clip ? { ok: true, clip } : fail("not_found");
}

type ReadOutcome =
  | { kind: "read"; reading: ClipReading; callId: string }
  | { kind: "unreadable"; callId: string }
  | { kind: "error"; budget: boolean; disabled: boolean };

type ReadCall = { readonly clip: RedactedClip; readonly request: AiRequest };

// The one reading request, built only from a RedactedClip, so the raw file cannot reach the model.
function readCall(clip: RedactedClip, traceId: string): ReadCall {
  return {
    clip,
    request: {
      purpose: "clip_read",
      messages: [
        {
          role: "user",
          content: CLIP_PROMPT,
          attachments: [{ kind: "video", mime: "video/mp4", bytes: clip.bytes, frameCount: clip.frameCount }],
        },
      ],
      format: CLIP_FORMAT,
      maxOutputTokens: READ_OUTPUT_TOKENS,
      maxCostCents: flags.clipLimits.readMaxCostCents,
      traceId,
    },
  };
}

// The one reading call.
async function readRedacted(session: Session, { clip, request }: ReadCall, deps: ClipDeps): Promise<ReadOutcome> {
  try {
    const result = await complete("spark", request, session, deps.ai);
    if (result.status !== "ok") return { kind: "unreadable", callId: result.callId };
    const parsed = parseClipReading(result.text, clip.durationMs);
    if (!parsed.ok) {
      console.error("clip reading refused:", parsed.category);
      return { kind: "unreadable", callId: result.callId };
    }
    return { kind: "read", reading: parsed.reading, callId: result.callId };
  } catch (err) {
    logFailure("reading", err);
    const category = err instanceof AiError ? err.category : null;
    return { kind: "error", budget: category === "cap" || category === "too_expensive", disabled: category === "disabled" };
  }
}

export type GetResult = { ok: true; clip: ClipView; plan: RedactionPlan | null } | ClipFailure;

export async function getClip(session: Session, id: string, deps: ClipDeps = {}): Promise<GetResult> {
  if (!flags.clipsEnabled) return fail("disabled");
  if (!isUuid(id)) return fail("not_found");
  const kept = await withPlan(session, deps, id);
  return kept ? { ok: true, ...kept } : fail("not_found");
}

export type ListResult = { ok: true; clips: ClipView[] } | ClipFailure;

export async function listClips(session: Session, loadId: string | null, deps: ClipDeps = {}): Promise<ListResult> {
  if (!flags.clipsEnabled) return fail("disabled");
  if (loadId !== null && !isUuid(loadId)) return fail("not_found");
  const clips = await tx(session, deps, (q) => listViews(q, loadId));
  return { ok: true, clips };
}

export type FileResult = { ok: true; bytes: Uint8Array } | ClipFailure;

// The redacted file only. There is no raw file to return: it was never kept.
export async function readRedactedFile(session: Session, id: string, deps: ClipDeps = {}): Promise<FileResult> {
  if (!flags.clipsEnabled) return fail("disabled");
  if (!isUuid(id)) return fail("not_found");
  const bytes = await tx(session, deps, (q) => redactedFile(q, id));
  return bytes ? { ok: true, bytes } : fail("not_found");
}
