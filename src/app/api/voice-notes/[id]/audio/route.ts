import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { isCrossSite } from "@/lib/http/same-site";
import { assertMembership } from "@/lib/tenant/context";
import { isUuid } from "@/lib/uuid";
import { failed, voiceOn, voiceRefuse } from "@/lib/voice/http";
import { readVoiceAudio } from "@/lib/voice/read";

// GET: the stored recording for playback on the note's page, for this carrier's members only.
// Never cached; another site may not embed it. One byte range is served as 206, since some
// browsers (Safari) will not play audio from a server that ignores Range. A read that fails
// answers its category, never the error.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

type Wanted = { kind: "all" } | { kind: "part"; start: number; end: number } | { kind: "unsatisfiable" };

// One range, as "bytes=a-b", "bytes=a-" or "bytes=-n". Anything else (several ranges, a
// malformed header, an If-Range this route cannot match, since it sends no validator) gets the
// whole clip, which a server may always send. A well-formed range that starts past the end, or an
// empty suffix, cannot be met.
function wantedRange(request: Request, size: number): Wanted {
  const header = request.headers.get("range");
  if (header === null || request.headers.get("if-range") !== null) return { kind: "all" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "all" };
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix)) return { kind: "all" };
    if (suffix === 0) return { kind: "unsatisfiable" };
    return { kind: "part", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === "" ? null : Number(m[2]);
  if (!Number.isSafeInteger(start) || (last !== null && !Number.isSafeInteger(last))) return { kind: "all" };
  if (last !== null && last < start) return { kind: "all" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "part", start, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

const PRIVATE = {
  "accept-ranges": "bytes",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;

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
    if (!audio || audio.bytes.byteLength === 0) return voiceRefuse("not_found");
    const size = audio.bytes.byteLength;
    const wanted = wantedRange(request, size);
    if (wanted.kind === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...PRIVATE, "content-range": `bytes */${size}` } });
    }
    const [start, end] = wanted.kind === "part" ? [wanted.start, wanted.end] : [0, size - 1];
    const body = new Uint8Array(audio.bytes.subarray(start, end + 1));
    return new Response(body, {
      status: wanted.kind === "part" ? 206 : 200,
      headers: {
        ...PRIVATE,
        "content-type": audio.mime,
        "content-length": String(body.byteLength),
        "content-disposition": "inline",
        ...(wanted.kind === "part" ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  } catch (err) {
    return failed(err, "audio");
  }
}
