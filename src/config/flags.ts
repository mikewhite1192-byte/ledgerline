// Release switches. Every outside effect (payments, accounting posts, email, model calls)
// reads its switch here, and every path that reaches the write re-checks it.
// Turning a switch on is the owner's call, in its own one-line PR.

export type Flags = {
  // Model calls through src/lib/ai. Off until the wrapper and its spend cap are live.
  aiEnabled: boolean;
  // The most one job may spend on model calls in the last 60 minutes, or since an admin last
  // cleared it when that is more recent, in cents, inside the overall budget. A job is one trace,
  // or a carrier's calls for one purpose with no trace. A call that would take its job past this
  // is refused, and the job stays stopped until an admin clears its alert on the Meta models page.
  // Live from the start: it only ever refuses.
  aiJobHourlyCapCents: number;
  // The model connection check on the home page; on only to prove a deploy.
  aiProofRoute: boolean;
  // Which model triages inbound email: "meta" (Muse Spark) until Baseten credits land.
  triageProvider: "meta" | "baseten";
  // Muse Spark Open's standby host. "off": a call Baseten cannot serve fails as it always has.
  // "fireworks": when Baseten fails for a reason that is Baseten's (no key, 429, 401/403, 402, a
  // connection failure, a 5xx other than 504), the wrapper makes one more attempt on Fireworks
  // with its own reservation and ledger row, inside the time the caller had left. The wrapper
  // reads it at the moment of that decision; callers never do.
  sparkOpenFallback: "off" | "fireworks";
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
    // Largest detention charge one proposal may add to an invoice.
    detentionChargeMaxCents: number;
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
  // Document upload and the one Muse Spark read of each file. Off means the routes answer 404,
  // the pages say reading is off, and no model call is made (the reader re-checks it).
  documentsEnabled: boolean;
  // The crop step before a photo is read. Off: the photo goes to the model as uploaded. The crop
  // itself is a later item; on does nothing new until it lands.
  documentCrop: boolean;
  // Upload limits: bytes per file, PDF pages, the per-read cost bound in cents (the wrapper's own
  // spend cap still applies) and uploads per carrier in any rolling 24 hours.
  documentLimits: {
    maxBytes: number;
    maxPdfPages: number;
    readMaxCostCents: number;
    perTenantPerDay: number;
  };
  // The advance flow: approving an advance proposal, Retry, Check pending, Post to QuickBooks and
  // the request desk. Off means each refuses with disabled before any write. The agent can still
  // propose an advance (that writes only our own tables).
  advancesEnabled: boolean;
  // The advance payout path, on top of advancesEnabled and payoutsEnabled. Every approval and
  // retry checks all of it before the ledger reserves a row: armed, the amount at or under
  // capCents, and the tenant's local date on or after startDate (YYYY-MM-DD).
  advancePayouts: { armed: boolean; capCents: number; startDate: string };
  advancesLimits: {
    // Advance proposals one carrier can make in one of its local days.
    proposalsPerDay: number;
    // Payout tries per advance, the first included; Retry stops at this many.
    maxPayoutAttempts: number;
    // The QuickBooks post runs in the approve request only with this much of its time left.
    legTwoMinRemainingMs: number;
  };
  // Operator turns on Muse Spark send the tools no question needs at first as a name and a
  // description only, with the API's search tool to load one. Off sends every tool in full.
  agentToolSearch: boolean;
  // Operator turns on Muse Spark send a shared prompt cache key and keep the turn's state summary
  // out of the cached prefix. Off sends today's request. "24h" is a retention hint with its own
  // price: read the pricing page before choosing it.
  agentPromptCache: { enabled: boolean; retention: "in_memory" | "24h" };
  // Driver notes: a short note in the driver's language explaining a settled week's pay, written
  // by Muse Spark, checked against the paystub, and shown to the driver only after a person
  // approves it. Off means the pages show the switched-off state and the routes refuse before any
  // model call. aiEnabled must also be on for a draft to reach a model.
  driverNotesEnabled: boolean;
  // Approved notes also go by email, to allowlisted addresses only. Off: delivery is the driver
  // view and the email path logs "would send" instead of sending.
  driverNotesEmailEnabled: boolean;
  // Exact, lower-cased addresses the email path may send to. Empty refuses every address.
  driverNotesEmailAllowlist: string[];
  // Email goes only for a period that ends on or after this date (YYYY-MM-DD, a whole date on the
  // carrier's calendar, as the period's own dates are). Older periods are the backlog, and a
  // release never notifies the backlog: their notes stay on the driver view only. The release PR
  // that arms email sets this to its go-live date. A value that is not a whole date refuses every
  // email.
  driverNotesEmailFrom: string;
  // Caps on note drafting: one note's worst case, the spend of one period's notes, and the
  // output budget of one note.
  driverNoteLimits: { maxNoteCents: number; maxBatchCents: number; maxOutputTokens: number };
  // The five report tools in the chat and the report download route. Off: the agent is not
  // offered them, a call to one is refused as an unknown tool, and the route answers 404.
  reportsEnabled: boolean;
  // Driver voice notes: upload, transcribe (Muse Voice Transcribe), screen, translate (Muse
  // Spark), sort (the triage model) and hand to the agent. Off means every voice route refuses
  // with disabled before reading the upload or calling a model.
  voiceIntakeEnabled: boolean;
  voiceLimits: {
    // The 16 kHz mono WAV sent for transcription: about 62 seconds.
    maxWavBytes: number;
    // The original recording kept for playback; one row must read back under the Data API's
    // 1 MiB answer limit (base64 of 700,000 bytes is 933,336 characters).
    maxOriginalBytes: number;
    // Longer audio is refused before the transcription call: the 60 seconds the page promises,
    // inside what the WAV cap holds, so the words, the recorder and the server agree.
    maxDurationMs: number;
    // Voice notes one carrier can upload in one of its local days.
    voiceNotesPerDay: number;
  };
  // Unbilled detention: the agent's find and propose tools are offered and a person's approval
  // adds the charge to the load's open invoice. Off means neither tool is offered or runs and an
  // approval is refused before anything is written.
  detentionEnabled: boolean;
  // The portal runner: the agent opens the fictional broker portal in a browser and reads a
  // load's delivery stamps and POD. Off gates the portal pages, the run routes, the gateway tool
  // and the worker, which re-checks it when it claims a run. aiEnabled must also be on.
  portalRunnerEnabled: boolean;
  // The model that drives the browser, and the only one a computer step may call. Muse Spark is
  // the default: Muse Wonder answered 400 "Unsupported tool type: 'computer'" when the runner was
  // built. Moving to Muse Wonder once it takes the tool is the owner's call, in its own one-line
  // change.
  portalRunnerModel: "wonder" | "spark";
  // Hard caps on one portal run. Reaching any of them ends the run with no evidence.
  portalRunLimits: {
    maxSteps: number;
    maxWallMs: number;
    maxRunCents: number;
    maxCallCents: number;
    maxActionsPerStep: number;
    screenshotMaxBytes: number;
    podMaxBytes: number;
    // A safety check a person has not decided within this many minutes ends the run.
    approvalWaitMinutes: number;
  };
};

export const flags: Flags = {
  aiEnabled: false,
  aiJobHourlyCapCents: 1000,
  aiProofRoute: false,
  triageProvider: "meta",
  sparkOpenFallback: "off",
  payoutsEnabled: false,
  paymentProvider: "mock",
  accountingEnabled: false,
  inboundEmailEnabled: false,
  screenOutputMode: "text",
  gatewayLimits: {
    payCorrectionMaxCents: 50_000,
    invoiceFixMaxCents: 250_000,
    detentionChargeMaxCents: 100_000,
  },
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
  documentsEnabled: false,
  documentCrop: false,
  documentLimits: { maxBytes: 700_000, maxPdfPages: 3, readMaxCostCents: 8, perTenantPerDay: 20 },
  advancesEnabled: false,
  advancePayouts: { armed: false, capCents: 50_000, startDate: "2026-10-27" },
  advancesLimits: { proposalsPerDay: 30, maxPayoutAttempts: 3, legTwoMinRemainingMs: 12_000 },
  agentToolSearch: false,
  agentPromptCache: { enabled: false, retention: "in_memory" },
  driverNotesEnabled: false,
  driverNotesEmailEnabled: false,
  driverNotesEmailAllowlist: [],
  driverNotesEmailFrom: "2026-10-27",
  driverNoteLimits: { maxNoteCents: 3, maxBatchCents: 60, maxOutputTokens: 400 },
  reportsEnabled: false,
  voiceIntakeEnabled: false,
  voiceLimits: { maxWavBytes: 2_000_000, maxOriginalBytes: 700_000, maxDurationMs: 60_000, voiceNotesPerDay: 20 },
  detentionEnabled: false,
  portalRunnerEnabled: false,
  portalRunnerModel: "spark",
  portalRunLimits: {
    maxSteps: 15,
    maxWallMs: 240_000,
    maxRunCents: 150,
    maxCallCents: 25,
    maxActionsPerStep: 8,
    screenshotMaxBytes: 400_000,
    podMaxBytes: 300_000,
    approvalWaitMinutes: 30,
  },
};
