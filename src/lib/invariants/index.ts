import type { Db } from "../db/types";
import { checkApprovals } from "./approvals";
import { checkKeys } from "./keys";
import { checkLedger } from "./ledger";
import { checkModelCalls } from "./model-calls";
import { checkRls } from "./rls";
import type { InvariantResult } from "./types";

export { exitCodeOf, formatLine, type InvariantResult } from "./types";

// admin: a login that reads every tenant (the local superuser, or the cluster's master user on
// Aurora, both of which bypass row security). app: the app role, which row security holds.
// Each check runs on its own, so one unreadable check never hides another's result.
export async function runInvariants(dbs: { admin: Db; app: Db }): Promise<InvariantResult[]> {
  return [
    await checkLedger(dbs.admin),
    await checkKeys(dbs.admin),
    await checkApprovals(dbs.admin),
    await checkModelCalls(dbs.admin),
    await checkRls(dbs.admin, dbs.app),
  ];
}
