import { describe, expect, it } from "vitest";
import { qboConfig, type QboConfig } from "./env";
import { authorizeUrl, exchangeCode, refreshTokens, revokeToken } from "./oauth";
import { CLIENT_ID, CLIENT_SECRET, qboEnv, REFRESH, scriptedFetch, tokenReply } from "./test-fakes";

const cfg = (() => {
  const c = qboConfig(qboEnv());
  if (!c.ok) throw new Error("test settings refused");
  return c.config;
})() satisfies QboConfig;

describe("QuickBooks OAuth", () => {
  it("builds the consent link with the accounting scope, the callback and the state", () => {
    const url = new URL(authorizeUrl(cfg, "state-1"));
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      redirect_uri: "http://localhost:3000/api/qbo/callback",
      state: "state-1",
    });
  });

  it("exchanges a code with basic auth and reads the tokens", async () => {
    const { fetch, sent } = scriptedFetch([{ status: 200, body: tokenReply() }]);
    const tokens = await exchangeCode(cfg, CLIENT_SECRET, "code-1", { fetch, timeoutMs: 1_000 });
    expect(tokens).toMatchObject({ accessExpiresIn: 3600, refreshExpiresIn: 8_726_400 });
    expect(sent[0].url.toString()).toBe("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer");
    expect(sent[0].headers.Authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(sent[0].body ?? ""))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:3000/api/qbo/callback",
    });
  });

  it("maps refusals to categories: invalid_grant means connect again", async () => {
    const cases: [{ status: number; body?: unknown } | { throws: string }, string][] = [
      [{ status: 400, body: { error: "invalid_grant" } }, "not_connected"],
      [{ status: 400, body: { error: "invalid_request" } }, "validation"],
      [{ status: 401, body: {} }, "auth"],
      [{ status: 429 }, "rate_limited"],
      [{ status: 502 }, "unavailable"],
      [{ status: 200, body: { access_token: "short" } }, "unknown"],
      [{ throws: "TimeoutError" }, "timeout"],
      [{ throws: "TypeError" }, "network"],
    ];
    for (const [answer, category] of cases) {
      const { fetch } = scriptedFetch([answer]);
      await expect(refreshTokens(cfg, CLIENT_SECRET, REFRESH, { fetch, timeoutMs: 1_000 }), category).rejects.toMatchObject(
        { category },
      );
    }
  });

  it("revokes with a JSON body and throws unless Intuit confirms", async () => {
    const ok = scriptedFetch([{ status: 200 }]);
    await revokeToken(cfg, CLIENT_SECRET, REFRESH, { fetch: ok.fetch, timeoutMs: 1_000 });
    expect(ok.sent[0].url.toString()).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    expect(JSON.parse(ok.sent[0].body ?? "")).toEqual({ token: REFRESH });
    const no = scriptedFetch([{ status: 503 }]);
    await expect(revokeToken(cfg, CLIENT_SECRET, REFRESH, { fetch: no.fetch, timeoutMs: 1_000 })).rejects.toMatchObject({
      category: "unavailable",
    });
  });
});
