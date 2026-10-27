// A multipart form read with a size cap: the declared length is checked first, then the body is
// counted as it arrives and dropped the moment it passes the cap, so an oversized upload is never
// held in memory whole and nothing of it is stored.

export type FormRead = { ok: true; form: FormData } | { ok: false; category: "too_large" | "bad_request" };

export async function readCappedForm(request: Request, maxBytes: number): Promise<FormRead> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) return { ok: false, category: "bad_request" };
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, category: "too_large" };
  }
  if (!request.body) return { ok: false, category: "bad_request" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, category: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, category: "bad_request" };
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    const form = await new Response(all, { headers: { "content-type": type } }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, category: "bad_request" };
  }
}
