import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import { REPORT_COLUMNS, REPORT_TITLES, type ReportResult } from "@/lib/reports/types";
import { GET } from "./route";

// The download route's checks, in order: the report switch, the login, then the report name and
// its strict query, each before any read. Every answer is no-store; a CSV cell that starts like a
// spreadsheet formula is served as text.

const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const CUSTOMER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), reportForSession: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/reports/for-session", () => ({ reportForSession: mocks.reportForSession }));

function aging(rows: number): ReportResult {
  return {
    report: "ar_aging",
    title: REPORT_TITLES.ar_aging,
    asOf: "2026-11-02",
    args: { asOf: "2026-11-02" },
    columns: [...REPORT_COLUMNS.ar_aging],
    rows: Array.from({ length: rows }, (_, i) => ({
      customer: { table: "customers", id: CUSTOMER, label: i === 0 ? "=cmd|' /C calc'!A0" : `Customer ${i}` },
      currentCents: 100,
      days1To30Cents: 0,
      days31To60Cents: 0,
      days61To90Cents: 0,
      over90Cents: -250,
      totalCents: -150,
    })),
    totals: {
      currentCents: 100 * rows,
      days1To30Cents: 0,
      days31To60Cents: 0,
      days61To90Cents: 0,
      over90Cents: -250 * rows,
      totalCents: -150 * rows,
    },
    truncated: false,
    rowsTotal: rows,
  };
}

function get(name: string, query = "") {
  const request = new Request(`https://app.example/api/reports/${name}${query}`);
  return GET(request, { params: Promise.resolve({ name }) });
}

beforeEach(() => {
  flags.reportsEnabled = true;
  mocks.getSession.mockReset().mockResolvedValue(SESSION);
  mocks.reportForSession.mockReset().mockResolvedValue(aging(1));
});

afterEach(() => {
  flags.reportsEnabled = false;
  flags.iftaEnabled = false;
  flags.yearEndEnabled = false;
  flags.trustMeterEnabled = false;
  vi.restoreAllMocks();
});

describe("GET /api/reports/:name", () => {
  it("is not there while the report switch is off, before reading the session", async () => {
    flags.reportsEnabled = false;
    const response = await get("ar_aging");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.reportForSession).not.toHaveBeenCalled();
  });

  it("is not there for the IFTA quarter while its own switch is off, though the others answer", async () => {
    flags.iftaEnabled = false;
    const off = await get("ifta_quarter");
    expect(off.status).toBe(404);
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect(await off.json()).toEqual({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.reportForSession).not.toHaveBeenCalled();
    expect((await get("ar_aging")).status).toBe(200);
    // On, it reaches the session and the report like any other.
    flags.iftaEnabled = true;
    mocks.getSession.mockClear();
    await get("ifta_quarter", "?asOf=2026-11-02");
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.reportForSession.mock.calls.at(-1)?.[1]).toEqual({ name: "ifta_quarter", args: { asOf: "2026-11-02" } });
    // With reports off, the IFTA switch alone does not open it.
    flags.reportsEnabled = false;
    expect((await get("ifta_quarter")).status).toBe(404);
  });

  it("is not there for the year-end 1099 while its own switch is off, though the others answer", async () => {
    flags.yearEndEnabled = false;
    const off = await get("year_end_contractors", "?year=2026");
    expect(off.status).toBe(404);
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect(await off.json()).toEqual({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.reportForSession).not.toHaveBeenCalled();
    expect((await get("ar_aging")).status).toBe(200);
    // The IFTA switch does not open it.
    flags.iftaEnabled = true;
    expect((await get("year_end_contractors")).status).toBe(404);
    // On, it reaches the session and the report like any other, with its year as typed.
    flags.yearEndEnabled = true;
    mocks.getSession.mockClear();
    await get("year_end_contractors", "?year=2026");
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.reportForSession.mock.calls.at(-1)?.[1]).toEqual({ name: "year_end_contractors", args: { year: "2026" } });
    // A year outside 2000 to 2100 is refused before any read.
    const calls = mocks.reportForSession.mock.calls.length;
    expect((await get("year_end_contractors", "?year=2101")).status).toBe(400);
    expect(mocks.reportForSession.mock.calls.length).toBe(calls);
    // With reports off, its own switch alone does not open it.
    flags.reportsEnabled = false;
    expect((await get("year_end_contractors")).status).toBe(404);
  });

  it("is not there for the trust meter while its own switch is off, though the others answer", async () => {
    flags.trustMeterEnabled = false;
    const off = await get("trust_meter", "?asOf=2026-11-02");
    expect(off.status).toBe(404);
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect(await off.json()).toEqual({ error: "not_found" });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.reportForSession).not.toHaveBeenCalled();
    expect((await get("ar_aging")).status).toBe(200);
    // Another report's own switch does not open it.
    flags.iftaEnabled = true;
    flags.yearEndEnabled = true;
    expect((await get("trust_meter")).status).toBe(404);
    // On, it reaches the session and the report like any other, with its date as typed.
    flags.trustMeterEnabled = true;
    mocks.getSession.mockClear();
    await get("trust_meter", "?asOf=2026-11-02");
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.reportForSession.mock.calls.at(-1)?.[1]).toEqual({ name: "trust_meter", args: { asOf: "2026-11-02" } });
    // An arg it does not take is refused before any read.
    const calls = mocks.reportForSession.mock.calls.length;
    expect((await get("trust_meter", "?year=2026")).status).toBe(400);
    expect(mocks.reportForSession.mock.calls.length).toBe(calls);
    // With reports off, its own switch alone does not open it.
    flags.reportsEnabled = false;
    expect((await get("trust_meter")).status).toBe(404);
  });

  it("refuses a request with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await get("ar_aging");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(mocks.reportForSession).not.toHaveBeenCalled();
  });

  it("refuses an unknown report, bad args, an unknown key, a repeated key or another format", async () => {
    const cases: [string, string][] = [
      ["payroll", ""],
      ["ar_aging", "?asOf=tomorrow"],
      ["ar_aging", "?asOf=2026-11-02&limit=5"],
      ["ar_aging", "?asOf=2026-11-02&asOf=2026-11-01"],
      ["ar_aging", "?format=xlsx"],
      ["driver_pay_summary", "?driverId=7"],
      ["margin_per_load", "?periodStart=2026-08-02&periodEnd=2026-11-02"],
    ];
    for (const [name, query] of cases) {
      const response = await get(name, query);
      expect(response.status, `${name}${query}`).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }
    expect(mocks.reportForSession).not.toHaveBeenCalled();
  });

  it("serves the chat's table as JSON, capped at 50 rows, never cached or sniffed", async () => {
    mocks.reportForSession.mockResolvedValue(aging(60));
    const response = await get("ar_aging", "?format=json&asOf=2026-11-02");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await response.json()) as ReportResult;
    expect(body.rows).toHaveLength(50);
    expect(body.truncated).toBe(true);
    expect(body.rowsTotal).toBe(60);
    const [session, request] = mocks.reportForSession.mock.calls[0];
    expect(session).toEqual(SESSION);
    expect(request).toEqual({ name: "ar_aging", args: { asOf: "2026-11-02" } });
  });

  it("downloads every row as CSV, guarded against formulas, never cached", async () => {
    mocks.reportForSession.mockResolvedValue(aging(60));
    const response = await get("ar_aging", "?asOf=2026-11-02");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="ar_aging-2026-11-02.csv"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const lines = (await response.text()).split("\r\n");
    expect(lines).toHaveLength(1 + 60 + 1 + 1);
    expect(lines[1]).toBe(`'=cmd|' /C calc'!A0,${CUSTOMER},1.00,0.00,0.00,0.00,-2.50,-1.50`);
    expect(lines[61]).toBe("Total,,60.00,0.00,0.00,0.00,-150.00,-90.00");
    expect(lines.slice(1, 61).some((l) => l.startsWith("="))).toBe(false);
  });

  it("answers forbidden for a login with no membership, and unavailable for anything else", async () => {
    mocks.reportForSession.mockRejectedValueOnce(Object.assign(new Error("no membership"), { name: "ForbiddenError" }));
    const forbidden = await get("ar_aging");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.reportForSession.mockRejectedValueOnce(new Error("relation secret_table does not exist"));
    const failed = await get("ar_aging");
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(failed.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await failed.text();
    expect(text).toBe('{"error":"unavailable"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret_table");
  });
});
