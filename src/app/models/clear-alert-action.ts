"use server";

import { revalidatePath } from "next/cache";
import { clearSpendAlert } from "@/lib/ai/watch";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";

export type ClearAlertCategory = "invalid" | "not_found" | "forbidden" | "unreadable";

export type ClearAlertState =
  | { ok: true; result: "cleared" | "already_cleared" }
  | { ok: false; category: ClearAlertCategory }
  | null;

// The Clear button on a job the spend watch stopped: a person lets the job run again. Admins only,
// checked inside the carrier's own transaction (clearSpendAlert), where row security also limits
// the alert to this carrier. The alert records who cleared it and when. Categories only come back.
// Signed out: withRequestTenant redirects to /sign-in, and that redirect is rethrown.
export async function clearAlertAction(_prev: ClearAlertState, formData: FormData): Promise<ClearAlertState> {
  const alertId = formData.get("alertId");
  if (typeof alertId !== "string" || !isUuid(alertId)) return { ok: false, category: "invalid" };
  try {
    const result = await withRequestTenant((q, session) => clearSpendAlert(q, session, alertId, null));
    if (result === "not_found") return { ok: false, category: "not_found" };
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof DbError) return { ok: false, category: "unreadable" };
    throw err;
  } finally {
    revalidatePath("/models");
  }
}
