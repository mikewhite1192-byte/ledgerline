import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { synthAll } from "./synth";

describe("AuthStack", () => {
  let synth: ReturnType<typeof synthAll>;
  let template: Template;

  // Synthesize into a temp folder this test owns, and remove it afterward.
  beforeAll(() => {
    synth = synthAll();
    template = synth.auth;
  });

  afterAll(() => synth?.cleanup());

  function pool(): Record<string, unknown> {
    const pools = Object.values(template.findResources("AWS::Cognito::UserPool"));
    expect(pools).toHaveLength(1);
    return pools[0].Properties;
  }

  function client(): Record<string, unknown> {
    const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
    expect(clients).toHaveLength(1);
    return clients[0].Properties;
  }

  it("lets only an administrator create users", () => {
    expect(pool().AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: true });
  });

  it("stores the tenant as an immutable custom attribute", () => {
    expect(pool().Schema).toContainEqual(
      expect.objectContaining({ Name: "tenant_id", Mutable: false }),
    );
  });

  it("sends no mail: admin-only recovery, no auto-verified attribute, no MFA", () => {
    const props = pool();
    expect(props.AccountRecoverySetting).toEqual({
      RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }],
    });
    expect(props.AutoVerifiedAttributes ?? []).toEqual([]);
    expect(props.MfaConfiguration).toBe("OFF");
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
  });

  it("allows only password sign-in from a public client with no secret", () => {
    const props = client();
    expect(props.GenerateSecret).toBe(false);
    expect(props.ExplicitAuthFlows).toContain("ALLOW_USER_PASSWORD_AUTH");
    expect(props.ExplicitAuthFlows).not.toContain("ALLOW_ADMIN_USER_PASSWORD_AUTH");
    expect(props.ExplicitAuthFlows).not.toContain("ALLOW_USER_SRP_AUTH");
  });

  it("has no OAuth flow and no redirect URL", () => {
    const props = client();
    expect(props.AllowedOAuthFlowsUserPoolClient).toBe(false);
    expect(props.AllowedOAuthFlows).toBeUndefined();
    expect(props.CallbackURLs).toBeUndefined();
    expect(props.LogoutURLs).toBeUndefined();
  });

  it("puts the tenant on the ID token but never lets the client write it", () => {
    const props = client();
    expect(props.ReadAttributes).toContain("custom:tenant_id");
    expect(props.WriteAttributes).not.toContain("custom:tenant_id");
  });

  it("names no account id and carries the project tag", () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/\b\d{12}\b/);
    expect(synth.stacks.auth.tags.tagValues()).toEqual({ project: "payday-copilot" });
    expect(pool().UserPoolTags).toEqual({ project: "payday-copilot" });
  });
});
