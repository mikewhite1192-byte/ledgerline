import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { callAnswer, callFailed, callRefuse, phoneOn } from "@/lib/calls/http";
import { receiveSegment } from "@/lib/calls/pipeline";
import { isCrossSite } from "@/lib/http/same-site";
import { readCappedForm } from "@/lib/http/multipart";
import { isUuid } from "@/lib/uuid";

// POST: one segment of a call, as multipart: seq (its place, from 0), offsetMs (where it starts in
// the call), driverId and wav (16 kHz mono PCM, made in the browser, sent to the model and never
// stored). The first segment opens the call under the id in the path. Transcribes the segment,
// screens it and reads a case update per turn; an advance request or pay question is handed to the
// agent, which proposes, and a person approves. A re-sent segment answers what it stored. The body
// is read with a cap, so an oversized segment is refused before anything is stored. Staff only: a
// demo visitor (the judge role) is refused before the body is read.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// Room for the form's own boundaries and fields.
const FORM_OVERHEAD = 64 * 1024;
const PLACE = /^(0|[1-9][0-9]{0,6})$/;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return callRefuse("forbidden");
  if (!phoneOn()) return callRefuse("disabled");
  const session = await getSession();
  if (!session) return callRefuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const { id } = await params;
  if (!isUuid(id)) return callRefuse("bad_request");
  const limits = flags.phoneLineLimits;
  const read = await readCappedForm(request, limits.maxSegmentBytes + FORM_OVERHEAD);
  if (!read.ok) return callRefuse(read.category);
  const seq = read.form.get("seq");
  const offsetMs = read.form.get("offsetMs");
  const driverId = read.form.get("driverId");
  const wav = read.form.get("wav");
  if (typeof seq !== "string" || !PLACE.test(seq)) return callRefuse("bad_request");
  if (typeof offsetMs !== "string" || !PLACE.test(offsetMs)) return callRefuse("bad_request");
  if (typeof driverId !== "string" || !(wav instanceof Blob)) return callRefuse("bad_request");
  // The part against its own cap before its bytes are copied out of the form.
  if (wav.size > limits.maxSegmentBytes) return callRefuse("too_large");
  try {
    const result = await receiveSegment(session, {
      callId: id,
      seq: Number(seq),
      offsetMs: Number(offsetMs),
      driverId,
      wav: new Uint8Array(await wav.arrayBuffer()),
    });
    return callAnswer(result);
  } catch (err) {
    return callFailed(err, "segment");
  }
}
