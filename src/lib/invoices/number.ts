import type { Queryable } from "../db";

// Invoice numbers: <PREFIX>-INV-<n>, the same shape the seed writes (BR-INV-10001). The prefix is
// the initials of the carrier's slug words (blue-ridge is BR, prairie-wind is PW), because the
// tenants table has no code column; a unit test holds it equal to each demo carrier's prefix.
//
// QuickBooks keeps the number with the tenant's 5-character document key in front
// (T0001-BR-INV-10001, the key unique per tenant since 0015) in a 21-character field, so ours is
// at most 15: a prefix of up to 4 and a sequence of up to 6 digits. The adapter refuses anything
// longer, never cuts it.

// What the tenants table's CHECK allows (0001): lowercase letters, digits and dashes, any order.
const SLUG = /^[a-z0-9-]{3,40}$/;
const PREFIX = /^[A-Z0-9]{1,4}$/;
const FALLBACK_PREFIX = "INV";
export const FIRST_INVOICE_NUMBER = 10001;
export const MAX_INVOICE_NUMBER = 999_999;

// Every slug the CHECK allows has a prefix: words are the runs between dashes (a doubled or
// leading dash makes no empty word), and a slug of dashes only falls back to INV.
export function invoicePrefixOf(slug: string): string {
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new RangeError("not a carrier slug");
  const prefix =
    slug
      .split(/-+/)
      .filter((w) => w.length > 0)
      .map((w) => w[0].toUpperCase())
      .join("")
      .slice(0, 4) || FALLBACK_PREFIX;
  if (!PREFIX.test(prefix)) throw new RangeError("not an invoice prefix");
  return prefix;
}

function checkPrefix(prefix: string): string {
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) throw new RangeError("not an invoice prefix");
  return prefix;
}

export function invoiceNumberOf(prefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_INVOICE_NUMBER) {
    throw new RangeError("not an invoice sequence number");
  }
  return `${checkPrefix(prefix)}-INV-${n}`;
}

// Anchored at both ends, so BR-INV-10001X and XBR-INV-10001 never count. The prefix is letters and
// digits only (checked), so it needs no escaping inside the pattern.
export function invoiceNumberPattern(prefix: string): string {
  return `^${checkPrefix(prefix)}-INV-([0-9]{1,6})$`;
}

// A lock per tenant and purpose, held to the end of the caller's transaction. Wrapped in count(*)
// so the statement returns a plain number (the lock function itself returns void).
export type TenantLockPurpose =
  | "invoice_number"
  | "invoice_propose"
  | "customer_payment"
  | "cash_check"
  | "sweep_day_cents"
  | "card_check"
  | "collections_draft"
  | "brief_write";

export async function tenantLock(q: Queryable, purpose: TenantLockPurpose): Promise<void> {
  await q.query(
    `SELECT count(*) AS n FROM (
       SELECT pg_advisory_xact_lock(hashtext(CAST(current_tenant_id() AS text) || ':' || $1))
     ) AS l`,
    [purpose],
  );
}

// The next number for this tenant, inside the caller's transaction. The advisory lock is held to
// the end of that transaction, so two approvals never take the same number and the unique key on
// (tenant_id, invoice_number) is only the backstop.
export async function nextInvoiceNumber(q: Queryable, prefix: string): Promise<string> {
  const pattern = invoiceNumberPattern(prefix);
  await tenantLock(q, "invoice_number");
  const [row] = await q.query<{ n: number | string | null }>(
    `SELECT max(CAST(substring(invoice_number from $1) AS bigint)) AS n FROM invoices
      WHERE tenant_id = current_tenant_id() AND invoice_number ~ $1`,
    [pattern],
  );
  const top = row?.n === null || row?.n === undefined ? null : Number(row.n);
  if (top !== null && (!Number.isSafeInteger(top) || top < 0)) throw new Error("unreadable invoice number");
  return invoiceNumberOf(prefix, top === null ? FIRST_INVOICE_NUMBER : Math.max(top + 1, FIRST_INVOICE_NUMBER));
}
