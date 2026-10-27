import { createHash } from "node:crypto";
import { flags } from "../../../../config/flags";
import type { Queryable } from "../../../db";
import { DbError } from "../../../db";
import { isCanonicalUuid, requestIdOf } from "../../../money/keys";
import { MoneyError, type MoneyFailure } from "../../../money/types";
import type { AccountingAdapter, ReadBack, Ready, SendContext, SendOutcome } from "../../types";
import { createQboClient, type Opened, type QboDeps, type Reply } from "./client";
import {
  appliedAsAsked,
  billBody,
  billKeyOf,
  billPaymentBody,
  checkApplications,
  checkDocNumber,
  checkOutsideId,
  customerBody,
  customerDisplayName,
  DOC_TYPES,
  entityOf,
  invoiceBody,
  isVoided,
  keyedDocNumber,
  PATH_OF,
  paymentBody,
  purchaseBody,
  queryRows,
  REF_FIELD,
  vendorBody,
  vendorDisplayName,
  type Application,
  type DocType,
  type EntityType,
  type Found,
} from "./entities";
import { quoteQueryValue } from "./mapping";
import { readEntityId, storeEntityId, tenantCode, type EntityTable } from "./store";

// The QuickBooks Online sandbox behind the accounting interface. Each create posts once with the
// ledger row's request id as Intuit's requestid, so a resend of the same row replays the first
// answer. Intuit does not refuse a second document with the same number under a new requestid
// (measured 2026-10-27), so every create first looks for its document number and adopts only a
// single match that is ours; anything ambiguous never posts. A reply that is not a clear yes or no
// is unknown until read back. The switch, the settings, the allowed company and the connection are
// checked again on every call.

const READY_TIMEOUT_MS = 10_000;
const REQUEST_ID = /^[0-9a-f]{32}$/;
// Intuit fault codes this adapter acts on.
const DUPLICATE_NAME = "6240";
const DUPLICATE_DOC_NUMBER = "6140";
const OBJECT_NOT_FOUND = "610";

type Built = {
  body: Record<string, unknown>;
  totalCents: number;
  docNumber: string;
  // Payment only: the invoices it applies to, checked.
  applications?: Application[];
};

// Why a record QuickBooks holds is not the one we asked for. Logged, never stored; the ledger
// gets an outcome it already knows.
type Mismatch = "voided" | "amount_mismatch" | "applied_short";

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
        // Made meanwhile, or the name is held where this query does not look (QuickBooks keeps
        // display names unique across customers, vendors and employees): look once more. Never an
        // inactive record: QuickBooks renames a customer or vendor made inactive, so a query by
        // the original name finds nothing (measured 2026-10-27).
        id = one(await query(q, opened, type, where, ctx.timeoutMs));
        if (!id) throw new MoneyError("not_configured");
      } else {
        throw toError(reply);
      }
    }
    return { outsideId: await storeEntityId(q, table, localId, id) };
  }

  // A document create: build (every value checked), look for our number, post once only when
  // nothing holds it, read the answer whole.
  async function create(
    q: Queryable,
    type: DocType,
    actionId: unknown,
    ctx: SendContext,
    build: (opened: Opened) => Built,
  ): Promise<SendOutcome> {
    let built: Built;
    let opened: Opened;
    let held: Found[];
    try {
      if (flags.accountingEnabled !== true) return { kind: "failed", category: "disabled" };
      checkContext(ctx, actionId);
      opened = await client.connection(q, ctx.timeoutMs, { write: true });
      built = build(opened);
      // The adapter cannot tell a row's first send from a resend (both carry the row's stored
      // request id), so it looks every time; for a resend the look finds the document the replay
      // would answer with.
      held = await byNumber(q, opened, type, built.docNumber, ctx.timeoutMs);
    } catch (err) {
      // Nothing was sent.
      return { kind: "failed", category: categoryOf(err) };
    }
    const adopted = ofHeld(type, held, built);
    if (adopted) return adopted;
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
      // The amount is the executor's to compare; a voided record or a cut payment never confirms.
      const why = mismatchOf(type, found, built, { amount: false });
      if (why) return notOurs(type, why);
      return confirmed(type, found, built.docNumber);
    }
    if (reply.kind === "refused" && reply.codes.includes(DUPLICATE_DOC_NUMBER)) {
      return afterDuplicateNumber(q, opened, type, built, ctx);
    }
    if (reply.kind === "refused") {
      return { kind: "failed", category: reply.category, httpStatus: reply.status };
    }
    return { kind: "unknown", category: reply.category, httpStatus: reply.status };
  }

  function byNumber(
    q: Queryable,
    opened: Opened,
    type: DocType,
    docNumber: string,
    timeoutMs: number,
  ): Promise<Found[]> {
    return query(q, opened, type, `${REF_FIELD[type]} = ${quoteQueryValue(docNumber)}`, timeoutMs);
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

  // A record that is not the one we asked for: never confirmed. The executor records any
  // failure outside its definite list as unknown, so a person or a read-back settles it.
  function notOurs(type: DocType, why: Mismatch): SendOutcome {
    client.log(`qbo: ${type} ${why}`);
    return { kind: "failed", category: "amount_mismatch" };
  }

  function mismatchOf(
    type: DocType,
    found: Found,
    built: Built,
    opts: { amount: boolean },
  ): Mismatch | null {
    if (isVoided(found)) return "voided";
    if (opts.amount && found.amountCents !== built.totalCents) return "amount_mismatch";
    if (type === "Payment" && !(built.applications && appliedAsAsked(found, built.applications))) {
      return "applied_short";
    }
    return null;
  }

  // What the documents already holding our number mean. null: none, so the post may go. One that
  // is ours (same party, same amount, not voided, a payment applied as asked) is adopted, so a
  // retry under a new request id never makes a second one. Two or more: nobody can tell which is
  // ours, unknown. Another party's: refused, nothing of ours was made. Ours but different:
  // never confirmed.
  function ofHeld(type: DocType, rows: Found[], built: Built): SendOutcome | null {
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      client.log(`qbo: ${type} duplicate`);
      return { kind: "unknown", category: "unknown" };
    }
    const [row] = rows;
    if (row.amountCents === null) return { kind: "unknown", category: "unknown" };
    if (row.partyId !== partyOf(built.body)) {
      client.log(`qbo: ${type} number held by another party`);
      return { kind: "failed", category: "validation" };
    }
    const why = mismatchOf(type, row, built, { amount: true });
    if (why) return notOurs(type, why);
    client.log(`qbo: ${type} adopted by number id=${row.id}${row.ourNote ? "" : " hand-made"}`);
    return confirmed(type, row, built.docNumber);
  }

  // A 6140: Intuit refused the post because a document has this number (still possible for check
  // numbers), so this post made nothing. The same judgment as the look before the post; a number
  // held by nothing we can find refuses.
  async function afterDuplicateNumber(
    q: Queryable,
    opened: Opened,
    type: DocType,
    built: Built,
    ctx: SendContext,
  ): Promise<SendOutcome> {
    try {
      const rows = await byNumber(q, opened, type, built.docNumber, ctx.timeoutMs);
      return ofHeld(type, rows, built) ?? { kind: "failed", category: "validation" };
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

    // The invoice number and the payment reference carry the tenant's key too, so two tenants
    // in the one sandbox company never send the same number.
    createInvoice(q, inv, ctx) {
      return create(q, "Invoice", inv?.actionId, ctx, (o) =>
        invoiceBody(inv, o.conn.items, billKeyOf(o.conn.tenantId)),
      );
    },

    // The bill number carries the tenant's key, from the tenant id the connection was loaded
    // under (current_tenant_id(), the source of tenantCode).
    createBill(q, bill, ctx) {
      return create(q, "Bill", bill?.actionId, ctx, (o) =>
        billBody(bill, o.conn.accounts, billKeyOf(o.conn.tenantId)),
      );
    },

    payBill(q, p, ctx) {
      return create(q, "BillPayment", p?.actionId, ctx, (o) => billPaymentBody(p, o.conn.accounts));
    },

    createExpense(q, e, ctx) {
      return create(q, "Purchase", e?.actionId, ctx, (o) => purchaseBody(e, o.conn.accounts));
    },

    recordCustomerPayment(q, p, ctx) {
      return create(q, "Payment", p?.actionId, ctx, (o) =>
        paymentBody(p, o.conn.accounts, billKeyOf(o.conn.tenantId)),
      );
    },

    // By id when known, else by our document number, exact. Not found is not "never happened":
    // the row stays unknown. Nothing here ever posts; a replay is the caller's: the same create
    // with the same context. A voided document reads back canceled (no money moved); a payment
    // QuickBooks applied short of what was asked throws amount_mismatch, so the row stays
    // unknown for a person and is never confirmed. A single document with our number that
    // belongs to another party is not ours: not found, and a replay's own look refuses it too.
    // An invoice or payment still unknown has no outside number stored yet: the caller passes our
    // own number (localRef), keyed here as the create keyed it, and our customer (partyLocalId),
    // resolved through the stored id map; a customer never created there means nothing was sent.
    async readBack(q, ref, ctx): Promise<ReadBack> {
      checkContext(ctx);
      if (!(DOC_TYPES as readonly unknown[]).includes(ref?.type) || ref.requestId !== ctx.requestId) {
        throw new MoneyError("validation");
      }
      const type = ref.type as DocType;
      // A payment is judged by how it was applied, so its read-back must say what was asked.
      const asked = type === "Payment" ? checkApplications(ref.applications) : null;
      const keyed = type === "Invoice" || type === "Payment";
      if ((ref.localRef || ref.partyLocalId) && !keyed) throw new MoneyError("validation");
      let party =
        ref.partyOutsideId === undefined || ref.partyOutsideId === null
          ? null
          : checkOutsideId(ref.partyOutsideId);
      if (party === null && ref.partyLocalId) {
        if (!isCanonicalUuid(ref.partyLocalId)) throw new MoneyError("validation");
        party = await readEntityId(q, "customers", ref.partyLocalId);
        if (party === null) return { found: false };
      }
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
      } else if (ref.outsideRef || ref.localRef) {
        const number = ref.outsideRef
          ? checkDocNumber(ref.outsideRef)
          : keyedDocNumber(billKeyOf(opened.conn.tenantId), ref.localRef);
        const rows = await byNumber(q, opened, type, number, ctx.timeoutMs);
        if (rows.length === 0) return { found: false };
        if (rows.length > 1) {
          // Two or more documents carry our number: nobody can tell which is ours.
          client.log(`qbo: ${type} read-back duplicate`);
          throw new MoneyError("duplicate");
        }
        if (party !== null && rows[0].partyId !== party) {
          client.log(`qbo: ${type} number held by another party`);
          return { found: false };
        }
        found = rows[0];
      } else {
        return { found: false };
      }
      if (found.amountCents === null) throw new MoneyError("unknown");
      const voided = isVoided(found);
      if (voided) {
        client.log(`qbo: ${type} voided`);
      } else if (asked && !appliedAsAsked(found, asked)) {
        client.log(`qbo: ${type} applied_short`);
        throw new MoneyError("amount_mismatch");
      }
      return {
        found: true,
        system: "qbo_sandbox",
        type,
        id: found.id,
        ...(found.ref ? { ref: found.ref } : {}),
        amountCents: found.amountCents,
        status: voided ? "canceled" : "succeeded",
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
