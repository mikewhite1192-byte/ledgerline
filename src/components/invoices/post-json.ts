// One same-site POST from an invoice screen. A network failure or an unreadable reply is
// "unavailable": the screen says it did not go through and reads the page back.
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
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>;
    } catch {
      // An empty or non-JSON reply carries no category.
    }
    const error = typeof data.error === "string" ? data.error : res.ok ? null : "unavailable";
    return { ok: res.ok, error, data };
  } catch {
    return { ok: false, error: "unavailable", data: {} };
  }
}
