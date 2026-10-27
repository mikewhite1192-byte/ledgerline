// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable, type Column } from "./data-table";
import { Money } from "./money";

afterEach(cleanup);

type Row = { id: string; payCents: number };
const columns: Column<Row>[] = [
  { key: "id", header: "Load", cell: (r) => r.id },
  { key: "pay", header: "Driver pay", align: "right", cell: (r) => <Money cents={r.payCents} /> },
];
const rows: Row[] = [
  { id: "L-1", payCents: 75_000 },
  { id: "L-2", payCents: 60_000 },
];
const base = { caption: "Loads", columns, rows, rowKey: (r: Row) => r.id };
const EMPTY = { title: "No loads this week" };

describe("DataTable", () => {
  it("shows the rows when ready, with money on the right edge", () => {
    render(<DataTable {...base} empty={EMPTY} />);
    const table = screen.getByRole("table", { name: "Loads" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const cell = screen.getByText("$750.00").closest("td");
    expect(cell?.className).toContain("text-right");
    expect(cell?.className).toContain("tabular-nums");
    expect(screen.queryByText(EMPTY.title)).toBeNull();
  });

  it("shows skeletons and marks the table busy while loading", () => {
    render(<DataTable {...base} rows={[]} state="loading" empty={EMPTY} />);
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("L-1")).toBeNull();
    expect(screen.queryByText(EMPTY.title)).toBeNull();
  });

  it("says it is loading in words a screen reader hears, and only while loading", () => {
    const { rerender } = render(<DataTable {...base} state="loading" />);
    expect(screen.getByRole("table", { name: "Loads, loading" })).toBeTruthy();
    expect(screen.getByText(", loading").className).toContain("sr-only");
    rerender(<DataTable {...base} />);
    expect(screen.getByRole("table", { name: "Loads" })).toBeTruthy();
    expect(screen.queryByText(", loading")).toBeNull();
  });

  it("shows the empty copy when there are no rows", () => {
    render(<DataTable {...base} rows={[]} empty={EMPTY} />);
    expect(screen.getByText(EMPTY.title)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an alert, never the empty copy, when the read failed", () => {
    render(<DataTable {...base} rows={[]} state="error" empty={EMPTY} error={{ category: "unreadable" }} />);
    expect(within(screen.getByRole("alert")).getByText("Could not read your carrier's data")).toBeTruthy();
    expect(screen.queryByText(EMPTY.title)).toBeNull();
  });
});
