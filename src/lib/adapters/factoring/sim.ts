import { createHash } from "node:crypto";
import { flags } from "../../../config/flags";
import { isCanonicalUuid, requestIdOf } from "../../money/keys";
import { AMOUNT_LIMIT_CENTS, MoneyError } from "../../money/types";
import type { FactoringAdapter, FactoringSubmission, ReadBack, Ready, SendContext, SendOutcome } from "../types";

// The factoring partner in Test mode: a simulated partner that lives inside the app. It holds no
// key, reads no environment variable, makes no network call and keeps no state, so its answer is a
// pure function of the ledger row's request id and the invoice's balance. A read-back on another
// server instance (or after a restart) computes the same answer the submit gave. The balance's
// last two digits pick the answer, so a demo can show each outcome on purpose (the Factoring page
// says so):
//   ..99  declined (definite, no money moved); reads back failed
//   ..98  unknown (timeout) at submit; reads back succeeded: the advance was made, the reply lost
//   else  funded at once with the advance less the fee; reads back succeeded
// The partner's reference is fsim_adv_ + 24 hex of sha256("adv:" + request id), the same for the
// same request id on every call, so a resend after a crash lands on the same advance. ready() and
// every call re-read payoutsEnabled and the factoring switches; submitting also needs armed. Logs
// carry the outcome, the reference, the cents and the invoice number, never a name.

export type FactoringSimDeps = { log?: (line: string) => void };

const REQUEST_ID = /^[0-9a-f]{32}$/;
const INVOICE_NUMBER = /^[A-Za-z0-9-]{1,40}$/;

// The partner's id for the advance a request id made.
export function advanceRef(requestId: string): string {
  return `fsim_adv_${createHash("sha256").update(`adv:${requestId}`).digest("hex").slice(0, 24)}`;
}

export type FactoringBehavior = "funded" | "declined" | "slow";

export function factoringBehavior(balanceCents: number): FactoringBehavior {
  const tail = balanceCents % 100;
  return tail === 99 ? "declined" : tail === 98 ? "slow" : "funded";
}

const cents = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v < AMOUNT_LIMIT_CENTS;

// The submission checked whole: the request id is the ledger row's own, every amount a whole cent
// count and the arithmetic the engine's (net = advance - fee, reserve = balance - advance).
function validSubmission(r: FactoringSubmission, ctx: SendContext): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    typeof ctx.requestId === "string" &&
    REQUEST_ID.test(ctx.requestId) &&
    typeof r === "object" &&
    r !== null &&
    isCanonicalUuid(r.actionId) &&
    requestIdOf(r.actionId) === ctx.requestId &&
    typeof r.invoiceNumber === "string" &&
    INVOICE_NUMBER.test(r.invoiceNumber) &&
    isCanonicalUuid(r.customerCode) &&
    cents(r.balanceCents, 1) &&
    cents(r.advanceCents, 0) &&
    cents(r.feeCents, 0) &&
    cents(r.netCents, 1) &&
    cents(r.reserveCents, 0) &&
    r.netCents === r.advanceCents - r.feeCents &&
    r.reserveCents === r.balanceCents - r.advanceCents
  );
}

const factoringOn = (): boolean => flags.payoutsEnabled === true && flags.factoring?.enabled === true;

export function createFactoringSim(deps: FactoringSimDeps = {}): FactoringAdapter {
  const log = deps.log ?? ((line: string) => console.info(line));

  return {
    system: "factoring_sim",

    async ready(): Promise<Ready> {
      if (!factoringOn()) return { ok: false, category: "disabled" };
      return flags.factoring.armed === true ? { ok: true } : { ok: false, category: "disabled" };
    },

    // Never waits and never throws for a valid submission.
    async submitInvoice(r: FactoringSubmission, ctx: SendContext): Promise<SendOutcome> {
      if (!validSubmission(r, ctx)) return { kind: "failed", category: "validation" };
      if (!factoringOn() || flags.factoring.armed !== true) return { kind: "failed", category: "disabled" };
      const behavior = factoringBehavior(r.balanceCents);
      const id = advanceRef(ctx.requestId);
      log(`factoring: invoice ${r.invoiceNumber} ${behavior} ${id} ${r.netCents}c of ${r.balanceCents}c`);
      switch (behavior) {
        case "funded":
          return { kind: "confirmed", system: "factoring_sim", type: "factoring_advance", id, amountCents: r.netCents };
        case "declined":
          return { kind: "failed", category: "declined" };
        case "slow":
          return { kind: "unknown", category: "timeout" };
      }
    },

    // Reads only: nothing is ever submitted by a read-back.
    async readBack(ref, ctx): Promise<ReadBack> {
      if (
        typeof ref !== "object" ||
        ref === null ||
        !validSubmission(ref.request, ctx) ||
        ref.requestId !== ctx.requestId
      ) {
        throw new MoneyError("validation");
      }
      const id = advanceRef(ctx.requestId);
      if (ref.outsideId !== undefined && ref.outsideId !== null && ref.outsideId !== id) {
        throw new MoneyError("validation");
      }
      if (!factoringOn()) throw new MoneyError("disabled");
      const declined = factoringBehavior(ref.request.balanceCents) === "declined";
      return {
        found: true,
        system: "factoring_sim",
        type: "factoring_advance",
        id,
        amountCents: ref.request.netCents,
        status: declined ? "failed" : "succeeded",
      };
    },
  };
}
