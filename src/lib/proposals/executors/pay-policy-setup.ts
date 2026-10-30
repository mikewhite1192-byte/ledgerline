import { randomUUID } from "node:crypto";
import { flags } from "../../../config/flags";
import type { Queryable } from "../../db";
import { untrustedContentHash } from "../../data/content-hash";
import { configFor, sortVersions } from "../../data/config-version";
import type { PayConfigRow } from "../../data/rows";
import { readRowsWhereId, readTable } from "../../data/read";
import { RULE_KEYS, RuleError, RULES, valueText } from "../../pay-rules/rules";
import { insertVersionCopy, lockPayRules, one, payConfigColumns, VERSION_NOTE_MAX } from "../../pay-rules/write-version";
import { parsePolicyArgs, type PolicyArgs } from "../../policy-onboard/args";
import { citedPassage, namesRule } from "../../policy-onboard/cite";
import { candidatesFor } from "../../policy-onboard/parse";
import { checkStart, parseStoredValue, planVersion, type Edits, type PlannedChange } from "../../policy-onboard/plan";
import { sectionsOfTranscript } from "../../policy-onboard/sections";
import { readPlanRows, readPolicyDocument, readTranscript } from "../../policy-onboard/store";
import { parsePayConfig } from "../../rules-engine";
import type { Executor, Precheck, ProposalRefused, ProposalResult } from "../execute";

// A person approved a pay_policy_setup card: write one new dated version of the carrier's pay
// rules, in one tenant transaction, or nothing.
//
// The proposal row is locked first, then every version and the tenant's pay rules lock (the same
// one a pay rule change takes, so the two run one after the other). Then everything the card was
// made from is checked again: the transcript is the one the document points at and still hashes
// the same, every quote is word for word in its section, and every Found value is one the quote
// itself states, from a quote that names its rule. The start must still be a week start after this week with no later version and
// no approved or paid pay on or after it, and its base still the version in force. Then the plan:
// each Found value, or the person's edit, set over the base (a rule Not in document keeps the
// base's value; one that Needs you must be edited), each through the rule's own parser and the
// whole version through the engine's own check. A version that raises the advance limit or the
// most recovered a week, or lowers the net pay floor, needs an admin (design 5.2): the role is
// read here because a resume skips the gate.
//
// What the person can fix (a choice still needed, an edit that does not parse, a value out of
// range, nothing left to change, the role) is refused without touching the row, so the card can
// be approved again with other edits or by an admin. Anything else (the card or its document no
// longer checks, the start no longer holds) fails the row as stale or not_executable.
//
// On a pass: one new version copied from the base with each changed rule replaced (guarded on its
// old value), one pay_rule_changes row per changed rule, a read-back through the engine's own
// parser, and the proposal moves to done. A mismatch after a write throws, so the transaction
// rolls back. The switch: policyOnboardEnabled off refuses as not_executable before anything is
// read. Nothing here moves money, writes a settlement or calls an outside system.

const done = (proposalId: string): ProposalResult => ({ ok: true, proposalId, status: "done", moneyActionId: null });
const refusal = (category: string, retryable = false): ProposalRefused => ({ ok: false, category, retryable });

type Checked =
  | { ok: true; base: PayConfigRow; changes: PlannedChange[] }
  | { ok: false; category: string; person: boolean };

// The card's own record, checked against the rows: the document, its transcript and every passage.
async function recordHolds(q: Queryable, args: PolicyArgs): Promise<boolean> {
  const doc = await readPolicyDocument(q, args.documentId);
  if (!doc || doc.document_kind !== "pay_policy" || doc.read_status !== "read") return false;
  if (doc.untrusted_input_id !== args.transcriptId) return false;
  const transcript = await readTranscript(q, args.transcriptId);
  if (!transcript || transcript.content_hash !== untrustedContentHash("document", transcript.body_text)) return false;
  const sections = sectionsOfTranscript(transcript.body_text);
  if (!sections) return false;
  for (const key of RULE_KEYS) {
    const field = args.fields[key];
    for (const p of field.passages) {
      const cited = citedPassage(sections, p);
      if (!cited || cited.quote !== p.quote || cited.paragraph !== p.paragraph) return false;
    }
    if (field.state === "found") {
      if (field.passages.length === 0) return false;
      let value;
      try {
        value = parseStoredValue(key, field.value);
      } catch (error) {
        if (error instanceof RuleError) return false;
        throw error;
      }
      for (const p of field.passages) {
        if (!namesRule(key, p.quote)) return false;
        const c = candidatesFor(key, p.quote);
        if (c.range !== null || c.weekMismatch || !c.values.includes(value)) return false;
      }
    }
    if (field.state === "not_in_document" && field.passages.length > 0) return false;
  }
  for (const n of args.noted) {
    const cited = citedPassage(sections, n);
    if (!cited || cited.quote !== n.quote) return false;
  }
  return true;
}

async function check(
  q: Queryable,
  args: PolicyArgs,
  subjectId: string,
  edits: Edits,
  role: string | null,
  now: Date,
): Promise<Checked> {
  if (args.baseVersionId !== subjectId) return { ok: false, category: "not_executable", person: false };
  if (!(await recordHolds(q, args))) return { ok: false, category: "not_executable", person: false };
  const placed = checkStart(await readPlanRows(q), args.effectiveFrom, args.baseVersionId, now);
  if (!placed.ok) {
    const category = placed.reason === "locked_version" ? "locked_version" : "stale";
    return { ok: false, category, person: false };
  }
  const plan = planVersion(placed.base, args.fields, edits);
  if (!plan.ok) return { ok: false, category: plan.reason, person: true };
  if (plan.adminRequired && role !== "admin") return { ok: false, category: "role", person: true };
  return { ok: true, base: placed.base, changes: plan.changes };
}

async function roleOf(q: Queryable, sub: string): Promise<string | null> {
  const rows = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [sub],
  );
  return rows[0]?.role ?? null;
}

// Before the approval, inside the gate's transaction: the same checks, reads only, so a card that
// cannot be written stays proposed with its Approve button.
const precheck: Precheck = async (q, proposal, now, ctx) => {
  if (!flags.policyOnboardEnabled || proposal.kind !== "pay_policy_setup" || !ctx) return refusal("not_executable");
  const args = parsePolicyArgs(proposal.args);
  if (!args) return refusal("not_executable");
  const checked = await check(q, args, proposal.subjectId, ctx.opts.edits ?? {}, await roleOf(q, ctx.session.sub), now);
  return checked.ok ? null : refusal(checked.category, checked.person);
};

async function fail(q: Queryable, proposalId: string, category: string, nowIso: string): Promise<ProposalResult> {
  await q.execute(
    `UPDATE proposals SET status = 'failed', decision_note = $2, updated_at = CAST($3 AS timestamptz)
      WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid)
        AND status IN ('approved', 'executing')`,
    [proposalId, category, nowIso],
  );
  console.warn(`pay policy setup ${proposalId} refused: ${category}`);
  return refusal(category);
}

// The version's note: the rules it set, the person's own marked, cut to the note's length.
function noteOf(changes: readonly PlannedChange[]): string {
  const parts = changes.map((c) => (c.edited ? `${RULES[c.key].label} (changed by you)` : RULES[c.key].label));
  const note = `From the pay policy document: ${parts.join(", ")}`;
  return note.length <= VERSION_NOTE_MAX ? note : `${note.slice(0, VERSION_NOTE_MAX - 3)}...`;
}

type Locked = { status: string; args: string };

const execute: Executor = async (db, session, proposal, opts, deps) => {
  if (!flags.policyOnboardEnabled) return refusal("not_executable");
  if (proposal.kind !== "pay_policy_setup") return refusal("not_executable");
  const now = (deps.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();
  return db.withTenant(session.tenantId, async (q) => {
    const locked = await q.query<Locked>(
      `SELECT status, CAST(args AS text) AS args FROM proposals
        WHERE tenant_id = current_tenant_id() AND id = CAST($1 AS uuid) AND kind = 'pay_policy_setup'
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
    const args = parsePolicyArgs(raw);
    if (!args) return fail(q, proposal.id, "not_executable", nowIso);

    // Every version locked, and the tenant's pay rules serialized, before anything is read.
    await lockPayRules(q);
    const checked = await check(q, args, proposal.subjectId, opts.edits ?? {}, await roleOf(q, session.sub), now);
    if (!checked.ok) {
      if (checked.person) return refusal(checked.category, true);
      return fail(q, proposal.id, checked.category, nowIso);
    }
    const { base, changes } = checked;

    const versionId = randomUUID();
    await insertVersionCopy(q, await payConfigColumns(q), {
      versionId,
      baseVersionId: base.id,
      effectiveFrom: args.effectiveFrom,
      note: noteOf(changes),
      replacements: changes.map((c) => ({ key: c.key, newValue: c.newValue, oldValue: c.oldValue })),
    });
    for (const c of changes) {
      await one(
        q,
        `INSERT INTO pay_rule_changes (id, tenant_id, pay_config_id, proposal_id, rule_key, old_value,
           new_value, asked_from, effective_from, applied, decided_by)
         VALUES (CAST($1 AS uuid), current_tenant_id(), CAST($2 AS uuid), CAST($3 AS uuid), $4, $5, $6,
           CAST($7 AS date), CAST($8 AS date), 'new_version', $9)`,
        [
          randomUUID(),
          versionId,
          proposal.id,
          c.key,
          valueText(c.oldValue),
          valueText(c.newValue),
          args.askedFrom,
          args.effectiveFrom,
          session.sub,
        ],
      );
    }

    // Read back: the engine's own parser takes the written version, it holds every new value, the
    // versions still sort, and the week it starts runs under exactly this version.
    const [written] = await readRowsWhereId(q, "pay_configs", "id", versionId);
    if (!written) throw new Error("the written pay rules could not be read back");
    parsePayConfig(written as unknown as Record<string, unknown>);
    const versions = sortVersions(await readTable(q, "pay_configs"));
    if (
      changes.some((c) => written[RULES[c.key].column] !== c.newValue) ||
      written.effective_from !== args.effectiveFrom ||
      configFor(versions, args.effectiveFrom).id !== versionId
    ) {
      throw new Error("the written pay rules do not match the approved card");
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
    console.info(`pay policy setup ${proposal.id} done rules=${changes.length}`);
    return done(proposal.id);
  });
};

export const payPolicySetupExecutor: Executor = Object.assign(execute, { precheck });
