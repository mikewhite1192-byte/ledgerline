import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The agent proposes; it never moves money. The lint rule in eslint.config.mjs is the wall, and
// this test keeps it standing: each forbidden import is reported, each allowed one is not. The
// ledger's allowlist (money/read, types, keys and format; adapters/types and adapters/tms) is the
// gateway's rule, so the probe sits in src/lib/agent/gateway. Agent code outside the gateway may
// import none of money/ or adapters/ (src/lib/agent/__tests__/agent-ban.test.ts proves that); here
// it only has to refuse every forbidden case too.
const GATEWAY_PROBE = "src/lib/agent/gateway/probe.ts";
const AGENT_PROBE = "src/lib/agent/probe.ts";
// Each forbidden case with the rule that must report it. The module loader bans refuse by name,
// so a case naming more than one loader (createRequire and getBuiltinModule) is reported more than
// once; each case needs at least its own rule among the reports.
const IMPORTS = "no-restricted-imports";
const SYNTAX = "no-restricted-syntax";
const FORBIDDEN_IMPORTS = [
  'import { executeMoneyAction } from "../money/execute";',
  'import { approvalFrom } from "@/lib/money/approval";',
  'import { reserve } from "../money/ledger";',
  'import { reconcileMoneyActions } from "../money/reconcile";',
  'import { paymentAdapter } from "../adapters";',
  'import { paymentAdapter } from "../adapters/index";',
  'import { createMockPaymentAdapter } from "../adapters/payment/mock";',
  // The QuickBooks and Stripe test adapters, their secrets, connect flow and start-up guard.
  'import { createQboAdapter } from "../adapters/accounting/qbo/adapter";',
  'import { createQboConnect } from "@/lib/adapters/accounting/qbo/connect";',
  'import { loadConnection } from "../adapters/accounting/qbo/store";',
  'import { createStripeTestAdapter } from "../adapters/payment/stripe-test";',
  'import { moneySecret } from "../adapters/secrets";',
  'import { assertMoneyEnvSafe } from "../money/guard";',
  // Odd spellings of the same paths, and any other module under money/ or adapters/.
  'import { executeMoneyAction } from "../money/./execute";',
  'import { executeMoneyAction } from "../money//execute";',
  'import { executeMoneyAction } from "../Money/Execute";',
  'import { reserve } from "../money/read/../ledger";',
  'import { reserve } from "@/lib/money/../money/ledger";',
  'export { executeMoneyAction } from "../money/./execute";',
  'import { executeMoneyAction } from "../money/";',
  'import { executeMoneyAction } from "../money/index";',
  'import { FakeLedger } from "../money/test-fakes";',
  'import { executeMoneyAction } from "../money";',
  'import { createMockPaymentAdapter } from "../adapters/./payment/mock";',
  'import { createMockPaymentAdapter } from "../adapters//payment/mock";',
  'import { createMockPaymentAdapter } from "../adapters/tms/../payment/mock";',
  // The factoring executor, its switches and the simulated partner.
  'import { factoringRequestExecutor } from "../factoring/execute";',
  'import { checkPendingFactoring } from "@/lib/factoring/execute";',
  'import { submitGate } from "../factoring/switches";',
  'import { createFactoringSim } from "../adapters/factoring/sim";',
  'import { readRequest } from "../factoring/read/../execute";',
  'import { factoringRequestExecutor } from "../factoring";',
  // createRequire, imported.
  'import { createRequire } from "node:module";',
  'import { createRequire as load } from "module";',
];
const FORBIDDEN_SYNTAX = [
  'export const m = () => import("../money/execute");',
  'export const r = () => require("../money/ledger");',
  // createRequire reached without an import.
  'export const q = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
  // The same way in, destructured, computed or aliased, and require through an alias.
  'export const { createRequire: cr } = process.getBuiltinModule("node:module");',
  'export const cr = process.getBuiltinModule("node:module")["createRequire"];',
  'export const g = process["getBuiltinModule"];',
  "export const g = process.getBuiltinModule;",
  "export const { getBuiltinModule: g } = process;",
  'const r = require;\nexport const m = r("../money/ledger");',
];
const ALLOWED = [
  'import { readAction } from "../money/read";',
  'import type { MoneyAction } from "../money/types";',
  'import { dollars } from "../money/format";',
  'import { idempotencyKey } from "@/lib/money/keys";',
  'import { dbTmsAdapter } from "../adapters/tms/db";',
  'import type { TmsAdapter } from "../adapters/types";',
  'import { readRequest } from "../factoring/read";',
  'import { packetsOf } from "@/lib/factoring/packet";',
  'import { packetLine } from "../factoring/words";',
  'import { factoringProposalOf } from "../factoring/propose";',
  'import { factoringFor } from "../rules-engine/factoring";',
  // Names that only start like a banned one.
  'export const schema = { required: ["driverId"] };',
];

describe("agent import ban", () => {
  it("reports every forbidden import in agent code and none of the allowed ones", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const lint = async (code: string, filePath: string) => {
      const [res] = await eslint.lintText(`${code}\n`, { filePath });
      return res.messages
        .map((m) => m.ruleId)
        .filter((id) => id === IMPORTS || id === SYNTAX);
    };
    const cases: [code: string, rule: string][] = [
      ...FORBIDDEN_IMPORTS.map((code): [string, string] => [code, IMPORTS]),
      ...FORBIDDEN_SYNTAX.map((code): [string, string] => [code, SYNTAX]),
    ];
    for (const filePath of [GATEWAY_PROBE, AGENT_PROBE]) {
      for (const [code, rule] of cases) {
        const ids = await lint(code, filePath);
        expect(ids.length, `${filePath}: ${code}`).toBeGreaterThanOrEqual(1);
        expect(ids, `${filePath}: ${code}`).toContain(rule);
      }
    }
    for (const code of ALLOWED) expect(await lint(code, GATEWAY_PROBE), code).toHaveLength(0);
    // Outside agent code the same import is fine.
    const [elsewhere] = await eslint.lintText(`${FORBIDDEN_IMPORTS[0]}\n`, {
      filePath: "src/app/approve/route.ts",
    });
    expect(elsewhere.messages.filter((m) => m.ruleId === "no-restricted-imports")).toHaveLength(0);
  }, 60_000);
});
