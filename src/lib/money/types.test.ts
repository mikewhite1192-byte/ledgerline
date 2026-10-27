import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MONEY_FAILURES, OUTSIDE_SYSTEMS, SIM_BEHAVIORS } from "./types";

// The lists the code and the newest migration hold must be the same, value for value: a value
// only one side knows is a row the database refuses, or a category the code cannot name.
const SQL = readFileSync(path.join(process.cwd(), "db/migrations/0017_driver_cards.sql"), "utf8");

function listAfter(marker: string): string[] {
  const at = SQL.indexOf(marker);
  if (at < 0) throw new Error(`missing ${marker}`);
  const open = SQL.indexOf("(", at + marker.length);
  const close = SQL.indexOf(")", open);
  return [...SQL.slice(open + 1, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("the money vocabulary against migration 0017", () => {
  it("holds the same outside systems", () => {
    expect(listAfter("CHECK (outside_system IN")).toEqual([...OUTSIDE_SYSTEMS]);
  });

  it("holds the same failure categories, declined among them", () => {
    expect(listAfter("CHECK (failure_category IN")).toEqual([...MONEY_FAILURES]);
    expect(MONEY_FAILURES).toContain("declined");
  });

  it("holds the same simulated card behaviors", () => {
    expect(listAfter("CHECK (sim_behavior IN")).toEqual([...SIM_BEHAVIORS]);
  });
});
