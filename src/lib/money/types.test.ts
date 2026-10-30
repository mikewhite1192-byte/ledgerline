import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MONEY_FAILURES, OUTSIDE_SYSTEMS, SIM_BEHAVIORS } from "./types";

// The lists the code and the newest migration holding each list must be the same, value for
// value: a value only one side knows is a row the database refuses, or a category the code cannot
// name. 0017 holds all three first; 0047 and 0048 widen the outside systems.
const DIR = path.join(process.cwd(), "db/migrations");
const FILES = readdirSync(DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

function listAfter(marker: string): string[] {
  const newest = FILES.filter((f) => readFileSync(path.join(DIR, f), "utf8").includes(marker)).at(-1);
  if (newest === undefined) throw new Error(`missing ${marker}`);
  const sql = readFileSync(path.join(DIR, newest), "utf8");
  const at = sql.lastIndexOf(marker);
  const open = sql.indexOf("(", at + marker.length);
  const close = sql.indexOf(")", open);
  return [...sql.slice(open + 1, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("the money vocabulary against the newest migration holding each list", () => {
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
