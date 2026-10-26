import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The agent proposes; it never moves money. The lint rule in eslint.config.mjs is the wall, and
// this test keeps it standing: each forbidden import is reported, each allowed one is not.
const FORBIDDEN = [
  'import { executeMoneyAction } from "../money/execute";',
  'import { approvalFrom } from "@/lib/money/approval";',
  'import { reserve } from "../money/ledger";',
  'import { reconcileMoneyActions } from "../money/reconcile";',
  'import { paymentAdapter } from "../adapters";',
  'import { paymentAdapter } from "../adapters/index";',
  'import { createMockPaymentAdapter } from "../adapters/payment/mock";',
  'export const m = () => import("../money/execute");',
  'export const r = () => require("../money/ledger");',
];
const ALLOWED = [
  'import { readAction } from "../money/read";',
  'import type { MoneyAction } from "../money/types";',
  'import { dollars } from "../money/format";',
  'import { dbTmsAdapter } from "../adapters/tms/db";',
  'import type { TmsAdapter } from "../adapters/types";',
];

describe("agent import ban", () => {
  it("reports every forbidden import in agent code and none of the allowed ones", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const lint = async (code: string) => {
      const [res] = await eslint.lintText(`${code}\n`, { filePath: "src/lib/agent/probe.ts" });
      return res.messages
        .map((m) => m.ruleId)
        .filter((id) => id === "no-restricted-imports" || id === "no-restricted-syntax");
    };
    for (const code of FORBIDDEN) expect(await lint(code), code).toHaveLength(1);
    for (const code of ALLOWED) expect(await lint(code), code).toHaveLength(0);
    // Outside agent code the same import is fine.
    const [elsewhere] = await eslint.lintText(`${FORBIDDEN[0]}\n`, {
      filePath: "src/app/approve/route.ts",
    });
    expect(elsewhere.messages.filter((m) => m.ruleId === "no-restricted-imports")).toHaveLength(0);
  }, 60_000);
});
