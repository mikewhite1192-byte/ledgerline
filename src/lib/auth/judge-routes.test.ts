import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import { JUDGE_ALLOWED, NO_CARRIER_LOGIN, WRITING_GETS } from "./judge-allowlist";

// Every write route off the judge allowlist, called for real with a judge's session: each answers
// the judge refusal, and none reads the database, the body or anything else first. The database is
// a trap here (any use throws), so a route that did work before its staff check would fail.

const SESSION = { sub: "judge-sub", email: "judge@example.com", tenantId: "00000000-0000-4000-8000-000000000001" };
const ID = "00000000-0000-4000-8000-0000000000aa";

const mocks = vi.hoisted(() => ({ gate: vi.fn(), db: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => SESSION,
  requireSession: async () => SESSION,
}));
vi.mock("@/lib/auth/staff-gate", () => ({ staffGate: mocks.gate }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  getDb: () => {
    mocks.db();
    throw new Error("the database was touched before the staff check");
  },
}));

const ROOT = resolve(__dirname, "../../..");
const API = join(ROOT, "src/app/api");
const METHODS = ["POST", "PUT", "PATCH", "DELETE", "GET"] as const;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) routeFiles(full, out);
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

const saved = structuredClone(flags);

// Every switch on, so no route stops at "disabled" before it reaches the check.
beforeAll(() => {
  const on = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "boolean") o[k] = true;
      else if (v && typeof v === "object" && "enabled" in v) (v as { enabled: boolean }).enabled = true;
    }
  };
  on(flags as unknown as Record<string, unknown>);
});

afterAll(() => {
  Object.assign(flags, saved);
});

describe("a judge on every staff-only route", () => {
  const files = routeFiles(API);
  const cases: { key: string; file: string; method: (typeof METHODS)[number]; params: Record<string, string> }[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const dir = relative(join(ROOT, "src/app"), file).split(sep).slice(0, -1);
    const path = `/${dir.join("/")}`;
    const params = Object.fromEntries(
      dir.filter((d) => d.startsWith("[")).map((d) => [d.slice(1, -1), ID]),
    );
    for (const method of METHODS) {
      const key = `${method} ${path}`;
      if (!new RegExp(`export (async )?function ${method}\\b`).test(text)) continue;
      if (method === "GET" && !WRITING_GETS.includes(key)) continue;
      if (Object.hasOwn(JUDGE_ALLOWED, key) || Object.hasOwn(NO_CARRIER_LOGIN, key)) continue;
      cases.push({ key, file, method, params });
    }
  }

  it.each(cases.map((c) => [c.key, c] as const))("%s refuses before any work", async (_key, c) => {
    const mod = (await import(c.file)) as Record<string, unknown>;
    const handler = mod[c.method] as (r: Request, ctx: unknown) => Promise<Response>;
    mocks.gate.mockReset();
    mocks.db.mockReset();
    mocks.gate.mockResolvedValue(NextResponse.json({ error: "judge", retryable: false }, { status: 403 }));
    const res = await handler(
      new Request(`http://localhost${c.key.split(" ")[1]}`, {
        method: c.method,
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: c.method === "GET" ? undefined : "{}",
      }),
      { params: Promise.resolve(c.params) },
    );
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    expect(mocks.gate).toHaveBeenCalledWith(SESSION);
    expect(mocks.db).not.toHaveBeenCalled();
    if (c.key.includes("/api/qbo/")) {
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/settings/accounting?qbo=forbidden");
    } else {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "judge", retryable: false });
    }
  });

  it("covers the money routes", () => {
    const keys = cases.map((c) => c.key);
    expect(keys.length).toBeGreaterThan(35);
    for (const k of [
      "POST /api/proposals/[id]/approve",
      "POST /api/proposals/[id]/reject",
      "POST /api/settlements/run",
      "POST /api/batches",
      "POST /api/advances/[id]/retry-payout",
      "POST /api/invoices/[id]/post",
      "POST /api/customer-payments/[id]/post",
      "POST /api/sweeps/[id]/approve-clean",
      "POST /api/driver-notes/[id]/approve",
      "POST /api/drivers/[id]/arm",
      "POST /api/collections/[id]/approve",
      "POST /api/collections/[id]/reject",
      "POST /api/collections/draft",
      "POST /api/cards/check",
      "POST /api/cards/check/[runId]",
      "POST /api/cards/breaks/[id]/dismiss",
      "POST /api/cash/check",
      "POST /api/briefs/profit",
      "POST /api/inbound-messages",
      "POST /api/inbound-messages/[id]/sort",
      "POST /api/inbound-messages/[id]/hand-off",
    ]) {
      expect(keys).toContain(k);
    }
  });
});
