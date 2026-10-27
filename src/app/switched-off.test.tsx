// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";

// A switched-off page reads only the carrier chip (the tenant's name and zone, the member's email)
// and shows the shared off state inside the shell. Any other read fails this test.
const reads = vi.hoisted(() => ({ sql: [] as string[] }));
const SESSION: Session = { sub: "sub-test-1", email: "office@example.test", tenantId: "00000000-0000-4000-8000-000000000001" };

const fakeQ = {
  async query(sql: string) {
    reads.sql.push(sql);
    if (/FROM tenants/.test(sql)) return [{ name: "Test Carrier", timezone: "America/Chicago" }];
    if (/FROM memberships/.test(sql)) return [{ email: SESSION.email }];
    throw new Error(`unexpected read: ${sql}`);
  },
} as unknown as Queryable;

vi.mock("@/lib/tenant/context", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/tenant/context")>();
  return {
    ...real,
    withRequestTenant: async <T,>(fn: (q: Queryable, s: Session) => Promise<T>) => fn(fakeQ, SESSION),
    withSessionTenant: async <T,>(_s: Session, fn: (q: Queryable) => Promise<T>) => fn(fakeQ),
  };
});

const SWITCHES = [
  "voiceIntakeEnabled",
  "portalRunnerEnabled",
  "advancesEnabled",
  "sweepEnabled",
  "driverNotesEnabled",
  "documentsEnabled",
  "clipsEnabled",
  "invoicesEnabled",
  "customerPaymentsEnabled",
] as const;
const saved = Object.fromEntries(SWITCHES.map((s) => [s, flags[s]])) as Record<(typeof SWITCHES)[number], boolean>;

beforeEach(() => {
  reads.sql = [];
  for (const s of SWITCHES) flags[s] = false;
});
afterEach(() => {
  for (const s of SWITCHES) flags[s] = saved[s];
  cleanup();
});

// A server page returns an element whose top may be an async server component (the off page);
// run that one to its tree so the DOM can render it.
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

const ID = "0b9f6a52-3c1d-4e8f-9a7b-5d2c1e7c41e2";
const params = () => Promise.resolve({ id: ID });
const searchParams = () => Promise.resolve({});

const CASES: { route: string; load: () => Promise<ReactNode>; off: string; title: string }[] = [
  {
    route: "/voice-notes",
    load: async () => (await import("./voice-notes/page")).default(),
    off: "Voice notes are off for this carrier",
    title: "Voice notes",
  },
  {
    route: "/voice-notes/[id]",
    load: async () => (await import("./voice-notes/[id]/page")).default({ params: params() }),
    off: "Voice notes are off for this carrier",
    title: "Voice note",
  },
  {
    route: "/portal-runs",
    load: async () => (await import("./portal-runs/page")).default(),
    off: "Portal runs are off for this carrier",
    title: "Portal runs",
  },
  {
    route: "/portal-runs/[id]",
    load: async () => (await import("./portal-runs/[id]/page")).default({ params: params() }),
    off: "Portal runs are off for this carrier",
    title: "Portal run",
  },
  {
    route: "/advances",
    load: async () => (await import("./advances/page")).default({ searchParams: searchParams() }),
    off: "Advances are off for this carrier",
    title: "Advances",
  },
  {
    route: "/advances/new",
    load: async () => (await import("./advances/new/page")).default(),
    off: "Advances are off for this carrier",
    title: "Request an advance",
  },
  {
    route: "/records/advances/[id]",
    load: async () => (await import("./records/advances/[id]/page")).default({ params: params() }),
    off: "Advances are off for this carrier",
    title: "Advance",
  },
  {
    route: "/sweep",
    load: async () => (await import("./sweep/page")).default(),
    off: "Pay sweep is off for this carrier",
    title: "Pay sweep",
  },
  {
    route: "/sweep/[id]",
    load: async () => (await import("./sweep/[id]/page")).default({ params: params() }),
    off: "Pay sweep is off for this carrier",
    title: "Pay sweep",
  },
  {
    route: "/driver-notes",
    load: async () => (await import("./driver-notes/page")).default(),
    off: "Driver notes are off for this carrier",
    title: "Driver notes",
  },
  {
    route: "/driver-notes/[settlementId]/view",
    load: async () =>
      (await import("./driver-notes/[settlementId]/view/page")).default({ params: Promise.resolve({ settlementId: ID }) }),
    off: "Driver notes are off for this carrier",
    title: "Driver note",
  },
  {
    route: "/pay/[periodId]/notes",
    load: async () => (await import("./pay/[periodId]/notes/page")).default({ params: Promise.resolve({ periodId: ID }) }),
    off: "Driver notes are off for this carrier",
    title: "Driver notes",
  },
  {
    route: "/documents",
    load: async () => (await import("./documents/page")).default(),
    off: "Documents are off for this carrier",
    title: "Documents",
  },
  {
    route: "/documents/[id]",
    load: async () => (await import("./documents/[id]/page")).default({ params: params() }),
    off: "Documents are off for this carrier",
    title: "Document",
  },
  {
    route: "/clips",
    load: async () => (await import("./clips/page")).default(),
    off: "Dock clips are off for this carrier",
    title: "Dock clips",
  },
  {
    route: "/invoices",
    load: async () => (await import("./invoices/page")).default({ searchParams: searchParams() }),
    off: "Invoices are off for this carrier",
    title: "Invoices",
  },
  {
    route: "/customer-payments/new",
    load: async () => (await import("./customer-payments/new/page")).default({ searchParams: searchParams() }),
    off: "Payments are off for this carrier",
    title: "Record a payment",
  },
];

describe("a switched-off page", () => {
  it.each(CASES)("$route shows the off state inside the shell, never a 404", async ({ load, off, title }) => {
    const tree = await resolve(await load());
    render(<>{tree}</>);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: off })).toBeTruthy();
    expect(screen.getByText("Nothing here has changed. Ask your administrator to switch it on.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/404|could not be found/);
    expect(reads.sql.every((sql) => /FROM (tenants|memberships)/.test(sql))).toBe(true);
    expect(reads.sql.length).toBeGreaterThan(0);
  });
});
