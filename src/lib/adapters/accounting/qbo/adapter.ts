import { createHash } from "node:crypto";
import { flags } from "../../../../config/flags";
import type { Queryable } from "../../../db";
import { DbError } from "../../../db";
import { isCanonicalUuid, requestIdOf } from "../../../money/keys";
import { MoneyError, type MoneyFailure } from "../../../money/types";
import type { AccountingAdapter, ReadBack, Ready, SendContext, SendOutcome } from "../../types";
import { createQboClient, type Opened, type QboDeps, type Reply } from "./client";
import {
  billBody,
  billPaymentBody,
  checkDocNumber,
  checkOutsideId,
  customerBody,
  customerDisplayName,
  DOC_TYPES,
  entityOf,
  invoiceBody,
  PATH_OF,
  paymentBody,
  purchaseBody,
  queryRows,
  REF_FIELD,
  vendorBody,
  vendorDisplayName,
  type DocType,
  type EntityType,
  type Found,
} from "./entities";
import { quoteQueryValue } from "./mapping";
import { readEntityId, storeEntityId, tenantCode, type EntityTable } from "./store";

// The QuickBooks Online sandbox behind the accounting interface. Each create posts once with the
// ledger row's request id as Intuit's requestid, so a resend replays the first answer instead of
// making a second record. A reply that is not a clear yes or no is unknown until read back. The
// switch, the settings, the allowed company and the connection are checked again on every call.

const READY_TIMEOUT_MS = 10_000;
const REQUEST_ID = /^[0-9a-f]{32}$/;
// Intuit fault codes this adapter acts on.
const DUPLICATE_NAME = "6240";
const DUPLICATE_DOC_NUMBER = "6140";
const OBJECT_NOT_FOUND = "610";

type Built = { body: Record<string, unknown>; totalCents: number; docNumber: string };

function categoryOf(err: unknown): MoneyFailure {
  if (err instanceof MoneyError) return err.category;
  if (err instanceof DbError) return "unavailable";
  return "unknown";
}

// The ledger's own request id, from the row the executor reserved.
function checkContext(ctx: SendContext, actionId?: unknown): void {
  if (
    typeof ctx !== "object" ||
    ctx === null ||
    typeof ctx.requestId !== "string" ||
    !REQUEST_ID.test(ctx.requestId) ||
    !Number.isSafeInteger(ctx.timeoutMs) ||
    ctx.timeoutMs < 1 ||
    (actionId !== undefined && (!isCanonicalUuid(actionId) || requestIdOf(actionId) !== ctx.requestId))
  ) {
    throw new MoneyError("validation");
  }
}

// A stable requestid of our own for a customer or vendor create made inside a document's send, so
// it never shares the document's requestid and a resend of the same send replays it too.
function subRequestId(requestId: string, what: string): string {
  return createHash("sha256").update(`${requestId}:${what}`).digest("hex").slice(0, 32);
}

function toError(reply: Exclude<Reply, { kind: "ok" }>): MoneyError {
  return new MoneyError(reply.category, reply.status);
}

export function createQboAdapter(deps: QboDeps = {}): AccountingAdapter {
  const client = createQboClient(deps);

  async function query(
    q: Queryable,
    opened: Opened,
    type: EntityType,
    where: string,
    timeoutMs: number,
  ): Promise<Found[]> {
    const reply = await client.request(
      q,
      opened,
      { method: "GET", path: "query", query: { query: `SELECT * FROM ${type} WHERE ${where}` } },
      timeoutMs,
    );
    if (reply.kind !== "ok") throw toError(reply);
    const rows = queryRows(type, reply.body);
    if (!rows) throw new MoneyError("unknown");
    return rows;
  }

  // The local id map, then the display name, then a create; the id found is kept in the map.
  async function ensureEntity(
    q: Queryable,
    table: EntityTable,
    localId: unknown,
    ctx: SendContext,
    build: (code: string) => { name: string; body: Record<string, unknown> },
  ): Promise<{ outsideId: string }> {
    checkContext(ctx);
    if (!isCanonicalUuid(localId)) throw new MoneyError("validation");
    const opened = await client.connection(q, ctx.timeoutMs, { write: true });
    const stored = await readEntityId(q, table, localId);
    if (stored) return { outsideId: stored };
    const type = table === "customers" ? "Customer" : "Vendor";
    const { name, body } = build(await tenantCode(q));
    const where = `DisplayName = ${quoteQueryValue(name)}`;
    const one = (rows: Found[]): string | null => {
      // Two records with one display name: a person fixes the company; nothing is guessed.
      if (rows.length > 1) throw new MoneyError("not_configured");
      return rows.length === 1 ? rows[0].id : null;
    };
    let id = one(await query(q, opened, type, where, ctx.timeoutMs));
    if (!id) {
      const reply = await client.request(
        q,
        opened,
        {
          method: "POST",
          path: PATH_OF[type],
          body,
          requestId: subRequestId(ctx.requestId, `${type}:${localId}`),
        },
        ctx.timeoutMs,
      );
      if (reply.kind === "ok") {
        id = entityOf(type, reply.body)?.id ?? null;
        if (!id) throw new MoneyError("unknown");
      } else if (reply.kind === "refused" && reply.codes.includes(DUPLICATE_NAME)) {
        // Made meanwhile (or inactive): look once more.
        id = one(await query(q, opened, type, where, ctx.timeoutMs));
        if (!id) throw new MoneyError("not_configured");
      } else {
        throw toError(reply);
      }
    }
    return { outsideId: await storeEntityId(q, table, localId, id) };
  }

  // A document create: build (every value checked), post once, read the answer whole.
  async function create(
    q: Queryable,
    type: DocType,
    actionId: unknown,
    ctx: SendContext,
    build: (opened: Opened) => Built,
  ): Promise<SendOutcome> {
    let built: Built;
    let opened: Opened;
    try {
      if (flags.accountingEnabled !== true) return { kind: "failed", category: "disabled" };
      checkContext(ctx, actionId);
      opened = await client.connection(q, ctx.timeoutMs, { write: true });
      built = build(opened);
    } catch (err) {
      // Nothing was sent.
      return { kind: "failed", category: categoryOf(err) };
    }
    let reply: Reply;
    try {
      reply = await client.request(
        q,
        opened,
        { method: "POST", path: PATH_OF[type], body: built.body, requestId: ctx.requestId },
        ctx.timeoutMs,
      );
    } catch (err) {
      // Thrown before the post went out, or after a 401 (which made nothing): nothing was made.
      return { kind: "failed", category: categoryOf(err) };
    }
    if (reply.kind === "ok") {
      const found = entityOf(type, reply.body);
      if (!found || found.amountCents === null) return { kind: "unknown", category: "unknown" };
      return confirmed(type, found, built.docNumber);
    }
    if (reply.kind === "refused" && reply.codes.includes(DUPLICATE_DOC_NUMBER)) {
      return adoptByDocNumber(q, opened, type, built, ctx);
    }
    if (reply.kind === "refused") {
      return { kind: "failed", category: reply.category, httpStatus: reply.status };
    }
    return { kind: "unknown", category: reply.category, httpStatus: reply.status };
  }

  function confirmed(type: DocType, found: Found, ref: string): SendOutcome {
    return {
      kind: "confirmed",
      system: "qbo_sandbox",
      type,
      id: found.id,
      ref: found.ref ?? ref,
      amountCents: found.amountCents as number,
    };
  }

  // A 6140: a document with this number exists. Ours from an earlier send (same party) is
  // adopted, and the executor compares its amount; anyone else's refuses the create.
  async function adoptByDocNumber(
    q: Queryable,
    opened: Opened,
    type: DocType,
    built: Built,
    ctx: SendContext,
  ): Promise<SendOutcome> {
    try {
      const rows = await query(
        q,
        opened,
        type,
        `${REF_FIELD[type]} = ${quoteQueryValue(built.docNumber)}`,
        ctx.timeoutMs,
      );
      const party = partyOf(built.body);
      if (rows.length === 1 && rows[0].amountCents !== null && rows[0].partyId === party) {
        return confirmed(type, rows[0], built.docNumber);
      }
      return { kind: "failed", category: "validation" };
    } catch (err) {
      const category = categoryOf(err);
      return category === "unavailable" || category === "timeout" || category === "network"
        ? { kind: "unknown", category }
        : { kind: "unknown", category: "unknown" };
    }
  }

  return {
    system: "qbo_sandbox",

    async ready(q: Queryable): Promise<Ready> {
      try {
        await client.connection(q, READY_TIMEOUT_MS, { write: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, category: categoryOf(err) };
      }
    },

    ensureCustomer(q, c, ctx) {
      return ensureEntity(q, "customers", c?.id, ctx, (code) => {
        const name = customerDisplayName(code, c);
        return { name, body: customerBody(name) };
      });
    },

    ensureVendor(q, d, ctx) {
      return ensureEntity(q, "drivers", d?.id, ctx, (code) => {
        const name = vendorDisplayName(code, d);
        return { name, body: vendorBody(name, d.workerType) };
      });
    },

    createInvoice(q, inv, ctx) {
      return create(q, "Invoice", inv?.actionId, ctx, (o) => invoiceBody(inv, o.conn.items));
    },

    createBill(q, bill, ctx) {
      return create(q, "Bill", bill?.actionId, ctx, (o) => billBody(bill, o.conn.accounts));
    },

    payBill(q, p, ctx) {
      return create(q, "BillPayment", p?.actionId, ctx, (o) => billPaymentBody(p, o.conn.accounts));
    },

    createExpense(q, e, ctx) {
      return create(q, "Purchase", e?.actionId, ctx, (o) => purchaseBody(e, o.conn.accounts));
    },

    recordCustomerPayment(q, p, ctx) {
      return create(q, "Payment", p?.actionId, ctx, (o) => paymentBody(p, o.conn.accounts));
    },

    // By id when known, else by our document number, exact. Not found is not "never happened":
    // the row stays unknown. A replay is the caller's: the same create with the same context.
    async readBack(q, ref, ctx): Promise<ReadBack> {
      checkContext(ctx);
      if (!(DOC_TYPES as readonly unknown[]).includes(ref?.type) || ref.requestId !== ctx.requestId) {
        throw new MoneyError("validation");
      }
      const type = ref.type as DocType;
      const opened = await client.connection(q, ctx.timeoutMs, { write: false });
      let found: Found | null = null;
      if (ref.outsideId) {
        const id = checkOutsideId(ref.outsideId);
        const reply = await client.request(
          q,
          opened,
          { method: "GET", path: `${PATH_OF[type]}/${id}` },
          ctx.timeoutMs,
        );
        if (reply.kind === "refused" && reply.codes.includes(OBJECT_NOT_FOUND)) {
          return { found: false };
        }
        if (reply.kind !== "ok") throw toError(reply);
        found = entityOf(type, reply.body);
        if (!found || found.id !== id) throw new MoneyError("unknown");
      } else if (ref.outsideRef) {
        const docNumber = checkDocNumber(ref.outsideRef);
        const rows = await query(
          q,
          opened,
          type,
          `${REF_FIELD[type]} = ${quoteQueryValue(docNumber)}`,
          ctx.timeoutMs,
        );
        if (rows.length === 0) return { found: false };
        if (rows.length > 1) throw new MoneyError("duplicate");
        found = rows[0];
      } else {
        return { found: false };
      }
      if (found.amountCents === null) throw new MoneyError("unknown");
      return {
        found: true,
        system: "qbo_sandbox",
        type,
        id: found.id,
        ...(found.ref ? { ref: found.ref } : {}),
        amountCents: found.amountCents,
        status: "succeeded",
      };
    },
  };
}

function partyOf(body: Record<string, unknown>): string | null {
  for (const k of ["CustomerRef", "VendorRef", "EntityRef"]) {
    const v = body[k];
    if (typeof v === "object" && v !== null && typeof (v as { value?: unknown }).value === "string") {
      return (v as { value: string }).value;
    }
  }
  return null;
}
