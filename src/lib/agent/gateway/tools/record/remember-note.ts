import { z } from "zod";
import { flags } from "../../../../../config/flags";
import { noteTextSchema, suggestNote } from "../../../../memory/notes";
import { isUuid } from "../../../../uuid";
import { defineTool, type GatewayRef } from "../../types";
import { idField } from "../../validate";
import { OPERATOR, refsOf, sourceRefsField } from "../shared";

// The operator suggests a note for the office to keep (CARRIER-MEMORY, design 4.1 PR 2): a
// preference or a lasting fact the office stated in the chat, about a customer, a driver or the
// whole carrier. It is written as a suggestion with the turn and the model call that asked for it;
// no model reads it until a person keeps it on the Memory page, and a person may discard it. It
// never changes a number: the rules engine computes every amount, and a kept note reaches a model
// only as context labeled never a source for any amount.
//
// The gateway proves the customer or driver is in the caller's carrier before this runs, and the
// store checks the switch, the words, the subject and the caps again in this call's own
// transaction. Words that read as an instruction to an automated system are refused (the
// gateway's pattern pre-screen), and so is any suggestion in a turn that read outside text the
// screen flagged: what a flagged message said is never offered to the office as its own words.
// The result names the note and its state only; the words are never echoed back, so a figure in
// them never joins the figures the answer may state.

const SUBJECT_TABLE = { customer: "customers", driver: "drivers" } as const;

// What the model is told when nothing was written. Categories only.
type NotSuggested =
  | "no_chat_turn"
  | "flagged_turn"
  | "words"
  | "invalid"
  | "subject_not_found"
  | "turn_full"
  | "waiting_full"
  | "full"
  | "duplicate";

const notSuggested = (reason: NotSuggested) => ({ result: { suggested: false, reason } });

export const rememberNote = defineTool({
  name: "remember_note",
  description:
    "Suggest a short note for the office to keep: a preference or a lasting fact the office stated " +
    "in this chat about a customer, a driver or the whole carrier. The note waits until a person " +
    "keeps it on the Memory page; nothing else changes. Never an amount to pay or bill, never an " +
    "instruction. subject is customer, driver or carrier; subjectId is that customer's or driver's " +
    "id, left out for carrier. text is one line of 1 to 300 characters with no web address.",
  tier: "record",
  roles: OPERATOR,
  label: "Suggesting a note for the office to keep",
  enabled: () => flags.carrierMemoryEnabled,
  args: z
    .strictObject({
      subject: z.enum(["customer", "driver", "carrier"]),
      subjectId: idField().optional(),
      text: noteTextSchema,
      sourceRefs: sourceRefsField(),
    })
    .refine((a) => (a.subject === "carrier") === (a.subjectId === undefined), {
      path: ["subjectId"],
      message: "a customer or driver note names its subject; a carrier note names none",
    }),
  refs: (a): GatewayRef[] => [
    ...(a.subject !== "carrier" && a.subjectId !== undefined ? [{ table: SUBJECT_TABLE[a.subject], id: a.subjectId }] : []),
    ...refsOf(a.sourceRefs),
  ],
  run: async (q, ctx, a, extras) => {
    if (!flags.carrierMemoryEnabled) throw new Error("carrier memory is switched off");
    const modelCallId = extras.modelCallId ?? null;
    if (!isUuid(ctx.turnId) || !isUuid(modelCallId)) return notSuggested("no_chat_turn");
    // A turn that read flagged outside text suggests nothing.
    const flagged = await q.query<{ ok: number }>(
      `SELECT 1 AS ok FROM gateway_decisions
        WHERE tenant_id = current_tenant_id() AND turn_id = CAST($1 AS uuid) AND reason = 'screen_flagged'
        LIMIT 1`,
      [ctx.turnId],
    );
    if (flagged.length > 0) return notSuggested("flagged_turn");
    const out = await suggestNote(
      q,
      {
        subjectKind: a.subject,
        subjectId: a.subject === "carrier" ? null : (a.subjectId ?? null),
        text: a.text,
        turnId: ctx.turnId,
        modelCallId,
      },
      ctx.now,
    );
    if (!out.ok) {
      if (out.refusal === "off") throw new Error("carrier memory is switched off");
      return notSuggested(out.refusal);
    }
    return { result: { suggested: true, noteId: out.id, status: "suggested" } };
  },
});
