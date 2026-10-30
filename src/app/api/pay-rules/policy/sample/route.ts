import { z } from "zod";
import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { isCrossSite } from "@/lib/http/same-site";
import { startPolicyRun } from "@/lib/policy-onboard/run";
import { SAMPLE_POLICY_PDFS } from "@/lib/policy-onboard/samples.generated";
import { failure, refused, reply } from "../reply";

// POST {name}: start a run on one of this repo's own sample policies (synthetic documents for
// invented carriers, generated from src/lib/seed/policy). The same run as an upload, from bytes
// the server already holds, so a demo needs no file on hand.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const SAMPLE_NAMES = ["harrow-flats-pay-policy", "cedar-bend-pay-policy"] as const;

const Body = z.strictObject({ name: z.enum(SAMPLE_NAMES) });

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.policyOnboardEnabled) return refused("disabled");
  let name: (typeof SAMPLE_NAMES)[number];
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return reply({ error: "bad_request" }, 400);
    name = parsed.data.name;
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  const base64 = SAMPLE_POLICY_PDFS[name];
  if (base64 === undefined) return refused("not_found");
  try {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    const outcome = await startPolicyRun(session, { name: `${name}.pdf`, type: "application/pdf", bytes });
    if (!outcome.ok) return refused(outcome.error);
    return reply({ turnId: outcome.turnId, documentId: outcome.documentId }, 201);
  } catch (err) {
    return failure("sample", err);
  }
}
