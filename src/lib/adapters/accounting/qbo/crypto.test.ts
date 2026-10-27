import { describe, expect, it } from "vitest";
import { openToken, sealToken, tokenKeyFrom } from "./crypto";
import { qboConfig } from "./env";
import { KEY, qboEnv, REALM, REALM_OFF_BY_ONE, TENANT, TOKEN_KEY_TEXT } from "./test-fakes";

const OTHER_TENANT = "9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a6f";

describe("QuickBooks token sealing", () => {
  it("opens what it sealed, and nothing sealed for another tenant, company or column", () => {
    const sealed = sealToken(KEY, "token-value-abc", TENANT, REALM, "refresh");
    expect(openToken(KEY, sealed, TENANT, REALM, "refresh")).toBe("token-value-abc");
    expect(sealed.toString("utf8")).not.toContain("token-value-abc");
    for (const [tenant, realm, kind] of [
      [OTHER_TENANT, REALM, "refresh"],
      [TENANT, REALM_OFF_BY_ONE, "refresh"],
      [TENANT, REALM, "access"],
    ] as const) {
      expect(() => openToken(KEY, sealed, tenant, realm, kind)).toThrow(
        expect.objectContaining({ category: "not_connected" }),
      );
    }
    expect(() => openToken(Buffer.alloc(32, 8), sealed, TENANT, REALM, "refresh")).toThrow(
      expect.objectContaining({ category: "not_connected" }),
    );
    const damaged = Buffer.from(sealed);
    damaged[14] ^= 1;
    expect(() => openToken(KEY, damaged, TENANT, REALM, "refresh")).toThrow(
      expect.objectContaining({ category: "not_connected" }),
    );
  });

  it("uses a fresh nonce each time", () => {
    const a = sealToken(KEY, "same", TENANT, REALM, "access");
    const b = sealToken(KEY, "same", TENANT, REALM, "access");
    expect(a.equals(b)).toBe(false);
  });

  it("takes only a 32-byte base64 key", () => {
    expect(tokenKeyFrom(TOKEN_KEY_TEXT)?.equals(KEY)).toBe(true);
    for (const bad of [undefined, "", "short", Buffer.alloc(16).toString("base64"), `${TOKEN_KEY_TEXT} `]) {
      expect(tokenKeyFrom(bad), String(bad)).toBeNull();
    }
  });
});

describe("QuickBooks settings", () => {
  it("accepts complete sandbox settings, minor version 75 by default", () => {
    expect(qboConfig(qboEnv())).toEqual({
      ok: true,
      config: {
        clientId: expect.any(String),
        redirectUri: "http://localhost:3000/api/qbo/callback",
        allowedRealmId: REALM,
        minorVersion: 75,
      },
    });
    expect(qboConfig(qboEnv({ QBO_MINOR_VERSION: "76" }))).toMatchObject({ config: { minorVersion: 76 } });
  });

  it("names the first bad variable and never its value", () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ QBO_ENVIRONMENT: "production" }, "QBO_ENVIRONMENT"],
      [{ QBO_ENVIRONMENT: "Sandbox" }, "QBO_ENVIRONMENT"],
      [{ QBO_CLIENT_ID: "has space in it" }, "QBO_CLIENT_ID"],
      [{ QBO_REDIRECT_URI: "http://app.example.com/api/qbo/callback" }, "QBO_REDIRECT_URI"],
      [{ QBO_REDIRECT_URI: "https://app.example.com/api/qbo/callback?x=1" }, "QBO_REDIRECT_URI"],
      [{ QBO_REDIRECT_URI: "https://app.example.com/api/qbo/other" }, "QBO_REDIRECT_URI"],
      [{ QBO_ALLOWED_REALM_ID: undefined }, "QBO_ALLOWED_REALM_ID"],
      [{ QBO_ALLOWED_REALM_ID: `${REALM} ` }, "QBO_ALLOWED_REALM_ID"],
      [{ QBO_MINOR_VERSION: "65" }, "QBO_MINOR_VERSION"],
      [{ QBO_MINOR_VERSION: "75.5" }, "QBO_MINOR_VERSION"],
    ];
    for (const [over, variable] of cases) {
      expect(qboConfig(qboEnv(over)), variable).toEqual({ ok: false, variable });
    }
    expect(qboConfig(qboEnv({ QBO_REDIRECT_URI: "https://app.example.com/api/qbo/callback" })).ok).toBe(true);
  });
});
