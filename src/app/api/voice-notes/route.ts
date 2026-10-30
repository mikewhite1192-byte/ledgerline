import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { staffGate } from "@/lib/auth/staff-gate";
import { isCrossSite } from "@/lib/http/same-site";
import { readCappedForm } from "@/lib/http/multipart";
import { answer, failed, voiceOn, voiceRefuse } from "@/lib/voice/http";
import { voiceMime } from "@/lib/voice/mime";
import { uploadVoiceNote } from "@/lib/voice/pipeline";

// POST: a driver's voice note, as multipart: driverId, wav (16 kHz mono PCM, made in the browser,
// sent to the model and not stored) and original (the clip as recorded, kept for playback,
// optional). Transcribes it and stores the transcript as an untrusted input. The body is read with
// a cap, so an oversized upload is refused before anything is stored. Staff only: a demo visitor
// (the judge role) is refused before the body is read.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

// Room for both files and the form's own boundaries and fields.
const FORM_OVERHEAD = 64 * 1024;

export async function POST(request: Request) {
  if (isCrossSite(request)) return voiceRefuse("forbidden");
  if (!voiceOn()) return voiceRefuse("disabled");
  const session = await getSession();
  if (!session) return voiceRefuse("unauthenticated");
  const notStaff = await staffGate(session);
  if (notStaff) return notStaff;
  const limits = flags.voiceLimits;
  const read = await readCappedForm(request, limits.maxWavBytes + limits.maxOriginalBytes + FORM_OVERHEAD);
  if (!read.ok) return voiceRefuse(read.category);
  const driverId = read.form.get("driverId");
  const wav = read.form.get("wav");
  const original = read.form.get("original");
  if (typeof driverId !== "string" || !(wav instanceof Blob)) return voiceRefuse("bad_request");
  if (original !== null && !(original instanceof Blob)) return voiceRefuse("bad_request");
  // Each part against its own cap before its bytes are copied out of the form.
  if (wav.size > limits.maxWavBytes || (original !== null && original.size > limits.maxOriginalBytes)) {
    return voiceRefuse("too_large");
  }
  try {
    const result = await uploadVoiceNote(session, {
      driverId,
      wav: new Uint8Array(await wav.arrayBuffer()),
      original: original ? { bytes: new Uint8Array(await original.arrayBuffer()), mime: voiceMime(original.type) } : null,
    });
    return answer(result);
  } catch (err) {
    return failed(err, "upload");
  }
}
