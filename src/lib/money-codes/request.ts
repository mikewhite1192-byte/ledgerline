import { flags } from "../../config/flags";
import type { GatewayRef } from "../agent/gateway/types";
import type { Session } from "../auth/claims";
import { readMoneyCodeInput } from "../data/read";
import { getDb, type Queryable, type TenantDb } from "../db";
import { readTenantZone } from "../money/read";
import { persistEngineProposal } from "../proposals/engine";
import { checkMoneyCode, type MoneyCodePurpose } from "../rules-engine/money-codes";
import { assertMembership } from "../tenant/context";
import { addDays, localDateOf } from "../time/local-date";
import { isUuid } from "../uuid";
import { moneyCodesOn } from "./switches";

// The Request a code form (/money-codes/new). A person picks a load on the road (its driver comes
// with it), the amount, the purpose and, optionally, a receipt the carrier already has. The rules
// engine checks it as of now, exactly as for the agent's proposal, and a passing request becomes
// one money_code proposal waiting on the Money codes page, made without a model (no conversation,
// no turn). Nothing is issued until a person approves it there; the approval runs the same gate
// and executor as the agent's card.

export type RequestChoiceLoad = {
  id: string;
  loadNumber: string;
  driverCode: string;
  driverName: string;
  status: "in_transit" | "delivered";
};

export type RequestChoiceReceipt = { id: string; filename: string; kind: "lumper_receipt" | "other" };

export type RequestChoices = { loads: RequestChoiceLoad[]; receipts: RequestChoiceReceipt[] };

const CHOICES_MAX = 100;
// Receipts read in the last week, the kinds a money code can be for.
const RECEIPT_DAYS = 7;
// The engine's window for a delivered load, so the list offers only loads it can allow.
const DELIVERED_DAYS = 3;

// What the form offers, read in the caller's tenant transaction.
export async function readRequestChoices(q: Queryable, now: Date): Promise<RequestChoices> {
  const zone = await readTenantZone(q);
  const today = localDateOf(now.toISOString(), zone);
  const loads = await q.query<{
    id: string;
    load_number: string;
    driver_code: string;
    driver_name: string;
    status: string;
  }>(
    `SELECT CAST(l.id AS text) AS id, l.load_number, d.code AS driver_code,
            d.first_name || ' ' || d.last_name AS driver_name, l.status
       FROM loads l
       JOIN drivers d ON d.tenant_id = l.tenant_id AND d.id = l.driver_id
      WHERE l.tenant_id = current_tenant_id()
        AND (l.status = 'in_transit'
             OR (l.status = 'delivered' AND l.delivered_on BETWEEN CAST($1 AS date) AND CAST($2 AS date)))
      ORDER BY d.code, l.load_number
      LIMIT ${CHOICES_MAX}`,
    [addDays(today, -DELIVERED_DAYS), today],
  );
  const receipts = await q.query<{ id: string; filename: string; document_kind: string }>(
    `SELECT CAST(id AS text) AS id, filename, document_kind FROM documents
      WHERE tenant_id = current_tenant_id() AND read_status = 'read'
        AND document_kind IN ('lumper_receipt', 'other')
        AND created_at > CAST($1 AS timestamptz) - make_interval(days => ${RECEIPT_DAYS})
      ORDER BY created_at DESC, id
      LIMIT ${CHOICES_MAX}`,
    [now.toISOString()],
  );
  return {
    loads: loads.map((l) => ({
      id: l.id,
      loadNumber: l.load_number,
      driverCode: l.driver_code,
      driverName: l.driver_name,
      status: l.status === "delivered" ? "delivered" : "in_transit",
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      filename: r.filename,
      kind: r.document_kind === "lumper_receipt" ? "lumper_receipt" : "other",
    })),
  };
}

export type MoneyCodeAskBody = {
  loadId: string;
  amountCents: number;
  purpose: MoneyCodePurpose;
  documentId: string | null;
};

export type RequestResult =
  | { ok: true; outcome: "created" | "duplicate"; proposalId: string }
  | { ok: false; category: string; retryable: boolean };

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

// One request from the form. Reads and one proposal write, in one tenant transaction with the
// load locked, so two presses for one load take turns. A refusal writes nothing.
export async function requestMoneyCode(
  session: Session,
  body: MoneyCodeAskBody,
  deps: { db?: TenantDb; clock?: () => Date } = {},
): Promise<RequestResult> {
  if (!moneyCodesOn()) return no("codes_off");
  if (!isUuid(body.loadId) || (body.documentId !== null && !isUuid(body.documentId))) return no("bad_request");
  const loadId = body.loadId.toLowerCase();
  const documentId = body.documentId === null ? null : body.documentId.toLowerCase();
  const db = deps.db ?? getDb();
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    const loads = await q.query<{ driver_id: string | null }>(
      `SELECT CAST(driver_id AS text) AS driver_id FROM loads
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) FOR UPDATE`,
      [loadId],
    );
    if (loads.length !== 1) return no("not_found");
    const driverId = loads[0].driver_id;
    if (driverId === null) return no("load_not_drivers");
    const source = documentId === null ? "form" : "document";
    const { capCents, perDriverPerDay } = flags.moneyCodes;
    const input = await readMoneyCodeInput(
      q,
      {
        driverId,
        loadId,
        purpose: body.purpose,
        amountCents: body.amountCents,
        source,
        documentId,
        voiceNoteId: null,
        capCents,
        perDriverPerDay,
      },
      nowIso,
    );
    const decision = checkMoneyCode(input);
    if (!decision.ok) return no(decision.category);

    const sources: GatewayRef[] = [
      { table: "drivers", id: driverId },
      { table: "loads", id: loadId },
    ];
    if (documentId !== null) {
      // The receipt is cited by the outside input it came through, when it has one.
      const inputs = await q.query<{ input_id: string | null }>(
        `SELECT CAST(untrusted_input_id AS text) AS input_id FROM documents
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)`,
        [documentId],
      );
      const inputId = inputs[0]?.input_id ?? null;
      if (inputId !== null) sources.push({ table: "untrusted_inputs", id: inputId });
    }
    const zone = await readTenantZone(q);
    const result = await persistEngineProposal(
      q,
      {
        kind: "money_code",
        subjectTable: "loads",
        subjectId: loadId,
        amountCents: decision.amountCents,
        args: {
          driverId,
          loadId,
          amountCents: decision.amountCents,
          purpose: decision.purpose,
          source,
          documentId,
          voiceNoteId: null,
          inputId: null,
          // The same request twice on one day is one card; a new day is a new request.
          requestedOn: localDateOf(nowIso, zone),
        },
        exceptions: [],
        reasons: [...decision.reasons],
        sources,
      },
      session,
      now,
    );
    if (result.kind === "created" || result.kind === "duplicate") {
      return { ok: true as const, outcome: result.kind, proposalId: result.proposalId };
    }
    return no(result.kind);
  });
}
