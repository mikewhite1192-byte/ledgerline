// Release switches. Every outside effect (payments, accounting posts, email, model calls)
// reads its switch here, and every path that reaches the write re-checks it.
// Turning a switch on is the owner's call, in its own one-line PR.
// The demo-path test's local overrides (src/config/local-overrides.ts) are inert in production
// and whenever an Aurora cluster is configured.

import { applyLocalOverrides } from "./local-overrides";

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
  // Which model sorts driver messages and voice notes: "baseten" (Muse Spark Open, the open-weights
  // model) or "meta" (Muse Spark).
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
    // Largest absolute change to last settled week's total net pay a rule change may carry.
    ruleChangeImpactMaxCents: number;
  };
  // The agent chat. Off means the composer shows its reason text and the turn route refuses
  // before any model call. aiEnabled must also be on for a turn to reach a model.
  agentEnabled: boolean;
  // How the chat follows a running turn: server-sent events, or polling the turn every 1.5 s.
  // The client falls back to polling on its own when no event arrives within 3 seconds.
  agentStreamMode: "sse" | "poll";
  // One ceiling over every agent run (design-agents-101 3.3): a turn is one plan, act, observe
  // round of the run's own loop (a chat answer: one model call). A cap, never a switch: the
  // tighter cap that already exists still wins (the effective limit is the smaller one), and
  // FLAGS_LOCAL_OVERRIDES cannot touch it.
  runLimits: {
    maxTurns: number;
  };
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
  // Taking an advance back: an unpaid one is cancelled, a paid one records the amount taken back
  // (it stops counting as owed; nothing is pulled off the card). Off refuses with disabled before
  // any write. maxCents bounds one take-back, on top of the advance's own bound.
  advanceTakeback: { enabled: boolean; maxCents: number };
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
  // The invoice queue: Refresh turns each delivered, rated load into an invoice card, and an
  // approval records the invoice here. Posting it to the books still needs accountingEnabled.
  invoicesEnabled: boolean;
  // Loads delivered on or after this tenant-local date enter the queue; older ones never do.
  invoicesStart: string;
  invoiceLimits: {
    // Cards one Refresh makes; past it the run stops and says so.
    proposalsPerRun: number;
    // Tries at posting one invoice; a retry follows only a definite failure.
    maxPostAttempts: number;
  };
  // Recording a customer's payment against open invoices. Posting it to the books still needs
  // accountingEnabled.
  customerPaymentsEnabled: boolean;
  customerPaymentLimits: {
    // Payments one carrier may record in one tenant-local day.
    perDay: number;
    // Largest single payment.
    maxCents: number;
  };
  // Dock clips: off means no upload is taken and no model sees a clip (both segmentation calls
  // and the reading). aiEnabled must also be on for a model call to run.
  clipsEnabled: boolean;
  clipLimits: {
    // The uploaded file and the redacted file, each.
    bytes: number;
    durationMs: number;
    frames: number;
    // Each of the two segmentation calls (faces, plates); 600 frames cost 12 cents.
    redactMaxCostCents: number;
    // The one reading call.
    readMaxCostCents: number;
    // New clips per carrier per UTC day (a repeat of the same file is not a new clip).
    perTenantPerDay: number;
  };
  // Driver voice notes: upload, transcribe (Muse Voice Transcribe), screen, translate (Muse
  // Spark), sort (the triage model) and hand to the agent. Off means every voice route refuses
  // with disabled before reading the upload or calling a model.
  // Driver messages can be pasted (and, with the mail switch, emailed) into the Inbox, sorted by
  // the triage model and handed to the agent. Off means every Inbox route refuses with disabled
  // before reading the body, and nothing is screened, sorted or stored.
  inboxEnabled: boolean;
  inboxLimits: {
    // Messages one carrier can add in one of its local days, failed and held ones too.
    messagesPerDay: number;
    // Longest message text kept, in characters, after trimming.
    maxChars: number;
    // Sorting tries per message (the first one included); after the last a failed message stays
    // failed. Also the attempts CHECK in migration 0037: raise both together.
    maxAttempts: number;
  };
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
  // The demo reset page (/settings/demo): a demo carrier's admin puts the carrier back to its
  // seeded week in one transaction. Off means the page answers 404 and the action refuses before
  // any read or write. It writes only our own database, never an outside system.
  demoResetEnabled: boolean;
  // Pay rules changed by talking: the two chat tools, the approval executor and the Pay rules
  // page. Off means neither tool is offered or runs, an approval is refused before anything is
  // written, and the page shows the switched-off state.
  rulesByTalkingEnabled: boolean;
  // The pay sweep: checks one open week for every driver, drafts a pay correction for each
  // finding it can fix and lists the rest for a person. It only proposes; a person approves.
  // Off means the Sweep page shows its reason text and the routes refuse before any work.
  sweepEnabled: boolean;
  // The nightly kicker (infra sweep stack). Off means the internal route refuses every call.
  sweepScheduleEnabled: boolean;
  // A person's approval of a pay correction (drafted by the sweep or in chat) writes its pay item
  // for the next pay run. Off means the kind has no executor: an approval or a resume is refused
  // as not_executable before anything is written, and the proposal stays as it was.
  payCorrectionsEnabled: boolean;
  sweepLimits: {
    // Findings kept per run; the rest are left for the next run with a visible line.
    maxItems: number;
    // Model spend one run may count, in cents (explanations plus audits).
    maxRunCents: number;
    // The cap on one explanation call, in cents.
    maxExplainCents: number;
    // How long one request works before it answers "running" and the page asks again.
    sliceMs: number;
    // Audit tries per item while the auditor answers "in progress".
    maxAuditAttempts: number;
  };
  // Cash Friday: the Cash page answers whether the bank covers Friday's pay run, fuel card loads
  // and bills due, and drafts up to three ways to close a short for a person to approve. Off
  // means the page is not found, the check route and the agent's read tool refuse, and the three
  // option kinds have no executor, so an approval is refused before anything is written.
  cashFridayEnabled: boolean;
  cashFridayLimits: {
    // The cap on one explanation call, in cents, and the longest paragraph kept.
    maxExplainCents: number;
    maxExplainChars: number;
    // Invoices one factoring option may name, and late payers the chase options may name.
    maxFactorInvoices: number;
    maxChaseCustomers: number;
    // Days past a customer's usual lateness before an invoice is no longer expected by pay day.
    graceDays: number;
    // Only invoices issued within this many days can be factored.
    factoringMaxAgeDays: number;
  };
  // The sweep's second opinion: Muse Wonder orders the drivers, one short Muse Spark check per
  // driver reads that driver's records, and Muse Wonder writes how the two views compare. It
  // reads and labels only: no proposal, no number, nothing for a model to approve. An issue only
  // a checker raised waits for a person. Read when a run leaves find and again before every model
  // call. sweepEnabled must also be on.
  fanoutEnabled: boolean;
  fanoutLimits: {
    // Drivers checked per run, busiest week first; the rest are listed as over the limit.
    maxDrivers: number;
    // Checks run side by side in one slice.
    parallel: number;
    // Model calls one driver's check may make.
    maxCallsPerDriver: number;
    // Record reads one driver's check may make.
    maxToolSteps: number;
    // The cap on one check call, in cents.
    callCents: number;
    // The cap on one driver's check, all its calls together, in cents.
    driverCents: number;
    // The caps on the ordering call and the comparison call, in cents.
    planCents: number;
    reconcileCents: number;
    // One driver's check, start to answer, in milliseconds.
    childTimeoutMs: number;
    // Sweep model spend one carrier may count in one of its local days, in cents. A run that
    // reaches the second opinion with the day already at it skips it and finishes as a plain
    // sweep, and every hold the second opinion takes must fit what is left of it across the
    // carrier's runs that day.
    tenantDayCents: number;
    // Runs with the second opinion one carrier may start in one of its local days.
    runsPerTenantDay: number;
    // A run's whole cap when the second opinion is on (the sweep's own spend included), in cents.
    // The second opinion holds at most this less sweepLimits.maxRunCents, so the sweep's own
    // budget is always left for its explanations and audits.
    runCapCents: number;
  };
  // Approve all clean: one deliberate approval over the clean fixes a person saw. A batch whose
  // total is over approverRole.adminAboveCents needs an admin, like a single proposal.
  approveAllLimits: { maxItems: number };
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
  // The weekly pay run: "Run the week" drafts each driver's paystub and a card a person approves;
  // an approval pays the driver and books the bill. Paying still needs payoutsEnabled and booking
  // still needs accountingEnabled; each write re-checks its own switch.
  settlementsEnabled: boolean;
  // Pay periods that start on or after this tenant-local date can be run; older ones never are.
  settlementsStart: string;
  settlementLimits: {
    // Drivers one run drafts; past it the run stops and says so.
    driversPerRun: number;
    // Tries at paying one settlement; a retry follows only a definite failure.
    maxPayoutAttempts: number;
    // A single approval books the bill only when at least this much of the request is left.
    legTwoMinRemainingMs: number;
  };
  // "Approve all clean": one approval over the clean paystubs of a week, then a drain that sends
  // each reserved leg. The legs still need payoutsEnabled and accountingEnabled.
  batchApproveEnabled: boolean;
  batchLimits: {
    // Paystubs in one batch.
    maxItems: number;
    // The batch total, in cents.
    maxTotalCents: number;
    // How long one drain request may send before it stops and says what is left.
    drainBudgetMs: number;
  };
  // Invoice review: the Review tab, the review card on an invoice, Mark reviewed, Mark as sent and
  // the agent's two review read tools. Off: the tab and card are hidden, the routes answer 404 and
  // the tools are not offered. invoicesEnabled must also be on. A post to accounting is always
  // left unsent there (a constant on the adapter, not a switch); LedgerLine never sends one.
  invoiceReviewEnabled: boolean;
  // Collections: the Collections page lists invoices 30 or more days past due, Muse Spark drafts one
  // short reminder email per invoice and stage, code checks every number in it against the invoice,
  // and a person approves or rejects each one. Off means the page shows the switched-off state, the
  // routes answer 404 before any read and the agent's read tool is not offered. aiEnabled must also
  // be on for a draft to reach a model. Nothing here moves money.
  collectionsEnabled: boolean;
  // Approved reminders also go by email, to allowlisted addresses only. Off: approval records the
  // reminder as approved and not sent, and the email path logs "would send" instead of sending.
  collectionsEmailEnabled: boolean;
  // Exact, lower-cased addresses the email path may send to. Empty refuses every address.
  collectionsEmailAllowlist: string[];
  // Email goes only for a reminder drafted on or after this date (YYYY-MM-DD, a whole date on the
  // carrier's calendar). Older reminders are the backlog, and a release never notifies the backlog.
  // The release PR that arms email sets this to its go-live date. A value that is not a whole date
  // (the default, empty) refuses every email.
  collectionsEmailFrom: string;
  // Caps on reminder drafting: one reminder's worst case, the spend of one Draft run, the output
  // budget of one reminder, how many reminders one run drafts, and how late an invoice must be (in
  // whole days past its due date) before it gets a reminder.
  collectionsLimits: {
    maxDraftCents: number;
    maxRunCents: number;
    maxOutputTokens: number;
    maxDraftsPerRun: number;
    minDaysLate: number;
  };
  // The Profit brief at /profit: last closed week's margin by route and by customer, how fast each
  // customer pays, and "Write this week's brief", which asks Muse Spark to word those figures (a
  // button press, never a schedule). Off: the page shows its off state, the route answers 409 and
  // the agent's read tool is not offered. aiEnabled must also be on for the button to reach a model.
  profitBriefEnabled: boolean;
  profitBriefLimits: {
    // One brief's worst case, checked by the wrapper before the request goes out.
    maxBriefCents: number;
    // The brief's output budget, reasoning included.
    maxOutputTokens: number;
    // Rows the brief's figures and the page's tables keep, best margin first.
    maxLanes: number;
    maxCustomers: number;
  };
  // Carrier memory: short notes the office keeps about customers, drivers and its own ways, which
  // the agent reads as context on each question (never for an amount; the notes' figures are
  // never allowed in an answer). Off: the Memory page shows that it is off, the menu has no
  // item, the note actions refuse before any read or write, the agent's summary has no notes
  // section and a turn's trace lists none. No model call of its own, so no spend cap.
  carrierMemoryEnabled: boolean;
  carrierMemoryLimits: {
    // Notes one question may carry, and their characters in the agent's summary.
    maxNotesPerTurn: number;
    maxPromptChars: number;
    // One note's length (the table's own check holds 300 too).
    maxNoteChars: number;
    // Notes one carrier may keep; the page refuses one more with "Remove a note first".
    maxNotesPerCarrier: number;
  };
  // The agent's side of carrier memory, under the same switch: the operator may suggest a note from
  // a chat turn (it waits as a suggestion until a person keeps it; no model reads it before), and
  // the second check sees the kept notes about the request's driver or customer, never as evidence
  // for an amount.
  carrierMemoryAgentLimits: {
    // Suggestions one question may make, and suggestions that may wait unkept at once.
    maxSuggestionsPerTurn: number;
    maxSuggestionsWaiting: number;
    // Notes the second check sees on one request.
    maxAuditorNotes: number;
  };
  // Fuel checks: every fill-up held against the truck's tank, the load's route and the driver's
  // day, with a Muse Spark look at two receipt photos of a fill-up turned in twice. It only lists
  // and proposes; a person approves a pay correction on its card. Off means the Fuel checks page
  // is not found, its link is hidden, the routes and the service refuse before any work, no
  // receipt compare is called, and the agent's run_checks leaves fuel findings out.
  fuelAnomalyEnabled: boolean;
  fuelAnomalyLimits: {
    // Tenant-local date: fill-ups before it are never listed. The release PR that turns
    // fuelAnomalyEnabled on also sets this to its go-live date; left as it is, the first run lists
    // every fill-up from this date up to go-live.
    from: string;
    // Two fill-ups with the same gallons, amount and state this close together are one fill-up
    // turned in twice.
    duplicateWindowMinutes: number;
    // The largest correction the page will suggest, in cents (the same as the gateway's pay
    // correction limit); above it the row says to handle it by hand.
    chargebackMaxCents: number;
    // The cap on one receipt compare call, in cents, and its output tokens.
    compareMaxCostCents: number;
    compareMaxOutputTokens: number;
    // Receipt compares one run may make, and one carrier may make in a day.
    comparesPerRun: number;
    comparesPerTenantPerDay: number;
  };
};

export const flags: Flags = {
  aiEnabled: false,
  aiJobHourlyCapCents: 1000,
  aiProofRoute: false,
  triageProvider: "baseten",
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
    ruleChangeImpactMaxCents: 500_000,
  },
  agentEnabled: false,
  agentStreamMode: "sse",
  runLimits: {
    maxTurns: 30,
  },
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
  advanceTakeback: { enabled: false, maxCents: 100_000 },
  agentToolSearch: false,
  agentPromptCache: { enabled: false, retention: "in_memory" },
  driverNotesEnabled: false,
  driverNotesEmailEnabled: false,
  driverNotesEmailAllowlist: [],
  driverNotesEmailFrom: "2026-10-27",
  driverNoteLimits: { maxNoteCents: 3, maxBatchCents: 60, maxOutputTokens: 400 },
  reportsEnabled: false,
  invoicesEnabled: false,
  invoicesStart: "2026-10-05",
  invoiceLimits: { proposalsPerRun: 50, maxPostAttempts: 3 },
  customerPaymentsEnabled: false,
  customerPaymentLimits: { perDay: 50, maxCents: 5_000_000 },
  clipsEnabled: false,
  clipLimits: {
    bytes: 700_000,
    durationMs: 20_000,
    frames: 600,
    redactMaxCostCents: 13,
    readMaxCostCents: 10,
    perTenantPerDay: 20,
  },
  inboxEnabled: false,
  inboxLimits: { messagesPerDay: 50, maxChars: 20_000, maxAttempts: 3 },
  voiceIntakeEnabled: false,
  voiceLimits: { maxWavBytes: 2_000_000, maxOriginalBytes: 700_000, maxDurationMs: 60_000, voiceNotesPerDay: 20 },
  detentionEnabled: false,
  demoResetEnabled: false,
  rulesByTalkingEnabled: false,
  sweepEnabled: false,
  sweepScheduleEnabled: false,
  payCorrectionsEnabled: false,
  sweepLimits: { maxItems: 40, maxRunCents: 150, maxExplainCents: 5, sliceMs: 20_000, maxAuditAttempts: 3 },
  fanoutEnabled: false,
  fanoutLimits: {
    maxDrivers: 30,
    parallel: 6,
    maxCallsPerDriver: 3,
    maxToolSteps: 4,
    callCents: 3,
    driverCents: 9,
    planCents: 12,
    reconcileCents: 12,
    childTimeoutMs: 15_000,
    tenantDayCents: 1_000,
    runsPerTenantDay: 3,
    runCapCents: 450,
  },
  approveAllLimits: { maxItems: 25 },
  cashFridayEnabled: false,
  cashFridayLimits: {
    maxExplainCents: 8,
    maxExplainChars: 600,
    maxFactorInvoices: 3,
    maxChaseCustomers: 2,
    graceDays: 14,
    factoringMaxAgeDays: 45,
  },
  portalRunnerEnabled: false,
  portalRunnerModel: "spark",
  portalRunLimits: {
    maxSteps: 15,
    maxWallMs: 240_000,
    maxRunCents: 150,
    maxCallCents: 25,
    maxActionsPerStep: 8,
    screenshotMaxBytes: 400_000,
    // Also the held_pod_pdf CHECK in migration 0021 (300000 bytes): raise both together, or a
    // paused run cannot hold its POD and its resume ends pod_not_kept.
    podMaxBytes: 300_000,
    approvalWaitMinutes: 30,
  },
  settlementsEnabled: false,
  settlementsStart: "2026-10-05",
  settlementLimits: { driversPerRun: 200, maxPayoutAttempts: 3, legTwoMinRemainingMs: 12_000 },
  batchApproveEnabled: false,
  batchLimits: { maxItems: 50, maxTotalCents: 10_000_000, drainBudgetMs: 22_000 },
  invoiceReviewEnabled: false,
  collectionsEnabled: false,
  collectionsEmailEnabled: false,
  collectionsEmailAllowlist: [],
  collectionsEmailFrom: "",
  collectionsLimits: { maxDraftCents: 2, maxRunCents: 40, maxOutputTokens: 500, maxDraftsPerRun: 12, minDaysLate: 30 },
  profitBriefEnabled: false,
  profitBriefLimits: { maxBriefCents: 6, maxOutputTokens: 700, maxLanes: 10, maxCustomers: 12 },
  carrierMemoryEnabled: false,
  carrierMemoryLimits: { maxNotesPerTurn: 8, maxPromptChars: 1600, maxNoteChars: 300, maxNotesPerCarrier: 500 },
  carrierMemoryAgentLimits: { maxSuggestionsPerTurn: 2, maxSuggestionsWaiting: 20, maxAuditorNotes: 4 },
  fuelAnomalyEnabled: false,
  fuelAnomalyLimits: {
    from: "2026-10-27",
    duplicateWindowMinutes: 60,
    chargebackMaxCents: 50_000,
    compareMaxCostCents: 5,
    compareMaxOutputTokens: 200,
    comparesPerRun: 10,
    comparesPerTenantPerDay: 20,
  },
};

applyLocalOverrides(flags);
