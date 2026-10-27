import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The lint wall around agent code, kept standing: each forbidden import is reported once, each
// way to load a module with no import line for exactly its reasons, and each allowed one not at
// all, at the three places the rule draws a line. The import-boundary test walks the whole graph;
// this one proves the editor and CI stop the line itself.

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
// Each way to load a module with no import line, with the reasons it is refused (each message's
// headline): the import of node:module, a dynamic import, a loader's name, or a loader's name in
// quotes. Names are refused wherever they appear, so an alias, a member and a computed member are
// caught like a direct call.
const IMPORT_LINE = "No createRequire in agent code";
const DYNAMIC = "No dynamic imports in agent code";
const BY_NAME = "No module loader in agent code";
const QUOTED = "No module loader by a quoted name in agent code";
const REASONS = [IMPORT_LINE, DYNAMIC, BY_NAME, QUOTED];
const LOADERS: [code: string, reasons: string[]][] = [
  ['export const m = () => import("../gateway");', [DYNAMIC]],
  ['export const r = () => require("../gateway");', [BY_NAME]],
  ['import { createRequire } from "node:module";', [IMPORT_LINE, BY_NAME]],
  ['import { createRequire as load } from "module";', [IMPORT_LINE, BY_NAME]],
  ['export const q = process.getBuiltinModule("node:module").createRequire(import.meta.url);', [BY_NAME]],
  ['const r = require;\nexport const m = r("../../money/execute");', [BY_NAME]],
  ['export const m = module.require("../../money/execute");', [BY_NAME]],
  ['export const m = process.mainModule.require("../../money/execute");', [BY_NAME]],
  ['export const m = __non_webpack_require__("../../money/execute");', [BY_NAME]],
  ['export const m = __webpack_require__("../../money/execute");', [BY_NAME]],
  [
    'export const m = process.getBuiltinModule("node:module")["createRequire"](import.meta.url);',
    [BY_NAME, QUOTED],
  ],
  ['export const m = module.constructor._load("../../money/execute");', [BY_NAME]],
  ['export const m = module.constructor[`_load`]("../../money/execute");', [QUOTED]],
];
// Names that only look like a loader's.
const PLAIN_NAMES = [
  'export const schema = { required: ["driverId"], requirements: ["a"] };',
  'export const loadItems = () => "required";',
  'import { z } from "zod";\nexport const s = z.object({ a: z.string() }).required();',
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

// Every loader spelling is refused for exactly its expected reasons and no other.
async function expectLoadersRefused(filePath: string) {
  eslint ??= new ESLint({ cwd: process.cwd() });
  await Promise.all(
    LOADERS.map(async ([code, reasons]) => {
      const [res] = await eslint.lintText(`${code}\n`, { filePath });
      const got = res.messages
        .filter((m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax")
        .map((m) => REASONS.find((r) => m.message.includes(`${r}:`)) ?? m.message);
      expect([...new Set(got)].sort(), `${filePath}: ${code}`).toEqual([...reasons].sort());
    }),
  );
}

describe("agent lint wall", () => {
  it("outside the gateway, agent code imports none of the gateway's modules, money or loaders", async () => {
    for (const file of ["src/lib/agent/probe.ts", "src/lib/agent/operator/loop.ts", "src/app/api/agent/turn/route.ts"]) {
      await expectReports([...LEDGER_FORBIDDEN, ...LEDGER_READS, ...GATEWAY_MODULES, ...MODEL_WRAPPER], file, 1);
      await expectLoadersRefused(file);
      await expectReports([...PLAIN, ...PLAIN_NAMES], file, 0);
    }
  }, 60_000);

  it("the gateway imports records, the engine, ledger reads and the model wrapper, never a money write", async () => {
    const file = "src/lib/agent/gateway/probe.ts";
    await expectReports(LEDGER_FORBIDDEN, file, 1);
    await expectLoadersRefused(file);
    await expectReports([...LEDGER_READS, ...GATEWAY_MODULES, ...MODEL_WRAPPER, ...PLAIN, ...PLAIN_NAMES], file, 0);
  }, 60_000);

  it("the operator turn may call the model wrapper and nothing else the gateway owns", async () => {
    const file = "src/lib/agent/operator/turn.ts";
    await expectReports(MODEL_WRAPPER, file, 0);
    await expectReports([...LEDGER_FORBIDDEN, ...LEDGER_READS, ...GATEWAY_MODULES], file, 1);
    await expectLoadersRefused(file);
    await expectReports(PLAIN_NAMES, file, 0);
  }, 60_000);

  it("leaves code outside the agent alone", async () => {
    const loaders = LOADERS.map(([code]) => code);
    await expectReports([LEDGER_FORBIDDEN[0], GATEWAY_MODULES[0], ...loaders], "src/app/approve/route.ts", 0);
  }, 60_000);
});
