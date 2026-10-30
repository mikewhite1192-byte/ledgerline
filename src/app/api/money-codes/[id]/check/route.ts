import { checkPendingCode } from "@/lib/money-codes/execute";
import { codeAction } from "@/lib/money-codes/http";

// POST: Check pending. Reads back this code's open payment records by their stored request ids
// and finishes a code found issued (its two paystub lines and, for a lumper, the invoice line,
// once each); never asks for a new code.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return codeAction(request, params, (session, id) => checkPendingCode(session, id));
}
