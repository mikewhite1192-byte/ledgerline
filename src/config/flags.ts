// Release switches. Every outside effect (payments, accounting posts, email, model calls)
// reads its switch here, and every path that reaches the write re-checks it.
// Turning a switch on is the owner's call, in its own one-line PR.

export type Flags = {
  // Model calls through src/lib/ai. Off until the wrapper and its spend cap are live.
  aiEnabled: boolean;
  // The model connection check on the home page; on only to prove a deploy.
  aiProofRoute: boolean;
  // Which model triages inbound email: "meta" (Muse Spark) until Baseten credits land.
  triageProvider: "meta" | "baseten";
  // Any payout through the payment adapter, mock included. Off means the money executor refuses
  // before reserving a ledger row, and the adapter refuses again at send.
  payoutsEnabled: boolean;
  // Payouts: the mock card-load adapter unless Stripe test mode is switched on.
  paymentProvider: "mock" | "stripe_test";
  // Posts to the QuickBooks Online sandbox company. Never a production company.
  accountingEnabled: boolean;
  // Inbound email through SES. Off means the paste box is the only intake.
  inboundEmailEnabled: boolean;
  // How the untrusted-input screener reads Muse Spark Open's answer: three fixed lines ("text")
  // or one report_screen tool call ("tool"). Either way an answer that does not parse is flagged.
  // Screening itself has no off switch.
  screenOutputMode: "tool" | "text";
  // The agent gateway's amount limits for proposals the rules engine does not size itself.
  gatewayLimits: {
    // Largest pay correction, either direction, a proposal may carry.
    payCorrectionMaxCents: number;
    // Largest change to an invoice total a proposal may carry.
    invoiceFixMaxCents: number;
  };
  // The agent chat. Off means the composer shows its reason text and the turn route refuses
  // before any model call. aiEnabled must also be on for a turn to reach a model.
  agentEnabled: boolean;
  // How the chat follows a running turn: server-sent events, or polling the turn every 1.5 s.
  // The client falls back to polling on its own when no event arrives within 3 seconds.
  agentStreamMode: "sse" | "poll";
  // Hard caps on one turn. Reaching any of them ends the turn with what it found so far.
  agentTurnLimits: {
    maxToolSteps: number;
    maxModelCalls: number;
    maxTurnCents: number;
    // Leaves room inside the 30 second response for the last event to flush.
    wallClockMs: number;
    // The state summary the model is given, in characters.
    summaryChars: number;
  };
  // A proposal older than this becomes expired when someone tries to approve it.
  proposalMaxAgeDays: number;
  // The auditor: one Muse Wonder call per proposal that checks it against the records and the
  // rules engine. Off means no audit call is made and the card reads "Auditor off".
  auditorEnabled: boolean;
  // Proposals created before this instant are never audited.
  auditorStart: string;
  // On: a proposal needs the auditor's verdict before a person can approve it. While this is on
  // and auditorEnabled is off, nothing can be approved: the release flips both together.
  auditorRequired: boolean;
  // Any member approves a proposal up to adminAboveCents; above it, only an admin.
  approverRole: { adminAboveCents: number };
  // Operator turns on Muse Spark send the tools no question needs at first as a name and a
  // description only, with the API's search tool to load one. Off sends every tool in full.
  agentToolSearch: boolean;
  // Operator turns on Muse Spark send a shared prompt cache key and keep the turn's state summary
  // out of the cached prefix. Off sends today's request. "24h" is a retention hint with its own
  // price: read the pricing page before choosing it.
  agentPromptCache: { enabled: boolean; retention: "in_memory" | "24h" };
};

export const flags: Flags = {
  aiEnabled: false,
  aiProofRoute: false,
  triageProvider: "meta",
  payoutsEnabled: false,
  paymentProvider: "mock",
  accountingEnabled: false,
  inboundEmailEnabled: false,
  screenOutputMode: "text",
  gatewayLimits: { payCorrectionMaxCents: 50_000, invoiceFixMaxCents: 250_000 },
  agentEnabled: false,
  agentStreamMode: "sse",
  agentTurnLimits: {
    maxToolSteps: 6,
    maxModelCalls: 4,
    maxTurnCents: 40,
    wallClockMs: 22_000,
    summaryChars: 10_000,
  },
  proposalMaxAgeDays: 7,
  auditorEnabled: false,
  auditorStart: "2026-10-27T00:00:00Z",
  auditorRequired: true,
  approverRole: { adminAboveCents: 200_000 },
  agentToolSearch: false,
  agentPromptCache: { enabled: false, retention: "in_memory" },
};
