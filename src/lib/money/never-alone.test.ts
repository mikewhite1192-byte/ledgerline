import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { PROPOSAL_KINDS } from "../agent/gateway/types";
import {
  AUTO_ALLOWED_KINDS,
  autoAllowed,
  isNeverAloneKind,
  isNeverAloneRefusal,
  namedPersonRequired,
  NEVER_ALONE_KINDS,
  NEVER_ALONE_REFUSALS,
  rejectAllowed,
} from "./never-alone";

// The never-alone lists and checks, pure: every kind the code and the database know sits in
// exactly one of the two sets, the database's allowlist is the code's, and each check fails
// closed on a value it does not know.

const DIR = path.join(process.cwd(), "db/migrations");
const read = (name: string) =>
  readFileSync(path.join(DIR, name), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
const quoted = (list: string) => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
const sorted = (values: readonly string[]) => [...values].sort();

// The kinds 0070's autopilot_rules kind check lists (no later file re-creates it).
function ruleKinds(): string[] {
  const m = read("0070_autopilot.sql").match(/kind\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i);
  if (!m) throw new Error("0070 kind check not found");
  return quoted(m[1]);
}

describe("the two sets", () => {
  it("puts every proposal kind and every rule kind in exactly one of Auto allowed and never alone", () => {
    const allowed = new Set<string>(AUTO_ALLOWED_KINDS);
    const never = new Set<string>(NEVER_ALONE_KINDS);
    for (const kind of new Set<string>([...PROPOSAL_KINDS, ...ruleKinds()])) {
      expect(Number(allowed.has(kind)) + Number(never.has(kind)), kind).toBe(1);
    }
    expect(sorted([...AUTO_ALLOWED_KINDS, ...NEVER_ALONE_KINDS])).toEqual(sorted(PROPOSAL_KINDS));
    expect(new Set(NEVER_ALONE_KINDS).size).toBe(NEVER_ALONE_KINDS.length);
    // Every allowed kind is a real proposal kind.
    for (const kind of AUTO_ALLOWED_KINDS) expect(PROPOSAL_KINDS as readonly string[]).toContain(kind);
  });

  it("keeps settlement_approve, escrow_release and the pay rule kinds for a person (D-072)", () => {
    for (const kind of [
      "settlement_approve",
      "escrow_release",
      "pay_correction",
      "pay_rule_change",
      "pay_policy_setup",
      "detention_charge",
      "factoring_request",
      "bill_defer",
      "collections_chase",
      "load_create",
      "load_rate_fill",
      "invoice_fix",
      "load_move",
      "card_load_ruling",
      "card_pullback",
    ]) {
      expect(NEVER_ALONE_KINDS, kind).toContain(kind);
    }
  });

  it("lists in 0077's check exactly the code's allowlist, in the check and in the narrowing", () => {
    const sql = read("0077_never_alone.sql");
    const validate = read("0077_never_alone_validate.sql");
    const check = sql.match(/ADD\s+CONSTRAINT\s+autopilot_rules_auto_allowlist\s+CHECK\s*\(\s*mode\s*<>\s*'auto'\s+OR\s+kind\s+IN\s*\(([^)]*)\)\s*\)\s*NOT\s+VALID\s*;/i);
    expect(check).not.toBeNull();
    expect(sorted(quoted(check?.[1] ?? ""))).toEqual(sorted(AUTO_ALLOWED_KINDS));
    // 0077 only adds the check; the narrowing runs in the validate file, before its VALIDATE.
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    const narrow = validate.match(/UPDATE\s+autopilot_rules\s+SET\s+mode\s*=\s*'ask',\s*version\s*=\s*version\s*\+\s*1[^;]*kind\s+NOT\s+IN\s*\(([^)]*)\)\s*;/i);
    expect(narrow).not.toBeNull();
    expect(sorted(quoted(narrow?.[1] ?? ""))).toEqual(sorted(AUTO_ALLOWED_KINDS));
    const validated = validate.search(
      /ALTER\s+TABLE\s+autopilot_rules\s+VALIDATE\s+CONSTRAINT\s+autopilot_rules_auto_allowlist\s*;/i,
    );
    expect(validated).toBeGreaterThan(-1);
    expect(narrow?.index ?? -1).toBeGreaterThan(-1);
    expect(narrow?.index ?? Infinity).toBeLessThan(validated);
  });

  it("lets the autopilot switch list only allowed kinds", () => {
    for (const kind of Object.keys(flags.autopilot.kinds)) expect(autoAllowed(kind), kind).toBe(true);
  });
});

describe("the checks", () => {
  it("reads whole values only", () => {
    expect(autoAllowed("invoice_post")).toBe(true);
    expect(autoAllowed("invoice_post ")).toBe(false);
    expect(autoAllowed("INVOICE_POST")).toBe(false);
    expect(autoAllowed("toString")).toBe(false);
    expect(autoAllowed(7)).toBe(false);
    expect(isNeverAloneKind("escrow_release")).toBe(true);
    expect(isNeverAloneKind("invoice_post")).toBe(false);
    // An unknown kind is not one of the known never-alone kinds, but it still needs a person.
    expect(isNeverAloneKind("toString")).toBe(false);
    expect(isNeverAloneKind(null)).toBe(false);
  });

  it("requires a named person on every kind off the allowlist, unknown ones too", () => {
    for (const kind of NEVER_ALONE_KINDS) expect(namedPersonRequired(kind), kind).toBe(true);
    for (const kind of AUTO_ALLOWED_KINDS) expect(namedPersonRequired(kind), kind).toBe(false);
    for (const kind of ["toString", "", "settlement_approve_x", "Card_match", undefined, null, 1]) {
      expect(namedPersonRequired(kind), String(kind)).toBe(true);
    }
  });

  it("allows a reject only with no ledger row or a failed one", () => {
    expect(rejectAllowed(null)).toBe(true);
    expect(rejectAllowed("failed")).toBe(true);
    for (const state of ["reserved", "sent", "confirmed", "unknown", "", "FAILED", "unreadable"]) {
      expect(rejectAllowed(state), state).toBe(false);
    }
  });

  it("names each refusal once, as a stable code", () => {
    expect(new Set(NEVER_ALONE_REFUSALS).size).toBe(NEVER_ALONE_REFUSALS.length);
    for (const code of NEVER_ALONE_REFUSALS) expect(code).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect(NEVER_ALONE_REFUSALS).toHaveLength(24);
    expect(isNeverAloneRefusal("reject_after_money_moved")).toBe(true);
    expect(isNeverAloneRefusal("send_stub")).toBe(true);
    expect(isNeverAloneRefusal("pay_carrier")).toBe(true);
    expect(isNeverAloneRefusal("toString")).toBe(false);
    expect(isNeverAloneRefusal(3)).toBe(false);
  });
});
