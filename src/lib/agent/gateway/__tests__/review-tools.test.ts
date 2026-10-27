import { afterEach, describe, expect, it } from "vitest";
import { flags } from "../../../../config/flags";
import { instantAt } from "../../../seed/calendar";
import { callTool } from "../index";
import type { GatewayContext } from "../types";
import { context, fixedClock } from "./fake-db";
import { blueRidgePlan, planDb } from "./plan-db";

// The two invoice review tools on the real readers and the real rules engine over the synthetic
// seed plan: switched off they refuse before reading anything; on, they read back exactly the
// review plants the seed planted, and they never write.

const plan = blueRidgePlan();
const zone = plan.carrier.timezone;
const ctx: GatewayContext = context({ now: new Date(instantAt(plan.anchor, 12, 0, zone)), timeZone: zone });
const r = plan.planted.invoiceReview;

const call = (name: string, args: unknown) => ({ id: "call-1", name, argumentsJson: JSON.stringify(args) });
const run = (name: string, args: unknown, role: GatewayContext["role"] = "operator") => {
  const db = planDb(plan);
  return callTool({ ...ctx, role }, call(name, args), { db, clock: fixedClock }).then((out) => ({ out, db }));
};
const on = () => {
  flags.invoicesEnabled = true;
  flags.invoiceReviewEnabled = true;
};
const writes = (db: ReturnType<typeof planDb>) =>
  db.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql) && !/INTO gateway_decisions/.test(s.sql));

afterEach(() => {
  flags.invoicesEnabled = false;
  flags.invoiceReviewEnabled = false;
});

describe("invoice review tools switched off", () => {
  it.each([
    ["get_invoice_review", { invoiceId: r.readyInvoiceId }],
    ["get_invoice_review_queue", {}],
  ])("%s refuses as disabled while the review switch is off, reading no record", async (name, args) => {
    flags.invoicesEnabled = true;
    const { out, db } = await run(name, args);
    expect(out).toMatchObject({ decision: "blocked", reason: "disabled" });
    for (const st of db.statements) expect(st.sql).not.toMatch(/FROM (invoices|customers|loads|money_actions)\b/);
  });
});

describe("get_invoice_review_queue", () => {
  it("counts exactly the seed's plants, worst first", async () => {
    on();
    const { out, db } = await run("get_invoice_review_queue", {});
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const result = out.result as {
      counts: Record<string, number>;
      truncated: boolean;
      rows: { invoiceId: string; status: string; firstReason: string | null; sentOn: string | null }[];
    };
    expect(result.counts).toEqual({
      sync_error: 0,
      rate_mismatch: 1,
      missing_documents: 1,
      duplicate_warning: 2,
      needs_review: r.needsReviewInvoiceIds.length,
      ready_to_send: 1,
    });
    expect(result.truncated).toBe(false);
    expect(result.rows.map((x) => x.status)).toEqual([
      "rate_mismatch",
      "missing_documents",
      "duplicate_warning",
      "duplicate_warning",
      ...r.needsReviewInvoiceIds.map(() => "needs_review"),
      "ready_to_send",
    ]);
    expect(result.rows[0]).toMatchObject({ invoiceId: r.rateMismatchInvoiceId, firstReason: "engine_total_differs" });
    expect(result.rows.at(-1)).toMatchObject({ invoiceId: r.readyInvoiceId, firstReason: "not_posted", sentOn: null });
    expect(writes(db)).toEqual([]);
  });

  it("filters the rows to one status and keeps the whole queue's counts", async () => {
    on();
    const { out } = await run("get_invoice_review_queue", { status: "needs_review" }, "auditor");
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const result = out.result as { counts: Record<string, number>; rows: { invoiceId: string }[] };
    expect(result.rows.map((x) => x.invoiceId).sort()).toEqual([...r.needsReviewInvoiceIds].sort());
    expect(result.counts.duplicate_warning).toBe(2);
  });

  it("refuses a status that is not one of the six", async () => {
    on();
    const { out } = await run("get_invoice_review_queue", { status: "sent" });
    expect(out.decision).toBe("invalid_args");
  });
});

describe("get_invoice_review", () => {
  it("explains the missing documents plant with its sentence and the load behind it", async () => {
    on();
    const { out, db } = await run("get_invoice_review", { invoiceId: r.missingDocumentsInvoiceId });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const inv = plan.rows.invoices.find((i) => i.id === r.missingDocumentsInvoiceId)!;
    expect(out.result).toMatchObject({
      invoiceId: inv.id,
      status: "missing_documents",
      reasons: [
        {
          reason: "no_delivery_document",
          sentence: "This customer requires a signed delivery document; none is on file for this load.",
        },
        { reason: "not_reviewed", sentence: "Nobody has reviewed this yet." },
      ],
      sources: [
        { table: "invoices", id: inv.id },
        { table: "loads", id: inv.load_id },
      ],
      inReviewQueue: true,
      posted: false,
      accountingEmailStatus: null,
      postedAmountCents: null,
      reviewed: false,
      sentOn: null,
    });
    expect(writes(db)).toEqual([]);
  });

  it("names the earlier invoice behind the duplicate warning", async () => {
    on();
    const [first, second] = r.duplicateInvoiceIds;
    const { out } = await run("get_invoice_review", { invoiceId: second });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    const number = plan.rows.invoices.find((i) => i.id === first)!.invoice_number;
    expect(out.result).toMatchObject({
      status: "duplicate_warning",
      duplicateOf: [{ id: first, invoiceNumber: number }],
    });
  });

  it("reads seeded history as ready and sent, out of the queue", async () => {
    on();
    const sent = plan.rows.invoices.find((i) => i.status === "paid")!;
    const { out } = await run("get_invoice_review", { invoiceId: sent.id });
    if (out.decision !== "allowed") throw new Error(`not allowed: ${out.reason}`);
    expect(out.result).toMatchObject({ status: "ready_to_send", inReviewQueue: false, sentOn: sent.sent_on });
  });

  it("refuses an id that is not a uuid", async () => {
    on();
    const { out } = await run("get_invoice_review", { invoiceId: "INV-1" });
    expect(out.decision).toBe("invalid_args");
  });
});
