import type { Param, Queryable, TenantDb } from "../../../db";
import type { Session } from "../../../auth/claims";
import type { GatewayContext } from "../types";

// A scripted TenantDb for the gateway's unit tests: no network, no clock. It answers the
// membership check, the ref check, single-table reads by an id column and the decision insert,
// and hands anything else to the test's own handler. Every statement is recorded in order.

export type Row = Record<string, unknown>;
export type Handler = (sql: string, params: Param[]) => Row[] | number | undefined;

export type LoggedDecision = {
  id: string;
  turnId: string | null;
  traceId: string;
  role: string;
  model: string;
  tool: string;
  tier: string | null;
  argsRedacted: Record<string, unknown>;
  refs: unknown[];
  decision: string;
  reason: string;
  limitCents: number | null;
  requestedCents: number | null;
  resultChars: number | null;
  modelCallId: string | null;
  latencyMs: number;
};

export class FakeDb implements TenantDb {
  readonly statements: { tenantId: string; sql: string; params: Param[] }[] = [];
  readonly decisions: LoggedDecision[] = [];
  transactions = 0;
  member = true;
  failDecisionInsert = false;

  constructor(
    // Rows per table, as the readers would return them.
    readonly tables: Record<string, Row[]> = {},
    readonly handler?: Handler,
  ) {}

  async withTenant<T>(tenantId: string, fn: (q: Queryable) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const q: Queryable = {
      query: async <R>(sql: string, params: Param[] = []) => {
        const out = this.answer(tenantId, sql, params);
        if (typeof out === "number") throw new Error("a query got a row count");
        return out as R[];
      },
      execute: async (sql: string, params: Param[] = []) => {
        const out = this.answer(tenantId, sql, params);
        return typeof out === "number" ? out : out.length;
      },
    };
    return fn(q);
  }

  private answer(tenantId: string, sql: string, params: Param[]): Row[] | number {
    this.statements.push({ tenantId, sql, params });
    // A member reads as staff, for the shell's role read (a judge has its own tests).
    if (sql.includes("FROM memberships")) return this.member ? [{ ok: 1, role: "staff" }] : [];
    if (sql.startsWith("INSERT INTO gateway_decisions")) {
      if (this.failDecisionInsert) throw new Error("insert refused");
      this.decisions.push(decisionOf(params));
      return 1;
    }
    const custom = this.handler?.(sql, params);
    if (custom !== undefined) return custom;
    const ref = /^SELECT 1 AS ok FROM (\w+) WHERE tenant_id = current_tenant_id\(\) AND id = CAST\(\$1 AS uuid\)$/.exec(
      sql,
    );
    if (ref) {
      return (this.tables[ref[1]] ?? []).some((r) => r.id === params[0]) ? [{ ok: 1 }] : [];
    }
    const byId = /FROM (\w+) WHERE tenant_id = current_tenant_id\(\) AND (\w+) = CAST\(\$1 AS uuid\)/.exec(sql);
    if (byId) return (this.tables[byId[1]] ?? []).filter((r) => r[byId[2]] === params[0]);
    throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
  }
}

function decisionOf(p: Param[]): LoggedDecision {
  return {
    id: p[0] as string,
    turnId: p[1] as string | null,
    traceId: p[2] as string,
    role: p[3] as string,
    model: p[4] as string,
    tool: p[5] as string,
    tier: p[6] as string | null,
    argsRedacted: JSON.parse(p[7] as string),
    refs: JSON.parse(p[8] as string),
    decision: p[9] as string,
    reason: p[10] as string,
    limitCents: p[11] as number | null,
    requestedCents: p[12] as number | null,
    resultChars: p[13] as number | null,
    modelCallId: p[14] as string | null,
    latencyMs: p[15] as number,
  };
}

export const TENANT = "5b0a4d8e-2c1f-4e3a-9b7d-6f5e4d3c2b1a";
export const OTHER_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";

export const SESSION: Session = {
  sub: "sub-operator",
  email: "ops@example.test",
  tenantId: TENANT,
};

// A fixed clock: 2026-10-24 15:00 UTC, with a deadline a minute later.
export const NOW = Date.UTC(2026, 9, 24, 15, 0, 0);

export function context(over: Partial<GatewayContext> = {}): GatewayContext {
  return {
    session: SESSION,
    role: "operator",
    model: "spark",
    turnId: null,
    traceId: "trace-test-1",
    now: new Date(NOW),
    deadlineAt: NOW + 60_000,
    timeZone: "America/New_York",
    ...over,
  };
}

export const fixedClock = () => NOW;
