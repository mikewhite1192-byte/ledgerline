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
};

export const flags: Flags = {
  aiEnabled: false,
  aiProofRoute: false,
  triageProvider: "meta",
  payoutsEnabled: false,
  paymentProvider: "mock",
  accountingEnabled: false,
  inboundEmailEnabled: false,
};
