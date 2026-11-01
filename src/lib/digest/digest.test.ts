import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../config/flags";
import { AiError, type AiErrorCategory, type AiResult } from "../ai";
import type { Session } from "../auth/claims";
import { factIdsFor, needsCount, numberFacts, NOT_READ, type FactId, type ReadValues } from "./facts";
import { DIGEST_TEXT_MAX, digestWords } from "./words";
import { DIGEST_FORMAT, DIGEST_PURPOSE, DIGEST_TIMEOUT_MS, digestRequest, draftDigest, factsText, writeDigest, type CompleteFn } from "./write";

const SESSION: Session = { sub: "sub-digest", email: "desk@example.test", tenantId: "00000000-0000-4000-8000-0000000000d1" };

// Wednesday, Friday and the 1st (2026-11-04 is a Wednesday).
const WEDNESDAY = "2026-11-04";
const FRIDAY = "2026-11-06";
const FIRST = "2026-12-01";

const DAILY: ReadValues = {
  card_check: "statement verified",
  card_breaks: 2,
  cancelled: 1,
  hand_loads: 1,
  hand_load_cents: 15_000,
  rulings_waiting: 0,
  parked: 1,
  parked_reasons: "name mismatch",
  advance_cards: 0,
  advances_paid: 3,
  advances_paid_cents: 45_000,
  send: 2,
  fix: 1,
  add: 4,
  past_due: 1,
  past_due_cents: 120_000,
};

const factsFor = (date: string, values: ReadValues = DAILY) => numberFacts(factIdsFor(date), values);

function answer(text: string, status: AiResult["status"] = "ok", costNanocents = 2_500_000_000): AiResult {
  return {
    callId: "c0ffee00-0000-4000-8000-0000000000d1",
    status,
    text,
    toolCalls: [],
    usage: { input: 900, cached: 0, output: 120, reasoning: 40 },
    costNanocents,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
  };
}

const replying = (text: string, status: AiResult["status"] = "ok"): CompleteFn => async () => answer(text, status);

const DRAFT =
  "2 [f2] card breaks and 1 [f7] parked advance wait for you, with 2 [f12] invoices to send and 1 [f13] load to fix. " +
  "Yesterday 1 [f3] trip was cancelled and 3 [f10] advances were paid, $450.00 [f11] in all. " +
  "Billing has 4 [f14] loads to add and 1 [f15] invoice past due.";

const saved = { ...flags.morningDigest };
afterEach(() => {
  flags.morningDigest = { ...saved };
});

describe("the facts", () => {
  it("lists the daily facts, the Friday ones on a Friday and the 1st-of-month ones on the 1st", () => {
    expect(factIdsFor(WEDNESDAY)).toHaveLength(16);
    expect(factIdsFor(FRIDAY).slice(16)).toEqual(["paystubs_paid", "paystubs_net_cents"]);
    expect(factIdsFor(FIRST).slice(16)).toEqual([
      "month_invoices",
      "month_invoice_cents",
      "month_not_posted",
      "ledger_unknown",
      "approval_breaks",
    ]);
  });

  it("numbers the facts in order, and a missing or malformed value is not read, never 0", () => {
    const facts = numberFacts(factIdsFor(WEDNESDAY), { ...DAILY, card_breaks: -1, cancelled: 1.5, send: undefined, card_check: "" });
    expect(facts.map((f) => f.key).slice(0, 3)).toEqual(["f1", "f2", "f3"]);
    for (const id of ["card_breaks", "cancelled", "send", "card_check"] as FactId[]) {
      const f = facts.find((x) => x.id === id);
      expect(f).toMatchObject({ kind: "text", value: NOT_READ, known: false });
    }
    expect(facts.find((f) => f.id === "fix")).toMatchObject({ kind: "int", value: 1, known: true });
  });

  it("counts the needs above zero and known as found", () => {
    expect(needsCount(factsFor(WEDNESDAY))).toBe(4);
    expect(needsCount(factsFor(WEDNESDAY, {}))).toBe(0);
  });

  it("gives the model one fact a line with its tag and money in dollars", () => {
    const text = factsText(factsFor(WEDNESDAY));
    expect(text.split("\n")).toHaveLength(16);
    expect(text).toContain("[f2] Card check differences waiting for a person: 2");
    expect(text).toContain("[f5] Hand loads yesterday, total: $150.00");
    expect(text).toContain("[f16] FYI: past due balance: $1,200.00");
  });
});

describe("the words line", () => {
  it("says what needs a person first, then yesterday, then billing", () => {
    expect(digestWords(factsFor(WEDNESDAY))).toBe(
      "Morning digest. Needs you: 2 card breaks, 1 parked advance (name mismatch), 2 invoices to send, 1 load to fix. " +
        "Card check: statement verified. " +
        "Yesterday: 1 trip cancelled, 1 hand load ($150.00), 3 advances paid ($450.00). " +
        "Billing: SEND 2, FIX 1, ADD 4, FYI 1 past due ($1,200.00).",
    );
  });

  it("says not read for every fact that could not be read, never 0", () => {
    const line = digestWords(factsFor(WEDNESDAY, {}));
    expect(line).toContain("card breaks not read");
    expect(line).toContain("Card check: not read.");
    expect(line).toContain("trips cancelled not read");
    expect(line).toContain("hand loads not read (not read)");
    expect(line).toContain("SEND not read, FIX not read, ADD not read, FYI not read past due (not read)");
    expect(line).not.toMatch(/\b0\b/);
    expect(line.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX);
  });

  it("says nothing needs you when every need is zero", () => {
    const quiet = { ...DAILY, card_breaks: 0, parked: 0, send: 0, fix: 0 };
    expect(digestWords(factsFor(WEDNESDAY, quiet))).toMatch(/^Morning digest\. Needs you: nothing\. /);
  });

  it("adds the week's paystubs on a Friday", () => {
    const line = digestWords(factsFor(FRIDAY, { ...DAILY, paystubs_paid: 5, paystubs_net_cents: 1_234_567 }));
    expect(line).toContain("This week: 5 paystubs paid ($12,345.67).");
    expect(line.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX);
  });

  it("adds last month and the ledger and approval checks on the 1st", () => {
    const line = digestWords(
      factsFor(FIRST, {
        ...DAILY,
        month_invoices: 40,
        month_invoice_cents: 9_876_500,
        month_not_posted: 2,
        ledger_unknown: 1,
        approval_breaks: 0,
      }),
    );
    expect(line).toContain("1 ledger row unknown");
    expect(line).not.toContain("approval break");
    expect(line).toContain("Last month: 40 invoices issued ($98,765.00), 2 not posted.");
    expect(line.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX);
  });

  it("stays within 400 characters by leaving out whole sentences, never cutting one", () => {
    const big = Object.fromEntries(Object.entries(DAILY).map(([k, v]) => [k, typeof v === "number" ? 999_999_999_999 : v]));
    const line = digestWords(factsFor(FIRST, { ...big, month_invoices: 1, month_invoice_cents: 1, month_not_posted: 1, ledger_unknown: 9, approval_breaks: 9 }));
    expect(line.length).toBeLessThanOrEqual(DIGEST_TEXT_MAX);
    expect(line.startsWith("Morning digest. Needs you: ")).toBe(true);
    expect(line.endsWith(".")).toBe(true);
  });
});

describe("the request", () => {
  it("is one capped call with the strict text format", () => {
    const r = digestRequest(factsFor(WEDNESDAY), "trace-1");
    expect(r).toMatchObject({
      purpose: DIGEST_PURPOSE,
      maxOutputTokens: flags.morningDigest.maxOutputTokens,
      maxCostCents: flags.morningDigest.maxCostCents,
      timeoutMs: DIGEST_TIMEOUT_MS,
      traceId: "trace-1",
      format: DIGEST_FORMAT,
    });
    expect(DIGEST_FORMAT.strict).toBe(true);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[1].content).toBe(factsText(factsFor(WEDNESDAY)));
  });
});

describe("the draft", () => {
  const facts = factsFor(WEDNESDAY);
  const words = digestWords(facts);

  it("keeps the model's checked words, with the tags taken out", async () => {
    const d = await draftDigest(facts, replying(JSON.stringify({ text: DRAFT })), SESSION, "t");
    expect(d.category).toBe("drafted");
    expect(d.text).not.toMatch(/\[f\d+\]/);
    expect(d.text).toBe(DRAFT.replace(/ \[f\d+\]/g, ""));
    expect(d.text).toContain("2 card breaks and 1 parked advance wait for you");
    expect(d.cents).toBe(3);
  });

  it("lands the words line on a number not in the list", async () => {
    const d = await draftDigest(facts, replying(JSON.stringify({ text: "7 [f2] card breaks wait for you." })), SESSION, "t");
    expect(d).toMatchObject({ text: words, category: "check_number_mismatch" });
  });

  it("lands the words line on an untagged number", async () => {
    const d = await draftDigest(facts, replying(JSON.stringify({ text: "2 [f2] card breaks and 1 load to fix wait for you." })), SESSION, "t");
    expect(d).toMatchObject({ text: words, category: "check_untagged" });
  });

  it("lands the words line on a tag not in the list", async () => {
    const d = await draftDigest(facts, replying(JSON.stringify({ text: "2 [f99] card breaks wait for you." })), SESSION, "t");
    expect(d).toMatchObject({ text: words, category: "check_unknown_tag" });
  });

  it("lands the words line on a reply that is not the format", async () => {
    const d = await draftDigest(facts, replying("not json"), SESSION, "t");
    expect(d).toMatchObject({ text: words, category: "check_format" });
  });

  it("lands the words line on an incomplete result, still counting its cost", async () => {
    const d = await draftDigest(facts, replying(JSON.stringify({ text: DRAFT }), "incomplete"), SESSION, "t");
    expect(d).toEqual({ text: words, category: "model_incomplete", cents: 3 });
  });

  it("lands the words line on a reply over 400 characters", async () => {
    const long = `${"2 [f2] card breaks wait for you. ".repeat(16)}`.trim();
    const d = await draftDigest(facts, replying(JSON.stringify({ text: long })), SESSION, "t");
    expect(d).toMatchObject({ text: words, category: "check_too_long" });
  });

  const categories: AiErrorCategory[] = [
    "disabled",
    "not_configured",
    "cap",
    "job_cap",
    "too_expensive",
    "rate_limited",
    "unavailable",
    "timeout",
    "bad_request",
    "auth",
    "billing",
    "too_long",
    "network",
    "unknown",
  ];
  it.each(categories)("lands the words line on a model error of %s, keeping only its category", async (category) => {
    const d = await draftDigest(
      facts,
      async () => {
        throw new AiError(category, 503);
      },
      SESSION,
      "t",
    );
    expect(d).toEqual({ text: words, category: `model_${category}` });
  });

  it("lands the words line on any other throw", async () => {
    const d = await draftDigest(
      facts,
      async () => {
        throw new Error("secret upstream text");
      },
      SESSION,
      "t",
    );
    expect(d).toEqual({ text: words, category: "model_unknown" });
  });
});

describe("the switch and the start date", () => {
  const never: CompleteFn = async () => {
    throw new Error("no call expected");
  };

  it("does nothing switched off", async () => {
    flags.morningDigest = { ...saved, enabled: false };
    await expect(writeDigest(SESSION, WEDNESDAY, { complete: never })).resolves.toEqual({
      kind: "skipped",
      category: "switched_off",
    });
  });

  it("skips a date before the start date and refuses a date that is not one", async () => {
    flags.morningDigest = { ...saved, enabled: true, startDate: "2026-11-05" };
    await expect(writeDigest(SESSION, WEDNESDAY, { complete: never })).resolves.toEqual({
      kind: "skipped",
      category: "before_start",
    });
    await expect(writeDigest(SESSION, "2026-W45", { complete: never })).resolves.toEqual({
      kind: "failed",
      category: "bad_request",
    });
  });
});
