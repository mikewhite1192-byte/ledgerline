import { randomBytes } from "node:crypto";
import { flags } from "../../../config/flags";
import { isCanonicalUuid, requestIdOf } from "../../money/keys";
import { AMOUNT_LIMIT_CENTS, MoneyError, type MoneyFailure } from "../../money/types";
import type {
  PaymentAdapter,
  PayoutRequest,
  ReadBack,
  Ready,
  SendContext,
  SendOutcome,
} from "../types";

// The demo's card load: a payout that lives in this server process only. It behaves like a real
// processor where it matters to the ledger: a repeated request id replays the first payout
// instead of making a second, and a read-back by request id is that same replay, so a payout the
// map holds (or lost to a restart) comes back confirmed either way, never "not found". It still
// refuses everything while payoutsEnabled is off, checked on every call.

type Stored = { id: string; amountCents: number };

export type MockPaymentAdapter = PaymentAdapter & {
  // Test hooks, each for the next sendPayout only.
  failNext(category: MoneyFailure): void;
  // Never resolves; the executor's timeout turns it into unknown.
  hangNext(): void;
  // Records the payout, then throws a network error, so only a read-back can confirm it.
  confirmSilently(): void;
  // Payouts this instance created, and sendPayout calls that got past validation.
  readonly createdCount: number;
  readonly sendCount: number;
};

export type MockDeps = { log?: (line: string) => void; newId?: () => string };

const REQUEST_ID = /^[0-9a-f]{32}$/;

function validRequest(p: PayoutRequest, ctx: SendContext): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    typeof ctx.requestId === "string" &&
    REQUEST_ID.test(ctx.requestId) &&
    isCanonicalUuid(p?.actionId) &&
    requestIdOf(p.actionId) === ctx.requestId &&
    isCanonicalUuid(p.driverId) &&
    Number.isSafeInteger(p.amountCents) &&
    p.amountCents > 0 &&
    p.amountCents < AMOUNT_LIMIT_CENTS &&
    typeof p.memoCode === "string" &&
    p.memoCode.length > 0 &&
    p.memoCode.length <= 80
  );
}

export function createMockPaymentAdapter(deps: MockDeps = {}): MockPaymentAdapter {
  const log = deps.log ?? ((line: string) => console.info(line));
  const newId = deps.newId ?? (() => `mock_${randomBytes(8).toString("hex")}`);
  const payouts = new Map<string, Stored>();
  let next: { mode: "fail"; category: MoneyFailure } | { mode: "hang" } | { mode: "silent" } | null =
    null;
  let createdCount = 0;
  let sendCount = 0;

  function confirmed(s: Stored): SendOutcome {
    return { kind: "confirmed", system: "mock", type: "payout", id: s.id, amountCents: s.amountCents };
  }

  // The one write. Replays a stored payout; creates one only while the switch is on.
  function payout(p: PayoutRequest, requestId: string): Stored {
    const stored = payouts.get(requestId);
    if (stored) return stored;
    if (flags.payoutsEnabled !== true) throw new MoneyError("disabled");
    const made = { id: newId(), amountCents: p.amountCents };
    payouts.set(requestId, made);
    createdCount += 1;
    log(`money: mock payout ${made.id} ${made.amountCents}c for ${p.memoCode}`);
    return made;
  }

  return {
    system: "mock",

    async ready(): Promise<Ready> {
      return flags.payoutsEnabled === true ? { ok: true } : { ok: false, category: "disabled" };
    },

    async sendPayout(p: PayoutRequest, ctx: SendContext): Promise<SendOutcome> {
      if (!validRequest(p, ctx)) return { kind: "failed", category: "validation" };
      if (flags.payoutsEnabled !== true) return { kind: "failed", category: "disabled" };
      sendCount += 1;
      const mode = next;
      next = null;
      if (mode?.mode === "hang") return new Promise<SendOutcome>(() => {});
      if (mode?.mode === "fail") return { kind: "failed", category: mode.category };
      const made = payout(p, ctx.requestId);
      if (mode?.mode === "silent") throw new MoneyError("network");
      return confirmed(made);
    },

    async readBack(ref, ctx): Promise<ReadBack> {
      if (!validRequest(ref?.payout, ctx) || ref.requestId !== ctx.requestId) {
        throw new MoneyError("validation");
      }
      const made = payout(ref.payout, ctx.requestId);
      return {
        found: true,
        system: "mock",
        type: "payout",
        id: made.id,
        amountCents: made.amountCents,
        status: "succeeded",
      };
    },

    failNext(category: MoneyFailure) {
      next = { mode: "fail", category };
    },
    hangNext() {
      next = { mode: "hang" };
    },
    confirmSilently() {
      next = { mode: "silent" };
    },
    get createdCount() {
      return createdCount;
    },
    get sendCount() {
      return sendCount;
    },
  };
}
