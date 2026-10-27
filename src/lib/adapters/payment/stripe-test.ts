import { flags } from "../../../config/flags";
import { isCanonicalUuid, requestIdOf } from "../../money/keys";
import { AMOUNT_LIMIT_CENTS, MoneyError, type MoneyFailure } from "../../money/types";
import { forgetMoneySecret, moneySecret, type SecretDeps } from "../secrets";
import type {
  PaymentAdapter,
  PayoutRequest,
  ReadBack,
  ReadBackStatus,
  Ready,
  SendContext,
  SendOutcome,
  UnknownCategory,
} from "../types";

// Payouts in Stripe test mode: a transfer to the one test connected account the environment
// names. Test keys only: a key that does not start with sk_test_ is refused on every call (and at
// startup, src/lib/money/guard.ts). Each payout carries the ledger row's request id twice: as the
// Idempotency-Key, so a resend within Stripe's replay window returns the first transfer, and as
// the transfer_group, so a read-back finds the transfer by our key at any age without sending
// anything. The switch, the provider, the key and the destination are checked on every write.
// Logs carry the status, the category and Stripe's error type and code only.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type StripeDeps = SecretDeps & {
  fetch?: FetchLike;
  log?: (line: string) => void;
};

const STRIPE_API = "https://api.stripe.com";
const MAX_TIMEOUT_MS = 20_000;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const DESTINATION = /^acct_[A-Za-z0-9]{6,64}$/;
const TRANSFER_ID = /^tr_[A-Za-z0-9]{6,64}$/;
const CODE = /^[a-z_]{1,60}$/;

type Settings = { key: string; destination: string };
type Reply =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "refused"; category: MoneyFailure; status: number }
  | { kind: "not_found" }
  | { kind: "unknown"; category: UnknownCategory; status?: number };

function validRequest(p: PayoutRequest, ctx: SendContext): boolean {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    typeof ctx.requestId === "string" &&
    REQUEST_ID.test(ctx.requestId) &&
    Number.isSafeInteger(ctx.timeoutMs) &&
    ctx.timeoutMs > 0 &&
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

// A key the adapter may use: a Stripe test secret key, never a live or restricted one.
export function isTestKey(key: string | null | undefined): key is string {
  if (typeof key !== "string") return false;
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return false;
  return key.startsWith("sk_test_");
}

function transferGroup(requestId: string): string {
  return `ll_${requestId}`;
}

type Transfer = { id: string; amountCents: number; status: ReadBackStatus };

// A transfer from Stripe, read whole: ours (our action and our group), in dollars, with a sane id
// and amount. Anything else is null.
function transferOf(raw: unknown, p: PayoutRequest, requestId: string): Transfer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const metadata = t.metadata as Record<string, unknown> | null | undefined;
  if (
    t.object !== "transfer" ||
    typeof t.id !== "string" ||
    !TRANSFER_ID.test(t.id) ||
    !Number.isSafeInteger(t.amount) ||
    (t.amount as number) <= 0 ||
    t.currency !== "usd" ||
    t.transfer_group !== transferGroup(requestId) ||
    typeof metadata !== "object" ||
    metadata === null ||
    metadata.ledgerline_action !== p.actionId
  ) {
    return null;
  }
  // A reversed transfer took the money back: no payout stands.
  return { id: t.id, amountCents: t.amount as number, status: t.reversed === true ? "canceled" : "succeeded" };
}

export function createStripeTestAdapter(deps: StripeDeps = {}): PaymentAdapter {
  const env = deps.env ?? process.env;
  const fetcher: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const log = deps.log ?? ((line: string) => console.info(line));
  const secretDeps: SecretDeps = { env, secrets: deps.secrets, log: deps.log };

  // The provider and a test key: enough to read.
  async function readSettings(): Promise<{ ok: true; key: string } | { ok: false; category: MoneyFailure }> {
    if (flags.paymentProvider !== "stripe_test") return { ok: false, category: "not_configured" };
    const key = await moneySecret("stripe_secret_key", secretDeps);
    if (!key) {
      log("stripe: not configured (STRIPE_SECRET_KEY)");
      return { ok: false, category: "not_configured" };
    }
    if (!isTestKey(key)) {
      log("stripe: refused, STRIPE_SECRET_KEY is not a test secret key");
      return { ok: false, category: "not_configured" };
    }
    return { ok: true, key };
  }

  // Everything a payout needs, the switch first.
  async function writeSettings(): Promise<{ ok: true; s: Settings } | { ok: false; category: MoneyFailure }> {
    if (flags.payoutsEnabled !== true) return { ok: false, category: "disabled" };
    const read = await readSettings();
    if (!read.ok) return read;
    const destination = env.STRIPE_TEST_DESTINATION_ACCOUNT?.trim();
    if (!destination || !DESTINATION.test(destination)) {
      log("stripe: not configured (STRIPE_TEST_DESTINATION_ACCOUNT)");
      return { ok: false, category: "not_configured" };
    }
    return { ok: true, s: { key: read.key, destination } };
  }

  async function call(
    key: string,
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    form?: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<Reply> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let res: Response;
    try {
      res = await fetcher(`${STRIPE_API}${path}`, {
        method,
        headers,
        body: form ? new URLSearchParams(form).toString() : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMEOUT_MS)),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      const category = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
      log(`stripe: ${method} ${path.split("?")[0]} ${category}`);
      return { kind: "unknown", category };
    }
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const status = res.status;
    const error =
      typeof body === "object" && body !== null
        ? ((body as { error?: unknown }).error as Record<string, unknown> | undefined)
        : undefined;
    const type = typeof error?.type === "string" && CODE.test(error.type) ? error.type : "";
    const code = typeof error?.code === "string" && CODE.test(error.code) ? error.code : "";
    const line = (category: string) =>
      log(`stripe: ${method} ${path.split("?")[0]} ${status} ${category}${type ? ` ${type}` : ""}${code ? ` ${code}` : ""}`);
    if (status === 200) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        line("unknown");
        return { kind: "unknown", category: "unknown", status };
      }
      return { kind: "ok", body: body as Record<string, unknown> };
    }
    let reply: Reply;
    if (status === 400 && type === "idempotency_error") {
      // The key was used with other parameters: not a clean refusal of this payout.
      reply = { kind: "refused", category: "duplicate", status };
    } else if (status === 400 || status === 402) reply = { kind: "refused", category: "validation", status };
    else if (status === 401 || status === 403) reply = { kind: "refused", category: "auth", status };
    else if (status === 404) reply = { kind: "not_found" };
    else if (status === 429) reply = { kind: "refused", category: "rate_limited", status };
    else if (status >= 500) reply = { kind: "unknown", category: "unavailable", status };
    else reply = { kind: "unknown", category: "unknown", status };
    line(reply.kind === "refused" || reply.kind === "unknown" ? reply.category : "not_found");
    if (status === 401) forgetMoneySecret("stripe_secret_key");
    return reply;
  }

  return {
    system: "stripe_test",

    async ready(): Promise<Ready> {
      const w = await writeSettings();
      return w.ok ? { ok: true } : { ok: false, category: w.category };
    },

    async sendPayout(p: PayoutRequest, ctx: SendContext): Promise<SendOutcome> {
      if (!validRequest(p, ctx)) return { kind: "failed", category: "validation" };
      const w = await writeSettings();
      if (!w.ok) return { kind: "failed", category: w.category };
      const reply = await call(
        w.s.key,
        "POST",
        "/v1/transfers",
        ctx.timeoutMs,
        {
          amount: String(p.amountCents),
          currency: "usd",
          destination: w.s.destination,
          transfer_group: transferGroup(ctx.requestId),
          "metadata[ledgerline_action]": p.actionId,
          description: "LedgerLine driver payout",
        },
        ctx.requestId,
      );
      if (reply.kind === "ok") {
        const t = transferOf(reply.body, p, ctx.requestId);
        if (!t || t.status !== "succeeded") return { kind: "unknown", category: "unknown" };
        return { kind: "confirmed", system: "stripe_test", type: "transfer", id: t.id, amountCents: t.amountCents };
      }
      if (reply.kind === "refused") {
        return { kind: "failed", category: reply.category, httpStatus: reply.status };
      }
      if (reply.kind === "not_found") return { kind: "unknown", category: "unknown", httpStatus: 404 };
      return { kind: "unknown", category: reply.category, httpStatus: reply.status };
    },

    // By id when known, else by our transfer group. Reads only: nothing is sent again, so a
    // read-back after Stripe's replay window can never make a second transfer.
    async readBack(ref, ctx): Promise<ReadBack> {
      if (!validRequest(ref?.payout, ctx) || ref.requestId !== ctx.requestId) {
        throw new MoneyError("validation");
      }
      const r = await readSettings();
      if (!r.ok) throw new MoneyError(r.category);
      let t: Transfer | null;
      if (ref.outsideId) {
        if (!TRANSFER_ID.test(ref.outsideId)) throw new MoneyError("validation");
        const reply = await call(r.key, "GET", `/v1/transfers/${ref.outsideId}`, ctx.timeoutMs);
        if (reply.kind === "not_found") return { found: false };
        if (reply.kind !== "ok") throw new MoneyError(reply.category);
        t = transferOf(reply.body, ref.payout, ctx.requestId);
        if (!t || t.id !== ref.outsideId) throw new MoneyError("unknown");
      } else {
        const q = new URLSearchParams({ transfer_group: transferGroup(ctx.requestId), limit: "3" });
        const reply = await call(r.key, "GET", `/v1/transfers?${q.toString()}`, ctx.timeoutMs);
        if (reply.kind === "not_found") throw new MoneyError("unknown");
        if (reply.kind !== "ok") throw new MoneyError(reply.category);
        const data = reply.body.data;
        if (reply.body.object !== "list" || !Array.isArray(data)) throw new MoneyError("unknown");
        if (data.length === 0) return { found: false };
        if (data.length > 1) throw new MoneyError("duplicate");
        t = transferOf(data[0], ref.payout, ctx.requestId);
        if (!t) throw new MoneyError("unknown");
      }
      return {
        found: true,
        system: "stripe_test",
        type: "transfer",
        id: t.id,
        amountCents: t.amountCents,
        status: t.status,
      };
    },
  };
}
