// The escrow_release executor (src/lib/escrow/execute.ts), named here beside the other proposal
// executors. It is read through escrowRelease.enabled on every approval (EXECUTORS in
// ../execute.ts), with a precheck that refuses a release whose facts no longer hold before
// anything is approved; the executor asks the whole release gate again itself, and the money
// executor reserves the ledger row before the one test-mode payout.
export { escrowReleaseExecutor } from "../../escrow/execute";
