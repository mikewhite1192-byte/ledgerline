"use server";

import { revalidatePath } from "next/cache";
import { flags } from "@/config/flags";
import { AiError, complete, type AiErrorCategory } from "@/lib/ai";
import type { Session } from "@/lib/auth/claims";
import { requireStaff } from "@/lib/auth/role";
import { DbError } from "@/lib/db";
import { ForbiddenError, withRequestTenant } from "@/lib/tenant/context";

export type ProofCategory = AiErrorCategory | "incomplete" | "forbidden" | "unreadable";

export type ProofState =
  | { ok: true; text: string; callId: string }
  | { ok: false; category: ProofCategory }
  | null;

// The model connection check behind the home page button. It returns categories only, never
// upstream text; the reply is shown from this return value and never stored. The ledger rows
// under the button are the read-back, from the database. Only a carrier admin may run it: each
// press spends against the one global cap, so staff logins are refused before any reservation.
export async function proofCallAction(): Promise<ProofState> {
  // The button's own switch, re-checked here; complete() checks aiEnabled itself.
  if (!flags.aiProofRoute) return { ok: false, category: "disabled" };
  // Signed out: withRequestTenant redirects to /sign-in, and that redirect is rethrown below. The
  // role is read in its own short transaction, before and outside the model call.
  let session: Session;
  try {
    session = await withRequestTenant(async (q, s) => {
      await requireStaff(q, s);
      const rows = await q.query<{ role: string }>(
        "SELECT role FROM memberships WHERE cognito_sub = $1",
        [s.sub],
      );
      if (rows.length !== 1 || rows[0].role !== "admin") throw new ForbiddenError();
      return s;
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof DbError) return { ok: false, category: "unreadable" };
    throw err;
  }
  try {
    const result = await complete(
      "spark",
      {
        purpose: "proof",
        messages: [
          { role: "system", content: "Reply in one sentence." },
          { role: "user", content: "Say hello to the money desk." },
        ],
        // Reasoning tokens count against this budget, so it leaves room for the reply after them.
        maxOutputTokens: 1024,
        // A paused database can take 25 s to resume; call plus settle must fit the response window.
        timeoutMs: 15_000,
      },
      session,
    );
    if (result.status === "incomplete") return { ok: false, category: "incomplete" };
    return { ok: true, text: result.text, callId: result.callId };
  } catch (err) {
    if (err instanceof AiError) return { ok: false, category: err.category };
    if (err instanceof ForbiddenError) return { ok: false, category: "forbidden" };
    if (err instanceof DbError) return { ok: false, category: "unreadable" };
    throw err;
  } finally {
    revalidatePath("/");
  }
}
