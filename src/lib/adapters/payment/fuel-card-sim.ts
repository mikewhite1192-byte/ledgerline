import { createHash } from "node:crypto";
import { flags } from "../../../config/flags";
import { isCanonicalUuid, requestIdOf } from "../../money/keys";
import { AMOUNT_LIMIT_CENTS, MoneyError, SIM_BEHAVIORS, type SimBehavior } from "../../money/types";
import { MONEY_CODE_PURPOSES } from "../../rules-engine";
import type {
  FuelCardDestination,
  MoneyCodeIssuer,
  MoneyCodeRequest,
  PaymentAdapter,
  PayoutRequest,
  ReadBack,
  Ready,
  SendContext,
  SendOutcome,
} from "../types";

// The fuel-card rail in test mode: a simulated card provider that lives inside the app. It holds
// no key, reads no environment variable, makes no network call and keeps no state, so its answer
// is a pure function of the card's sim_behavior and the ledger row's request id. A read-back on
// another server instance (or after a restart) therefore computes the same answer the send gave:
//   ok        confirms at send; reads back succeeded
//   declined  fails at send (definite, no money moved); reads back not found
//   slow      unknown (timeout) at send; reads back succeeded: the load landed, the reply was lost
//   offline   unknown (unavailable) at send; the read-back throws unavailable (tests only)
// The load id is the same for the same request id on every call, which is what makes a resend
// after a crash land on the same load instead of a second one. payoutsEnabled is re-read on every
// call. Logs carry the behavior, the load id, the amount and the memo code, never the card's
// token or last four.

export type FuelCardSimDeps = { log?: (line: string) => void };

const REQUEST_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^fcs_card_[0-9a-f]{24}$/;
const LAST4 = /^[0-9]{4}$/;

// The provider's id for the load a request id made: a pure function of the request id.
export function loadId(requestId: string): string {
  return `fcs_load_${createHash("sha256").update(`load:${requestId}`).digest("hex").slice(0, 24)}`;
}

function isSimBehavior(value: unknown): value is SimBehavior {
  return typeof value === "string" && (SIM_BEHAVIORS as readonly string[]).includes(value);
}

function validDestination(d: unknown): d is FuelCardDestination {
  if (typeof d !== "object" || d === null) return false;
  const c = d as Record<string, unknown>;
  return (
    c.rail === "fuel_card" &&
    c.provider === "fuel_card_sim" &&
    typeof c.token === "string" &&
    TOKEN.test(c.token) &&
    typeof c.last4 === "string" &&
    LAST4.test(c.last4) &&
    isSimBehavior(c.simBehavior)
  );
}

// The mock's whole-value checks, plus the rail and a destination this provider issued.
function validRequest(p: PayoutRequest, ctx: SendContext): p is PayoutRequest & {
  destination: FuelCardDestination;
} {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    typeof ctx.requestId === "string" &&
    REQUEST_ID.test(ctx.requestId) &&
    typeof p === "object" &&
    p !== null &&
    isCanonicalUuid(p.actionId) &&
    requestIdOf(p.actionId) === ctx.requestId &&
    isCanonicalUuid(p.driverId) &&
    Number.isSafeInteger(p.amountCents) &&
    p.amountCents > 0 &&
    p.amountCents < AMOUNT_LIMIT_CENTS &&
    typeof p.memoCode === "string" &&
    p.memoCode.length > 0 &&
    p.memoCode.length <= 80 &&
    p.rail === "fuel_card" &&
    validDestination(p.destination)
  );
}

export function createFuelCardSimAdapter(deps: FuelCardSimDeps = {}): PaymentAdapter {
  const log = deps.log ?? ((line: string) => console.info(line));

  return {
    system: "fuel_card_sim",

    async ready(): Promise<Ready> {
      return flags.payoutsEnabled === true ? { ok: true } : { ok: false, category: "disabled" };
    },

    // Never waits and never throws for a valid request.
    async sendPayout(p: PayoutRequest, ctx: SendContext): Promise<SendOutcome> {
      if (!validRequest(p, ctx)) return { kind: "failed", category: "validation" };
      if (flags.payoutsEnabled !== true) return { kind: "failed", category: "disabled" };
      const behavior = p.destination.simBehavior;
      const id = loadId(ctx.requestId);
      log(`fuelcard: ${behavior} load ${id} ${p.amountCents}c for ${p.memoCode}`);
      switch (behavior) {
        case "ok":
          return {
            kind: "confirmed",
            system: "fuel_card_sim",
            type: "card_load",
            id,
            amountCents: p.amountCents,
          };
        case "declined":
          return { kind: "failed", category: "declined" };
        case "slow":
          return { kind: "unknown", category: "timeout" };
        case "offline":
          return { kind: "unknown", category: "unavailable" };
      }
    },

    // Reads only: nothing is ever created by a read-back.
    async readBack(ref, ctx): Promise<ReadBack> {
      if (
        typeof ref !== "object" ||
        ref === null ||
        !validRequest(ref.payout, ctx) ||
        ref.requestId !== ctx.requestId
      ) {
        throw new MoneyError("validation");
      }
      const id = loadId(ctx.requestId);
      if (ref.outsideId !== undefined && ref.outsideId !== null && ref.outsideId !== id) {
        throw new MoneyError("validation");
      }
      if (flags.payoutsEnabled !== true) throw new MoneyError("disabled");
      switch (ref.payout.destination.simBehavior) {
        case "ok":
        case "slow":
          return {
            found: true,
            system: "fuel_card_sim",
            type: "card_load",
            id,
            amountCents: ref.payout.amountCents,
            status: "succeeded",
          };
        case "declined":
          return { found: false };
        case "offline":
          throw new MoneyError("unavailable");
      }
    },
  };
}

// ---- Money codes ----
//
// The same provider issues one-time money codes for a lumper or a repair at the dock. Still no
// key, no network and no state: the answer is a pure function of the request id and the amount's
// last two digits (a code has no card, so no card behavior):
//   ..99  declined at issue (definite, nothing issued); reads back not found
//   ..98  unknown (timeout) at issue; reads back succeeded: the code was issued, the reply lost
//   else  issued at once; reads back succeeded
// The provider's reference is fcs_code_ + 24 hex of sha256("code:" + request id); the code is ten
// digits from the next 16 hex of that hash, so the reference never gives the code away. The code
// is never logged, never returned by issue or read-back, and never stored: revealCode derives it
// again for staff. ready() and every call re-read payoutsEnabled and moneyCodes; issuing also
// needs moneyCodes.armed. A real provider would hold its own codes; this simulation is labeled
// Test mode everywhere it shows.

function codeHash(requestId: string): string {
  return createHash("sha256").update(`code:${requestId}`).digest("hex");
}

// The provider's id for the code a request id issued.
export function codeRef(requestId: string): string {
  return `fcs_code_${codeHash(requestId).slice(0, 24)}`;
}

// The ten-digit code for a request id: the same digits on every call.
export function codeOf(requestId: string): string {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new MoneyError("validation");
  const n = BigInt(`0x${codeHash(requestId).slice(24, 40)}`) % 10_000_000_000n;
  return n.toString().padStart(10, "0");
}

export type CodeBehavior = "ok" | "declined" | "slow";

// The amount's last two digits pick the answer, so a demo can show each outcome on purpose.
export function codeBehavior(amountCents: number): CodeBehavior {
  const tail = amountCents % 100;
  return tail === 99 ? "declined" : tail === 98 ? "slow" : "ok";
}

function validCodeRequest(r: MoneyCodeRequest, ctx: SendContext): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    typeof ctx.requestId === "string" &&
    REQUEST_ID.test(ctx.requestId) &&
    typeof r === "object" &&
    r !== null &&
    isCanonicalUuid(r.actionId) &&
    requestIdOf(r.actionId) === ctx.requestId &&
    isCanonicalUuid(r.driverId) &&
    Number.isSafeInteger(r.amountCents) &&
    r.amountCents > 0 &&
    r.amountCents < AMOUNT_LIMIT_CENTS &&
    typeof r.memoCode === "string" &&
    r.memoCode.length > 0 &&
    r.memoCode.length <= 80 &&
    (MONEY_CODE_PURPOSES as readonly string[]).includes(r.purpose)
  );
}

const codesOn = (): boolean => flags.payoutsEnabled === true && flags.moneyCodes.enabled === true;

export function createMoneyCodeIssuer(deps: FuelCardSimDeps = {}): MoneyCodeIssuer {
  const log = deps.log ?? ((line: string) => console.info(line));

  return {
    system: "fuel_card_sim",

    async ready(): Promise<Ready> {
      return codesOn() ? { ok: true } : { ok: false, category: "disabled" };
    },

    // Never waits and never throws for a valid request.
    async issueMoneyCode(r: MoneyCodeRequest, ctx: SendContext): Promise<SendOutcome> {
      if (!validCodeRequest(r, ctx)) return { kind: "failed", category: "validation" };
      if (!codesOn() || flags.moneyCodes.armed !== true) return { kind: "failed", category: "disabled" };
      const behavior = codeBehavior(r.amountCents);
      const id = codeRef(ctx.requestId);
      log(`fuelcard: money code ${behavior} ${id} ${r.amountCents}c ${r.purpose} for ${r.memoCode}`);
      switch (behavior) {
        case "ok":
          return { kind: "confirmed", system: "fuel_card_sim", type: "money_code", id, amountCents: r.amountCents };
        case "declined":
          return { kind: "failed", category: "declined" };
        case "slow":
          return { kind: "unknown", category: "timeout" };
      }
    },

    // Reads only: nothing is ever issued by a read-back.
    async readBackCode(ref, ctx): Promise<ReadBack> {
      if (
        typeof ref !== "object" ||
        ref === null ||
        !validCodeRequest(ref.request, ctx) ||
        ref.requestId !== ctx.requestId
      ) {
        throw new MoneyError("validation");
      }
      const id = codeRef(ctx.requestId);
      if (ref.outsideId !== undefined && ref.outsideId !== null && ref.outsideId !== id) {
        throw new MoneyError("validation");
      }
      if (!codesOn()) throw new MoneyError("disabled");
      if (codeBehavior(ref.request.amountCents) === "declined") return { found: false };
      return {
        found: true,
        system: "fuel_card_sim",
        type: "money_code",
        id,
        amountCents: ref.request.amountCents,
        status: "succeeded",
      };
    },

    revealCode(requestId: string): string {
      if (flags.moneyCodes.enabled !== true) throw new MoneyError("disabled");
      return codeOf(requestId);
    },

    codeLast4(requestId: string): string {
      return codeOf(requestId).slice(-4);
    },
  };
}
