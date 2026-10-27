"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { proofCallAction, type ProofCategory, type ProofState } from "./ai-proof-action";

// A fixed message per category; nothing from the provider is shown but the reply itself.
const MESSAGES: Record<ProofCategory, string> = {
  disabled: "Model calls are switched off.",
  not_configured: "The model connection is not configured.",
  cap: "The spend cap is reached. No call was made.",
  job_cap: "This job used more than its hourly budget and is paused until an admin resumes it under Settings, Models and spend. No call was made.",
  too_expensive: "That call could cost more than its limit. No call was made.",
  rate_limited: "The model is busy. Try again in a minute.",
  unavailable: "The model service is unavailable. Try again later.",
  timeout: "The model took too long to answer. Its cost is held against the cap.",
  bad_request: "The model refused the request.",
  auth: "The model key was refused.",
  billing: "The model credit is used up.",
  too_long: "The request was too long for the model.",
  network: "Could not reach the model service. Its cost is held against the cap.",
  unknown: "The call's outcome is unknown. Its cost is held against the cap.",
  incomplete: "The model ran out of output budget before it answered.",
  forbidden: "Only an admin of this carrier can run the model check.",
  unreadable: "Could not reach the spend ledger. Try again in a moment.",
};

export function AiProofForm() {
  const [state, action, pending] = useActionState<ProofState>(proofCallAction, null);
  return (
    <form action={action} className="grid justify-items-start gap-3">
      <Button type="submit" variant="outline" pending={pending} pendingLabel="Calling the model">
        Test the model connection
      </Button>
      {state?.ok ? (
        <InlineAlert tone="success" title="Reply" className="w-full">
          {state.text || "(empty)"}
        </InlineAlert>
      ) : state ? (
        <InlineAlert tone="destructive" className="w-full">
          {MESSAGES[state.category]}
        </InlineAlert>
      ) : null}
    </form>
  );
}
