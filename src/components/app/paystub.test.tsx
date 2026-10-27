// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRef } from "@/lib/records/href";
import { Paystub, type PaystubProps } from "./paystub";

afterEach(cleanup);

const hrefFor = (s: SourceRef) => `#${s.table}-${s.id}`;

// Lines arrive out of order on purpose; the component orders them by seq.
const props: PaystubProps = {
  driver: { name: "Sample Driver", code: "SD-01", workerType: "company" },
  period: { start: "2026-10-26", end: "2026-11-01" },
  status: "draft",
  lines: [
    { seq: 4, kind: "escrow", label: "Escrow", amountCents: -10_000, sources: [{ table: "deduction_schedules", id: "DS-2" }] },
    { seq: 2, kind: "reimbursement", label: "Reimbursements", amountCents: 18_000, sources: [{ table: "pay_items", id: "PI-1" }] },
    { seq: 3, kind: "insurance", label: "Insurance", amountCents: -5_500, sources: [{ table: "deduction_schedules", id: "DS-1" }] },
    {
      seq: 1,
      kind: "load_pay",
      label: "Load pay, 2 loads",
      amountCents: 240_000,
      sources: [
        { table: "loads", id: "L-1" },
        { table: "loads", id: "L-2" },
      ],
    },
  ],
  grossCents: 258_000,
  deductionsCents: 15_500,
  netCents: 242_500,
  carryForwardCents: 0,
  exceptions: [],
  hrefFor,
};

const rowLabels = (title: string) => {
  const group = screen.getByText(title).closest("tbody");
  return within(group as HTMLElement)
    .getAllByRole("link")
    .map((a) => a.textContent);
};

describe("Paystub", () => {
  it("links every line to its first record", () => {
    render(<Paystub {...props} />);
    for (const line of props.lines) {
      const link = screen.getByRole("link", { name: line.label });
      expect(link.getAttribute("href")).toBe(hrefFor(line.sources[0]));
    }
    expect(screen.getByText("and 1 more record")).toBeTruthy();
  });

  it("groups earnings and deductions and orders each by seq", () => {
    render(<Paystub {...props} />);
    expect(rowLabels("Earnings")).toEqual(["Load pay, 2 loads", "Load L-2", "Reimbursements"]);
    expect(rowLabels("Deductions")).toEqual(["Insurance", "Escrow"]);
  });

  it("shows the net it was given, never a sum of its own", () => {
    render(<Paystub {...props} netCents={100_001} />);
    expect(screen.getByTestId("net-pay").textContent).toBe("$1,000.01");
    expect(screen.queryByText("$2,425.00")).toBeNull();
  });

  it("shows the carried shortfall only when it is not zero, as an add-back with a caption", () => {
    const { rerender } = render(<Paystub {...props} />);
    expect(screen.queryByText("Shortfall carried to next period")).toBeNull();
    expect(screen.queryByText("Taken from next period's pay.")).toBeNull();
    rerender(<Paystub {...props} carryForwardCents={1_250} />);
    expect(screen.getByText("Shortfall carried to next period")).toBeTruthy();
    expect(screen.getByText("+$12.50").hasAttribute("data-negative")).toBe(false);
    const caption = screen.getByText("Taken from next period's pay.");
    expect(caption.className).toContain("text-foreground-2");
  });

  it("names the paystub by driver and period", () => {
    render(<Paystub {...props} />);
    expect(screen.getByRole("region", { name: "Paystub for Sample Driver, Oct 26 to Nov 1, 2026" })).toBeTruthy();
  });

  it("raises an exception in words with links to its records", () => {
    const exception = {
      category: "unmatched_fuel",
      label: "A fuel purchase has no matching load",
      sources: [{ table: "fuel_purchases", id: "FP-1" }],
    };
    render(<Paystub {...props} exceptions={[exception]} />);
    const alert = screen.getByText(exception.label).closest("[role]") as HTMLElement;
    expect(alert.getAttribute("role")).toBe("status");
    expect(within(alert).getByRole("link", { name: "Fuel purchase FP-1" }).getAttribute("href")).toBe("#fuel_purchases-FP-1");
  });

  it("shows a record the link rules do not know as plain text, without a link", () => {
    const lines = [
      {
        seq: 1,
        kind: "load_pay",
        label: "Load pay, 1 load",
        amountCents: 240_000,
        sources: [
          { table: "users", id: "U-1" },
          { table: "loads", id: "L-1" },
          { table: "trips", id: "T-9" },
        ],
      },
    ];
    const exception = { category: "unmatched_fuel", label: "A fuel purchase has no load", sources: [{ table: "users", id: "U-2" }] };
    // No hrefFor: the default record links refuse the unknown tables.
    render(<Paystub {...props} lines={lines} exceptions={[exception]} hrefFor={undefined} />);
    expect(screen.getByText("Load pay, 1 load").closest("a")).toBeNull();
    expect(screen.getByText("Trips T-9").closest("a")).toBeNull();
    expect(screen.getByText("Users U-2").closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "Load L-1" }).getAttribute("href")).toBe("/records/loads/L-1");
  });

  it("puts a single rule over each subtotal and a double rule under the net", () => {
    render(<Paystub {...props} />);
    expect(screen.getByText("$2,580.00").closest("td")?.className).toContain("rule-single");
    expect(screen.getByText("−$155.00").closest("td")?.className).toContain("rule-single");
    expect(screen.getByTestId("net-pay").className).toContain("rule-double");
  });

  it("names the pay rules the week was paid under, linked only when a page is given", () => {
    render(<Paystub {...props} payRules={{ from: "2026-10-19", href: "/settings/pay-rules" }} />);
    expect(screen.getByRole("link", { name: "Paid under rules from Oct 19" }).getAttribute("href")).toBe(
      "/settings/pay-rules",
    );
    cleanup();
    render(<Paystub {...props} payRules={{ from: "2026-10-19" }} />);
    expect(screen.getByText("Paid under rules from Oct 19").closest("a")).toBeNull();
    cleanup();
    render(<Paystub {...props} />);
    expect(screen.queryByText(/Paid under rules/)).toBeNull();
  });
});
