import { flags } from "../../config/flags";
import { FALLBACKS } from "./targets";
import type { AiProvider, AiTarget, CallOutcome } from "./types";

// The first attempt of a call that has a standby host, as the wrapper saw it: never sent (the
// primary host's key or model id is missing), or what the one HTTP call produced.
export type FirstAttempt = { kind: "not_sent" } | CallOutcome<unknown>;

// Whether a failed first attempt may be tried once more on the standby host. Only failures that
// are the primary host's own fall back: nothing was sent; a definite refusal for the host's
// limits, key or billing (429, 401, 402); a 403; a connection that failed before any answer;
// or a 5xx other than 504. Never an answer (a second call would charge twice for one question),
// a timeout or 504 (the model may still be running, and the time is spent), an unreadable 200
// (it billed, and the same parser would read the same shape on the other host), or a 400, 404,
// 413 or any other status (the same body fails the same way; a 404 is a wrong model id to fix).
// The wrapper's own refusals (switch, cap, cost, validation, membership) and a failed settle
// never reach this question: they throw first.
export function shouldFallBack(first: FirstAttempt): boolean {
  switch (first.kind) {
    case "not_sent":
      return true;
    case "answered":
      return false;
    case "refused":
      return (
        first.category === "rate_limited" || first.category === "auth" || first.category === "billing"
      );
    case "unknown":
      return (
        first.category === "network" || first.category === "unavailable" || first.category === "auth"
      );
  }
}

// The standby host the switch allows for a target right now, or null. flags.sparkOpenFallback is
// read here, at the moment of each decision, never by callers.
export function standbyFor(target: AiTarget): AiProvider | null {
  const standby = FALLBACKS[target];
  if (!standby) return null;
  return flags.sparkOpenFallback === standby.provider ? standby.provider : null;
}
