import type { Session } from "../auth/claims";
import { getDb } from "../db";
import { readBySubject } from "../money/read";
import { reconcileMoneyActions, type ReconcileSummary } from "../money/reconcile";
import { assertMembership } from "../tenant/context";
import { nowOf, releaseReconcileHooks, type EscrowDeps } from "./execute";
import { readRelease } from "./read";
import { escrowReleaseOn } from "./switches";

// Check pending for one escrow release: the reconcile pass over this release's own open ledger
// rows, each read back through the payment adapter by its request id. Never sends anything new;
// a payout found paid gets the same finishRelease the approval would have run (once: the release
// row is locked and a released one is left as it is), and one found not paid ends the release
// failed. A person asked, so the read-back runs even past the automatic check limit; it stays
// read-only toward the provider.

// The reconcile pass reads back a row still sent only once it is this old (an unknown row at
// once), so a send still in flight is not read back as if it had been lost.
const CHECK_AFTER_SECONDS = 60;

export type CheckResult =
  | { ok: true; summary: ReconcileSummary; tooNew: number; stillWaiting: number }
  | { ok: false; category: string; retryable: boolean };

const no = (category: string, retryable = false) => ({ ok: false as const, category, retryable });

export async function checkPendingEscrowRelease(
  session: Session,
  releaseId: string,
  deps: EscrowDeps = {},
): Promise<CheckResult> {
  if (!escrowReleaseOn()) return no("escrow_off");
  const db = deps.db ?? getDb();
  const nowIso = nowOf(deps).toISOString();
  const found = await db.withTenant(session.tenantId, async (q) => {
    await assertMembership(q, session);
    return readRelease(q, "id", releaseId);
  });
  if (!found) return no("not_found");
  const summary = await reconcileMoneyActions(
    db,
    session,
    {
      hooks: { escrow_release: releaseReconcileHooks(nowIso) },
      limit: 5,
      olderThanSeconds: CHECK_AFTER_SECONDS,
      subject: { table: "escrow_releases", id: found.id },
      ignoreCheckLimit: true,
    },
    deps.money,
  );
  let tooNew = 0;
  let stillWaiting = 0;
  if (summary.checked === 0) {
    const rows = (await db.withTenant(session.tenantId, (q) => readBySubject(q, "escrow_releases", found.id))).filter(
      (a) => a.kind === "escrow_release",
    );
    for (const r of rows) {
      if (r.state === "sent" && r.sentSecondsAgo !== null && r.sentSecondsAgo <= CHECK_AFTER_SECONDS) tooNew += 1;
      else if (r.state === "sent" || r.state === "unknown") stillWaiting += 1;
    }
  }
  return { ok: true, summary, tooNew, stillWaiting };
}
