import { randomBytes } from "node:crypto";
import type { Queryable } from "../../../db";
import { MoneyError } from "../../../money/types";
import { createQboClient, type Prepared, type QboDeps, type Target } from "./client";
import { PATH_OF, queryRows } from "./entities";
import { REALM_ID } from "./env";
import { resolveMapping, type MappingPort } from "./mapping";
import { authorizeUrl, exchangeCode, revokeToken, type Tokens } from "./oauth";
import {
  addOAuthState,
  deleteConnection,
  loadConnection,
  membershipOf,
  saveConnection,
  takeOAuthState,
} from "./store";

// Connecting a tenant to the one allowed QuickBooks sandbox company, by an admin of that tenant.
// This sets the connection up (and, the first time, the LedgerLine accounts and items in that
// company); it books nothing. Finding the accounts and items needs only complete QuickBooks
// settings, but creating any of them is a write to the company, so it waits for the accounting
// switch (client.direct refuses the POST): with the switch off, a company still missing them is
// refused as "disabled" and nothing stays connected. Each database step is its own short tenant
// transaction; no transaction is held open across a call to Intuit.

// Runs fn in a transaction scoped to the signed-in user's tenant, membership checked.
export type TenantRun = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

export type ConnectRefusal =
  // Not an admin of this tenant.
  | "forbidden"
  // QuickBooks settings or secrets missing or malformed.
  | "not_configured"
  // The state was unknown, used, stale or another person's: start again.
  | "expired"
  // Intuit sent back a company other than the allowed one; the grant was revoked.
  | "not_allowed"
  // The person said no at Intuit.
  | "declined"
  // The company's accounts or items had to be created and the accounting switch is off; the grant
  // was revoked.
  | "disabled"
  // Intuit refused, or the company's accounts could not be set up.
  | "failed";

export type StartResult = { ok: true; url: string } | { ok: false; reason: ConnectRefusal };
export type FinishResult = { ok: true } | { ok: false; reason: ConnectRefusal };

const TIMEOUT_MS = 20_000;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[\x21-\x7e]{1,512}$/;

export type CallbackParams = {
  code: string | null;
  state: string | null;
  realmId: string | null;
  error: string | null;
};

export function createQboConnect(deps: QboDeps = {}) {
  const client = createQboClient(deps);
  const log = client.log;

  async function prepared(): Promise<Prepared | null> {
    try {
      return await client.prepare();
    } catch {
      return null;
    }
  }

  // An admin asks to connect: a single-use state tied to their membership, then Intuit.
  async function start(run: TenantRun, sub: string): Promise<StartResult> {
    const p = await prepared();
    if (!p) return { ok: false, reason: "not_configured" };
    const state = randomBytes(32).toString("base64url");
    const ok = await run(async (q) => {
      const m = await membershipOf(q, sub);
      if (!m || m.role !== "admin") return false;
      await addOAuthState(q, state, m.id);
      return true;
    });
    if (!ok) return { ok: false, reason: "forbidden" };
    return { ok: true, url: authorizeUrl(p.config, state) };
  }

  async function revoke(p: Prepared, tokens: Tokens, why: string): Promise<void> {
    try {
      await revokeToken(p.config, p.clientSecret, tokens.refreshToken, {
        fetch: client.fetch,
        timeoutMs: TIMEOUT_MS,
      });
      log(`qbo: connect ${why}, grant revoked`);
    } catch (err) {
      const category = err instanceof MoneyError ? err.category : "unknown";
      log(`qbo: connect ${why}, revoke not confirmed (${category})`);
    }
  }

  function port(p: Prepared, target: Target): MappingPort {
    return {
      async findIds(entity, where) {
        const reply = await client.direct(
          p,
          target,
          { method: "GET", path: "query", query: { query: `SELECT * FROM ${entity} WHERE ${where}` } },
          TIMEOUT_MS,
        );
        if (reply.kind !== "ok") throw new MoneyError(reply.category);
        const rows = queryRows(entity, reply.body);
        if (!rows) throw new MoneyError("unknown");
        return rows.map((r) => r.id);
      },
      async create(entity, body) {
        // A fresh requestid: a lost answer is found by name on the next connect, never made twice
        // by a replay of a different body.
        const reply = await client.direct(
          p,
          target,
          {
            method: "POST",
            path: PATH_OF[entity],
            body,
            requestId: randomBytes(16).toString("hex"),
          },
          TIMEOUT_MS,
        );
        if (reply.kind === "refused" && reply.codes.includes("6240")) {
          throw new MoneyError("duplicate");
        }
        if (reply.kind !== "ok") throw new MoneyError(reply.category);
        const made = reply.body[entity];
        const id = typeof made === "object" && made !== null ? (made as { Id?: unknown }).Id : null;
        if (typeof id !== "string" || !/^[0-9]{1,20}$/.test(id)) throw new MoneyError("unknown");
        return id;
      },
    };
  }

  // Intuit sends the person back. The state is used up first, whatever happens next.
  async function finish(run: TenantRun, sub: string, params: CallbackParams): Promise<FinishResult> {
    const state = params.state;
    if (typeof state !== "string" || !STATE.test(state)) return { ok: false, reason: "expired" };
    const taken = await run(async (q) => {
      const t = await takeOAuthState(q, state);
      const m = await membershipOf(q, sub);
      return { t, m };
    });
    if (!taken.t || !taken.t.fresh) return { ok: false, reason: "expired" };
    if (!taken.m || taken.m.role !== "admin" || taken.m.id !== taken.t.membershipId) {
      return { ok: false, reason: "forbidden" };
    }
    const membershipId = taken.m.id;
    if (params.error !== null || params.code === null) return { ok: false, reason: "declined" };
    if (!CODE.test(params.code)) return { ok: false, reason: "failed" };
    const p = await prepared();
    if (!p) return { ok: false, reason: "not_configured" };

    let tokens: Tokens;
    try {
      tokens = await exchangeCode(p.config, p.clientSecret, params.code, {
        fetch: client.fetch,
        timeoutMs: TIMEOUT_MS,
      });
    } catch (err) {
      const category = err instanceof MoneyError ? err.category : "unknown";
      log(`qbo: connect code exchange refused (${category})`);
      return { ok: false, reason: "failed" };
    }

    // The one allowed company, compared as whole strings. Any other: nothing stays connected.
    const realmId = params.realmId;
    if (realmId !== p.config.allowedRealmId || !REALM_ID.test(realmId)) {
      log("qbo: connect refused, not the allowed company (QBO_ALLOWED_REALM_ID)");
      await revoke(p, tokens, "refused");
      return { ok: false, reason: "not_allowed" };
    }

    let mapping: Awaited<ReturnType<typeof resolveMapping>>;
    try {
      mapping = await resolveMapping(port(p, { realmId, accessToken: tokens.accessToken }));
    } catch (err) {
      const category = err instanceof MoneyError ? err.category : "unknown";
      log(`qbo: connect could not set up accounts and items (${category})`);
      await revoke(p, tokens, "abandoned");
      return { ok: false, reason: category === "disabled" ? "disabled" : "failed" };
    }

    try {
      await run(async (q) => {
        // Still an admin, and the same person who started.
        const m = await membershipOf(q, sub);
        if (!m || m.role !== "admin" || m.id !== membershipId) throw new MoneyError("auth");
        await saveConnection(q, p.key, { realmId, tokens, ...mapping, membershipId });
      });
    } catch (err) {
      const category = err instanceof MoneyError ? err.category : "unknown";
      log(`qbo: connect could not store the connection (${category})`);
      await revoke(p, tokens, "abandoned");
      return { ok: false, reason: category === "auth" ? "forbidden" : "failed" };
    }
    log("qbo: connected");
    return { ok: true };
  }

  // An admin disconnects: the grant revoked at Intuit when it can be, the row deleted either way.
  async function disconnect(
    run: TenantRun,
    sub: string,
  ): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: "forbidden" }> {
    const p = await prepared();
    const read = await run(async (q) => {
      const m = await membershipOf(q, sub);
      if (!m || m.role !== "admin") return { admin: false as const };
      if (!p) return { admin: true as const, refreshToken: null };
      try {
        const conn = await loadConnection(q, p.key, { lock: false });
        return { admin: true as const, refreshToken: conn?.refreshToken ?? null };
      } catch {
        // Tokens that cannot be opened cannot be revoked; the row still goes.
        return { admin: true as const, refreshToken: null };
      }
    });
    if (!read.admin) return { ok: false, reason: "forbidden" };
    let revoked = false;
    if (p && read.refreshToken) {
      try {
        await revokeToken(p.config, p.clientSecret, read.refreshToken, {
          fetch: client.fetch,
          timeoutMs: TIMEOUT_MS,
        });
        revoked = true;
      } catch (err) {
        const category = err instanceof MoneyError ? err.category : "unknown";
        log(`qbo: disconnect revoke not confirmed (${category})`);
      }
    }
    const removed = await run(async (q) => {
      const m = await membershipOf(q, sub);
      if (!m || m.role !== "admin") return null;
      return deleteConnection(q);
    });
    if (removed === null) return { ok: false, reason: "forbidden" };
    log(`qbo: disconnected (rows ${removed}, revoked ${revoked})`);
    return { ok: true, revoked };
  }

  return { start, finish, disconnect };
}

