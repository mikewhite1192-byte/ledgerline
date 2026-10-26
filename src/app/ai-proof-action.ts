"use server";

import { revalidatePath } from "next/cache";
import { flags } from "@/config/flags";
import { AiError, complete, type AiErrorCategory } from "@/lib/ai";
import { requireSession } from "@/lib/auth/session";
import { DbError } from "@/lib/db";
import { ForbiddenError } from "@/lib/tenant/context";

export type ProofCategory = AiErrorCategory | "incomplete" | "forbidden" | "unreadable";

export type ProofState =
  | { ok: true; text: string; callId: string }
  | { ok: false; category: ProofCategory }
  | null;

// The model connection check behind the home page button. It returns categories only, never
// upstream text; the reply is shown from this return value and never stored. The ledger rows
// under the button are the read-back, from the database.
export async function proofCallAction(): Promise<ProofState> {
  // The button's own switch, re-checked here; complete() checks aiEnabled itself.
  if (!flags.aiProofRoute) return { ok: false, category: "disabled" };
  const session = await requireSession();
  try {
    const result = await complete(
      "meta",
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
