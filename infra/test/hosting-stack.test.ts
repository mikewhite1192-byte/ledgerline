import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GITHUB_TOKEN_SECRET_NAME, HostingStack, REPOSITORY_URL } from "../lib/hosting-stack";

describe("HostingStack", () => {
  let outdir: string;
  let template: Template;

  // Synthesize into a temp folder this test owns, and remove it afterward.
  beforeAll(() => {
    outdir = mkdtempSync(join(tmpdir(), "hosting-stack-test-"));
    const app = new App({ outdir });
    const stack = new HostingStack(app, "Hosting", { env: { region: "us-east-2" } });
    template = Template.fromStack(stack);
  });

  afterAll(() => {
    if (outdir) rmSync(outdir, { recursive: true, force: true });
  });

  it("hosts the repo on the SSR platform with no inline build spec", () => {
    template.hasResourceProperties("AWS::Amplify::App", {
      Platform: "WEB_COMPUTE",
      Repository: REPOSITORY_URL,
      BuildSpec: Match.absent(),
    });
  });

  it("takes the GitHub token only from a Secrets Manager dynamic reference", () => {
    const apps = Object.values(template.findResources("AWS::Amplify::App"));
    expect(apps).toHaveLength(1);
    expect(apps[0].Properties.AccessToken).toBe(
      `{{resolve:secretsmanager:${GITHUB_TOKEN_SECRET_NAME}:SecretString:::}}`,
    );
    expect(JSON.stringify(template.toJSON())).not.toMatch(/ghp_|gho_|github_pat_/);
  });

  it("builds main as production with auto build and pull request previews", () => {
    template.hasResourceProperties("AWS::Amplify::Branch", {
      BranchName: "main",
      Stage: "PRODUCTION",
      Framework: "Next.js - SSR",
      EnableAutoBuild: true,
      EnablePullRequestPreview: true,
    });
  });
});
