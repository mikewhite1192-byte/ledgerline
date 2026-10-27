"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import type { RecordActions } from "@/lib/advances/read";
import { outcomeSentence } from "@/lib/advances/reasons";

type Action = "retry" | "check" | "post";

const ROUTES: Readonly<Record<Action, string>> = {
  retry: "retry-payout",
  check: "reconcile",
  post: "post-expense",
};

type Summary = { checked: number; confirmed: number; failed: number; stillUnknown: number };
type Body = { error?: unknown; status?: unknown; summary?: Summary; tooNew?: unknown };

function done(action: Action, body: Body): string {
  if (action === "check") {
    const s = body.summary;
    if (!s || s.checked === 0) {
      // A send still in flight is read back only after a minute; it is waiting, not nothing.
      if (typeof body.tooNew === "number" && body.tooNew > 0) {
        return "The payout or post was sent less than a minute ago, too soon to check. Check again in a minute.";
      }
      return "Nothing was waiting to be checked.";
    }
    return `Checked ${s.checked}: ${s.confirmed} confirmed, ${s.failed} failed, ${s.stillUnknown} still not known.`;
  }
  if (body.status === "paid") return "Paid.";
  if (body.status === "posted") return "Posted to QuickBooks.";
  return "Sent. The outcome is not known yet; use Check pending in a minute.";
}

// The buttons on an advance's page. Each one asks its route, which re-checks every switch and the
// advance's state itself; the page then reads the advance again.
export function RecordActionButtons({ advanceId, actions }: { advanceId: string; actions: RecordActions }) {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(action: Action) {
    if (pending) return;
    setPending(action);
    setNotice(null);
    try {
      const res = await fetch(`/api/advances/${encodeURIComponent(advanceId)}/${ROUTES[action]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      let body: Body = {};
      try {
        body = (await res.json()) as Body;
      } catch {
        body = {};
      }
      setNotice(
        res.ok
          ? { ok: true, text: done(action, body) }
          : { ok: false, text: outcomeSentence(typeof body.error === "string" ? body.error : "unavailable") },
      );
    } catch {
      setNotice({ ok: false, text: outcomeSentence("unavailable") });
    } finally {
      setPending(null);
      router.refresh();
    }
  }

  const anyAction = actions.retry || actions.check || actions.post;
  // The page reads the advance again after each press; an outcome can leave no button (a last
  // allowed attempt that failed, or paid with posting off), and its notice still shows.
  if (!anyAction && !notice) return null;
  return (
    <div className="grid gap-3">
      {anyAction ? (
        <div className="flex flex-wrap gap-2">
          {actions.retry ? (
            <Button variant="primary" pending={pending === "retry"} pendingLabel="Retrying" disabled={pending !== null} onClick={() => run("retry")}>
              Retry payout
            </Button>
          ) : null}
          {actions.check ? (
            <Button variant="outline" pending={pending === "check"} pendingLabel="Checking" disabled={pending !== null} onClick={() => run("check")}>
              Check pending
            </Button>
          ) : null}
          {actions.post ? (
            <Button variant="outline" pending={pending === "post"} pendingLabel="Posting" disabled={pending !== null} onClick={() => run("post")}>
              Post to QuickBooks
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice ? <InlineAlert tone={notice.ok ? "success" : "destructive"}>{notice.text}</InlineAlert> : null}
    </div>
  );
}
