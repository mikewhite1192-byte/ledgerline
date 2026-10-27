import { flags } from "../../../../config/flags";
import type { Queryable } from "../../../db";
import { MoneyError, type MoneyFailure } from "../../../money/types";
import { forgetMoneySecret, moneySecret, type SecretDeps } from "../../secrets";
import type { UnknownCategory } from "../../types";
import { tokenKeyFrom } from "./crypto";
import { QBO_API_BASE, qboConfig, type QboConfig } from "./env";
import { refreshTokens, type FetchLike } from "./oauth";
import { loadConnection, storeRefreshed, type Connection } from "./store";
import { bodyJson, faultCodes } from "./wire";

// One QuickBooks API call at a time for a tenant: the settings and secrets checked on every call,
// the connection opened and refreshed when its access token is about to end (under FOR UPDATE, the
// rotated refresh token stored), the request sent with its requestid and minorversion, and the
// reply mapped to what the ledger needs. A 401 gets one refresh and one resend with the same
// requestid. Logs carry the method, the entity, the status, the category and Intuit's error codes
// only: never a token, an amount, a name or Intuit's error text.

export type QboDeps = SecretDeps & {
  fetch?: FetchLike;
  log?: (line: string) => void;
};

export type Call = {
  method: "GET" | "POST";
  // Below /v3/company/<realm>/, e.g. "invoice" or "query".
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  // POST only: Intuit replays the first answer for a repeated requestid.
  requestId?: string;
};

export type Reply =
  | { kind: "ok"; body: Record<string, unknown> }
  // Intuit refused it: nothing was made.
  | { kind: "refused"; category: MoneyFailure; status: number; codes: string[] }
  // Nobody knows whether it landed.
  | { kind: "unknown"; category: UnknownCategory; status?: number };

export type Prepared = { config: QboConfig; clientSecret: string; key: Buffer };
// Where a call goes: the company and the access token for it.
export type Target = { realmId: string; accessToken: string };
export type Opened = { p: Prepared; conn: Connection };

const REQUEST_ID = /^[0-9a-f]{32}$/;

export function createQboClient(deps: QboDeps = {}) {
  const env = deps.env ?? process.env;
  const fetcher: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const log = deps.log ?? ((line: string) => console.info(line));
  const secretDeps: SecretDeps = { env, secrets: deps.secrets, log: deps.log };

  // The settings and both secrets, checked whole on every call; the variable's name is logged.
  async function prepare(): Promise<Prepared> {
    const c = qboConfig(env);
    if (!c.ok) {
      log(`qbo: not configured (${c.variable})`);
      throw new MoneyError("not_configured");
    }
    const clientSecret = await moneySecret("qbo_client_secret", secretDeps);
    const key = tokenKeyFrom(await moneySecret("qbo_token_key", secretDeps));
    if (!clientSecret || !key) {
      log(`qbo: not configured (${!clientSecret ? "QBO_CLIENT_SECRET" : "QBO_TOKEN_KEY"})`);
      throw new MoneyError("not_configured");
    }
    return { config: c.config, clientSecret, key };
  }

  // The connection must be to the one allowed company, as whole strings.
  function allowed(p: Prepared, conn: Connection | null): Connection {
    if (!conn) throw new MoneyError("not_connected");
    if (conn.realmId !== p.config.allowedRealmId) {
      log("qbo: the stored company is not the allowed one (QBO_ALLOWED_REALM_ID)");
      throw new MoneyError("not_configured");
    }
    if (conn.refreshExpired) throw new MoneyError("not_connected");
    return conn;
  }

  // Under FOR UPDATE: refresh unless another call already did (the row's token is no longer the
  // one we were refused with, or is no longer expiring), then store both new tokens.
  async function refresh(
    q: Queryable,
    p: Prepared,
    timeoutMs: number,
    refusedAccess: string | null,
  ): Promise<Connection> {
    const locked = allowed(p, await loadConnection(q, p.key, { lock: true }));
    if (refusedAccess === null && !locked.expiring) return locked;
    if (refusedAccess !== null && locked.accessToken !== refusedAccess) return locked;
    const tokens = await refreshTokens(p.config, p.clientSecret, locked.refreshToken, {
      fetch: fetcher,
      timeoutMs,
    }).catch((err: unknown) => {
      const category = err instanceof MoneyError ? err.category : "unknown";
      log(`qbo: token refresh refused (${category})`);
      // A refused client secret is read again next time, so a rotated one needs no redeploy.
      if (category === "auth") forgetMoneySecret("qbo_client_secret");
      throw err instanceof MoneyError ? err : new MoneyError("unknown");
    });
    await storeRefreshed(q, p.key, locked, tokens);
    return {
      ...locked,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiring: false,
    };
  }

  // The usable connection: settings whole, the allowed company, a live access token, and for
  // anything that writes (or decides a write may go ahead) the switch on.
  async function connection(
    q: Queryable,
    timeoutMs: number,
    opts: { write: boolean },
  ): Promise<Opened> {
    if (opts.write && flags.accountingEnabled !== true) throw new MoneyError("disabled");
    const p = await prepare();
    let conn = allowed(p, await loadConnection(q, p.key, { lock: false }));
    if (conn.expiring) conn = await refresh(q, p, timeoutMs, null);
    return { p, conn };
  }

  async function sendOnce(
    p: Prepared,
    conn: Target,
    call: Call,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown } | { thrown: UnknownCategory }> {
    const query = new URLSearchParams(call.query ?? {});
    if (call.method === "POST") {
      if (!call.requestId || !REQUEST_ID.test(call.requestId)) throw new MoneyError("validation");
      query.set("requestid", call.requestId);
    }
    query.set("minorversion", String(p.config.minorVersion));
    const url = `${QBO_API_BASE}/v3/company/${conn.realmId}/${call.path}?${query.toString()}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${conn.accessToken}`,
      Accept: "application/json",
    };
    if (call.method === "POST") headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetcher(url, {
        method: call.method,
        headers,
        body: call.method === "POST" ? bodyJson(call.body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      return { thrown: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  function replyOf(
    call: Call,
    r: { status: number; body: unknown } | { thrown: UnknownCategory },
  ): Reply {
    const what = `${call.method} ${call.path}`;
    if ("thrown" in r) {
      log(`qbo: ${what} ${r.thrown}`);
      return { kind: "unknown", category: r.thrown };
    }
    const { status, body } = r;
    const { type, codes } = faultCodes(body);
    const line = (category: string) =>
      log(`qbo: ${what} ${status} ${category}${type ? ` ${type}` : ""}${codes.length ? ` codes=${codes.join(",")}` : ""}`);
    if (status === 200) {
      if (typeof body !== "object" || body === null || Array.isArray(body) || type !== "") {
        // A 200 that is not a plain answer (a Fault inside, or no JSON): not known either way.
        line("unknown");
        return { kind: "unknown", category: "unknown", status };
      }
      return { kind: "ok", body: body as Record<string, unknown> };
    }
    let category: MoneyFailure | UnknownCategory;
    if (status === 400) category = "validation";
    else if (status === 401 || status === 403) category = "auth";
    else if (status === 429) category = "rate_limited";
    else if (status >= 500) category = "unavailable";
    else category = "unknown";
    line(category);
    if (category === "unavailable" || category === "unknown") {
      return { kind: "unknown", category, status };
    }
    return { kind: "refused", category, status, codes };
  }

  // One call on a connection from connection(): a 401 refreshes once and resends the same
  // request (same requestid). A POST checks the switch again here, at the write.
  async function request(
    q: Queryable,
    opened: Opened,
    call: Call,
    timeoutMs: number,
  ): Promise<Reply> {
    if (call.method === "POST" && flags.accountingEnabled !== true) {
      throw new MoneyError("disabled");
    }
    const { p, conn } = opened;
    let r = await sendOnce(p, conn, call, timeoutMs);
    if (!("thrown" in r) && r.status === 401) {
      log(`qbo: ${call.method} ${call.path} 401, refreshing once`);
      const fresh = await refresh(q, p, timeoutMs, conn.accessToken);
      r = await sendOnce(p, fresh, call, timeoutMs);
    }
    return replyOf(call, r);
  }

  // One call with tokens the caller holds (the connect flow, before anything is stored): no
  // switch, no refresh. The caller has checked the company is the allowed one.
  async function direct(p: Prepared, target: Target, call: Call, timeoutMs: number): Promise<Reply> {
    if (target.realmId !== p.config.allowedRealmId) throw new MoneyError("not_configured");
    return replyOf(call, await sendOnce(p, target, call, timeoutMs));
  }

  return { prepare, connection, request, direct, fetch: fetcher, log };
}

export type QboClient = ReturnType<typeof createQboClient>;
