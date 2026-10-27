// Fakes for the QuickBooks unit tests: a made-up company, settings and key; a fetch that records
// every request and answers from a script; and a Queryable that keeps the one connection row and
// the id map in memory. No network, no database, no clock. Tests only.

import type { Param, Queryable } from "../../../db";
import { sealToken } from "./crypto";
import type { FetchLike } from "./oauth";

export const TENANT = "5b0e6f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
// Made-up company ids, never a real one; the second differs from the first by one digit.
export const REALM = "1234567890123456";
export const REALM_OFF_BY_ONE = "1234567890123457";

export const KEY = Buffer.alloc(32, 7);
export const TOKEN_KEY_TEXT = KEY.toString("base64");

// Obviously fake values, built so no scanner mistakes them for real ones.
export const CLIENT_ID = `TESTCLIENT${"0".repeat(10)}`;
export const CLIENT_SECRET = "fake".repeat(6);
export const ACCESS = `access-${"1".repeat(24)}`;
export const REFRESH = `refresh-${"2".repeat(24)}`;
export const NEW_ACCESS = `access-${"3".repeat(24)}`;
export const NEW_REFRESH = `refresh-${"4".repeat(24)}`;

export function qboEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    QBO_ENVIRONMENT: "sandbox",
    QBO_CLIENT_ID: CLIENT_ID,
    QBO_CLIENT_SECRET: CLIENT_SECRET,
    QBO_REDIRECT_URI: "http://localhost:3000/api/qbo/callback",
    QBO_ALLOWED_REALM_ID: REALM,
    QBO_TOKEN_KEY: TOKEN_KEY_TEXT,
    ...over,
  } as unknown as NodeJS.ProcessEnv;
}

export const ACCOUNTS = {
  freight_income: "101",
  driver_pay: "102",
  driver_reimbursements: "103",
  driver_advances: "104",
  driver_escrow: "105",
  driver_chargebacks: "106",
  ledgerline_clearing: "107",
  accounts_receivable: "108",
  accounts_payable: "109",
};

export const ITEMS = {
  Freight: "201",
  "Fuel Surcharge": "202",
  Detention: "203",
  Layover: "204",
  Stop: "205",
  Lumper: "206",
};

export type Sent = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type Answer = { status: number; body?: unknown } | { throws: string };

// Answers each request with the next scripted answer; a request with none left fails the test.
export function scriptedFetch(answers: Answer[]): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const queue = [...answers];
  const fetch: FetchLike = async (url, init) => {
    sent.push({
      url: new URL(url),
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if ("throws" in next) {
      const err = new Error("fetch failed");
      err.name = next.throws;
      throw err;
    }
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return new Response(text, { status: next.status });
  };
  return { fetch, sent };
}

export const fault = (code: string, type = "ValidationFault") => ({
  Fault: { type, Error: [{ code, Message: "upstream words", Detail: "upstream detail" }] },
});

export const tokenReply = (access = NEW_ACCESS, refresh = NEW_REFRESH) => ({
  access_token: access,
  refresh_token: refresh,
  token_type: "bearer",
  expires_in: 3600,
  x_refresh_token_expires_in: 8_726_400,
});

type Row = {
  realm_id: string;
  access_enc: string;
  refresh_enc: string;
  expiring: boolean;
  refresh_expired: boolean;
  account_map: string;
  item_map: string;
};

// The tenant's QuickBooks rows, answering only the statements store.ts sends.
export class FakeQboDb implements Queryable {
  row: Row | null;
  entityIds = new Map<string, string>();
  locks = 0;
  refreshed: Param[][] = [];
  statements: string[] = [];
  // The tenant this database answers for (current_tenant_id()); its tokens are sealed to it.
  readonly tenantId: string;

  constructor(
    opts: {
      realmId?: string;
      expiring?: boolean;
      refreshExpired?: boolean;
      connected?: boolean;
      tenantId?: string;
    } = {},
  ) {
    const realm = opts.realmId ?? REALM;
    const tenant = opts.tenantId ?? TENANT;
    this.tenantId = tenant;
    this.row =
      opts.connected === false
        ? null
        : {
            realm_id: realm,
            access_enc: sealToken(KEY, ACCESS, tenant, realm, "access").toString("base64"),
            refresh_enc: sealToken(KEY, REFRESH, tenant, realm, "refresh").toString("base64"),
            expiring: opts.expiring ?? false,
            refresh_expired: opts.refreshExpired ?? false,
            account_map: JSON.stringify(ACCOUNTS),
            item_map: JSON.stringify(ITEMS),
          };
  }

  async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
    this.statements.push(sql);
    if (sql.includes("CAST(current_tenant_id() AS text) AS id")) return [{ id: this.tenantId }] as T[];
    if (sql.includes("FROM qbo_connections") && sql.includes("encode(access_token_enc")) {
      if (sql.includes("FOR UPDATE")) this.locks += 1;
      return (this.row ? [{ ...this.row }] : []) as T[];
    }
    if (sql.includes("SELECT outside_id FROM qbo_entity_ids")) {
      const v = this.entityIds.get(`${params[0]}:${params[1]}`);
      return (v ? [{ outside_id: v }] : []) as T[];
    }
    throw new Error("unexpected query");
  }

  async execute(sql: string, params: Param[] = []): Promise<number> {
    this.statements.push(sql);
    const s = sql.trimStart();
    if (s.startsWith("UPDATE qbo_connections") && this.row) {
      this.refreshed.push(params);
      this.row = {
        ...this.row,
        access_enc: String(params[0]),
        refresh_enc: String(params[1]),
        expiring: false,
      };
      return 1;
    }
    if (s.startsWith("INSERT INTO qbo_entity_ids")) {
      const k = `${params[0]}:${params[1]}`;
      if (this.entityIds.has(k)) return 0;
      this.entityIds.set(k, String(params[3]));
      return 1;
    }
    throw new Error("unexpected statement");
  }
}
