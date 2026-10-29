import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { configFor, sortVersions } from "../../data/config-version";
import { readRowsWhereId, readTable } from "../../data/read";
import { assertIdentifier } from "../../data/tables";
import { changeArgsSchema, changeMatches, readRuleChangeRows, ruleChangeOf } from "../../pay-rules/change";
import { formatValue, RULES, valueText, type RuleValue } from "../../pay-rules/rules";
import { parsePayConfig } from "../../rules-engine";
import type { Executor, ProposalResult } from "../execute";

// A person approved a pay_rule_change: write the dated version the change describes, in one tenant
// transaction, or nothing.
//
// The proposal row is locked first, then every version of the tenant's pay rules and a per-tenant
// advisory lock, so two approvals run one after the other: the second finds its proposal done, or
// finds the rules moved and fails as stale. Then the engine sizes the same change again from the
// rows as they are now (the sentence was checked when it was proposed, so grounding is skipped),
// and every stored figure must equal it whole: the rule, both values, both dates, the version it
// starts from, how it applies and the impact on last week's pay. Any refusal (the week began, a
// version was paid under, a later version was saved) or any difference fails it as stale, which
// writes nothing but the proposal's own move to failed.
//
// On a match it writes one version: a new row copied column by column from the version in force
// (every column the table has now, read from the catalog, so a column a later migration adds rides
// along) with the one rule replaced, or, when a person-made version already starts that week and
// nothing was paid under it, that version edited in place. Both writes are guarded on the old value. Then one
// pay_rule_changes row (one per proposal), a read-back through the engine's own parser, and the
// proposal moves to done. A mismatch after a write throws, so the transaction rolls back.
//
// The switch: rulesByTalkingEnabled off refuses as not_executable before anything is read. Nothing
// here moves money, writes a settlement or calls an outside system.

const done = (proposalId: string): ProposalResult => ({
  ok: true,
  proposalId,
  status: "done",
  moneyActionId: null,
});

const refusal = (category: string): ProposalResult => ({ ok: false, category, retryable: false });

type Locked = { status: string; amount_cents: number | string; args: string };

// Columns the copy sets itself; every other column is copied from the base version.
const OWN_COLUMNS = new Set(["id", "tenant_id", "effective_from", "note", "source", "created_at"]);

// The SQL type a replaced value is cast to, by the catalog's data_type. Anything else refuses.
const CASTS: Readonly<Record<string, string>> = {
  bigint: "bigint",
  integer: "integer",
  smallint: "smallint",
  text: "text",
};

async function fail(q: Queryable, proposalId: string, category: string, nowIso: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [proposalId, category, nowIso],
  );
  console.warn(`pay rule change ${proposalId} refused: ${category}`);
  return refusal(category);
}

async function one(q: Queryable, sql: string, params: (string | number | null)[]): Promise<void> {
  const n = await q.execute(sql, params);
  if (n !== 1) throw new Error("a pay rule change write did not change exactly one row");
}

// pay_configs' columns as the catalog lists them now, each a plain identifier, with its cast.
async function payConfigColumns(q: Queryable): Promise<Map<string, string>> {
  const rows = await q.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pay_configs'
      ORDER BY ordinal_position`,
  );
  const out = new Map<string, string>();
  for (const r of rows) out.set(assertIdentifier(r.column_name), r.data_type);
  for (const own of OWN_COLUMNS) {
    if (!out.has(own)) throw new Error("pay_configs is missing a column the copy sets");
  }
  return out;
}

function castFor(columns: Map<string, string>, column: string): string {
  const cast = CASTS[columns.get(column) ?? ""];
  if (!cast) throw new Error("a pay rule's column has no known type");
  return cast;
}

const param = (value: RuleValue): string | number | null => value;

export const executePayRuleChange: Executor = async (db, session, proposal, _opts, deps) => {
  if (!flags.rulesByTalkingEnabled) return refusal("not_executable");
  if (proposal.kind !== "pay_rule_change") return refusal("not_executable");
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    const locked = await q.query<Locked>(
      `SELECT status, amount_cents, CAST(args AS text) AS args FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'pay_rule_change'
        FOR UPDATE`,
      [proposal.id],
    );
    if (locked.length !== 1) return refusal("not_found");
    const row = locked[0];
    // Already written by an earlier run of this same approval: nothing to do again.
    if (row.status === "done") return done(proposal.id);
    if (row.status !== "approved" && row.status !== "executing") return refusal("already_decided");

    let raw: unknown;
    try {
      raw = JSON.parse(row.args);
    } catch {
      raw = null;
    }
    const parsed = changeArgsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.baseVersionId !== proposal.subjectId) {
      return fail(q, proposal.id, "not_executable", nowIso);
    }
    const args = parsed.data;

    // Every version locked, and the tenant's pay rules serialized, before anything is read.
    await q.query("SELECT id FROM pay_configs WHERE tenant_id = current_tenant_id() FOR UPDATE");
    await q.query(
      "SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended('pay_rules:' || CAST(current_tenant_id() AS text), 0))) AS l",
    );
    const check = ruleChangeOf(
      await readRuleChangeRows(q),
      { ruleKey: args.ruleKey, newValue: args.newValue, askedFrom: args.askedFrom },
      "skip",
      now,
    );
    if (!check.ok) return fail(q, proposal.id, "stale", nowIso);
    const change = check.change;
    if (!changeMatches(args, change) || Number(row.amount_cents) !== Math.abs(change.impact.netDeltaCents)) {
      return fail(q, proposal.id, "stale", nowIso);
    }

    const spec = RULES[change.ruleKey];
    const columns = await payConfigColumns(q);
    const column = assertIdentifier(spec.column);
    const cast = castFor(columns, column);
    const words = `${change.label} to ${formatValue(spec, change.newValue)} (from ${formatValue(spec, change.oldValue)})`;
    let versionId: string;
    if (change.applied === "new_version") {
      versionId = randomUUID();
      const copied = [...columns.keys()].filter((c) => !OWN_COLUMNS.has(c));
      if (!copied.includes(column)) throw new Error("a pay rule's column is not in pay_configs");
      const values = copied.map((c) => (c === column ? `CAST($4 AS ${cast})` : c));
      await one(
        q,
        `INSERT INTO pay_configs (id, tenant_id, effective_from, note, source, ${copied.join(", ")})
         SELECT CAST($1 AS uuid), current_tenant_id(), CAST($2 AS date), CAST($3 AS text), 'proposal',
                ${values.join(", ")}
           FROM pay_configs
          WHERE tenant_id = current_tenant_id() AND id = CAST($5 AS uuid)
            AND ${column} IS NOT DISTINCT FROM CAST($6 AS ${cast})`,
        [versionId, change.effectiveFrom, words, param(change.newValue), change.baseVersionId, param(change.oldValue)],
      );
    } else {
      versionId = change.baseVersionId;
      await one(
        q,
        `UPDATE pay_configs
            SET ${column} = CAST($1 AS ${cast}),
                note = CASE WHEN note IS NULL THEN CAST($2 AS text) ELSE note || '; ' || CAST($2 AS text) END
          WHERE tenant_id = current_tenant_id() AND id = CAST($3 AS uuid)
            AND effective_from = CAST($5 AS date)
            AND ${column} IS NOT DISTINCT FROM CAST($4 AS ${cast})
            AND NOT EXISTS (SELECT 1 FROM settlements s
                             WHERE s.tenant_id = current_tenant_id() AND s.pay_config_id = pay_configs.id
                               AND s.status IN ('approved', 'paid'))`,
        [param(change.newValue), words, versionId, param(change.oldValue), change.effectiveFrom],
      );
    }
    await one(
      q,
      `INSERT INTO pay_rule_changes (id, tenant_id, pay_config_id, proposal_id, rule_key, old_value,
         new_value, asked_from, effective_from, applied, decided_by)
       VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, $6,
         CAST($7 AS date), CAST($8 AS date), $9, $10)`,
      [
        randomUUID(),
        versionId,
        proposal.id,
        change.ruleKey,
        valueText(change.oldValue),
        valueText(change.newValue),
        change.askedFrom,
        change.effectiveFrom,
        change.applied,
        session.sub,
      ],
    );

    // Read back: the engine's own parser takes the written version, it holds the new value, the
    // versions still sort, and the week the change starts runs under exactly this version.
    const [written] = await readRowsWhereId(q, "pay_configs", "id", versionId);
    if (!written) throw new Error("the written pay rules could not be read back");
    parsePayConfig(written as unknown as Record<string, unknown>);
    const versions = sortVersions(await readTable(q, "pay_configs"));
    if (
      written[spec.column] !== change.newValue ||
      written.effective_from !== change.effectiveFrom ||
      configFor(versions, change.effectiveFrom).id !== versionId
    ) {
      throw new Error("the written pay rules do not match the approved change");
    }

    if (row.status === "approved") {
      await one(
        q,
        `UPDATE proposals SET status = 'executing', updated_at = CAST($2 AS timestamptz)
          WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'approved'`,
        [proposal.id, nowIso],
      );
    }
    await one(
      q,
      `UPDATE proposals SET status = 'done', updated_at = CAST($2 AS timestamptz)
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND status = 'executing'`,
      [proposal.id, nowIso],
    );
    console.info(`pay rule change ${proposal.id} done applied=${change.applied}`);
    return done(proposal.id);
  });
};
