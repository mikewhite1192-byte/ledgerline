import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { GET as FILE } from "./[id]/file/route";
import { POST as READ_AGAIN } from "./[id]/read/route";
import { GET, POST } from "./route";

// The document routes' own checks, in order, with the session and the service faked: a
// cross-site post is refused before the session is read, then the login, the switch, the size
// and the form, each before anything is stored. Replies carry categories only.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const ID = "22222222-2222-4222-8222-222222222222";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  uploadDocument: vi.fn(),
  listDocuments: vi.fn(),
  readDocumentFile: vi.fn(),
  readAgain: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/documents/service", () => ({
  uploadDocument: mocks.uploadDocument,
  listDocuments: mocks.listDocuments,
  readDocumentFile: mocks.readDocumentFile,
  readAgain: mocks.readAgain,
}));

async function upload(opts: { site?: string; files?: File[]; extra?: Record<string, string>; length?: string } = {}) {
  const form = new FormData();
  for (const f of opts.files ?? [new File([PNG], "receipt.png", { type: "image/png" })]) form.append("file", f);
  for (const [k, v] of Object.entries(opts.extra ?? {})) form.append(k, v);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  const headers: Record<string, string> = {
    "content-type": encoded.headers.get("content-type") ?? "",
    "content-length": opts.length ?? String(body.byteLength),
  };
  if (opts.site) headers["Sec-Fetch-Site"] = opts.site;
  return POST(new Request("https://app.example/api/documents", { method: "POST", headers, body }));
}

const VIEW = {
  id: ID,
  inputId: "33333333-3333-4333-8333-333333333333",
  readStatus: "read",
  kind: "toll_receipt",
  match: { found: false, reason: "no_record" },
};

const saved = flags.documentsEnabled;
beforeEach(() => {
  flags.documentsEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.uploadDocument.mockReset().mockResolvedValue({ ok: true, view: VIEW, duplicate: false });
  mocks.listDocuments.mockReset().mockResolvedValue([]);
  mocks.readDocumentFile.mockReset();
  mocks.readAgain.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  flags.documentsEnabled = saved;
  vi.restoreAllMocks();
});

describe("POST /api/documents", () => {
  it("refuses a cross-site post before reading the session", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await upload({ site });
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await upload({ site: "same-origin" });
    expect(res.status).toBe(401);
    expect(mocks.uploadDocument).not.toHaveBeenCalled();
  });

  it("answers not found while the switch is off", async () => {
    flags.documentsEnabled = false;
    const res = await upload();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "disabled" });
    expect(mocks.uploadDocument).not.toHaveBeenCalled();
  });

  it("refuses a body with no length or a length past the limit before reading it", async () => {
    expect((await upload({ length: "" })).status).toBe(400);
    const res = await upload({ length: String(flags.documentLimits.maxBytes + 64 * 1024) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(mocks.uploadDocument).not.toHaveBeenCalled();
  });

  it("refuses a form without exactly one file", async () => {
    const two = [new File([PNG], "a.png", { type: "image/png" }), new File([PNG], "b.png", { type: "image/png" })];
    expect((await upload({ files: two })).status).toBe(400);
    expect((await upload({ files: [], extra: { file: "text" } })).status).toBe(400);
    expect(mocks.uploadDocument).not.toHaveBeenCalled();
  });

  it("passes the file to the service and answers with the view, never the bytes", async () => {
    const res = await upload({ site: "same-origin" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ...VIEW, duplicate: false });
    const [session, file] = mocks.uploadDocument.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(file).toMatchObject({ name: "receipt.png", type: "image/png" });
    expect([...file.bytes]).toEqual([...PNG]);
  });

  it("answers 200 for a file already held", async () => {
    mocks.uploadDocument.mockResolvedValue({ ok: true, view: VIEW, duplicate: true });
    const res = await upload();
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(true);
  });

  it("maps each refusal to its status", async () => {
    const cases: [string, number][] = [
      ["too_large", 413],
      ["unsupported", 415],
      ["too_many_pages", 422],
      ["limit", 429],
    ];
    for (const [error, status] of cases) {
      mocks.uploadDocument.mockResolvedValue({ ok: false, error });
      const res = await upload();
      expect(res.status, error).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it("answers a thrown error as unavailable, and a non-member as forbidden, with no raw text", async () => {
    mocks.uploadDocument.mockRejectedValue(new Error("connection string with a password"));
    let res = await upload();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("password");
    const forbidden = new Error("not a member");
    forbidden.name = "ForbiddenError";
    mocks.uploadDocument.mockRejectedValue(forbidden);
    res = await upload();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

describe("GET /api/documents", () => {
  it("lists for a signed-in member and refuses otherwise", async () => {
    expect((await GET()).status).toBe(200);
    mocks.getSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});

describe("GET /api/documents/:id/file", () => {
  const get = (id = ID) => FILE(new Request(`https://app.example/api/documents/${id}/file`), { params: Promise.resolve({ id }) });

  it("refuses a bad id and a document it cannot find", async () => {
    expect((await get("not-a-uuid")).status).toBe(400);
    mocks.readDocumentFile.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("serves an image inline with no caching, no sniffing and a sandbox", async () => {
    mocks.readDocumentFile.mockResolvedValue({ mime: "image/png", bytes: PNG });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("serves a PDF without the sandbox, so the browser's viewer works", async () => {
    mocks.readDocumentFile.mockResolvedValue({ mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7") });
    const res = await get();
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("POST /api/documents/:id/read", () => {
  const post = (site?: string) =>
    READ_AGAIN(
      new Request(`https://app.example/api/documents/${ID}/read`, {
        method: "POST",
        headers: site ? { "Sec-Fetch-Site": site } : undefined,
      }),
      { params: Promise.resolve({ id: ID }) },
    );

  it("refuses a cross-site post and maps a read already running to 409", async () => {
    expect((await post("cross-site")).status).toBe(403);
    mocks.readAgain.mockResolvedValue({ ok: false, error: "in_progress" });
    const res = await post("same-origin");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "in_progress" });
  });
});
