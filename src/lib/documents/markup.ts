import { createHash } from "node:crypto";
import { flags } from "../../config/flags";
import {
  AiError,
  complete,
  editImage,
  spendRoom,
  type AiDeps,
  type AiRequest,
  type AiResult,
  type ImageEditRequest,
  type ImageResult,
} from "../ai";
import { looksLike } from "../ai/providers/media";
import type { Session } from "../auth/claims";
import { getDb, type Queryable, type TenantDb } from "../db";
import { assertMembership } from "../tenant/context";
import { checkMarkup, type MarkupMismatch } from "./markup-check";
import { MARKUP_CHECK_FORMAT, MARKUP_CHECK_PROMPT, parseMarkupCheck } from "./markup-schema";
import { markupPrompt, planMarkup, type MarkupBlocked, type MarkupPlan } from "./markup-text";
import { MARKUP_STALLED_MS, viewOf } from "./service";
import {
  claimMarkup,
  countRecentMarkups,
  finishMarkupChecked,
  finishMarkupFailed,
  lockTenantUploads,
  markMarkupBudget,
  readDocumentBytes,
  readDocumentMeta,
  readDriverLanguage,
  readMarkupBytes,
  type MarkupFailure,
  type MarkupLease,
} from "./store";
import { MARKUP_ATTEMPTS_MAX, type DocumentRead, type DocumentView, type MatchResult } from "./types";

// The marked copy: one Muse Image edit of an uploaded photo that circles the line in question and
// writes what the records say beside it, then one Muse Spark read of the copy that code compares
// with the original reading. The copy is a sample picture for a person: it never replaces the
// file, never feeds a number, and one that fails the check is not kept.
//
// One try: in a tenant transaction with the membership check (the documents routes' staff check),
// plan the target from the stored reading and comparison, test the spend room for the check call
// (a refusal here writes "waiting for budget" and uses no try), take the tenant's upload lock, test
// the day count, and claim the row (status, try count and time; two clicks start one try). Then
// the edit and the check run outside any transaction (up to 85 seconds). Then one write ends the
// try under the claim: the copy and its read-back when it passed, else a category and the
// read-back. A crash in between leaves the row marking; after MARKUP_STALLED_MS another try may
// start. A row gets MARKUP_ATTEMPTS_MAX tries.

export const MARKUP_CHECK_MAX_OUTPUT_TOKENS = 2_048;
export const MARKUP_CHECK_TIMEOUT_MS = 25_000;

export type MarkupDeps = {
  db?: TenantDb;
  now?: () => Date;
  edit?: (request: ImageEditRequest, session: Session) => Promise<ImageResult>;
  complete?: (target: "spark", request: AiRequest, session: Session) => Promise<AiResult>;
  ai?: AiDeps;
};

export type MarkupRefusal =
  | "disabled"
  | "not_found"
  | MarkupBlocked
  | "already_checked"
  | "in_progress"
  | "attempt_limit"
  | "limit"
  | "budget";

export type MarkupOutcome = { ok: true; view: DocumentView } | { ok: false; error: MarkupRefusal };

const EDIT_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
type EditMime = (typeof EDIT_MIMES)[number];

// Refusals that mean the provider was never paid: the try is given back.
const BUDGET: readonly string[] = ["cap", "job_cap", "too_expensive", "billing"];
const NOT_SENT: readonly string[] = ["disabled", "not_configured"];

const isEditMime = (mime: string): mime is EditMime => (EDIT_MIMES as readonly string[]).includes(mime);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base64Of = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64.replace(/\s+/g, ""), "base64"));

function tx<T>(db: TenantDb, session: Session, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return fn(q);
  });
}

// The check call for one picture: the strict read-back schema, no expected value in the prompt.
export function checkRequest(image: { mime: EditMime; bytes: Uint8Array }, traceId: string): AiRequest {
  return {
    messages: [
      { role: "system", content: MARKUP_CHECK_PROMPT },
      { role: "user", content: "Read this photo.", attachments: [{ kind: "image", mime: image.mime, bytes: image.bytes }] },
    ],
    format: MARKUP_CHECK_FORMAT,
    maxOutputTokens: MARKUP_CHECK_MAX_OUTPUT_TOKENS,
    reasoningEffort: "low",
    purpose: "document_markup_check",
    maxCostCents: flags.markupLimits.checkMaxCostCents,
    timeoutMs: MARKUP_CHECK_TIMEOUT_MS,
    traceId,
  };
}

function categoryOf(err: unknown): { category: "budget" | "timeout" | "unknown"; refundable: boolean } {
  if (err instanceof AiError) {
    if (BUDGET.includes(err.category)) return { category: "budget", refundable: true };
    if (NOT_SENT.includes(err.category)) return { category: "unknown", refundable: true };
    if (err.category === "timeout") return { category: "timeout", refundable: false };
  }
  return { category: "unknown", refundable: false };
}

const errorName = (err: unknown) => (err instanceof AiError ? err.category : ((err as Error)?.name ?? "unknown"));

type Planned = { read: DocumentRead; match: MatchResult; plan: Extract<MarkupPlan, { ok: true }> };

type Claimed = {
  lease: MarkupLease;
  traceId: string;
  original: { mime: EditMime; bytes: Uint8Array };
  planned: Planned;
};

// The try's result, before it is written: kept, or why not.
type Ending =
  | { kept: true; copy: { mime: EditMime; bytes: Uint8Array }; check: Record<string, unknown>; editCallId: string; checkCallId: string }
  | ({ kept: false } & MarkupFailure);

async function runTry(session: Session, claimed: Claimed, deps: MarkupDeps): Promise<Ending> {
  const { plan, read } = claimed.planned;
  const edit = deps.edit ?? ((r, s) => editImage(r, s, deps.ai ?? {}));
  const call = deps.complete ?? ((t, r, s) => complete(t, r, s, deps.ai ?? {}));
  const fail = (category: MarkupFailure["category"], over: Partial<MarkupFailure> = {}): Ending => ({
    kept: false,
    status: "unavailable",
    category,
    check: null,
    editCallId: null,
    checkCallId: null,
    refund: false,
    ...over,
  });

  // The switches are re-read here, at the outside call, whatever the route already checked.
  if (!flags.documentsEnabled || !flags.documentMarkupEnabled) return fail("unknown", { refund: true });

  let edited: ImageResult;
  try {
    edited = await edit(
      {
        prompt: markupPrompt(plan),
        image: claimed.original,
        purpose: "document_markup",
        maxCostCents: flags.markupLimits.editMaxCostCents,
        traceId: claimed.traceId,
      },
      session,
    );
  } catch (err) {
    const { category, refundable } = categoryOf(err);
    console.error(`documents: markup edit failed category=${errorName(err)}`);
    return fail(category, { refund: refundable });
  }
  const editCallId = edited.callId;
  // Exactly one picture that looks like its type, within the size cap; anything else fails closed.
  if (edited.images.length !== 1) return fail("unknown", { editCallId });
  const copy = edited.images[0];
  if (!isEditMime(copy.mime) || copy.bytes.byteLength === 0 || !looksLike(copy.mime, copy.bytes)) {
    return fail("unknown", { editCallId });
  }
  if (copy.bytes.byteLength > flags.markupLimits.maxBytes) return fail("too_large", { editCallId });

  let checked: AiResult;
  try {
    checked = await call("spark", checkRequest({ mime: copy.mime, bytes: copy.bytes }, claimed.traceId), session);
  } catch (err) {
    // The edit was paid for, so the try is used whatever stopped the check.
    const { category } = categoryOf(err);
    console.error(`documents: markup check failed category=${errorName(err)}`);
    return fail(category, { editCallId });
  }
  const checkCallId = checked.callId;
  const answer = checked.status === "ok" ? parseMarkupCheck(checked.text) : null;
  const verdict = checkMarkup(
    { original: read, callout: plan.callout, anchor: plan.anchor, claimCents: plan.claimCents },
    answer,
  );
  if (!verdict.ok || !answer) {
    const category: MarkupMismatch = verdict.ok ? "off_schema" : verdict.category;
    return fail(category, { status: "mismatch", check: answer?.raw ?? null, editCallId, checkCallId });
  }
  return { kept: true, copy: { mime: copy.mime, bytes: copy.bytes }, check: answer.raw, editCallId, checkCallId };
}

export async function markDocument(session: Session, id: string, deps: MarkupDeps = {}): Promise<MarkupOutcome> {
  if (!flags.documentsEnabled || !flags.documentMarkupEnabled) return { ok: false, error: "disabled" };
  const db = deps.db ?? getDb();
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - MARKUP_STALLED_MS).toISOString();

  const first = await tx(db, session, async (q): Promise<{ error: MarkupRefusal } | { claimed: Claimed }> => {
    const row = await readDocumentMeta(q, id, { lock: true });
    if (!row) return { error: "not_found" };
    const view = viewOf(row, now, { plan: false });
    if (view.markup.status === "checked") return { error: "already_checked" };
    if (view.markup.status === "marking" && !view.markup.stalled) return { error: "in_progress" };
    if (Number(row.markup_attempts) >= MARKUP_ATTEMPTS_MAX) return { error: "attempt_limit" };
    const match = view.match;
    const language = match?.found && match.driverId ? await readDriverLanguage(q, match.driverId) : null;
    const plan = planMarkup({ mime: view.mime, read: view.read, match }, language ?? "en");
    if (!plan.ok) return { error: plan.reason };
    if (!view.read || !match?.found || !isEditMime(view.mime)) return { error: "not_read" };
    const file = await readDocumentBytes(q, id);
    if (!file || !isEditMime(file.mime)) return { error: "not_found" };
    const original = { mime: file.mime, bytes: bytesOf(file.base64) };
    // The check is the larger call; the edit's one-image reserve meets the cap at its own call.
    const room = await spendRoom("spark", checkRequest(original, row.trace_id), q);
    if (room === "cap" || room === "too_expensive") {
      await markMarkupBudget(q, id, cutoffIso);
      console.error(`documents: markup ${id} waits on the cap: ${room}`);
      return { error: "budget" };
    }
    await lockTenantUploads(q);
    if ((await countRecentMarkups(q, id, nowIso)) >= flags.markupLimits.perTenantPerDay) return { error: "limit" };
    const attempt = await claimMarkup(q, id, { target: plan.target, callout: plan.callout, cutoffIso, nowIso });
    if (attempt === null) return { error: "in_progress" };
    return {
      claimed: {
        lease: { attempt, atIso: nowIso },
        traceId: row.trace_id,
        original,
        planned: { read: view.read, match, plan },
      },
    };
  });
  if ("error" in first) return { ok: false, error: first.error };
  const claimed = first.claimed;

  const ending = await runTry(session, claimed, deps);

  let failure: MarkupFailure | null = ending.kept ? null : ending;
  if (ending.kept) {
    // The copy's own statement; a write that fails (a parameter too large for the database's
    // answer path, a dropped connection) ends the try as unknown below, never as checked.
    try {
      const wrote = await tx(db, session, (q) =>
        finishMarkupChecked(q, id, claimed.lease, {
          mime: ending.copy.mime,
          bytesBase64: base64Of(ending.copy.bytes),
          byteLength: ending.copy.bytes.byteLength,
          hash: sha256(ending.copy.bytes),
          check: ending.check,
          editCallId: ending.editCallId,
          checkCallId: ending.checkCallId,
        }),
      );
      if (wrote !== 1) console.error(`documents: markup ${id} lost its claim before the copy was kept`);
    } catch (err) {
      console.error(`documents: markup ${id} copy write failed error=${(err as Error)?.name ?? "unknown"}`);
      failure = {
        status: "unavailable",
        category: "unknown",
        check: ending.check,
        editCallId: ending.editCallId,
        checkCallId: ending.checkCallId,
        refund: false,
      };
    }
  }

  const view = await tx(db, session, async (q) => {
    if (failure) {
      if ((await finishMarkupFailed(q, id, claimed.lease, failure)) !== 1) {
        console.error(`documents: markup ${id} lost its claim before the try ended`);
      }
    }
    const after = await readDocumentMeta(q, id);
    if (!after) throw new Error("document vanished");
    return viewOf(after, clock());
  });
  console.log(
    `documents: markup ${id} status=${view.markup.status} category=${view.markup.category ?? "none"} attempt=${claimed.lease.attempt}`,
  );
  return { ok: true, view };
}

export async function readMarkupFile(
  session: Session,
  id: string,
  deps: Pick<MarkupDeps, "db"> = {},
): Promise<{ mime: EditMime; bytes: Uint8Array } | null> {
  const db = deps.db ?? getDb();
  const file = await tx(db, session, (q) => readMarkupBytes(q, id));
  if (!file || !isEditMime(file.mime)) return null;
  return { mime: file.mime, bytes: bytesOf(file.base64) };
}
