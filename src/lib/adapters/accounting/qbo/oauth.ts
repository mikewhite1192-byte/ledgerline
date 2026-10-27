import { MoneyError, type MoneyFailure } from "../../../money/types";
import {
  QBO_AUTHORIZE_URL,
  QBO_REVOKE_URL,
  QBO_SCOPE,
  QBO_TOKEN_URL,
  type QboConfig,
} from "./env";

// Intuit's OAuth 2.0 calls: the consent link, the code exchange, the refresh and the revoke, from
// Intuit's public OAuth documentation. Plain fetch; nothing here reads the database. Failures are
// MoneyErrors with a category; Intuit's own error text is never kept or shown (its `error` code
// only decides the category).

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type OAuthDeps = { fetch: FetchLike; timeoutMs: number };

export type Tokens = {
  accessToken: string;
  refreshToken: string;
  // Seconds from now, as Intuit gave them; the database clock turns them into instants.
  accessExpiresIn: number;
  refreshExpiresIn: number;
};

export function authorizeUrl(config: QboConfig, state: string): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: config.redirectUri,
    state,
  });
  return `${QBO_AUTHORIZE_URL}?${query.toString()}`;
}

function basic(config: QboConfig, clientSecret: string): string {
  return `Basic ${Buffer.from(`${config.clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

// The category for a refused OAuth call. invalid_grant means the code or refresh token is no
// longer good: the tenant must connect again.
function oauthFailure(status: number, error: unknown): MoneyFailure {
  if (status === 400 && error === "invalid_grant") return "not_connected";
  if (status === 400) return "validation";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "unknown";
}

async function post(
  deps: OAuthDeps,
  url: string,
  init: { headers: Record<string, string>; body: string },
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new MoneyError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
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

const TOKEN = /^[\x21-\x7e]{20,8192}$/;

function tokensFrom(body: unknown): Tokens {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const accessExpiresIn = b.expires_in;
  const refreshExpiresIn = b.x_refresh_token_expires_in;
  const seconds = (v: unknown, max: number): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 60 && v <= max;
  if (
    typeof b.access_token !== "string" ||
    !TOKEN.test(b.access_token) ||
    typeof b.refresh_token !== "string" ||
    !TOKEN.test(b.refresh_token) ||
    !seconds(accessExpiresIn, 86_400) ||
    !seconds(refreshExpiresIn, 400 * 86_400)
  ) {
    // A 200 without usable tokens: nothing to store, and nothing to trust.
    throw new MoneyError("unknown");
  }
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    accessExpiresIn,
    refreshExpiresIn,
  };
}

async function tokenCall(
  config: QboConfig,
  clientSecret: string,
  form: Record<string, string>,
  deps: OAuthDeps,
): Promise<Tokens> {
  const { status, body } = await post(deps, QBO_TOKEN_URL, {
    headers: {
      Authorization: basic(config, clientSecret),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (status !== 200) {
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
    throw new MoneyError(oauthFailure(status, error), status);
  }
  return tokensFrom(body);
}

export function exchangeCode(
  config: QboConfig,
  clientSecret: string,
  code: string,
  deps: OAuthDeps,
): Promise<Tokens> {
  return tokenCall(
    config,
    clientSecret,
    { grant_type: "authorization_code", code, redirect_uri: config.redirectUri },
    deps,
  );
}

// Intuit may answer with a new refresh token; the caller stores whichever comes back.
export function refreshTokens(
  config: QboConfig,
  clientSecret: string,
  refreshToken: string,
  deps: OAuthDeps,
): Promise<Tokens> {
  return tokenCall(
    config,
    clientSecret,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    deps,
  );
}

// Revokes the grant (either token revokes it). Throws a MoneyError when Intuit did not confirm.
export async function revokeToken(
  config: QboConfig,
  clientSecret: string,
  token: string,
  deps: OAuthDeps,
): Promise<void> {
  const { status } = await post(deps, QBO_REVOKE_URL, {
    headers: {
      Authorization: basic(config, clientSecret),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });
  if (status !== 200) throw new MoneyError(oauthFailure(status, null), status);
}
