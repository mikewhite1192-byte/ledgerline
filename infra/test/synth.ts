import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { MoneySettings } from "../lib/hosting-stack";
import { addStacks } from "../lib/stacks";

// Synthesizes the real app (the same addStacks and cdk.json feature flags the deploy uses) into
// a temp folder the caller owns. No account by default: the templates must not depend on one.
// No money settings by default, as on a deploy from a shell that does not export them.
export function synthAll(account?: string, money?: MoneySettings) {
  const outdir = mkdtempSync(join(tmpdir(), "payday-stacks-test-"));
  const { context } = JSON.parse(readFileSync(fileURLToPath(new URL("../cdk.json", import.meta.url)), "utf8"));
  const app = new App({ outdir, context });
  const stacks = addStacks(app, { account, region: "us-east-2" }, money);
  return {
    app,
    stacks,
    data: Template.fromStack(stacks.data),
    auth: Template.fromStack(stacks.auth),
    hosting: Template.fromStack(stacks.hosting),
    cleanup: () => rmSync(outdir, { recursive: true, force: true }),
  };
}

type Json = unknown;

// Every IAM policy statement in a template: inline role policies and standalone policies.
export function policyStatements(template: Template): Record<string, Json>[] {
  const out: Record<string, Json>[] = [];
  for (const res of Object.values(template.toJSON().Resources as Record<string, Json>)) {
    const { Type, Properties } = res as { Type: string; Properties?: Record<string, Json> };
    const docs: Json[] = [];
    if (Type === "AWS::IAM::Role") {
      for (const p of (Properties?.Policies as { PolicyDocument: Json }[] | undefined) ?? []) {
        docs.push(p.PolicyDocument);
      }
    }
    if (Type === "AWS::IAM::Policy" || Type === "AWS::IAM::ManagedPolicy") {
      docs.push(Properties?.PolicyDocument);
    }
    for (const doc of docs) out.push(...(doc as { Statement: Record<string, Json>[] }).Statement);
  }
  return out;
}

// Renders an Fn::Join of literals and pseudo-parameter refs as a readable string, so a test
// can compare an ARN pattern whole: {"Ref": "AWS::AccountId"} becomes "${AWS::AccountId}".
export function joined(value: Json): string {
  if (typeof value === "string") return value;
  const v = value as { "Fn::Join"?: [string, Json[]]; Ref?: string };
  if (v.Ref) return `\${${v.Ref}}`;
  if (v["Fn::Join"]) return v["Fn::Join"][1].map(joined).join(v["Fn::Join"][0]);
  throw new Error(`cannot render ${JSON.stringify(value)}`);
}

export function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}
