import { describe, expect, it } from "vitest";
import { readCappedForm } from "./multipart";

// The capped multipart read: a declared length past the cap is refused unread, a body that grows
// past it is dropped mid-stream, and anything that is not a well-formed form is a bad request.

function formRequest(form: FormData, headers: Record<string, string> = {}): Promise<Request> {
  const encoded = new Response(form);
  return encoded.arrayBuffer().then(
    (body) =>
      new Request("https://app.example/api/voice-notes", {
        method: "POST",
        headers: { "content-type": encoded.headers.get("content-type") ?? "", ...headers },
        body,
      }),
  );
}

function streamed(type: string, parts: Uint8Array[]): { request: Request; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts[pulled];
      pulled += 1;
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  const request = new Request("https://app.example/api/voice-notes", {
    method: "POST",
    headers: { "content-type": type },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, pulled: () => pulled };
}

describe("readCappedForm", () => {
  it("reads a form under the cap", async () => {
    const form = new FormData();
    form.set("driverId", "d-1");
    form.set("wav", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "clip.wav");
    const read = await readCappedForm(await formRequest(form), 10_000);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.form.get("driverId")).toBe("d-1");
    const wav = read.form.get("wav");
    expect(wav).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (wav as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses a declared length past the cap without reading the body", async () => {
    const form = new FormData();
    form.set("wav", new Blob([new Uint8Array(100)]), "clip.wav");
    const request = await formRequest(form, { "content-length": "999999" });
    expect(await readCappedForm(request, 1_000)).toEqual({ ok: false, category: "too_large" });
    expect(request.bodyUsed).toBe(false);
  });

  it("drops a body that grows past the cap, whatever length it declared", async () => {
    const chunk = new Uint8Array(400);
    const { request, pulled } = streamed("multipart/form-data; boundary=x", [chunk, chunk, chunk, chunk, chunk, chunk]);
    expect(await readCappedForm(request, 1_000)).toEqual({ ok: false, category: "too_large" });
    expect(pulled()).toBeLessThan(6);
  });

  it("refuses anything that is not a multipart form", async () => {
    const json = new Request("https://app.example/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await readCappedForm(json, 1_000)).toEqual({ ok: false, category: "bad_request" });
    const noBoundary = new Request("https://app.example/x", { method: "POST", headers: { "content-type": "multipart/form-data" }, body: "x" });
    expect(await readCappedForm(noBoundary, 1_000)).toEqual({ ok: false, category: "bad_request" });
    const broken = streamed("multipart/form-data; boundary=x", [new TextEncoder().encode("not a form at all")]);
    expect(await readCappedForm(broken.request, 1_000)).toEqual({ ok: false, category: "bad_request" });
  });
});
