import { z } from "zod";
import { flags } from "../../../../../config/flags";
import type { Queryable } from "../../../../db";
import { cents, MONEY_CODE_PURPOSES, type MoneyCodeSource } from "../../../../rules-engine";
import { moneyCodeLimit } from "../../limits";
import { readDocumentForInput } from "../../store/document-reads";
import { defineTool, type GatewayRef, type LimitResult } from "../../types";
import { idField } from "../../validate";
import { OPERATOR } from "../shared";
import { VOICE_NOTE_SQL } from "../read/get-voice-note";

// Propose a one-time money code for a lumper or a repair at the dock. The evidence is named by
// the outside input it came through (the receipt photo or the voice note's transcript), the same
// id get_document and get_voice_note take (they screen it; this tool shows no model its text).
// The limit runs the rules engine as of now on that evidence and refuses any other amount;
// nothing is issued until a person approves the card.

type Evidence = { source: MoneyCodeSource; documentId: string | null; voiceNoteId: string | null };

// The evidence behind an input id. null: the input names no receipt or voice note this tool can
// use (another kind of input, or one not read yet), refused as evidence_missing.
async function evidenceOf(q: Queryable, inputId: string | undefined): Promise<Evidence | null> {
  if (inputId === undefined) return { source: "chat", documentId: null, voiceNoteId: null };
  const kinds = await q.query<{ kind: string }>(
    "SELECT kind FROM untrusted_inputs WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)",
    [inputId],
  );
  const kind = kinds[0]?.kind;
  if (kind === "document") {
    const doc = await readDocumentForInput(q, inputId);
    return doc ? { source: "document", documentId: doc.id, voiceNoteId: null } : null;
  }
  if (kind === "transcript") {
    const notes = await q.query<{ id: string }>(VOICE_NOTE_SQL, [inputId]);
    return notes.length === 1 ? { source: "voice_note", documentId: null, voiceNoteId: notes[0].id } : null;
  }
  return null;
}

export const proposeMoneyCode = defineTool({
  name: "propose_money_code",
  description:
    "Propose a one-time money code a driver gives a lumper or a repair shop, for a person to " +
    "approve. Nothing is issued by this call. Read the receipt (get_document) or the voice note " +
    "(get_voice_note) first, then propose exactly that total, in integer cents, on the driver's " +
    "load that is on the road or delivered in the last three days. inputId is the receipt's or " +
    "the voice note's input id; leave it out only when the driver named the amount in this chat. " +
    "A refusal returns a category; ask the driver for what it names instead of changing the amount.",
  tier: "propose",
  roles: OPERATOR,
  label: "Checking the money code",
  enabled: () => flags.moneyCodes.enabled,
  args: z.strictObject({
    driverId: idField(),
    loadId: idField(),
    amountCents: z.int().positive().max(100_000_000),
    purpose: z.enum(MONEY_CODE_PURPOSES),
    inputId: idField().optional(),
  }),
  refs: (a): GatewayRef[] => [
    { table: "drivers", id: a.driverId },
    { table: "loads", id: a.loadId },
    ...(a.inputId ? [{ table: "untrusted_inputs" as const, id: a.inputId }] : []),
  ],
  limit: async (q, ctx, a): Promise<LimitResult> => {
    const evidence = await evidenceOf(q, a.inputId);
    if (!evidence) {
      return {
        ok: false,
        reason: "engine_refused",
        limitCents: cents(flags.moneyCodes.capCents),
        requestedCents: cents(a.amountCents),
        category: "evidence_missing",
      };
    }
    return moneyCodeLimit(q, ctx, {
      driverId: a.driverId,
      loadId: a.loadId,
      amountCents: a.amountCents,
      purpose: a.purpose,
      inputId: a.inputId ?? null,
      ...evidence,
    });
  },
  run: async (q, _ctx, a, extras) => {
    if (!flags.moneyCodes.enabled) throw new Error("money codes are switched off");
    const limit = extras.limit;
    if (!limit) throw new Error("a proposal needs its limit");
    // The evidence again in this call's own transaction: the draft stores these ids, and the
    // executor checks them again at approval.
    const evidence = await evidenceOf(q, a.inputId);
    if (!evidence) throw new Error("the money code's evidence changed after its limit");
    const draft = {
      kind: "money_code" as const,
      subjectTable: "loads" as const,
      subjectId: a.loadId,
      amountCents: cents(a.amountCents),
      args: {
        driverId: a.driverId,
        loadId: a.loadId,
        amountCents: a.amountCents,
        purpose: a.purpose,
        source: evidence.source,
        documentId: evidence.documentId,
        voiceNoteId: evidence.voiceNoteId,
        inputId: a.inputId ?? null,
      },
      limitCents: limit.limitCents,
      exceptions: limit.exceptions,
      reasons: limit.reasons,
      sources: limit.sources,
    };
    return {
      result: {
        proposed: true,
        kind: draft.kind,
        driverId: a.driverId,
        loadId: a.loadId,
        amountCents: draft.amountCents,
        purpose: a.purpose,
        limitCents: draft.limitCents,
        note: "A person must approve this before any code is issued.",
      },
      draft,
    };
  },
});
