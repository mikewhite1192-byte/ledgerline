import { describe, expect, it } from "vitest";
import { tenantFromClaims } from "./claims";

const TENANT = "3f6c1a52-8e0b-4f4e-9d7a-2b5c8e1f0a93";

describe("tenantFromClaims", () => {
  it("reads the subject, email and tenant from a verified token", () => {
    expect(
      tenantFromClaims({ sub: "user-1", email: "ops@carrier.example", "custom:tenant_id": TENANT }),
    ).toEqual({ sub: "user-1", email: "ops@carrier.example", tenantId: TENANT });
  });

  it("is no session without a tenant, or with a tenant that is not a whole UUID", () => {
    expect(tenantFromClaims({ sub: "user-1" })).toBeNull();
    expect(tenantFromClaims({ sub: "user-1", "custom:tenant_id": "" })).toBeNull();
    expect(tenantFromClaims({ sub: "user-1", "custom:tenant_id": "not-a-uuid" })).toBeNull();
    expect(tenantFromClaims({ sub: "user-1", "custom:tenant_id": `${TENANT}x` })).toBeNull();
    expect(tenantFromClaims({ sub: "user-1", "custom:tenant_id": ` ${TENANT}` })).toBeNull();
    expect(tenantFromClaims({ sub: "user-1", "custom:tenant_id": 42 })).toBeNull();
  });

  it("is no session without a subject", () => {
    expect(tenantFromClaims({ "custom:tenant_id": TENANT })).toBeNull();
    expect(tenantFromClaims({ sub: "", "custom:tenant_id": TENANT })).toBeNull();
    expect(tenantFromClaims({ sub: 7, "custom:tenant_id": TENANT })).toBeNull();
  });

  it("keeps a session whose token has no email", () => {
    expect(tenantFromClaims({ sub: "user-1", "custom:tenant_id": TENANT })?.email).toBe("");
  });
});
