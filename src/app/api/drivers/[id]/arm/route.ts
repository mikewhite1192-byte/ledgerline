import { z } from "zod";
import { armDriver } from "@/lib/advances/arming";
import { bodyAction } from "@/lib/advances/http";

// POST: an admin arms or disarms a driver to receive money (src/lib/advances/arming.ts). The
// same state again is no change. Nothing is paid or sent.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.strictObject({ armed: z.boolean(), note: z.string().max(240).optional() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return bodyAction(request, params, Body, (session, ids, body) =>
    armDriver(session, ids.id, { armed: body.armed, note: body.note ?? null }),
  );
}
