// One same-site POST from an invoice screen. Once a request is out, the server may have done the
// work even when its reply is lost, so a request that throws, a server error (5xx) with no
// readable category, and a success whose reply cannot be read are all "unknown": the screen says
// the outcome is not known yet and reads the page back, never that nothing changed. Any other
// refusal with no readable category is "unavailable".
export type PostReply = { ok: boolean; error: string | null; data: Record<string, unknown> };

export async function postJson(url: string, body?: unknown): Promise<PostReply> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    let data: Record<string, unknown> = {};
    let readable = false;
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
        readable = true;
      }
    } catch {
      // An empty or non-JSON reply carries no category.
    }
    const error =
      typeof data.error === "string"
        ? data.error
        : res.ok
          ? readable
            ? null
            : "unknown"
          : res.status >= 500
            ? "unknown"
            : "unavailable";
    return { ok: res.ok, error, data };
  } catch {
    return { ok: false, error: "unknown", data: {} };
  }
}
