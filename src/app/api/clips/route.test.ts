import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { GET as getOne } from "./[id]/route";
import { GET as getFile } from "./[id]/file/route";
import { POST as postRead } from "./[id]/read/route";
import { PUT as putRedacted } from "./[id]/redacted/route";
import { GET as list, POST as upload } from "./route";

// The clip routes' own checks, before the service: the site, the login, the id, the switch and
// the body. Every refusal is a category with a fixed status; a thrown error never shows its text.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";
const LOAD = "33333333-3333-4333-8333-333333333333";
const CLIP_BYTES = Uint8Array.of(0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70);

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  uploadClip: vi.fn(),
  listClips: vi.fn(),
  getClip: vi.fn(),
  storeRedacted: vi.fn(),
  readClip: vi.fn(),
  readRedactedFile: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
// The staff check has its own tests (src/lib/auth/staff-gate.test.ts); here every caller is staff.
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: async () => null }));
vi.mock("@/lib/clips/service", () => ({
  uploadClip: mocks.uploadClip,
  listClips: mocks.listClips,
  getClip: mocks.getClip,
  storeRedacted: mocks.storeRedacted,
  readClip: mocks.readClip,
  readRedactedFile: mocks.readRedactedFile,
}));

const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const url = (path: string) => `https://app.example/api/clips${path}`;

function form(fields: Record<string, string | Blob>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

function post(body: FormData | string, headers: Record<string, string> = {}) {
  return upload(
    new Request(url(""), { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", ...headers }, body }),
  );
}

const goodForm = () =>
  form({ file: new File([CLIP_BYTES], "dock.mp4", { type: "video/mp4" }), loadId: LOAD, stop: "delivery" });

let logged: string[];

beforeEach(() => {
  flags.clipsEnabled = true;
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getSession.mockResolvedValue(SESSION);
});

afterEach(() => {
  flags.clipsEnabled = false;
  vi.restoreAllMocks();
});

describe("POST /api/clips", () => {
  it("refuses another site, then no session, then the switch off, before reading the body", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const r = await post(goodForm(), { "Sec-Fetch-Site": site });
      expect(r.status, site).toBe(403);
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
    mocks.getSession.mockResolvedValue(null);
    expect((await post(goodForm())).status).toBe(401);
    mocks.getSession.mockResolvedValue(SESSION);
    flags.clipsEnabled = false;
    const off = await post(goodForm());
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "disabled", retryable: false });
    expect(mocks.uploadClip).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a complete form, and one over the size cap", async () => {
    expect((await post("{}", { "content-type": "application/json" })).status).toBe(400);
    expect((await post(form({ loadId: LOAD, stop: "delivery" }))).status).toBe(400);
    expect((await post(form({ file: new File([CLIP_BYTES], "a.mp4"), loadId: "x", stop: "delivery" }))).status).toBe(400);
    // Sent as raw bytes (a FormData body's stream does not take a cancel cleanly in tests).
    const big = new Uint8Array(flags.clipLimits.bytes + 20_000);
    const r = await upload(
      new Request(url(""), {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "content-type": "multipart/form-data; boundary=x" },
        body: big,
      }),
    );
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "too_large", retryable: false });
    expect(mocks.uploadClip).not.toHaveBeenCalled();
  });

  it("passes the file's bytes, load and stop to the service and answers 201", async () => {
    mocks.uploadClip.mockResolvedValue({ ok: true, clip: { id: ID }, plan: null });
    const r = await post(goodForm());
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const [session, input] = mocks.uploadClip.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(input).toMatchObject({ loadId: LOAD, stop: "delivery", filename: "dock.mp4" });
    expect([...input.bytes]).toEqual([...CLIP_BYTES]);
  });

  it("maps refusals to fixed statuses and a thrown error to a 503 with only its name logged", async () => {
    const statuses: [string, number][] = [
      ["limit", 429],
      ["unsupported", 415],
      ["duplicate", 409],
      ["not_found", 404],
    ];
    for (const [category, status] of statuses) {
      mocks.uploadClip.mockResolvedValueOnce({ ok: false, category, retryable: false, clipId: ID });
      const r = await post(goodForm());
      expect(r.status, category).toBe(status);
      expect(await r.json()).toEqual({ error: category, retryable: false, clipId: ID });
    }
    mocks.uploadClip.mockRejectedValueOnce(new Error("connection to 10.0.0.5 refused, key abc"));
    const r = await post(goodForm());
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "unavailable", retryable: true });
    expect(logged.join("\n")).not.toContain("10.0.0.5");
    const forbidden = Object.assign(new Error("not a member"), { name: "ForbiddenError" });
    mocks.uploadClip.mockRejectedValueOnce(forbidden);
    expect((await post(goodForm())).status).toBe(403);
  });
});

describe("GET /api/clips and /api/clips/:id", () => {
  const read = (path: string, site = "same-origin") => new Request(url(path), { headers: { "Sec-Fetch-Site": site } });

  it("refuses another site's read, a bad id and the switch off", async () => {
    expect((await list(read("", "cross-site"))).status).toBe(403);
    expect((await getOne(read(`/${ID}`, "same-site"), params())).status).toBe(403);
    expect((await list(read("?loadId=nope"))).status).toBe(400);
    expect((await getOne(read("/nope"), params("nope"))).status).toBe(400);
    flags.clipsEnabled = false;
    expect((await list(read(""))).status).toBe(409);
    expect((await getOne(read(`/${ID}`), params())).status).toBe(409);
    expect((await getFile(read(`/${ID}/file`), params())).status).toBe(409);
    expect(mocks.listClips).not.toHaveBeenCalled();
    expect(mocks.getClip).not.toHaveBeenCalled();
    expect(mocks.readRedactedFile).not.toHaveBeenCalled();
  });

  it("lists for one load and gets one clip", async () => {
    mocks.listClips.mockResolvedValue({ ok: true, clips: [] });
    expect((await list(read(`?loadId=${LOAD}`))).status).toBe(200);
    expect(mocks.listClips).toHaveBeenCalledWith(SESSION, LOAD);
    mocks.getClip.mockResolvedValue({ ok: false, category: "not_found", retryable: false });
    expect((await getOne(read(`/${ID}`), params())).status).toBe(404);
  });

  it("serves the redacted file as private video with no type sniffing", async () => {
    mocks.readRedactedFile.mockResolvedValue({ ok: true, bytes: CLIP_BYTES });
    const r = await getFile(read(`/${ID}/file`), params());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(r.headers.get("content-length")).toBe(String(CLIP_BYTES.length));
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...CLIP_BYTES]);
  });
});

describe("PUT /api/clips/:id/redacted and POST /api/clips/:id/read", () => {
  const put = (body: BodyInit, type = "video/mp4", site = "same-origin") =>
    putRedacted(
      new Request(url(`/${ID}/redacted`), { method: "PUT", headers: { "content-type": type, "Sec-Fetch-Site": site }, body }),
      params(),
    );
  const readPost = (site = "same-origin", id = ID) =>
    postRead(new Request(url(`/${id}/read`), { method: "POST", headers: { "Sec-Fetch-Site": site } }), params(id));

  it("takes only video/mp4 under the cap, from this site, with the switch on", async () => {
    expect((await put(CLIP_BYTES, "video/mp4", "cross-site")).status).toBe(403);
    expect((await put(CLIP_BYTES, "application/octet-stream")).status).toBe(400);
    expect((await put(new Uint8Array(flags.clipLimits.bytes + 1))).status).toBe(413);
    flags.clipsEnabled = false;
    expect((await put(CLIP_BYTES)).status).toBe(409);
    expect(mocks.storeRedacted).not.toHaveBeenCalled();
    flags.clipsEnabled = true;
    mocks.storeRedacted.mockResolvedValue({ ok: false, category: "unchanged", retryable: false });
    expect((await put(CLIP_BYTES)).status).toBe(422);
    mocks.storeRedacted.mockResolvedValue({ ok: false, category: "store_failed", retryable: true });
    const failedStore = await put(CLIP_BYTES);
    expect(failedStore.status).toBe(503);
    expect(await failedStore.json()).toEqual({ error: "store_failed", retryable: true });
    expect([...mocks.storeRedacted.mock.calls[0][2]]).toEqual([...CLIP_BYTES]);
  });

  it("reads only from this site, with a valid id and the switch on", async () => {
    expect((await readPost("none")).status).toBe(403);
    expect((await readPost("same-origin", "nope")).status).toBe(400);
    flags.clipsEnabled = false;
    expect((await readPost()).status).toBe(409);
    expect(mocks.readClip).not.toHaveBeenCalled();
    flags.clipsEnabled = true;
    mocks.readClip.mockResolvedValue({ ok: false, category: "budget", retryable: true });
    expect((await readPost()).status).toBe(409);
    expect(mocks.readClip).toHaveBeenCalledWith(SESSION, ID);
  });
});
