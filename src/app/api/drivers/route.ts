import { bodyAction, refuse } from "@/lib/advances/http";
import { createDriver } from "@/lib/drivers/create";
import { DriverDraft } from "@/lib/drivers/draft";
import { driverAdminOn } from "@/lib/drivers/switch";

// POST: an admin adds a driver (src/lib/drivers/create.ts). The new driver starts not armed and
// with no card. The same driver sent again is code_taken, never a second row. The switch is asked
// here before anything else and again by the service. Nothing is paid or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_PARAMS: Promise<Record<string, string>> = Promise.resolve({});

export async function POST(request: Request) {
  if (!driverAdminOn()) return refuse("disabled");
  return bodyAction(request, NO_PARAMS, DriverDraft, (session, _ids, body) => createDriver(session, body));
}
