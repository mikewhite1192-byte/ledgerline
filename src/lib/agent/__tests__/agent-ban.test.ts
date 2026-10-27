import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The lint wall around agent code, kept standing: each forbidden import is reported once and each
// allowed one not at all, at the three places the rule draws a line. The import-boundary test
// walks the whole graph; this one proves the editor and CI stop the line itself.

const LEDGER_FORBIDDEN = [
  'import { executeMoneyAction } from "../money/execute";',
  'import { approvalFrom } from "@/lib/money/approval";',
  'import { reserve } from "../money/ledger";',
  'import { reconcileMoneyActions } from "../money/reconcile";',
  'import { paymentAdapter } from "../adapters";',
  'import { paymentAdapter } from "../adapters/index";',
  'import { createMockPaymentAdapter } from "../adapters/payment/mock";',
  'import { executeMoneyAction } from "../money/./execute";',
  'import { executeMoneyAction } from "../money//execute";',
  'import { executeMoneyAction } from "../Money/Execute";',
  'import { reserve } from "../money/read/../ledger";',
  'export { executeMoneyAction } from "../money/./execute";',
  'import { executeMoneyAction } from "../money";',
  'import { createMockPaymentAdapter } from "../adapters/tms/../payment/mock";',
];
const LEDGER_READS = [
  'import { readAction } from "../money/read";',
  'import type { MoneyAction } from "../money/types";',
  'import { dollars } from "../money/format";',
  'import { idempotencyKey } from "@/lib/money/keys";',
  'import { dbTmsAdapter } from "../adapters/tms/db";',
  'import type { TmsAdapter } from "../adapters/types";',
];
const GATEWAY_MODULES = [
  'import { createPgDb } from "../../db";',
  'import type { Queryable } from "@/lib/db";',
  'import { readRows } from "../../data/read";',
  'import { advanceEligibility } from "@/lib/rules-engine";',
  'import { advanceEligibility as a } from "../../rules-engine/advances";',
];
const MODEL_WRAPPER = ['import { complete } from "../../ai";', 'import type { AiTool } from "@/lib/ai/types";'];
const LOADERS = [
  'export const m = () => import("../gateway");',
  'export const r = () => require("../gateway");',
  'import { createRequire } from "node:module";',
  'import { createRequire as load } from "module";',
  'export const q = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
];
const PLAIN = [
  'import { callTool, toolsFor } from "../gateway";',
  'import { addDays } from "@/lib/time/local-date";',
  'import { z } from "zod";',
];

let eslint: ESLint;
async function lint(code: string, filePath: string): Promise<string[]> {
  eslint ??= new ESLint({ cwd: process.cwd() });
  const [res] = await eslint.lintText(`${code}\n`, { filePath });
  return res.messages
    .map((m) => m.ruleId ?? "")
    .filter((id) => id === "no-restricted-imports" || id === "no-restricted-syntax");
}

function expectReports(cases: string[], filePath: string, count: number) {
  return Promise.all(
    cases.map(async (code) => expect(await lint(code, filePath), `${filePath}: ${code}`).toHaveLength(count)),
  );
}

describe("agent lint wall", () => {
  it("outside the gateway, agent code imports none of the gateway's modules, money or loaders", async () => {
    for (const file of ["src/lib/agent/probe.ts", "src/lib/agent/operator/loop.ts", "src/app/api/agent/turn/route.ts"]) {
      await expectReports([...LEDGER_FORBIDDEN, ...LEDGER_READS, ...GATEWAY_MODULES, ...MODEL_WRAPPER], file, 1);
      await expectReports(LOADERS, file, 1);
      await expectReports(PLAIN, file, 0);
    }
  }, 60_000);

  it("the gateway imports records, the engine, ledger reads and the model wrapper, never a money write", async () => {
    const file = "src/lib/agent/gateway/probe.ts";
    await expectReports(LEDGER_FORBIDDEN, file, 1);
    await expectReports(LOADERS, file, 1);
    await expectReports([...LEDGER_READS, ...GATEWAY_MODULES, ...MODEL_WRAPPER, ...PLAIN], file, 0);
  }, 60_000);

  it("the operator turn may call the model wrapper and nothing else the gateway owns", async () => {
    const file = "src/lib/agent/operator/turn.ts";
    await expectReports(MODEL_WRAPPER, file, 0);
    await expectReports([...LEDGER_FORBIDDEN, ...LEDGER_READS, ...GATEWAY_MODULES], file, 1);
    await expectReports(LOADERS, file, 1);
  }, 60_000);

  it("leaves code outside the agent alone", async () => {
    await expectReports([LEDGER_FORBIDDEN[0], GATEWAY_MODULES[0], LOADERS[0]], "src/app/approve/route.ts", 0);
  }, 60_000);
});
