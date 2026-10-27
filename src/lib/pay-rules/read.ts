import type { Queryable } from "../db";
import { configForDay } from "../data/config-version";
import { readPayConfigVersions, readTenant } from "../data/read";
import type { PayConfigRow, PayRuleChangeRow } from "../data/rows";
import { ConfigError } from "../rules-engine";
import { localDateOf, type LocalDate } from "../time/local-date";
import { nextWeekStart } from "./words";

// The reads behind the Pay rules page and the chat's pay rule chip, inside the caller's tenant
// transaction (row security plus an explicit tenant filter on every statement).

const UTC_INSTANT = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

// Every executed pay rule change of the tenant, newest first: the diff beside each version.
export async function readPayRuleChanges(q: Queryable): Promise<PayRuleChangeRow[]> {
  return q.query<PayRuleChangeRow>(
    `SELECT CAST(id AS text) AS id, CAST(pay_config_id AS text) AS pay_config_id,
            CAST(proposal_id AS text) AS proposal_id, rule_key, old_value, new_value,
            CAST(asked_from AS text) AS asked_from, CAST(effective_from AS text) AS effective_from,
            applied, decided_by,
            to_char(created_at AT TIME ZONE 'UTC', ${UTC_INSTANT}) AS created_at
       FROM pay_rule_changes
      WHERE tenant_id = current_tenant_id()
      ORDER BY created_at DESC, id`,
  );
}

// The first date a change may start: the week after the one that holds now, in the carrier's zone
// and week shape (every version shares the week shape). Null only when the rules hold no week
// (no version, two on one date, a changed week shape). A failed read is not "no week": it throws,
// and the caller shows its own error state.
export async function readNextWeekStart(q: Queryable, now: Date): Promise<LocalDate | null> {
  const tenant = await readTenant(q);
  if (!tenant) return null;
  let first: PayConfigRow;
  try {
    [first] = await readPayConfigVersions(q);
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
  return nextWeekStart(now, tenant.timezone, first.week_start_dow);
}

export type PayRulesVersion = PayConfigRow & { weeksPaid: number };

export type PayRulesPage = {
  timeZone: string;
  // The first date a change may start, for the chat's example sentence.
  nextStart: LocalDate;
  // Oldest first, each with how many weeks were paid under it (approved or paid settlements).
  versions: PayRulesVersion[];
  // The version this week runs under.
  currentId: string;
  // The signed-in member's role, for the admin-only button.
  role: string | null;
};

// Everything the Pay rules page shows except the waiting cards. Throws when the rules cannot be
// read whole (no version, two on one date, a changed week shape): the page shows its error state.
export async function readPayRulesPage(q: Queryable, sub: string, now: Date): Promise<PayRulesPage> {
  const tenant = await readTenant(q);
  if (!tenant) throw new Error("no tenant is set");
  const versions = await readPayConfigVersions(q);
  const counts = await q.query<{ pay_config_id: string; weeks: number | string }>(
    `SELECT CAST(pay_config_id AS text) AS pay_config_id, CAST(count(DISTINCT period_id) AS integer) AS weeks
       FROM settlements
      WHERE tenant_id = current_tenant_id() AND status IN ('approved', 'paid')
      GROUP BY pay_config_id`,
  );
  const weeks = new Map(counts.map((c) => [c.pay_config_id, Number(c.weeks)]));
  const members = await q.query<{ role: string }>(
    "SELECT role FROM memberships WHERE tenant_id = current_tenant_id() AND cognito_sub = $1",
    [sub],
  );
  const today = localDateOf(now.toISOString(), tenant.timezone);
  return {
    timeZone: tenant.timezone,
    nextStart: nextWeekStart(now, tenant.timezone, versions[0].week_start_dow),
    versions: versions.map((v) => ({ ...v, weeksPaid: weeks.get(v.id) ?? 0 })),
    currentId: configForDay(versions, today).id,
    role: members.length === 1 ? members[0].role : null,
  };
}
