import { revealMoneyCode } from "@/lib/money-codes/execute";
import { codeAction } from "@/lib/money-codes/http";

// POST: Reveal. Answers with an issued, unexpired code's digits for staff to read to the driver.
// Any member of the carrier may ask; each ask is logged with who and when, never the code. The
// reply is never cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return codeAction(request, params, (session, id) => revealMoneyCode(session, id));
}
