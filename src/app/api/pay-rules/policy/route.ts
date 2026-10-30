import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { startPolicyRun } from "@/lib/policy-onboard/run";
import { failure, refused, reply } from "./reply";

// POST: start setting up pay rules from a pay policy document (multipart, one field named
// "file", a PDF). It stores the file and opens the run; nothing is read with a model here (each
// stage runs on its own request to the run's route). Staff only, so a demo visitor (the judge role)
// is refused before the body is read. Behind flags.policyOnboardEnabled, read here and again inside
// the run.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// Room for the multipart framing around the largest file allowed.
const FORM_OVERHEAD_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  if (!flags.policyOnboardEnabled) return refused("disabled");
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0) return reply({ error: "bad_request" }, 400);
  if (length > flags.policyLimits.maxBytes + FORM_OVERHEAD_BYTES) return refused("too_large");
  let file: File;
  try {
    const form = await request.formData();
    const entries = form.getAll("file");
    if (entries.length !== 1 || typeof entries[0] === "string") return reply({ error: "bad_request" }, 400);
    file = entries[0];
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  if (file.size > flags.policyLimits.maxBytes) return refused("too_large");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const outcome = await startPolicyRun(session, { name: file.name, type: file.type, bytes });
    if (!outcome.ok) return refused(outcome.error);
    return reply({ turnId: outcome.turnId, documentId: outcome.documentId }, 201);
  } catch (err) {
    return failure("start", err);
  }
}
