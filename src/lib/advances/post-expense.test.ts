import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { AccountingAdapter, SendContext } from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import type { MoneyHooks } from "../money/execute";
import type { MoneyAction } from "../money/types";
import { postPaidAdvanceExpense } from "./post-expense";

// The books step's post of a paid advance asks the books switch again at the send itself, so a
// switch turned off after the reserve (or a replayed reserve, which skips onReserved) sends nothing.

const hooks = vi.hoisted(() => ({ last: null as MoneyHooks | null }));

vi.mock("../money/execute", () => ({
  executeMoneyAction: vi.fn(async (_db: unknown, _s: unknown, _req: unknown, h: MoneyHooks) => {
    hooks.last = h;
    return null;
  }),
}));

vi.mock("./rows", () => ({
  readAdvanceView: vi.fn(async () => ({
    id: "adv-1",
    driverId: "drv-1",
    proposalId: null,
    requestRef: "ADV-1",
    requestedOn: "2026-11-02",
    amountCents: 30_000,
    feeCents: 500,
    status: "paid",
  })),
  readFlowAdvance: vi.fn(),
}));

const q = {
  query: async () => [{ id: "drv-1", code: "D1", first_name: "Ana", last_name: "Diaz", worker_type: "owner_operator" }],
} as unknown as Queryable;
const db = { withTenant: async (_t: string, fn: (q: Queryable) => unknown) => fn(q) } as unknown as TenantDb;
const session = { tenantId: "t-1" } as unknown as Session;

const saved = { books: flags.books.enabled, accounting: flags.accountingEnabled };
afterEach(() => {
  flags.books.enabled = saved.books;
  flags.accountingEnabled = saved.accounting;
  hooks.last = null;
});

describe("postPaidAdvanceExpense", () => {
  it("sends nothing when the books switch is off at the send", async () => {
    flags.books.enabled = true;
    flags.accountingEnabled = true;
    const ensureVendor = vi.fn();
    const createExpense = vi.fn();
    const accounting = { ensureVendor, createExpense } as unknown as AccountingAdapter;
    await postPaidAdvanceExpense(db, session, "adv-1", 1, { accounting });
    const send = hooks.last?.send;
    expect(send).toBeTypeOf("function");
    flags.books.enabled = false;
    const outcome = await send!({ id: "a-1" } as MoneyAction, {} as SendContext);
    expect(outcome).toEqual({ kind: "failed", category: "disabled" });
    expect(ensureVendor).not.toHaveBeenCalled();
    expect(createExpense).not.toHaveBeenCalled();
  });

  it("sends the purchase while the books switch is on", async () => {
    flags.books.enabled = true;
    flags.accountingEnabled = true;
    const ensureVendor = vi.fn(async () => ({ outsideId: "v-9" }));
    const createExpense = vi.fn(async (_q: unknown, _input: unknown, _ctx: unknown) => ({
      kind: "confirmed",
      outsideId: "p-1",
    }));
    const accounting = { ensureVendor, createExpense } as unknown as AccountingAdapter;
    await postPaidAdvanceExpense(db, session, "adv-1", 1, { accounting });
    await hooks.last!.send!({ id: "a-1" } as MoneyAction, {} as SendContext);
    expect(createExpense).toHaveBeenCalledTimes(1);
    expect(createExpense.mock.calls[0][1]).toMatchObject({ amountCents: 30_000, feeCents: 500, vendorOutsideId: "v-9" });
  });
});
