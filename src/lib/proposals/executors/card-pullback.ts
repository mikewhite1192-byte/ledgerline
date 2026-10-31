// The card_pullback executor (src/lib/pullbacks/execute.ts), named here beside the other proposal
// executors. It is read through cardPullback.enabled on every approval (EXECUTORS in
// ../execute.ts), with a precheck that refuses a machine login, a role below the line, or a pull
// whose plan no longer holds before anything is approved; the executor asks the whole pull gate
// again itself, and the money executor reserves the ledger row before the one test-mode pull.
export { pullbackExecutor } from "../../pullbacks/execute";
