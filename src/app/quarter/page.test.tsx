// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "@/lib/agent/gateway/__tests__/plan-db";
import { TENANT } from "@/lib/agent/gateway/__tests__/fake-db";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { readQuarter } from "@/lib/briefs/quarter-figures";
import { formatPeriod } from "@/lib/format/dates";
import { quarterContaining } from "@/lib/time/local-date";
import QuarterPage from "./page";

// The /quarter page on the Blue Ridge seed plan, read through the real readers and the real rules
// engine with no database, on a fixed day: the quarter's figures show before any review is
// written, with the one next step offered, and the page writes nothing.

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
  cleanup();
});

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
