// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AdvanceListRow } from "@/lib/advances/read";
import type { ProposalView, TurnView } from "@/lib/agent/view";
import { advancesRow, cardsRow, pastDueRow, type NeedsYouRow } from "@/lib/home/needs-you";
import type { InvoiceListRow } from "@/lib/invoices/views";
import * as fx from "@/test/page-fixtures";
import { NEEDS_YOU_EMPTY, NEEDS_YOU_UNREAD, NeedsYou } from "./needs-you";

afterEach(cleanup);

const card = (over: Partial<ProposalView>): ProposalView => ({ ...fx.PROPOSALS[0], ...over });
const turnWith = (id: string, proposals: ProposalView[]): TurnView => ({ ...fx.TURNS[0], id, proposals });
const advance = (over: Partial<AdvanceListRow>): AdvanceListRow => ({ ...fx.ADVANCES[0], ...over });
const invoice = (over: Partial<InvoiceListRow>): InvoiceListRow => ({ ...fx.INVOICES[0], ...over });

describe("NeedsYou", () => {
  const ROWS: NeedsYouRow[] = [
    cardsRow([turnWith("t1", [card({ id: "c1", amountCents: 25_000 })])])!,
    pastDueRow([invoice({ bucket: "31_60", balanceCents: 123_456 })])!,
  ];

  it("shows each row's count, what it is, its total, and its link", () => {
    render(<NeedsYou view={{ rows: ROWS, unread: false }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Needs you" })).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Waiting on you" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "1 card in your chat waiting for approval$250.00 to pay outGo to the newest card",
      "1 invoice past due$1,234.56 still owedOpen the invoice list",
    ]);
    expect(screen.getByRole("link", { name: "Go to the newest card" }).getAttribute("href")).toBe("#card-c1");
    expect(screen.getByRole("link", { name: "Open the invoice list" }).getAttribute("href")).toBe("/invoices?tab=invoices");
    expect(screen.queryByText(NEEDS_YOU_EMPTY)).toBeNull();
  });

  it("says nothing is waiting only when every read worked and found nothing", () => {
    render(<NeedsYou view={{ rows: [], unread: false }} />);
    expect(screen.getByText(NEEDS_YOU_EMPTY)).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("never says nothing is waiting when a read failed", () => {
    const { rerender } = render(<NeedsYou view={{ rows: [], unread: true }} />);
    expect(screen.getByRole("status").textContent).toBe(NEEDS_YOU_UNREAD);
    expect(screen.queryByText(NEEDS_YOU_EMPTY)).toBeNull();
    // What was read still shows, with the note that the rest could not be.
    rerender(<NeedsYou view={{ rows: ROWS, unread: true }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe(NEEDS_YOU_UNREAD);
  });

  it("says a count was cut off rather than give a short one", () => {
    const full = Array.from({ length: 200 }, (_, i) => advance({ id: `r${i}`, status: "requested", amountCents: 100 }));
    render(<NeedsYou view={{ rows: [advancesRow(full)!], unread: false }} />);
    expect(screen.getByRole("listitem").textContent).toContain("200 or more advance requests waiting for a decision");
  });
});
