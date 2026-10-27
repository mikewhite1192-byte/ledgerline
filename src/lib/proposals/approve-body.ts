import { z } from "zod";
import { OVERRIDE_REASON } from "../agent/auditor/words";
import type { ApproveOptions } from "./execute";

// The approve request's body, read strictly. An override reason is trimmed and must then be 10 to
// 240 characters; auditedAt must be an ISO instant. Anything else is a bad request, so a reason
// out of range never reaches the gate (which checks it again).
const Body = z.strictObject({
  confirmed: z.boolean().optional(),
  overrideReason: z.string().trim().min(OVERRIDE_REASON.min).max(OVERRIDE_REASON.max).optional(),
  auditedAt: z.iso.datetime({ offset: true, precision: 3 }).optional(),
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
  return {
    confirmed: parsed.data.confirmed === true,
    overrideReason: parsed.data.overrideReason ?? null,
    auditedAt: parsed.data.auditedAt ?? null,
  };
}
