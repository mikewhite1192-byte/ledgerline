import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIND_SHAPES, MONEY_ACTION_KINDS, OUTSIDE_SYSTEMS } from "./types";

// The money_actions lists and pairings, read from the migration texts, no database. 0060
// (FACTORING) and 0048 (MONEY-CODE) each re-create the same block, and production applies
// migrations in merge order while a fresh database applies them in number order, so whichever
// runs last decides what the table takes. The rule that keeps both orders equal: every
// re-creation from 0048 on lists the full union the code knows, and the newest one matches it.

const DIR = path.join(process.cwd(), "db/migrations");
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const UNION_FROM = "0048";

// SQL with -- line comments removed, so a comment that names a check is never read as one.
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

type Listing = { version: string; values: string[] };

// Fixed patterns, matched by constraint name afterwards: any ADD CONSTRAINT, one with a CHECK,
// and a CHECK of the form "<column> IN (...)".
const ADD_ANY = /ADD\s+CONSTRAINT\s+(\w+)/gi;
const ADD_CHECK = /ADD\s+CONSTRAINT\s+(\w+)\s+CHECK/gi;
const ADD_IN = /ADD\s+CONSTRAINT\s+(\w+)\s+CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)/gi;
const DROPPED = /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+(\w+)/gi;

const named = (re: RegExp, sql: string, name: string) =>
  [...sql.matchAll(re)].filter((m) => m[1].toLowerCase() === name);

// Each "ADD CONSTRAINT <name> CHECK (<column> IN (...))" in number order. A re-creation the
// parser cannot read fails the test, never is skipped.
function recreations(name: string, column: string): Listing[] {
  const out: Listing[] = [];
  for (const { version, sql } of migrations()) {
    const read = named(ADD_IN, sql, name).filter((m) => m[2].toLowerCase() === column);
    const adds = named(ADD_ANY, sql, name).length;
    expect(read.length, `${version} re-creates ${name} in a shape this test cannot read`).toBe(adds);
    for (const m of read) out.push({ version, values: quoted(m[3]) });
  }
  return out;
}

// The single "ADD CONSTRAINT <name> CHECK (...)" body of the newest migration that has one.
function newestBody(name: string): { version: string; body: string } {
  let found: { version: string; body: string } | null = null;
  for (const { version, sql } of migrations()) {
    const first = named(ADD_CHECK, sql, name)[0];
    if (!first || first.index === undefined) continue;
    const at = first.index;
    const end = sql.indexOf(";", at);
    found = { version, body: sql.slice(at, end) };
  }
  if (!found) throw new Error(`no migration adds ${name}`);
  return found;
}

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
const kindsWhere = (pick: (s: (typeof KIND_SHAPES)[keyof typeof KIND_SHAPES]) => boolean) =>
  sorted(MONEY_ACTION_KINDS.filter((k) => pick(KIND_SHAPES[k])));

describe("money_actions lists across the migrations", () => {
  const lists = [
    { name: "money_actions_kind_check", column: "kind", code: sorted(MONEY_ACTION_KINDS) },
    {
      name: "money_actions_subject_table_check",
      column: "subject_table",
      code: sorted(Object.values(KIND_SHAPES).map((s) => s.subjectTable)),
    },
    { name: "money_actions_outside_system_check", column: "outside_system", code: sorted(OUTSIDE_SYSTEMS) },
  ];

  for (const { name, column, code } of lists) {
    it(`every ${name} re-creation from ${UNION_FROM} on lists the full union the code knows`, () => {
      const since = recreations(name, column).filter((l) => l.version >= UNION_FROM);
      expect(since.length).toBeGreaterThan(0);
      for (const l of since) expect(sorted(l.values), `${l.version} ${name}`).toEqual(code);
    });
  }
});

describe("money_actions pairings in the newest migration", () => {
  it("the payment channel is exactly the code's payment kinds", () => {
    const { body } = newestBody("money_actions_channel_pairing");
    expect(body).toMatch(/channel\s*=\s*'payment'/);
    expect(sorted(quoted(body.replace(/channel\s*=\s*'payment'/, "")))).toEqual(kindsWhere((s) => s.channel === "payment"));
  });

  it("an invoices subject is exactly the code's invoice kinds", () => {
    const { body } = newestBody("money_actions_invoice_subject_pairing");
    expect(body).toMatch(/subject_table\s*=\s*'invoices'/);
    expect(sorted(quoted(body.replace(/subject_table\s*=\s*'invoices'/, "")))).toEqual(
      kindsWhere((s) => s.subjectTable === "invoices"),
    );
  });

  it("a customers counterparty is exactly the code's customer kinds", () => {
    const { body } = newestBody("money_actions_counterparty_pairing");
    expect(body).toMatch(/counterparty_table\s*=\s*'customers'/);
    expect(sorted(quoted(body.replace(/counterparty_table\s*=\s*'customers'/, "")))).toEqual(
      kindsWhere((s) => s.counterpartyTable === "customers"),
    );
  });

  it("drops 0006's unnamed pairings by the names Postgres gave them", () => {
    const { version } = newestBody("money_actions_channel_pairing");
    const sql = migrations().find((m) => m.version === version)!.sql;
    const dropped = [...sql.matchAll(DROPPED)].map((m) => m[1].toLowerCase());
    for (const old of ["money_actions_check2", "money_actions_check5", "money_actions_check7"]) {
      expect(dropped, old).toContain(old);
    }
  });
});
