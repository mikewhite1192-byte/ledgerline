import { flags } from "@/config/flags";
import { getSession } from "@/lib/auth/session";
import { listClips, uploadClip } from "@/lib/clips/service";
import { isCrossSite } from "@/lib/http/same-site";
import { isUuid } from "@/lib/uuid";
import { failed, isForeignRead, readCapped, refuse, reply } from "./reply";

// POST: a dock clip upload (multipart: file, loadId, stop). The raw file lives only in this
// request: the reply is the clip and the redaction plan the browser blurs from. GET: the carrier's
// clips, newest first, optionally for one load (?loadId=). Categories only in every reply.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Room for the multipart framing and the two text fields around the file.
const FORM_OVERHEAD_BYTES = 16_384;

export async function POST(request: Request) {
  if (isCrossSite(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  if (!flags.clipsEnabled) return refuse({ ok: false, category: "disabled", retryable: false });
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) return reply({ error: "bad_request" }, 400);
  const body = await readCapped(request, flags.clipLimits.bytes + FORM_OVERHEAD_BYTES);
  if (!body) return refuse({ ok: false, category: "too_large", retryable: false });
  let file: FormDataEntryValue | null;
  let loadId: FormDataEntryValue | null;
  let stop: FormDataEntryValue | null;
  try {
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    file = form.get("file");
    loadId = form.get("loadId");
    stop = form.get("stop");
  } catch {
    return reply({ error: "bad_request" }, 400);
  }
  if (!(file instanceof Blob) || typeof loadId !== "string" || typeof stop !== "string" || !isUuid(loadId)) {
    return reply({ error: "bad_request" }, 400);
  }
  try {
    const result = await uploadClip(session, {
      loadId,
      stop,
      filename: file instanceof File ? file.name : "clip.mp4",
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return result.ok ? reply(result, 201) : refuse(result);
  } catch (err) {
    return failed("upload", err);
  }
}

export async function GET(request: Request) {
  if (isForeignRead(request)) return reply({ error: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "unauthenticated" }, 401);
  const loadId = new URL(request.url).searchParams.get("loadId");
  if (loadId !== null && !isUuid(loadId)) return reply({ error: "bad_request" }, 400);
  if (!flags.clipsEnabled) return refuse({ ok: false, category: "disabled", retryable: false });
  try {
    const result = await listClips(session, loadId);
    return result.ok ? reply(result, 200) : refuse(result);
  } catch (err) {
    return failed("list", err);
  }
}
