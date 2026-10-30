import type { Queryable } from "../db";
import { readBySubject } from "../money/read";
import type { MoneyAction } from "../money/types";
import {
  MONEY_CODE_PURPOSES,
  MONEY_CODE_SOURCES,
  MONEY_CODE_STATUSES,
  type MoneyCodePurpose,
  type MoneyCodeSource,
  type MoneyCodeStatus,
} from "../rules-engine/money-codes";
import { isUuid } from "../uuid";

// The money-code readers for the pages and the agent's read tool. Reads only, in the caller's
// tenant transaction (every statement also names the tenant). The code itself is never here:
// only its last four digits, which the agent's tool leaves out too.

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type MoneyCodeRow = {
  id: string;
  driverId: string;
  driverName: string;
  driverCode: string;
  loadId: string;
  loadNumber: string;
  purpose: MoneyCodePurpose;
  amountCents: number;
  sourceKind: MoneyCodeSource;
  documentId: string | null;
  voiceNoteId: string | null;
  receiptTotalCents: number | null;
  proposalId: string | null;
  moneyActionId: string | null;
  status: MoneyCodeStatus;
  // Pages only, never the agent: the last four digits of an issued code.
  codeLast4: string | null;
  accessorialId: string | null;
  chargeItemId: string | null;
  reimbursementItemId: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

type Raw = {
  id: string;
  driver_id: string;
  driver_name: string;
  driver_code: string;
  load_id: string;
  load_number: string;
  purpose: string;
  amount_cents: number | string;
  source_kind: string;
  document_id: string | null;
  voice_note_id: string | null;
  receipt_total_cents: number | string | null;
  proposal_id: string | null;
  money_action_id: string | null;
  status: string;
  code_last4: string | null;
  accessorial_id: string | null;
  charge_item_id: string | null;
  reimbursement_item_id: string | null;
  issued_at: string | null;
  expires_at: string | null;
  created_at: string;
};

const SELECT = `
  SELECT CAST(c.id AS text) AS id, CAST(c.driver_id AS text) AS driver_id,
         d.first_name || ' ' || d.last_name AS driver_name, d.code AS driver_code,
         CAST(c.load_id AS text) AS load_id, l.load_number, c.purpose, c.amount_cents, c.source_kind,
         CAST(c.document_id AS text) AS document_id, CAST(c.voice_note_id AS text) AS voice_note_id,
         c.receipt_total_cents, CAST(c.proposal_id AS text) AS proposal_id,
         CAST(c.money_action_id AS text) AS money_action_id, c.status, c.code_last4,
         CAST(c.accessorial_id AS text) AS accessorial_id, CAST(c.charge_item_id AS text) AS charge_item_id,
         CAST(c.reimbursement_item_id AS text) AS reimbursement_item_id,
         ${ISO("c.issued_at")} AS issued_at, ${ISO("c.expires_at")} AS expires_at,
         ${ISO("c.created_at")} AS created_at
    FROM money_codes c
    JOIN drivers d ON d.tenant_id = c.tenant_id AND d.id = c.driver_id
    JOIN loads l ON l.tenant_id = c.tenant_id AND l.id = c.load_id`;

function whole(value: number | string, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${what} is not whole cents`);
  return n;
}

function oneOf<T extends string>(value: string, list: readonly T[], what: string): T {
  if (!(list as readonly string[]).includes(value)) throw new Error(`unknown ${what}`);
  return value as T;
}

function rowOf(r: Raw): MoneyCodeRow {
  return {
    id: r.id,
    driverId: r.driver_id,
    driverName: r.driver_name,
    driverCode: r.driver_code,
    loadId: r.load_id,
    loadNumber: r.load_number,
    purpose: oneOf(r.purpose, MONEY_CODE_PURPOSES, "purpose"),
    amountCents: whole(r.amount_cents, "amount"),
    sourceKind: oneOf(r.source_kind, MONEY_CODE_SOURCES, "source"),
    documentId: r.document_id,
    voiceNoteId: r.voice_note_id,
    receiptTotalCents: r.receipt_total_cents === null ? null : whole(r.receipt_total_cents, "receipt total"),
    proposalId: r.proposal_id,
    moneyActionId: r.money_action_id,
    status: oneOf(r.status, MONEY_CODE_STATUSES, "status"),
    codeLast4: r.code_last4,
    accessorialId: r.accessorial_id,
    chargeItemId: r.charge_item_id,
    reimbursementItemId: r.reimbursement_item_id,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

export const MONEY_CODE_LIST_MAX = 100;

// The newest codes first, optionally one driver's or one load's.
export async function listMoneyCodes(
  q: Queryable,
  opts: { driverId?: string | null; loadId?: string | null; limit: number },
): Promise<MoneyCodeRow[]> {
  const { driverId = null, loadId = null, limit } = opts;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MONEY_CODE_LIST_MAX) throw new RangeError("bad limit");
  if (driverId !== null && !isUuid(driverId)) throw new RangeError("bad driver id");
  if (loadId !== null && !isUuid(loadId)) throw new RangeError("bad load id");
  const rows = await q.query<Raw>(
    `${SELECT}
      WHERE c.tenant_id = current_tenant_id()
        AND ($1::uuid IS NULL OR c.driver_id = $1::uuid)
        AND ($2::uuid IS NULL OR c.load_id = $2::uuid)
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${limit}`,
    [driverId, loadId],
  );
  return rows.map(rowOf);
}

export async function readMoneyCodeRow(q: Queryable, id: string): Promise<MoneyCodeRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q.query<Raw>(`${SELECT} WHERE c.tenant_id = current_tenant_id() AND c.id = CAST($1 AS uuid)`, [
    id,
  ]);
  return rows[0] ? rowOf(rows[0]) : null;
}

export type MoneyCodeLine = { id: string; label: string; amountCents: number; itemDate: string };

export type MoneyCodeDetail = {
  code: MoneyCodeRow;
  charge: MoneyCodeLine | null;
  reimbursement: MoneyCodeLine | null;
  // The billable lumper line on the load, for a lumper code once it is issued.
  accessorial: { id: string; amountCents: number; description: string } | null;
  // The cited receipt's file name and type (a photo shows as a thumbnail), when there is one.
  receipt: { id: string; filename: string; isImage: boolean } | null;
  // The pay week the two lines land in, for the paystub link.
  settlementId: string | null;
  actions: MoneyAction[];
};

async function payLine(q: Queryable, id: string | null): Promise<MoneyCodeLine | null> {
  if (id === null) return null;
  const rows = await q.query<{ id: string; kind: string; subkind: string | null; amount_cents: number | string; item_date: string }>(
    `SELECT CAST(id AS text) AS id, kind, subkind, amount_cents, to_char(item_date, 'YYYY-MM-DD') AS item_date
       FROM pay_items WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const label = r.kind === "reimbursement" ? "Reimbursement" : "Charge";
  return { id: r.id, label, amountCents: whole(r.amount_cents, "pay item"), itemDate: r.item_date };
}

// One code with what it put on the paystub and the invoice, and its ledger rows.
export async function readMoneyCode(q: Queryable, id: string): Promise<MoneyCodeDetail | null> {
  const code = await readMoneyCodeRow(q, id);
  if (!code) return null;
  const charge = await payLine(q, code.chargeItemId);
  const reimbursement = await payLine(q, code.reimbursementItemId);
  let accessorial: MoneyCodeDetail["accessorial"] = null;
  if (code.accessorialId) {
    const rows = await q.query<{ id: string; amount_cents: number | string; description: string }>(
      `SELECT CAST(id AS text) AS id, amount_cents, description FROM load_accessorials
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [code.accessorialId],
    );
    if (rows[0]) {
      accessorial = {
        id: rows[0].id,
        amountCents: whole(rows[0].amount_cents, "accessorial"),
        description: rows[0].description,
      };
    }
  }
  let receipt: MoneyCodeDetail["receipt"] = null;
  if (code.documentId) {
    const rows = await q.query<{ id: string; filename: string; mime: string }>(
      `SELECT CAST(id AS text) AS id, filename, mime FROM documents
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
      [code.documentId],
    );
    receipt = rows[0] ? { id: rows[0].id, filename: rows[0].filename, isImage: rows[0].mime.startsWith("image/") } : null;
  }
  let settlementId: string | null = null;
  if (charge) {
    const rows = await q.query<{ id: string }>(
      `SELECT CAST(s.id AS text) AS id FROM settlements s
         JOIN settlement_periods p ON p.tenant_id = s.tenant_id AND p.id = s.period_id
        WHERE s.tenant_id = current_tenant_id() AND s.driver_id = CAST($1 AS uuid)
          AND CAST($2 AS date) BETWEEN p.period_start AND p.period_end
        LIMIT 1`,
      [code.driverId, charge.itemDate],
    );
    settlementId = rows[0]?.id ?? null;
  }
  const actions = (await readBySubject(q, "money_codes", code.id)).filter((a) => a.kind === "money_code_issue");
  return { code, charge, reimbursement, accessorial, receipt, settlementId, actions };
}
