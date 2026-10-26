"use client";

import { useActionState } from "react";
import { proofCallAction, type ProofCategory, type ProofState } from "./ai-proof-action";

// A fixed message per category; nothing from the provider is shown but the reply itself.
const MESSAGES: Record<ProofCategory, string> = {
  disabled: "Model calls are switched off.",
  not_configured: "The model connection is not configured.",
  cap: "The spend cap is reached. No call was made.",
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
  forbidden: "This login is not linked to a carrier.",
  unreadable: "Could not reach the spend ledger. Try again in a moment.",
};

export function AiProofForm() {
  const [state, action, pending] = useActionState<ProofState>(proofCallAction, null);
  return (
    <form action={action} style={{ marginTop: 12 }}>
      <button type="submit" disabled={pending} style={{ padding: "8px 10px", font: "inherit" }}>
        {pending ? "Calling the model" : "Test the model connection"}
      </button>
      {state?.ok ? (
        <p style={{ marginTop: 12 }}>Reply: {state.text || "(empty)"}</p>
      ) : state ? (
        <p role="alert" style={{ marginTop: 12 }}>
          {MESSAGES[state.category]}
        </p>
      ) : null}
    </form>
  );
}
