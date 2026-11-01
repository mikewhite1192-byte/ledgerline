import { bodyAction, refuse } from "@/lib/advances/http";
import { setDriverStatus, StatusBody } from "@/lib/drivers/status";
import { driverAdminOn } from "@/lib/drivers/switch";

// POST: an admin deactivates or reactivates a driver (src/lib/drivers/status.ts). Deactivating
// also disarms; reactivating never arms. The same state again is no change. The switch is asked
// here before anything else and again by the service. Nothing is paid or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!driverAdminOn()) return refuse("disabled");
  return bodyAction(request, params, StatusBody, (session, ids, body) =>
    setDriverStatus(session, ids.id, {
      active: body.active,
      effectiveOn: body.effectiveOn ?? null,
      note: body.note ?? null,
    }),
  );
}
