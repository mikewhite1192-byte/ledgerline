"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { formatCents } from "@/lib/format/money";
import { resetDemoAction, type ResetCategory, type ResetState } from "./reset-action";

// A fixed message per category; nothing from the database is shown.
export const RESET_MESSAGES: Record<ResetCategory, string> = {
  disabled: "The demo reset is switched off. Nothing was changed.",
  unconfirmed: "Tick the box to confirm the reset. Nothing was changed.",
  forbidden: "Only an admin of this carrier can reset the demo. Nothing was changed.",
  not_demo: "This carrier is not a demo carrier, so it cannot be reset. Nothing was changed.",
  refused: "The reset was refused. Nothing was changed.",
  failed: "The reset failed a check and was undone. Nothing was changed. Try again in a moment.",
  unknown:
    "The reset's outcome is unknown: the database did not confirm it. Reload this page to see the counts before trying again.",
  unreadable: "Could not reach the database. Nothing was changed. Try again in a moment.",
};

export function DemoResetForm() {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetDemoAction, null);
  return (
    <form action={action} className="grid justify-items-start gap-3">
      <label className="flex items-start gap-2 text-body text-foreground">
        <input type="checkbox" name="confirm" value="reset" required className="mt-1 size-4 shrink-0" />
        <span>I understand this deletes the demo&apos;s agent records and rewrites its data.</span>
      </label>
      <Button type="submit" variant="destructive" pending={pending} pendingLabel="Resetting the demo">
        Reset the demo
      </Button>
      {state?.ok ? (
        <InlineAlert tone="success" title="The demo is back to its seeded week" className="w-full">
          {`${state.rewritten} records rewritten, ${state.cleared} cleared.`}
          {state.heroNetCents !== null ? ` The hero driver's open week nets ${formatCents(state.heroNetCents)}.` : null}
        </InlineAlert>
      ) : state ? (
        <InlineAlert tone="destructive" className="w-full">
          {RESET_MESSAGES[state.category]}
          {state.reasons?.length ? (
            <ul className="mt-1 list-disc pl-5">
              {state.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </InlineAlert>
      ) : null}
    </form>
  );
}
