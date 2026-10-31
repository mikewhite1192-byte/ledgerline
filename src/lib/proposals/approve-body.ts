import { z } from "zod";
import { OVERRIDE_REASON } from "../agent/auditor/words";
import type { ApproveOptions } from "./execute";

// A pay_policy_setup card's edits: at most one per rule (13 rules), each a rule key and a value
// in the stored form ("null", a code, or whole cents or basis points). The executor parses each
// with the rule's own parser; this only bounds the shape. A card_load_ruling card's edit is one
// key, ruling, with a whole value its executor checks (owes_nothing or deficit).
const EDIT_KEY = /^[a-z][a-z_]{2,39}$/;
const EDIT_VALUE = /^(null|[a-z_]{2,40}|\d{1,9})$/;
const EDITS_MAX = 13;
const Edits = z
  .record(z.string().regex(EDIT_KEY), z.string().regex(EDIT_VALUE))
  .refine((e) => Object.keys(e).length <= EDITS_MAX);

// The approve request's body, read strictly. An override reason is trimmed and must then be 10 to
// 240 characters; auditedAt must be an ISO instant. Anything else is a bad request, so a reason
// out of range never reaches the gate (which checks it again).
const Body = z.strictObject({
  confirmed: z.boolean().optional(),
  overrideReason: z.string().trim().min(OVERRIDE_REASON.min).max(OVERRIDE_REASON.max).optional(),
  auditedAt: z.iso.datetime({ offset: true, precision: 3 }).optional(),
  edits: Edits.optional(),
});

export function parseApproveBody(text: string): ApproveOptions | null {
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return null;
  const opts: ApproveOptions = {
    confirmed: parsed.data.confirmed === true,
    overrideReason: parsed.data.overrideReason ?? null,
    auditedAt: parsed.data.auditedAt ?? null,
  };
  if (parsed.data.edits !== undefined) opts.edits = parsed.data.edits;
  return opts;
}
