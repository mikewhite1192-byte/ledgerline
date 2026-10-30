import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { configFor, sortVersions } from "../../data/config-version";
import { readRowsWhereId, readTable } from "../../data/read";
import { assertIdentifier } from "../../data/tables";
import { changeArgsSchema, changeMatches, readRuleChangeRows, ruleChangeOf } from "../../pay-rules/change";
import { formatValue, RULES, valueText, type RuleValue } from "../../pay-rules/rules";
import { castFor, insertVersionCopy, lockPayRules, one, payConfigColumns } from "../../pay-rules/write-version";
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
    await lockPayRules(q);
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
      // The shared write (src/lib/pay-rules/write-version.ts): the base copied with the one rule
      // replaced, guarded on its old value.
      await insertVersionCopy(q, columns, {
        versionId,
        baseVersionId: change.baseVersionId,
        effectiveFrom: change.effectiveFrom,
        note: words,
        replacements: [{ key: change.ruleKey, newValue: param(change.newValue), oldValue: param(change.oldValue) }],
      });
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
