import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import { KIND_SHAPES, MONEY_ACTION_KINDS, OUTSIDE_SYSTEMS } from "./types";

// The ledger's kind, subject, system and pairing checks, read from the migration texts, no
// database. 0047 (FACTORING) and 0048 (MONEY-CODE) each re-create them with one identical block,
// and production applies migrations in merge order while a fresh database applies them in number
// order, so whichever runs last decides the constraints. The rule that keeps both orders equal:
// every re-creation lists the full union the code knows. A value missing there would be refused by
// the database (23514) after the code had shipped.

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

// Each "ADD CONSTRAINT <name> CHECK (<lead> IN (...)<tail>)", in number order. A re-creation this
// parser cannot read fails the test, never is skipped.
function listings(name: string, lead: string): Listing[] {
  const out: Listing[] = [];
  const re = new RegExp(`ADD\\s+CONSTRAINT\\s+${name}\\s+CHECK\\s*\\(\\s*${lead}\\s+IN\\s*\\(([^)]*)\\)`, "gi");
  for (const { version, sql } of MIGRATIONS) {
    const read = [...sql.matchAll(re)].map((m) => ({ version, values: quoted(m[1]) }));
    const named = (sql.match(new RegExp(`ADD\\s+CONSTRAINT\\s+${name}\\b`, "gi")) ?? []).length;
    expect(named, `${version}: every ${name} re-creation is readable`).toBe(read.length);
    out.push(...read);
  }
  return out;
}

const sorted = (values: readonly string[]) => [...values].sort();
const kindsWhere = (pick: (k: keyof typeof KIND_SHAPES) => boolean) => MONEY_ACTION_KINDS.filter(pick);
const SUBJECT_TABLES = [...new Set(MONEY_ACTION_KINDS.map((k) => KIND_SHAPES[k].subjectTable))];

describe("the money ledger checks in the migration texts", () => {
  it("lists every money kind in each kind check re-creation", () => {
    const found = listings("money_actions_kind_check", "kind");
    expect(found.map((l) => l.version)).toContain("0048");
    for (const l of found) expect(sorted(l.values), l.version).toEqual(sorted(MONEY_ACTION_KINDS));
  });

  it("lists every subject table in each subject check re-creation", () => {
    const found = listings("money_actions_subject_table_check", "subject_table");
    expect(found.length).toBeGreaterThan(0);
    for (const l of found) expect(sorted(l.values), l.version).toEqual(sorted(SUBJECT_TABLES));
  });

  it("lists every outside system in each re-creation from the money-code block on", () => {
    const found = listings("money_actions_outside_system_check", "outside_system");
    const union = found.filter((l) => l.version >= "0047");
    expect(union.length).toBeGreaterThan(0);
    for (const l of union) expect(sorted(l.values), l.version).toEqual(sorted(OUTSIDE_SYSTEMS));
  });

  it("pairs channel, subject and counterparty exactly as the code's kind shapes do", () => {
    const channel = listings("money_actions_channel_pairing", "\\(\\s*channel\\s*=\\s*'payment'\\s*\\)\\s*=\\s*\\(\\s*kind");
    const invoice = listings("money_actions_invoice_subject_pairing", "\\(\\s*kind");
    const counterparty = listings(
      "money_actions_counterparty_pairing",
      "\\(\\s*counterparty_table\\s*=\\s*'customers'\\s*\\)\\s*=\\s*\\(\\s*kind",
    );
    for (const found of [channel, invoice, counterparty]) expect(found.length).toBeGreaterThan(0);
    for (const l of channel) {
      expect(sorted(l.values), l.version).toEqual(sorted(kindsWhere((k) => KIND_SHAPES[k].channel === "payment")));
    }
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
      ["money_actions_check2", "money_actions_channel_pairing"],
      ["money_actions_check5", "money_actions_invoice_subject_pairing"],
      ["money_actions_check7", "money_actions_counterparty_pairing"],
    ] as const;
    for (const { version, sql } of MIGRATIONS) {
      for (const [unnamed, named] of pairs) {
        if (new RegExp(`DROP\\s+CONSTRAINT\\s+(IF\\s+EXISTS\\s+)?${unnamed}\\b`, "i").test(sql)) {
          expect(new RegExp(`ADD\\s+CONSTRAINT\\s+${named}\\b`, "i").test(sql), `${version}: ${named}`).toBe(true);
        }
      }
    }
  });

  it("pairs the money code kind with its own subject", () => {
    const re = /ADD\s+CONSTRAINT\s+money_actions_money_code_subject_pairing\s+CHECK\s*\(\s*\(\s*kind\s*=\s*'money_code_issue'\s*\)\s*=\s*\(\s*subject_table\s*=\s*'money_codes'\s*\)\s*\)/i;
    const at = MIGRATIONS.filter((m) => re.test(m.sql)).map((m) => m.version);
    expect(at).toContain("0048");
    expect(KIND_SHAPES.money_code_issue.subjectTable).toBe("money_codes");
  });
});

describe("0048's proposal kind check", () => {
  it("lists the 14-kind union, which holds every kind the code knows", () => {
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
    for (const kind of PROPOSAL_KINDS) expect(kinds).toContain(kind);
  });
});
