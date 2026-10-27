import { decideRoute } from "@/lib/portal/http";

// POST: a person approves one safety check. A repeat click returns the current state and writes
// nothing.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request, { params }: { params: Promise<{ id: string; checkId: string }> }) {
  return decideRoute(request, params, "approve");
}
