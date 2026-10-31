import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import { KIND_SHAPES, MONEY_ACTION_KINDS, OUTSIDE_SYSTEMS } from "./types";

// The ledger's kind, subject, system and pairing checks, read from the migration texts, no
// database. 0048 (MONEY-CODE) and 0060 (FACTORING) each re-create them with one identical block,
// and production applies migrations in merge order while a fresh database applies them in number
// order, so whichever runs last decides the constraints. The rule that keeps both orders equal:
// every re-creation lists the full union the code knows. A value missing there would be refused by
// the database (23514) after the code had shipped. 0069 (ESCROW-RELEASE) adds the escrow kind and
// its subject after both had run everywhere, so for the kind, subject and channel checks the newest
// re-creation is the full union and each earlier one lists only values the code still knows.

const DIR = path.join(process.cwd(), "db/migrations");
const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

type Listing = { version: string; values: string[] };

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

const MIGRATIONS = readdirSync(DIR)
  .filter((f) => FILE.test(f))
  .sort()
  .map((f) => ({ version: f.slice(0, 4), sql: withoutComments(readFileSync(path.join(DIR, f), "utf8")) }));

// Each "ADD CONSTRAINT <name> CHECK (<lead> IN (...)<tail>)", in number order. `readable` matches a
// re-creation this parser can read (its list in group 1) and `every` matches each re-creation of
// the same name, so one the parser cannot read fails the test, never is skipped. Both are literal
// patterns written at each call.
function listings(readable: RegExp, every: RegExp): Listing[] {
  const out: Listing[] = [];
  for (const { version, sql } of MIGRATIONS) {
    const read = [...sql.matchAll(readable)].map((m) => ({ version, values: quoted(m[1]) }));
    const named = (sql.match(every) ?? []).length;
    expect(named, `${version}: every ${every.source} re-creation is readable`).toBe(read.length);
    out.push(...read);
  }
  return out;
}

const sorted = (values: readonly string[]) => [...values].sort();

// The newest re-creation (number order) lists exactly the code's union; each earlier one is part
// of it, so no value the code dropped is still allowed.
function newestIsTheUnion(found: Listing[], union: readonly string[]): string {
  expect(found.length).toBeGreaterThan(0);
  const newest = found[found.length - 1];
  expect(sorted(newest.values), newest.version).toEqual(sorted(union));
  for (const l of found) for (const v of l.values) expect(union, `${l.version}: ${v}`).toContain(v);
  return newest.version;
}
const kindsWhere = (pick: (k: keyof typeof KIND_SHAPES) => boolean) => MONEY_ACTION_KINDS.filter(pick);
const SUBJECT_TABLES = [...new Set(MONEY_ACTION_KINDS.map((k) => KIND_SHAPES[k].subjectTable))];

describe("the money ledger checks in the migration texts", () => {
  it("lists every money kind in each kind check re-creation", () => {
    const found = listings(
      /ADD\s+CONSTRAINT\s+money_actions_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi,
      /ADD\s+CONSTRAINT\s+money_actions_kind_check\b/gi,
    );
    expect(found.map((l) => l.version)).toContain("0048");
    expect(found.map((l) => l.version)).toContain("0060");
    expect(newestIsTheUnion(found, MONEY_ACTION_KINDS)).toBe("0069");
  });

  it("lists every subject table in each subject check re-creation", () => {
    const found = listings(
      /ADD\s+CONSTRAINT\s+money_actions_subject_table_check\s+CHECK\s*\(\s*subject_table\s+IN\s*\(([^)]*)\)/gi,
      /ADD\s+CONSTRAINT\s+money_actions_subject_table_check\b/gi,
    );
    expect(newestIsTheUnion(found, SUBJECT_TABLES)).toBe("0069");
  });

  it("lists every outside system in each re-creation from the money-code block on", () => {
    const found = listings(
      /ADD\s+CONSTRAINT\s+money_actions_outside_system_check\s+CHECK\s*\(\s*outside_system\s+IN\s*\(([^)]*)\)/gi,
      /ADD\s+CONSTRAINT\s+money_actions_outside_system_check\b/gi,
    );
    const union = found.filter((l) => l.version >= "0048");
    expect(union.length).toBeGreaterThan(0);
    for (const l of union) expect(sorted(l.values), l.version).toEqual(sorted(OUTSIDE_SYSTEMS));
  });

  it("pairs channel, subject and counterparty exactly as the code's kind shapes do", () => {
    const channel = listings(
      /ADD\s+CONSTRAINT\s+money_actions_channel_pairing\s+CHECK\s*\(\s*\(\s*channel\s*=\s*'payment'\s*\)\s*=\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi,
      /ADD\s+CONSTRAINT\s+money_actions_channel_pairing\b/gi,
    );
    const invoice = listings(
      /ADD\s+CONSTRAINT\s+money_actions_invoice_subject_pairing\s+CHECK\s*\(\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi,
      /ADD\s+CONSTRAINT\s+money_actions_invoice_subject_pairing\b/gi,
    );
    const counterparty = listings(
      /ADD\s+CONSTRAINT\s+money_actions_counterparty_pairing\s+CHECK\s*\(\s*\(\s*counterparty_table\s*=\s*'customers'\s*\)\s*=\s*\(\s*kind\s+IN\s*\(([^)]*)\)/gi,
      /ADD\s+CONSTRAINT\s+money_actions_counterparty_pairing\b/gi,
    );
    for (const found of [channel, invoice, counterparty]) expect(found.length).toBeGreaterThan(0);
    expect(newestIsTheUnion(channel, kindsWhere((k) => KIND_SHAPES[k].channel === "payment"))).toBe("0069");
    for (const l of invoice) {
      // The list, then the subject it pairs with: "(kind IN (...)) = (subject_table = 'invoices')".
      expect(sorted(l.values), l.version).toEqual(
        sorted(kindsWhere((k) => KIND_SHAPES[k].subjectTable === "invoices")),
      );
    }
    for (const l of counterparty) {
      expect(sorted(l.values), l.version).toEqual(
        sorted(kindsWhere((k) => KIND_SHAPES[k].counterpartyTable === "customers")),
      );
    }
  });

  it("drops each unnamed 0006 pairing only where it adds the named one back", () => {
    const pairs = [
      [/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?money_actions_check2\b/i, /ADD\s+CONSTRAINT\s+money_actions_channel_pairing\b/i],
      [/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?money_actions_check5\b/i, /ADD\s+CONSTRAINT\s+money_actions_invoice_subject_pairing\b/i],
      [/DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?money_actions_check7\b/i, /ADD\s+CONSTRAINT\s+money_actions_counterparty_pairing\b/i],
    ] as const;
    for (const { version, sql } of MIGRATIONS) {
      for (const [dropped, added] of pairs) {
        if (dropped.test(sql)) expect(added.test(sql), `${version}: ${added.source}`).toBe(true);
      }
    }
  });

  it("pairs the money code kind with its own subject", () => {
    const re = /ADD\s+CONSTRAINT\s+money_actions_money_code_subject_pairing\s+CHECK\s*\(\s*\(\s*kind\s*=\s*'money_code_issue'\s*\)\s*=\s*\(\s*subject_table\s*=\s*'money_codes'\s*\)\s*\)/i;
    const at = MIGRATIONS.filter((m) => re.test(m.sql)).map((m) => m.version);
    expect(at).toContain("0048");
    expect(KIND_SHAPES.money_code_issue.subjectTable).toBe("money_codes");
  });

  it("pairs the escrow release kind with its own subject", () => {
    const re = /ADD\s+CONSTRAINT\s+money_actions_escrow_subject_pairing\s+CHECK\s*\(\s*\(\s*kind\s*=\s*'escrow_release'\s*\)\s*=\s*\(\s*subject_table\s*=\s*'escrow_releases'\s*\)\s*\)/i;
    const at = MIGRATIONS.filter((m) => re.test(m.sql)).map((m) => m.version);
    expect(at).toEqual(["0069"]);
    expect(KIND_SHAPES.escrow_release.subjectTable).toBe("escrow_releases");
  });
});

// Kinds added by a later re-creation of the proposal check, which lists 0048's fourteen first.
const AFTER_0048 = ["pay_policy_setup", "load_create", "escrow_release", "load_move", "card_load_ruling"];

describe("0048's proposal kind check", () => {
  it("lists the 14-kind union, which holds every kind the code knew then", () => {
    const sql = MIGRATIONS.find((m) => m.version === "0048")?.sql ?? "";
    const m = /ADD\s+CONSTRAINT\s+proposals_kind_check\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
    expect(m).not.toBeNull();
    const kinds = quoted(m?.[1] ?? "");
    expect(kinds).toEqual([
      "advance_payout",
      "pay_correction",
      "invoice_fix",
      "load_rate_fill",
      "invoice_post",
      "payment_reapply",
      "settlement_approve",
      "detention_charge",
      "factoring_request",
      "bill_defer",
      "collections_chase",
      "pay_rule_change",
      "card_match",
      "money_code",
    ]);
    for (const kind of PROPOSAL_KINDS) {
      if (!AFTER_0048.includes(kind)) expect(kinds).toContain(kind);
    }
  });
});
