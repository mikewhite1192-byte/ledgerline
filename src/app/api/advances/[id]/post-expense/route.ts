import { postAdvanceExpense } from "@/lib/advances/post-expense";
import { advanceAction } from "@/lib/advances/http";

// POST: posts a paid advance to the QuickBooks sandbox when the accounting switch is on
// (src/lib/advances/post-expense.ts).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return advanceAction(request, params, (session, id) => postAdvanceExpense(session, id));
}
