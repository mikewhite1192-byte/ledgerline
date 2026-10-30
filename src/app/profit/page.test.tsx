// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import { blueRidgePlan, PLAN_ANCHOR, planDb } from "@/lib/agent/gateway/__tests__/plan-db";
import { TENANT } from "@/lib/agent/gateway/__tests__/fake-db";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { closedWeeks } from "@/lib/briefs/figures";
import { formatPeriod } from "@/lib/format/dates";
import ProfitPage from "./page";

// The /profit page on the Blue Ridge seed plan, read through the real readers and the real rules
// engine with no database, on a fixed day: the week's figures show before any brief is written,
// with the one next step offered, and the page writes nothing.

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

const saved = { brief: flags.profitBriefEnabled, ai: flags.aiEnabled, reports: flags.reportsEnabled };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  reads.sql = [];
  flags.profitBriefEnabled = true;
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
  flags.profitBriefEnabled = saved.brief;
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

async function show(week?: string) {
  const tree = await ProfitPage({ searchParams: Promise.resolve(week ? { week } : {}) });
  render(<>{await resolve(tree)}</>);
}

describe("/profit", () => {
  it("the figures page renders with no brief", async () => {
    await show();
    const weeks = await db.withTenant(TENANT, (q) => closedWeeks(q, PLAN_ANCHOR));
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Profit brief"]);
    const tabs = screen.getByRole("navigation", { name: "Pay weeks" });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(weeks.map((w) => formatPeriod(w.start, w.end)));
    expect(links[0].getAttribute("aria-current")).toBe("page");
    for (const label of ["Revenue", "Driver pay", "Margin", "Loads priced"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.getByText(/No brief for this week yet\./)).toBeTruthy();
    // The header promises no link the page does not have: with no brief and reports off, the
    // figures here link nowhere.
    expect(screen.getByText(/how fast each customer pays\.$/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/links to where/i);
    // One obvious next step.
    expect(screen.getByRole("button", { name: "Write this week's brief" })).toBeTruthy();
    expect(screen.getByText("By route")).toBeTruthy();
    expect(screen.getByText("By customer")).toBeTruthy();
    // Reads only, and no word the house list bans.
    expect(reads.sql.every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(document.body.textContent).not.toMatch(/proposal|tenant|rules engine|verdict|\blane|\u2014/i);
  });

  it("links the revenue to its loads file with a plain download link the router never prefetches", async () => {
    flags.reportsEnabled = true;
    await show();
    const link = screen.getByRole("link", { name: "Download the loads behind it" });
    expect(link.getAttribute("href")).toMatch(/^\/api\/reports\/margin_per_load\?format=csv&periodEnd=\d{4}-\d{2}-\d{2}&periodStart=\d{4}-\d{2}-\d{2}$/);
    expect(link.hasAttribute("download")).toBe(true);
    // The week tabs stay page links.
    for (const tab of within(screen.getByRole("navigation", { name: "Pay weeks" })).getAllByRole("link")) {
      expect(tab.hasAttribute("download")).toBe(false);
    }
  });

  it("opens the week asked for, and offers no button with the agent off", async () => {
    const weeks = await db.withTenant(TENANT, (q) => closedWeeks(q, PLAN_ANCHOR));
    const older = weeks.at(-1);
    if (!older) throw new Error("no closed week");
    flags.aiEnabled = false;
    await show(older.start);
    const current = within(screen.getByRole("navigation", { name: "Pay weeks" }))
      .getAllByRole("link")
      .find((a) => a.getAttribute("aria-current") === "page");
    expect(current?.textContent).toBe(formatPeriod(older.start, older.end));
    expect(screen.queryByRole("button", { name: /Write/ })).toBeNull();
  });
});
