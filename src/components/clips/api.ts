import type { RedactionPlan } from "@/lib/clips/redaction";
import type { ClipView } from "@/lib/clips/types";

// The clip routes from the browser. Every answer is a category or the clip; a network failure is
// "unavailable", never a guess.

export type Answer<T> = { ok: true; value: T } | { ok: false; category: string; retryable: boolean };

async function call<T>(url: string, init?: RequestInit): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  } catch {
    return { ok: false, category: "unavailable", retryable: true };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (!response.ok || record.ok !== true) {
    return {
      ok: false,
      category: typeof record.error === "string" ? record.error : "unavailable",
      retryable: record.retryable === true,
    };
  }
  return { ok: true, value: body as T };
}

export const clipUrl = (id: string) => `/api/clips/${encodeURIComponent(id)}`;
// The redacted file, the only video there is.
export const clipFileUrl = (id: string) => `${clipUrl(id)}/file`;

export function uploadRaw(file: File, loadId: string, stop: string) {
  const form = new FormData();
  form.set("file", file);
  form.set("loadId", loadId);
  form.set("stop", stop);
  return call<{ clip: ClipView; plan: RedactionPlan }>("/api/clips", { method: "POST", body: form });
}

export function sendRedacted(id: string, bytes: Uint8Array) {
  return call<{ clip: ClipView }>(`${clipUrl(id)}/redacted`, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: new Blob([bytes.slice().buffer], { type: "video/mp4" }),
  });
}

export function readClip(id: string) {
  return call<{ clip: ClipView }>(`${clipUrl(id)}/read`, { method: "POST" });
}

export function getClip(id: string) {
  return call<{ clip: ClipView; plan: RedactionPlan | null }>(clipUrl(id));
}
