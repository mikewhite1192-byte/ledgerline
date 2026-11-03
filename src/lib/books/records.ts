import { flags } from "../../config/flags";
import { accountingAdapter } from "../adapters";
import { recordDocNumber, type RecordDocPrefix } from "../adapters/accounting/qbo/entities";
import type { AccountingAdapter, CheckLine, SendContext, SendOutcome } from "../adapters/types";
import type { Session } from "../auth/claims";
import type { Queryable, TenantDb } from "../db";
import { executeMoneyAction, type ExecuteResult, type MoneyDeps } from "../money/execute";
import type { ReconcileHooks } from "../money/reconcile";
import { MoneyError, type MoneyAction } from "../money/types";

// The books records of two movements that never reached the accounting system before (D-104):
// an issued money code (money_code_expense, Dr driver reimbursements) and a released escrow
// balance (escrow_release_expense, Dr driver escrow). Each is one purchase paid by check from
// LedgerLine Clearing to the driver's vendor record, numbered MC- or ER- plus the carrier's bill
// key and 12 hex digits of the record's id, so a re-send adopts what QuickBooks already holds. Only
// the books step (pending.ts) calls these. The books switch and the record kind's own switch are
// checked here before anything is read, again in the reserve transaction (a throw rolls the
// reservation back) and again at the send; the money executor checks accountingEnabled and the
// adapter, and the adapter checks them once more.

export type RecordKind = "money_code_expense" | "escrow_release_expense";

type Shape = {
  table: "money_codes" | "escrow_releases";
  status: "issued" | "released";
  stamp: "issued_at" | "released_at";
  prefix: RecordDocPrefix;
  role: CheckLine["role"];
  switchOn: () => boolean;
};

const SHAPES: Readonly<Record<RecordKind, Shape>> = {
  money_code_expense: {
    table: "money_codes",
    status: "issued",
    stamp: "issued_at",
    prefix: "MC",
    role: "driver_reimbursements",
    switchOn: () => flags.books.kinds.moneyCodes === true,
  },
  escrow_release_expense: {
    table: "escrow_releases",
    status: "released",
    stamp: "released_at",
    prefix: "ER",
    role: "driver_escrow",
    switchOn: () => flags.books.kinds.escrow === true,
  },
};

export const RECORD_KINDS = Object.keys(SHAPES) as RecordKind[];

// Plain words on the purchase line, from a closed list: never a person's free text.
const PURPOSE_WORDS: Readonly<Record<string, string>> = {
  lumper: "Money code, lumper",
  repair: "Money code, repair",
  other: "Money code, other",
};

export function recordSwitchOn(kind: RecordKind): boolean {
  return flags.books.enabled === true && SHAPES[kind].switchOn();
}

type Vendor = { id: string; code: string; firstName: string; lastName: string; workerType: string };

type RecordRow = {
  id: string;
  driverId: string;
  amountCents: number;
  onDate: string;
  description: string;
  vendor: Vendor;
};

// The record, its date in the carrier's own zone and the driver's vendor facts; null when it is
// gone or no longer in the status its purchase records.
async function readRecord(q: Queryable, kind: RecordKind, id: string): Promise<RecordRow | null> {
  const s = SHAPES[kind];
  const purpose = kind === "money_code_expense" ? "r.purpose" : "NULL";
  const rows = await q.query<{
    id: string;
    driver_id: string;
    amount_cents: number | string;
    on_date: string;
    purpose: string | null;
    code: string;
    first_name: string;
    last_name: string;
    worker_type: string;
  }>(
    `SELECT r.id, r.driver_id, r.amount_cents,
            CAST(CAST(r.${s.stamp} AT TIME ZONE t.timezone AS date) AS text) AS on_date,
            ${purpose} AS purpose, d.code, d.first_name, d.last_name, d.worker_type
       FROM ${s.table} r
       JOIN tenants t ON t.id = r.tenant_id
       JOIN drivers d ON d.tenant_id = r.tenant_id AND d.id = r.driver_id
      WHERE r.tenant_id = current_tenant_id() AND r.id = CAST($1 AS uuid) AND r.status = $2
        AND r.${s.stamp} IS NOT NULL`,
    [id, s.status],
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  const amountCents = Number(r.amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  const description =
    kind === "money_code_expense" ? (PURPOSE_WORDS[r.purpose ?? ""] ?? "Money code") : "Escrow released";
  return {
    id: r.id,
    driverId: r.driver_id,
    amountCents,
    onDate: r.on_date,
    description,
    vendor: {
      id: r.driver_id,
      code: r.code,
      firstName: r.first_name,
      lastName: r.last_name,
      workerType: r.worker_type,
    },
  };
}

// The purchase's lines: one, the record's whole amount on its kind's account.
export function recordLines(kind: RecordKind, amountCents: number, description: string): CheckLine[] {
  return [{ role: SHAPES[kind].role, amountCents, description }];
}

export function recordDocRef(kind: RecordKind, tenantId: string, recordId: string): string {
  return recordDocNumber(SHAPES[kind].prefix, tenantId, recordId);
}

// The purchase for one record, as the attempt the step picked from the ledger. Null, with nothing
// written, when the record is gone or not in its status. Throws MoneyError before any write when a
// switch is off or the adapter is not ready.
export async function postRecordExpense(
  db: TenantDb,
  session: Session,
  kind: RecordKind,
  recordId: string,
  attempt: number,
  money: Partial<MoneyDeps>,
): Promise<ExecuteResult | null> {
  if (!recordSwitchOn(kind)) throw new MoneyError("disabled");
  const tenantId = session.tenantId;
  const record = await db.withTenant(tenantId, (q) => readRecord(q, kind, recordId));
  if (!record) return null;
  const accounting: AccountingAdapter = money.accounting ?? accountingAdapter();
  const docRef = recordDocRef(kind, tenantId, record.id);
  return executeMoneyAction(
    db,
    session,
    {
      kind,
      subjectId: record.id,
      counterpartyId: record.driverId,
      amountCents: record.amountCents,
      attempt,
      proposedBy: "agent",
      proposalId: null,
      traceId: null,
      subjectStatuses: [SHAPES[kind].status],
    },
    {
      // The post changes no domain row: where it stands is read from the ledger. The record is
      // asked again under the reserve's lock, and so is the switch.
      onReserved: async (q) => {
        if (!recordSwitchOn(kind)) throw new MoneyError("disabled");
        const now = await readRecord(q, kind, record.id);
        if (!now || now.amountCents !== record.amountCents) throw new MoneyError("validation");
      },
      send: (action: MoneyAction, ctx: SendContext): Promise<SendOutcome> => {
        if (!recordSwitchOn(kind)) return Promise.resolve({ kind: "failed", category: "disabled" });
        return db.withTenant(tenantId, async (q) => {
          let vendorOutsideId: string;
          try {
            vendorOutsideId = (await accounting.ensureVendor(q, record.vendor, ctx)).outsideId;
          } catch (err) {
            // No purchase was sent. The executor settles only a definite category as failed.
            return { kind: "failed", category: err instanceof MoneyError ? err.category : "unknown" };
          }
          return accounting.createCheck(
            q,
            {
              actionId: action.id,
              vendorOutsideId,
              onDate: record.onDate,
              docRef,
              lines: recordLines(kind, action.amountCents, record.description),
            },
            ctx,
          );
        });
      },
    },
    { ...money, accounting },
  );
}

// The reconcile pass's read-back for a purchase left unknown: by its outside id when the reply was
// kept, else by its document number, derived from the stored ids as the send derived it.
export function recordReconcileHooks(
  db: TenantDb,
  tenantId: string,
  accounting: AccountingAdapter,
): Record<RecordKind, ReconcileHooks> {
  const hooks = (kind: RecordKind): ReconcileHooks => ({
    onConfirmed: async () => {},
    readBack: (action, ctx) =>
      db.withTenant(tenantId, (q) =>
        accounting.readBack(
          q,
          {
            type: action.outsideType ?? "Purchase",
            requestId: action.requestId,
            outsideId: action.outsideId,
            outsideRef: action.outsideRef ?? recordDocRef(kind, tenantId, action.subjectId),
          },
          ctx,
        ),
      ),
  });
  return { money_code_expense: hooks("money_code_expense"), escrow_release_expense: hooks("escrow_release_expense") };
}
