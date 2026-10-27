"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { clearAlertAction, type ClearAlertCategory, type ClearAlertState } from "./clear-alert-action";

// A fixed message per category; nothing else from the server is shown.
const MESSAGES: Record<ClearAlertCategory, string> = {
  invalid: "That alert could not be read. Reload the page and try again.",
  not_found: "That alert is not here. It may have been removed, or it may belong to another carrier.",
  forbidden: "Only an admin of this carrier can clear a stopped job.",
  unreadable: "Could not read the spend records. Nothing was cleared. Try again in a moment.",
};

export function ClearAlertForm({ alertId, job }: { alertId: string; job: string }) {
  const [state, action, pending] = useActionState<ClearAlertState, FormData>(clearAlertAction, null);
  return (
    <form action={action} className="grid justify-items-end gap-2">
      <input type="hidden" name="alertId" value={alertId} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        pending={pending}
        pendingLabel="Clearing"
        aria-label={`Clear the stop on ${job}`}
      >
        Clear
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="max-w-[36ch] text-right text-small text-destructive">
          {MESSAGES[state.category]}
        </p>
      ) : null}
      {state?.ok && state.result === "already_cleared" ? (
        <p role="status" className="text-small text-foreground-2">
          Someone already cleared it.
        </p>
      ) : null}
    </form>
  );
}
