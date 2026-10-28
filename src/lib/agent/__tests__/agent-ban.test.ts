import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The lint wall around agent code, kept standing: each forbidden import is reported once, each
// way to load a module with no import line for exactly its reasons, and each allowed one not at
// all, at the three places the rule draws a line. Code from a string, the vm module and a network
// call of its own are refused in all three. The import-boundary test walks the whole graph; this
// one proves the editor and CI stop the line itself.

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
  // The factoring executor, its switches and the simulated partner.
  'import { factoringRequestExecutor } from "../factoring/execute";',
  'import { checkPendingFactoring } from "@/lib/factoring/execute";',
  'import { submitGate } from "../factoring/switches";',
  'import { createFactoringSim } from "../adapters/factoring/sim";',
  'import { readRequest } from "../factoring/read/../execute";',
  'import { factoringRequestExecutor } from "../factoring";',
];
const LEDGER_READS = [
  'import { readAction } from "../money/read";',
  'import type { MoneyAction } from "../money/types";',
  'import { dollars } from "../money/format";',
  'import { idempotencyKey } from "@/lib/money/keys";',
  'import { dbTmsAdapter } from "../adapters/tms/db";',
  'import type { TmsAdapter } from "../adapters/types";',
  // The factoring reads the gateway may use: requests, papers, words and the card's sizing.
  'import { readRequest } from "../factoring/read";',
  'import { packetsOf } from "@/lib/factoring/packet";',
  'import { packetLine } from "../factoring/words";',
  'import { factoringProposalOf } from "../../factoring/propose";',
];
const GATEWAY_MODULES = [
  'import { createPgDb } from "../../db";',
  'import type { Queryable } from "@/lib/db";',
  'import { readRows } from "../../data/read";',
  'import { advanceEligibility } from "@/lib/rules-engine";',
  'import { advanceEligibility as a } from "../../rules-engine/advances";',
  // The engine's cents math, not the ledger's money/.
  'import { cents } from "../../rules-engine/money";',
  'import { cents } from "@/lib/rules-engine/money";',
  // The engine's factoring math, not the factoring executor.
  'import { factoringFor } from "../../rules-engine/factoring";',
];
// A connection of its own: a database driver, the AWS SDK, a process, a socket or a file. Agent
// code outside the gateway may open none; the gateway holds the database and may.
const DIRECT_IO = [
  'import { Pool } from "pg";',
  'import Pool from "pg-pool";',
  'import { RDSDataClient } from "@aws-sdk/client-rds-data";',
  'import { exec } from "child_process";',
  'import { spawn } from "node:child_process";',
  'import { Worker } from "worker_threads";',
  'import { request } from "http";',
  'import { request } from "node:https";',
  'import { connect } from "http2";',
  'import { Socket } from "net";',
  'import { connect } from "node:tls";',
  'import { createSocket } from "dgram";',
  'import { lookup } from "dns";',
  'import { lookup } from "dns/promises";',
  'import { readFileSync } from "fs";',
  'import { writeFileSync } from "node:fs";',
  'import { readFile } from "fs/promises";',
  'import { readFile } from "node:fs/promises";',
];
// The vm module runs a string as code: refused in every agent block, the gateway included.
const VM = ['import { runInNewContext } from "vm";', 'import vm from "node:vm";'];
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
// Code from a string, with the rule that refuses it.
const STRING_CODE: [code: string, rule: string][] = [
  ['export const v = eval("1 + 1");', "no-eval"],
  ['export const f = new Function("return 1");', "no-new-func"],
  ['setTimeout("tick()", 10);', "no-implied-eval"],
];
// A network call of its own, with the rule that refuses it: the name bare, or reached through the
// global object by a member, a quoted member or a destructured key.
const NETWORK: [code: string, rule: string][] = [
  ['export const r = fetch("/x");', "no-restricted-globals"],
  ["export const x = new XMLHttpRequest();", "no-restricted-globals"],
  ['export const s = new WebSocket("/x");', "no-restricted-globals"],
  ['export const e = new EventSource("/x");', "no-restricted-globals"],
  ['export const r = globalThis.fetch("/x");', "no-restricted-properties"],
  ['export const r = globalThis["fetch"]("/x");', "no-restricted-properties"],
  ['export const s = new window.WebSocket("/x");', "no-restricted-properties"],
  ["export const x = new self.XMLHttpRequest();", "no-restricted-properties"],
  ['export const e = new global.EventSource("/x");', "no-restricted-properties"],
  ['const { fetch: f } = globalThis;\nexport const r = f("/x");', "no-restricted-properties"],
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
async function ruleIds(code: string, filePath: string): Promise<string[]> {
  eslint ??= new ESLint({ cwd: process.cwd() });
  const [res] = await eslint.lintText(`${code}\n`, { filePath });
  return res.messages.map((m) => m.ruleId ?? "");
}
async function lint(code: string, filePath: string): Promise<string[]> {
  return (await ruleIds(code, filePath)).filter(
    (id) => id === "no-restricted-imports" || id === "no-restricted-syntax",
  );
}

// Each case is refused by its own rule, in or out of the gateway.
async function expectRefusedBy(cases: [code: string, rule: string][], filePath: string) {
  await Promise.all(
    cases.map(async ([code, rule]) =>
      expect(await ruleIds(code, filePath), `${filePath}: ${code}`).toContain(rule),
    ),
  );
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
  it("outside the gateway, agent code imports none of the gateway's modules, money, I/O or loaders", async () => {
    for (const file of ["src/lib/agent/probe.ts", "src/lib/agent/operator/loop.ts", "src/app/api/agent/turn/route.ts"]) {
      await expectReports(
        [...LEDGER_FORBIDDEN, ...LEDGER_READS, ...GATEWAY_MODULES, ...MODEL_WRAPPER, ...DIRECT_IO, ...VM],
        file,
        1,
      );
      await expectLoadersRefused(file);
      await expectRefusedBy(STRING_CODE, file);
      await expectRefusedBy(NETWORK, file);
      await expectReports([...PLAIN, ...PLAIN_NAMES], file, 0);
    }
  }, 60_000);

  it("the gateway imports records, the engine, ledger reads and the model wrapper, never a money write", async () => {
    const file = "src/lib/agent/gateway/probe.ts";
    await expectReports([...LEDGER_FORBIDDEN, ...VM], file, 1);
    await expectLoadersRefused(file);
    await expectRefusedBy(STRING_CODE, file);
    await expectRefusedBy(NETWORK, file);
    await expectReports(
      [...LEDGER_READS, ...GATEWAY_MODULES, ...MODEL_WRAPPER, ...DIRECT_IO, ...PLAIN, ...PLAIN_NAMES],
      file,
      0,
    );
  }, 60_000);

  it("the operator turn may call the model wrapper and nothing else the gateway owns", async () => {
    const file = "src/lib/agent/operator/turn.ts";
    await expectReports(MODEL_WRAPPER, file, 0);
    await expectReports([...LEDGER_FORBIDDEN, ...LEDGER_READS, ...GATEWAY_MODULES, ...DIRECT_IO, ...VM], file, 1);
    await expectLoadersRefused(file);
    await expectRefusedBy(STRING_CODE, file);
    await expectRefusedBy(NETWORK, file);
    await expectReports(PLAIN_NAMES, file, 0);
  }, 60_000);

  it("leaves code outside the agent alone, the model wrapper included", async () => {
    const loaders = LOADERS.map(([code]) => code);
    for (const file of ["src/app/approve/route.ts", "src/lib/ai/probe.ts"]) {
      await expectReports([LEDGER_FORBIDDEN[0], GATEWAY_MODULES[0], DIRECT_IO[0], ...VM, ...loaders], file, 0);
      for (const [code, rule] of [...STRING_CODE, ...NETWORK]) {
        expect(await ruleIds(code, file), `${file}: ${code}`).not.toContain(rule);
      }
    }
  }, 60_000);
});
