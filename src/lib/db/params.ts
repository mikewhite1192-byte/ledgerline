import type { SqlParameter } from "@aws-sdk/client-rds-data";
import type { Param } from "./types";

// App SQL is written once with pg-style $1, $2 placeholders. The Data API wants named
// parameters, so $n becomes :pn and each value gets its typed field. Migrations never pass
// through here (their $$ bodies would not survive it); they run statement by statement.
const PLACEHOLDER = /\$(\d+)/g;

export function toDataApiParams(
  sql: string,
  params: Param[] = [],
): { sql: string; parameters: SqlParameter[] } {
  const used = new Set<number>();
  const rewritten = sql.replace(PLACEHOLDER, (_match, digits: string) => {
    const n = Number(digits);
    if (n < 1 || n > params.length) throw new Error(`placeholder $${n} has no parameter`);
    used.add(n);
    return `:p${n}`;
  });
  // Postgres refuses a parameter the statement never references, so the Data API path does too.
  if (used.size !== params.length) throw new Error("every parameter must be referenced");
  return { sql: rewritten, parameters: params.map((value, i) => toField(`p${i + 1}`, value)) };
}

function toField(name: string, value: Param): SqlParameter {
  if (value === null) return { name, value: { isNull: true } };
  if (typeof value === "string") return { name, value: { stringValue: value } };
  if (typeof value === "boolean") return { name, value: { booleanValue: value } };
  if (typeof value === "number") {
    // Cents are integers. A float or an integer past 2^53 would lose money silently.
    if (!Number.isSafeInteger(value)) throw new Error(`${name} is not a safe integer`);
    return { name, value: { longValue: value } };
  }
  throw new Error(`${name} has an unsupported type`);
}
