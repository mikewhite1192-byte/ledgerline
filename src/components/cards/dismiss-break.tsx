"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { STAFF_ONLY_NOTE } from "@/components/app/staff-only";
import { postJson } from "@/components/invoices/post-json";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { InlineAlert } from "@/components/ui/inline-alert";
import { controlClass } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { DISMISS_WORDS } from "@/lib/recon/words";

// Dismiss, on a difference's page: a person closes it with a reason. It changes only the
// difference; nothing is paid, posted or sent. The route re-checks the switch itself. The page
// reads itself back after a press.

const REASONS = Object.keys(DISMISS_WORDS);

const NOTICE: Readonly<Record<string, string>> = {
  disabled: "The card check is switched off right now. Nothing changed.",
  unauthenticated: "Your sign-in ended. Sign in again, then dismiss it.",
  forbidden: "You cannot change this carrier's card check.",
  judge: STAFF_ONLY_NOTE,
  not_found: "This difference is already closed.",
  bad_request: "Pick a reason. Nothing changed.",
};
const UNKNOWN = "We could not tell if that went through. Refresh the page to see.";

export function DismissBreak({ breakId }: { breakId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!REASONS.includes(reason)) {
      setError("Pick a reason.");
      return;
    }
    setPending(true);
    setNotice(null);
    const out = await postJson(`/api/cards/breaks/${encodeURIComponent(breakId)}/dismiss`, { category: reason });
    setPending(false);
    if (out.ok) {
      setNotice({ ok: true, text: "Dismissed." });
      setOpen(false);
      router.refresh();
      return;
    }
    setNotice({ ok: false, text: out.error && Object.hasOwn(NOTICE, out.error) ? NOTICE[out.error] : UNKNOWN });
    if (out.error === "unknown") router.refresh();
  }

  return (
    <div className="grid gap-3">
      {open ? (
        <form onSubmit={(e) => void submit(e)} className="grid max-w-sm gap-3">
          <Field id="dismiss-reason" label="Why dismiss it" error={error}>
            {(control) => (
              <select
                {...control}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(undefined);
                }}
                disabled={pending}
                className={cn(controlClass, "h-9")}
              >
                <option value="">Pick a reason</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {DISMISS_WORDS[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" pending={pending} pendingLabel="Dismissing">
              Dismiss it
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Never mind
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Dismiss
          </Button>
        </div>
      )}
      {notice ? <InlineAlert tone={notice.ok ? "success" : "destructive"}>{notice.text}</InlineAlert> : null}
    </div>
  );
}
