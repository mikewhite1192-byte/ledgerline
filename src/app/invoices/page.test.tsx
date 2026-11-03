// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "@/config/flags";
import type { Session } from "@/lib/auth/claims";
import type { Queryable } from "@/lib/db";
import { INVOICES, QUEUE, TENANT } from "@/test/page-fixtures";
import InvoicesPage from "./page";

// /invoices opens on the invoices themselves, so the first thing a person sees is the list, and the
// work queues follow in their tabs. No database: the reads are answered from fixtures.

const SESSION: Session = { sub: "sub-test", email: "", tenantId: "11111111-1111-4111-8111-111111111111" };
const q = {
  async query<T>(sql: string): Promise<T[]> {
    if (/FROM tenants/.test(sql)) return [TENANT] as T[];
    if (/FROM memberships/.test(sql)) return [{ email: "ops@example.test", role: "staff" }] as T[];
    throw new Error(`unexpected read: ${sql}`);
  },
  async execute() {
    throw new Error("the page writes nothing");
  },
} as Queryable;

const mocks = vi.hoisted(() => ({ readReviewQueue: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/tenant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/context")>()),
  withRequestTenant: async <T,>(fn: (q: Queryable, s: Session) => Promise<T>) => fn(q, SESSION),
}));
vi.mock("@/lib/invoices/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoices/views")>()),
  readInvoiceList: async () => INVOICES,
  readQueueView: async () => QUEUE,
}));
vi.mock("@/lib/agent/gateway/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/gateway/store")>()),
  readEngineProposalViews: async () => [],
}));
vi.mock("@/lib/invoices/review-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/invoices/review-read")>()),
  readReviewQueue: mocks.readReviewQueue,
}));

const savedInvoices = flags.invoicesEnabled;
const savedReview = flags.invoiceReviewEnabled;
afterEach(() => {
  flags.invoicesEnabled = savedInvoices;
  flags.invoiceReviewEnabled = savedReview;
  mocks.readReviewQueue.mockReset();
  cleanup();
});

const show = async (params: Record<string, string> = {}) =>
  render(await InvoicesPage({ searchParams: Promise.resolve(params) }));
const tabs = () =>
  within(screen.getByRole("navigation", { name: "Invoice lists" }))
    .getAllByRole("link")
    .map((l) => [l.textContent, l.getAttribute("aria-current")]);

describe("/invoices tabs", () => {
  it("opens on the Invoices list, with To invoice, Review and Exceptions after it", async () => {
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = true;
    await show();
    expect(tabs()).toEqual([
      ["Invoices", "page"],
      ["To invoice", null],
      ["Review", null],
      ["Exceptions", null],
    ]);
    expect(screen.getByText(INVOICES[0].invoiceNumber)).toBeTruthy();
    // The review is read only on its own tab.
    expect(mocks.readReviewQueue).not.toHaveBeenCalled();
  });

  it("still opens on the Invoices list with the review switch off, and leaves its tab out", async () => {
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = false;
    await show();
    expect(tabs()).toEqual([
      ["Invoices", "page"],
      ["To invoice", null],
      ["Exceptions", null],
    ]);
  });

  it("opens the tab asked for, and the list for a tab it does not have", async () => {
    flags.invoicesEnabled = true;
    flags.invoiceReviewEnabled = true;
    await show({ tab: "to-invoice" });
    expect(tabs()[1]).toEqual(["To invoice", "page"]);
    cleanup();
    await show({ tab: "nonsense" });
    expect(tabs()[0]).toEqual(["Invoices", "page"]);
  });
});
