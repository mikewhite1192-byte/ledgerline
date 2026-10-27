import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { assertMembership } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import { failed, voiceOn, voiceRefuse } from "@/lib/voice/http";
import { readVoiceAudio } from "@/lib/voice/read";

// GET: the stored recording for playback on the note's page, for this carrier's members only.
// Never cached; another site may not embed it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSite(request)) return voiceRefuse("forbidden");
  if (!voiceOn()) return voiceRefuse("disabled");
  const session = await getSession();
  if (!session) return voiceRefuse("unauthenticated");
  const { id } = await params;
  if (!isUuid(id)) return voiceRefuse("bad_request");
  try {
    const audio = await getDb().withTenant(session.tenantId, async (q) => {
      await assertMembership(q, session);
      return readVoiceAudio(q, id);
    });
    if (!audio) return voiceRefuse("not_found");
    return new Response(new Uint8Array(audio.bytes), {
      status: 200,
      headers: {
        "content-type": audio.mime,
        "content-length": String(audio.bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": "inline",
      },
    });
  } catch (err) {
    return failed(err, "audio");
  }
}
