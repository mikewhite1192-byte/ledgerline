import { afterEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../../../config/flags";
import { createQboClient } from "./client";
import type { FetchLike } from "./oauth";
import { ACCESS, type Answer, qboEnv, REALM, REALM_OFF_BY_ONE, scriptedFetch } from "./test-fakes";

// client.direct, the call the connect flow makes with tokens it holds: a GET goes out with the
// switch off, a POST waits for the accounting switch, checked at the write. No request leaves
// this machine.

const saved = { ...flags };
const TARGET = { realmId: REALM, accessToken: ACCESS };
const GET = { method: "GET" as const, path: "query", query: { query: "SELECT * FROM Account WHERE Active = true" } };
const POST = {
  method: "POST" as const,
  path: "account",
  body: { Name: "LedgerLine Test", AccountType: "Expense" },
  requestId: "0".repeat(32),
};

function make(answers: Answer[]) {
  const scripted = scriptedFetch(answers);
  const fetch = vi.fn<FetchLike>(scripted.fetch);
  const client = createQboClient({ env: qboEnv(), fetch, log: () => {} });
  return { client, fetch, sent: scripted.sent };
}

afterEach(() => {
  Object.assign(flags, saved);
});

describe("QuickBooks client: direct calls", () => {
  it("refuses a POST with the accounting switch off and sends nothing", async () => {
    flags.accountingEnabled = false;
    const { client, fetch } = make([]);
    const p = await client.prepare();
    await expect(client.direct(p, TARGET, POST, 1_000)).rejects.toMatchObject({ category: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the switch at the write, not when the call was prepared", async () => {
    flags.accountingEnabled = true;
    const { client, fetch } = make([]);
    const p = await client.prepare();
    flags.accountingEnabled = false;
    await expect(client.direct(p, TARGET, POST, 1_000)).rejects.toMatchObject({ category: "disabled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a GET with the switch off", async () => {
    flags.accountingEnabled = false;
    const { client, fetch, sent } = make([{ status: 200, body: { QueryResponse: {} } }]);
    const p = await client.prepare();
    expect(await client.direct(p, TARGET, GET, 1_000)).toEqual({ kind: "ok", body: { QueryResponse: {} } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent[0].method).toBe("GET");
    expect(sent[0].url.pathname).toBe(`/v3/company/${REALM}/query`);
  });

  it("sends a POST with the switch on, with its requestid", async () => {
    flags.accountingEnabled = true;
    const { client, fetch, sent } = make([{ status: 200, body: { Account: { Id: "301" } } }]);
    const p = await client.prepare();
    expect(await client.direct(p, TARGET, POST, 1_000)).toEqual({ kind: "ok", body: { Account: { Id: "301" } } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent[0].method).toBe("POST");
    expect(sent[0].url.searchParams.get("requestid")).toBe(POST.requestId);
  });

  it("refuses another company with the switch on too, sending nothing", async () => {
    flags.accountingEnabled = true;
    const { client, fetch } = make([]);
    const p = await client.prepare();
    for (const call of [GET, POST]) {
      await expect(client.direct(p, { ...TARGET, realmId: REALM_OFF_BY_ONE }, call, 1_000)).rejects.toMatchObject({
        category: "not_configured",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
