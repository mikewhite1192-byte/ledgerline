import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import { TABLES } from "../rules-engine/types";

// The proposals table's kind and subject checks, read from the migration texts, no database.
// Several migrations re-create proposals_kind_check, and production applies them in merge order
// while a fresh database applies them in number order, so whichever runs last decides which kinds
// the table takes. The rule that keeps both orders equal: every re-creation lists the full union,
// and the newest one lists every kind the code knows. A kind missing there would be refused by the
// database (23514) on a fresh build, after the code had shipped.

const DIR = path.join(process.cwd(), "db/migrations");
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

// Kinds a migration lists before their code is on the mainline: harmless in an allow list.
// card_match is CARD-RECON's (0046), listed by 0048 so whichever of the two runs last keeps it.
const PENDING_KINDS = ["settlement_approve", "pay_rule_change", "card_match"] as const;

// The union every re-creation since 0022 has listed (the queue's rule).
const BASE_UNION = [
  "advance_payout",
  "pay_correction",
  "invoice_fix",
  "load_rate_fill",
  "invoice_post",
  "payment_reapply",
  "settlement_approve",
  "detention_charge",
] as const;

type Listing = { version: string; kinds: string[] };

// SQL with -- line comments removed, so a comment that names the check is never read as one.
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function quoted(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function migrations(): { version: string; sql: string }[] {
  return readdirSync(DIR)
    .filter((f) => FILE.test(f))
    .sort()
    .map((f) => ({ version: f.slice(0, 4), sql: withoutComments(readFileSync(path.join(DIR, f), "utf8")) }));
}

// Each "ADD CONSTRAINT proposals_kind_check CHECK (kind IN (...))", in number order.
function kindRecreations(): Listing[] {
  const out: Listing[] = [];
  for (const { version, sql } of migrations()) {
    const re = /ADD\s+CONSTRAINT\s+proposals_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/gi;
    for (const m of sql.matchAll(re)) out.push({ version, kinds: quoted(m[1]) });
    // A re-creation this parser cannot read must fail the test, never be skipped.
    const named = (sql.match(/ADD\s+CONSTRAINT\s+proposals_kind_check\b/gi) ?? []).length;
    expect(named, `${version}: every proposals_kind_check re-creation is readable`).toBe(
      out.filter((l) => l.version === version).length,
    );
  }
  return out;
}

// The subject list: 0009's inline column check, then each re-creation, in number order.
function subjectListings(): Listing[] {
  const out: Listing[] = [];
  for (const { version, sql } of migrations()) {
    const inline = /subject_table\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*subject_table\s+IN\s*\(([^)]*)\)\s*\)/gi;
    const added = /ADD\s+CONSTRAINT\s+proposals_subject_table_check\s+CHECK\s*\(\s*subject_table\s+IN\s*\(([^)]*)\)\s*\)/gi;
    if (version === "0009") for (const m of sql.matchAll(inline)) out.push({ version, kinds: quoted(m[1]) });
    for (const m of sql.matchAll(added)) out.push({ version, kinds: quoted(m[1]) });
  }
  return out;
}

describe("the proposals kind check in the migration texts", () => {
  const listings = kindRecreations();
  const newest = listings[listings.length - 1];

  it("finds the re-creations, 0029 among them", () => {
    expect(listings.map((l) => l.version)).toEqual(expect.arrayContaining(["0013", "0015", "0022", "0029"]));
    expect(Number(newest.version)).toBeGreaterThanOrEqual(29);
  });

  it("has the newest re-creation list every kind the code knows", () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(newest.kinds, `${newest.version} lists ${kind}`).toContain(kind);
    }
  });

  it("never narrows: the newest lists every kind any migration ever listed", () => {
    const ever = new Set(listings.flatMap((l) => l.kinds));
    for (const kind of ever) expect(newest.kinds, `${newest.version} keeps ${kind}`).toContain(kind);
  });

  it("lists, in the newest, only kinds the code knows or a named pending kind", () => {
    const known = new Set<string>([...PROPOSAL_KINDS, ...PENDING_KINDS]);
    for (const kind of newest.kinds) expect(known.has(kind), `${kind} is known`).toBe(true);
  });

  it("keeps every list well formed and every re-creation since 0022 on the full base union", () => {
    for (const { version, kinds } of listings) {
      expect(new Set(kinds).size, `${version} has no duplicate`).toBe(kinds.length);
      for (const kind of kinds) expect(kind, version).toMatch(/^[a-z_]{3,40}$/);
      if (Number(version) >= 22) expect(kinds, version).toEqual(expect.arrayContaining([...BASE_UNION]));
    }
  });

  it("lists the twelve kinds in 0029, in the order every branch uses", () => {
    expect(listings.find((l) => l.version === "0029")?.kinds).toEqual([
      ...BASE_UNION,
      "factoring_request",
      "bill_defer",
      "collections_chase",
      "pay_rule_change",
    ]);
  });
});

describe("the proposals subject check in the migration texts", () => {
  it("has the newest subject list take every citable table, vendor bills included", () => {
    const listings = subjectListings();
    expect(listings[0]?.version).toBe("0009");
    const newest = listings[listings.length - 1];
    expect(new Set(newest.kinds).size).toBe(newest.kinds.length);
    expect([...newest.kinds].sort()).toEqual([...TABLES].sort());
    expect(newest.kinds).toContain("vendor_bills");
  });
});
