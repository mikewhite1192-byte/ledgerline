import { z } from "zod";
import { refuse, reply } from "@/lib/advances/http";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { requestMoneyCode } from "@/lib/money-codes/request";
import { moneyCodesOn } from "@/lib/money-codes/switches";
import { MONEY_CODE_PURPOSES } from "@/lib/rules-engine";

// POST: Request a code. A load (its driver comes with it), the amount in integer cents, the
// purpose and, optionally, a receipt already read. The pay rules check it as of now; a passing
// request becomes one card waiting on the Money codes page. No model runs and nothing is issued
// until a person approves the card.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

const Body = z.strictObject({
  loadId: z.uuid(),
  amountCents: z.int().positive().max(100_000_000),
  purpose: z.enum(MONEY_CODE_PURPOSES),
  documentId: z.uuid().nullable().optional(),
});

export async function POST(request: Request) {
  if (isCrossSite(request)) return refuse("forbidden");
  if (!moneyCodesOn()) return refuse("disabled");
  const session = await getSession();
  if (!session) return refuse("unauthenticated");
  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return refuse("bad_request");
    body = parsed.data;
  } catch {
    return refuse("bad_request");
  }
  try {
    const result = await requestMoneyCode(session, {
      loadId: body.loadId,
      amountCents: body.amountCents,
      purpose: body.purpose,
      documentId: body.documentId ?? null,
    });
    if (result.ok) return reply(result, 200);
    return refuse(result.category, result.retryable);
  } catch (err) {
    if (err instanceof Error && err.name === "ForbiddenError") return refuse("forbidden");
    console.error("money code request failed:", err instanceof Error ? err.name : "unknown");
    return refuse("unavailable", true);
  }
}
