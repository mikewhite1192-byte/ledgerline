// The QuickBooks Online sandbox settings, read from the environment and checked whole. Fail
// closed: anything missing or out of shape answers the variable's NAME, never its value, and
// nothing outside is called. Only the sandbox host appears in this code.

export const QBO_API_BASE = "https://sandbox-quickbooks.api.intuit.com";
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_CALLBACK_PATH = "/api/qbo/callback";
// Intuit retired the minor versions below 75.
export const QBO_MIN_MINOR_VERSION = 75;

// The one sandbox company a tenant may connect: 10 to 20 digits, compared as a whole string.
export const REALM_ID = /^[0-9]{10,20}$/;

export type QboConfig = {
  clientId: string;
  redirectUri: string;
  allowedRealmId: string;
  minorVersion: number;
};

export type QboConfigResult = { ok: true; config: QboConfig } | { ok: false; variable: string };

export function qboConfig(env: NodeJS.ProcessEnv = process.env): QboConfigResult {
  if (env.QBO_ENVIRONMENT !== "sandbox") return { ok: false, variable: "QBO_ENVIRONMENT" };
  const clientId = env.QBO_CLIENT_ID ?? "";
  if (!/^[A-Za-z0-9]{10,100}$/.test(clientId)) return { ok: false, variable: "QBO_CLIENT_ID" };
  const redirectUri = env.QBO_REDIRECT_URI ?? "";
  if (!isCallbackUri(redirectUri)) return { ok: false, variable: "QBO_REDIRECT_URI" };
  const allowedRealmId = env.QBO_ALLOWED_REALM_ID ?? "";
  if (!REALM_ID.test(allowedRealmId)) return { ok: false, variable: "QBO_ALLOWED_REALM_ID" };
  const minor = env.QBO_MINOR_VERSION ?? "";
  const minorVersion = minor === "" ? QBO_MIN_MINOR_VERSION : Number(minor);
  if (
    (minor !== "" && !/^[0-9]{2,3}$/.test(minor)) ||
    !Number.isSafeInteger(minorVersion) ||
    minorVersion < QBO_MIN_MINOR_VERSION
  ) {
    return { ok: false, variable: "QBO_MINOR_VERSION" };
  }
  return { ok: true, config: { clientId, redirectUri, allowedRealmId, minorVersion } };
}

// The callback this app serves, as one whole string: https (http only on this machine), no
// credentials, query or fragment, and exactly the callback path. Intuit then checks it against
// the URIs registered for the app.
function isCallbackUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return (
    url.toString() === value &&
    (url.protocol === "https:" || (url.protocol === "http:" && local)) &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === QBO_CALLBACK_PATH
  );
}
