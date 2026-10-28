// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "@/lib/agent/gateway/__tests__/plan-db";
import { TENANT } from "@/lib/agent/gateway/__tests__/fake-db";
import type { Session } from "@/lib/auth/claims";
import { DbError, type Queryable } from "@/lib/db";
import { figureValueText } from "@/lib/briefs/figures";
import { packFigures, readQuarter } from "@/lib/briefs/quarter-figures";
import { REVIEW_UNREADABLE } from "@/lib/briefs/quarter-words";
import { ReadLimitError } from "@/lib/data/read";
import { formatPeriod } from "@/lib/format/dates";
import { InputError, type BriefFigure } from "@/lib/rules-engine";
import { quarterContaining } from "@/lib/time/local-date";
import QuarterPage from "./page";

// The /quarter page on the Blue Ridge seed plan, read through the real readers and the real rules
// engine with no database, on a fixed day: the quarter's figures show before any review is
// written, with the one next step offered, and the page writes nothing. A written review is a
// briefs row the test puts in the fake table.

const plan = blueRidgePlan();
const SESSION: Session = { sub: "sub-test", email: "desk@example.test", tenantId: TENANT };
const NOW = new Date(Date.UTC(2026, 10, 2, 17, 0, 0));
const reads = vi.hoisted(() => ({ sql: [] as string[] }));

const mocks = vi.hoisted(() => ({ withRequestTenant: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: mocks.withRequestTenant,
}));

const db = planDb(plan, (sql) => {
  if (sql === "SELECT name, timezone FROM tenants WHERE id = current_tenant_id()") {
    return [{ name: plan.carrier.name, timezone: plan.carrier.timezone }];
  }
  if (sql.startsWith("SELECT email FROM memberships")) return [{ email: SESSION.email }];
  return undefined;
});

const saved = { review: flags.quarterReviewEnabled, ai: flags.aiEnabled, reports: flags.reportsEnabled };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  reads.sql = [];
  flags.quarterReviewEnabled = true;
  flags.aiEnabled = true;
  flags.reportsEnabled = false;
  mocks.withRequestTenant.mockImplementation((fn: (q: Queryable, s: Session) => Promise<unknown>) =>
    db.withTenant(TENANT, (q) => {
      const watched: Queryable = {
        query: (sql, params) => {
          reads.sql.push(sql);
          return q.query(sql, params);
        },
        execute: async () => {
          throw new Error("the page writes nothing");
        },
      };
      return fn(watched, SESSION);
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  flags.quarterReviewEnabled = saved.review;
  flags.aiEnabled = saved.ai;
  flags.reportsEnabled = saved.reports;
  delete db.tables.briefs;
  cleanup();
});

// The figures a review is written from today, as the writer packs them.
async function livePack(): Promise<BriefFigure[]> {
  const quarter = await db.withTenant(TENANT, (q) =>
    readQuarter(q, quarterContaining(PLAN_ANCHOR), PLAN_ANCHOR, plan.carrier.timezone),
  );
  return packFigures(quarter.figures, flags.quarterReviewLimits.maxInputChars);
}

// A review whose every number is its tagged figure, citing figures shown in this page's tables.
function bodyFrom(figures: readonly BriefFigure[]): Record<string, string[]> {
  const q = (label: string) => {
    const f = figures.find((x) => x.label === label);
    if (!f) throw new Error(`no figure ${label}`);
    return `${figureValueText(f)} [${f.key}]`;
  };
  return {
    went_well: [`Pay runs so far: ${q("Pay runs so far")}.`],
    problems: [`Paystubs with a problem so far: ${q("Paystubs with a problem")}.`],
    recovered: [`Money recovered came to ${q("Money recovered")}.`],
    change: [
      `Decide the fixes waiting for a decision: ${q("Fixes waiting for a decision")}.`,
      `Bill the detention not billed so far, ${q("Detention not billed")}.`,
      `Look into the paystub problems found, ${q("Paystub problems found")}.`,
    ],
  };
}

function writtenReview(figures: readonly BriefFigure[], body: Record<string, unknown>) {
  db.tables.briefs = [
    {
      id: "0b0b0b0b-0000-4000-8000-000000000001",
      kind: "quarter",
      period_start: "2026-10-01",
      period_end: "2026-12-31",
      as_of: PLAN_ANCHOR,
      status: "drafted",
      figures,
      body,
      refusal_category: null,
      verification: null,
      model: "wonder",
      trace_id: null,
      model_call_id: null,
      created_by: SESSION.sub,
      updated_at: "2026-11-02T15:00:00.000Z",
    },
  ];
}

const reviewRegions = () =>
  ["What went well", "Recurring problems", "Money recovered", "Three things to change"].map((name) =>
    screen.getByRole("region", { name }),
  );

// The page's top may be a server component; run it to its tree so the DOM can render it.
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (isValidElement(node) && typeof node.type === "function") {
    let out: unknown;
    try {
      out = (node.type as (p: unknown) => unknown)(node.props);
    } catch {
      return node;
    }
    if (out instanceof Promise) return resolve((await out) as ReactNode);
  }
  return node;
}

async function show() {
  const tree = await QuarterPage();
  render(<>{await resolve(tree)}</>);
}

describe("/quarter", () => {
  it("renders the quarter so far with no review, offers the one next step, and only reads", async () => {
    await show();
    const quarter = await db.withTenant(TENANT, (q) =>
      readQuarter(q, quarterContaining(PLAN_ANCHOR), PLAN_ANCHOR, plan.carrier.timezone),
    );
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Quarter review"]);
    expect(screen.getByText(`So far: ${formatPeriod("2026-10-01", PLAN_ANCHOR)}`)).toBeTruthy();
    for (const label of ["Pay runs", "Revenue invoiced", "Payments received", "Money recovered"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.getByText(/No review yet\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Write the quarter review" })).toBeTruthy();
    // One row a pay run, oldest first.
    const runs = screen.getByRole("table", { name: "Pay runs" });
    expect(within(runs).getAllByRole("row").length - 1).toBe(quarter.payRuns.length);
    for (const caption of ["Money recovered", "Customers"]) expect(screen.getByRole("table", { name: caption })).toBeTruthy();
    // Reads only, and no word the house list bans.
    expect(reads.sql.every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(document.body.textContent).not.toMatch(/proposal|tenant|rules engine|verdict|\blane|—/i);
  });

  it("links a written review's numbers to the tables that show them while its figures are unchanged", async () => {
    const figures = await livePack();
    writtenReview(figures, bodyFrom(figures));
    await show();
    const [wentWell] = reviewRegions();
    expect(within(wentWell).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#quarter-pay-runs"]);
    expect(screen.queryByText(/The figures changed after this review was written/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Write/ })).toBeNull();
  });

  it("shows a review whose figures changed since with its numbers as plain words, no link to a table that now differs", async () => {
    const live = await livePack();
    const runs = live.find((f) => f.label === "Pay runs so far");
    if (!runs) throw new Error("no pay runs figure");
    // Written when one fewer pay run had happened.
    const stored = live.map((f) => (f.key === runs.key ? { ...f, value: Number(f.value) - 1 } : f));
    writtenReview(stored, bodyFrom(stored));
    await show();
    expect(screen.getByText(/The figures changed after this review was written/)).toBeTruthy();
    const regions = reviewRegions();
    for (const region of regions) expect(within(region).queryAllByRole("link")).toEqual([]);
    expect(within(regions[0]).getByText(`Pay runs so far: ${Number(runs.value) - 1}.`)).toBeTruthy();
    for (const region of regions) expect(region.textContent).not.toMatch(/\[f\d+\]/);
    expect(screen.queryByRole("button", { name: /Write/ })).toBeNull();
  });

  it("says a written review that no longer reads back cannot be read, and offers no button", async () => {
    const figures = await livePack();
    const body = bodyFrom(figures);
    writtenReview(figures, { ...body, change: body.change.slice(0, 2) });
    await show();
    expect(screen.getByText(REVIEW_UNREADABLE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Write/ })).toBeNull();
    expect(screen.queryByText(/did not finish|did not pass/)).toBeNull();
  });

  it("shows the read failed for a failed read, a read past its bound, an amount not in whole cents and a record the engine refuses", async () => {
    for (const err of [
      new DbError("unavailable"),
      new ReadLimitError(),
      new RangeError("amount is not whole cents"),
      new InputError("asOf is not inside the quarter"),
    ]) {
      mocks.withRequestTenant.mockRejectedValueOnce(err);
      await show();
      expect(screen.getByText("Could not read your carrier's data"), err.name).toBeTruthy();
      expect(screen.queryByText(/So far:/)).toBeNull();
      cleanup();
    }
    // Anything else is not a read problem: it is raised, never shown as empty.
    mocks.withRequestTenant.mockRejectedValueOnce(new TypeError("x is not a function"));
    await expect(QuarterPage()).rejects.toThrow(TypeError);
  });

  it("offers no button with the agent off, and says the review is off with its switch", async () => {
    flags.aiEnabled = false;
    await show();
    expect(screen.queryByRole("button", { name: /Write/ })).toBeNull();
    cleanup();
    flags.quarterReviewEnabled = false;
    await show();
    expect(screen.getByText(/Quarter review is off for this carrier/)).toBeTruthy();
    expect(screen.queryByText(/So far:/)).toBeNull();
  });
});
