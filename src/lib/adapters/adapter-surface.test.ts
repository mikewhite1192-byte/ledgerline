import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createQboAdapter } from "./accounting/qbo/adapter";
import { createFactoringSim } from "./factoring/sim";
import { createFuelCardSimAdapter } from "./payment/fuel-card-sim";
import { createMockPaymentAdapter } from "./payment/mock";
import { createStripeTestAdapter } from "./payment/stripe-test";
import { tmsSource } from "./tms-source";

// LedgerLine never sends an invoice or an email: an invoice is posted unsent and a person sends it
// from the accounting system. So no adapter has a member that could, and a later change cannot
// add one unnoticed. Checked twice: the declared interfaces, and the members each adapter
// actually has. The one member allowed to say "send" is sendPayout, the payment rail's payout.

const ALLOWED = new Set(["sendPayout"]);
const forbidden = (name: string) => /send|email|mail/i.test(name) && !ALLOWED.has(name);

// Every member an object answers to, its prototypes included.
function membersOf(o: object): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let p: object | null = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Reflect.ownKeys(p)) {
      const d = Reflect.getOwnPropertyDescriptor(p, k);
      if (!out.has(String(k))) out.set(String(k), d && "value" in d ? d.value : undefined);
    }
  }
  return out;
}

// The member names an interface in types.ts declares, at its first level of indentation.
function declared(name: string, file = "types.ts"): string[] {
  const src = readFileSync(join(__dirname, file), "utf8");
  const start = src.indexOf(`export interface ${name} {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^ {2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[(:?]/gm)].map((m) => m[1]);
}

describe("adapter surface: nothing can send an invoice or an email", () => {
  it("the accounting interface declares no send or email member", () => {
    const names = declared("AccountingAdapter");
    expect(names).toContain("createInvoice");
    expect(names).toContain("readBack");
    expect(names.filter((n) => /send|email|mail/i.test(n))).toEqual([]);
  });

  it("the payment interface declares sendPayout and nothing else that sends", () => {
    const names = declared("PaymentAdapter");
    expect(names).toContain("sendPayout");
    expect(names.filter(forbidden)).toEqual([]);
  });

  it("the accounting adapter has no such member at all", () => {
    const names = [...membersOf(createQboAdapter()).keys()];
    expect(names).toContain("createInvoice");
    expect(names.filter((n) => /send|email|mail/i.test(n))).toEqual([]);
  });

  it("each payment adapter's only sending method is sendPayout", () => {
    for (const [name, adapter] of [
      ["mock", createMockPaymentAdapter({ log: () => {} })],
      ["fuel card", createFuelCardSimAdapter({ log: () => {} })],
      ["stripe test", createStripeTestAdapter()],
    ] as const) {
      const methods = [...membersOf(adapter)].filter(([, v]) => typeof v === "function").map(([k]) => k);
      expect(methods, name).toContain("sendPayout");
      expect(methods.filter(forbidden), name).toEqual([]);
    }
  });

  it("the factoring partner declares and has no send or email member", () => {
    const names = declared("FactoringAdapter");
    expect(names).toContain("submitInvoice");
    expect(names.filter(forbidden)).toEqual([]);
    const methods = [...membersOf(createFactoringSim({ log: () => {} }))]
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    expect(methods).toContain("submitInvoice");
    expect(methods.filter(forbidden)).toEqual([]);
  });

  // The dispatch system is read only: no member could write to it, send from it or attach to it.
  it("the dispatch source declares and has only reads", () => {
    const writes = (n: string) => /send|email|mail|create|update|post|put|delete|upload|attach/i.test(n);
    const names = declared("TmsSource", "tms-source/types.ts");
    expect(names).toEqual(["system", "ready", "listLoads", "readLoad", "readHistory", "readDocuments", "readLineItems", "readParty"]);
    expect(names.filter(writes)).toEqual([]);
    const members = [...membersOf(tmsSource({ system: "synthetic" })).keys()];
    expect(members).toContain("readLoad");
    expect(members.filter(writes)).toEqual([]);
    for (const n of ["updateLoad", "createLoad", "postStatus", "putDoc", "deleteLoad", "uploadPod", "attachFile"]) {
      expect(writes(n), n).toBe(true);
    }
  });

  it("the rule itself catches the names it is meant to", () => {
    for (const n of ["sendInvoice", "emailInvoice", "sendEmail", "mailTo", "resend", "SEND"]) {
      expect(forbidden(n), n).toBe(true);
    }
    expect(forbidden("sendPayout")).toBe(false);
    expect(forbidden("createInvoice")).toBe(false);
  });
});
