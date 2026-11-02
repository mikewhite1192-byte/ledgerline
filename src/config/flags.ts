// Release switches. Every outside effect (payments, accounting posts, email, model calls)
// reads its switch here, and every path that reaches the write re-checks it.
// Turning a switch on is the owner's call, in a release PR of its own; caps and start dates stay
// as set here. Arming a switch that lets money move is a one-line PR of its own.
// The demo-path test's local overrides (src/config/local-overrides.ts) are inert in production
// and whenever an Aurora cluster is configured.

import { applyLocalOverrides } from "./local-overrides";

export type Flags = {
  // Model calls through src/lib/ai, on since the wrapper and its spend cap went live.
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
  // before reserving a ledger row, and the adapter refuses again at send. With paymentProvider
  // stripe_test, a weekly pay payout (the bank rail) runs only for the two demo carriers, because
  // Stripe test mode sends every transfer to the one test account the environment names: any other
  // carrier is refused as if this were off, before a ledger row is reserved and again at the send.
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
  // A question asked from a record page carries that record (design-ui-pass 2): the turn route
  // accepts a focus, checks it under the carrier and names the record in the state summary's
  // Subject line, and GET /api/agent/recent returns the caller's newest conversation for the
  // panel to resume. Off: a turn with a focus is refused as a bad request and the recent route
  // answers agent_off. On now that the panel that sends it has landed; local mode can set it either
  // way through FLAGS_LOCAL_OVERRIDES.
  agentFocusEnabled: boolean;
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
  // Who sees "Step through" in the trace panel under an answer (design-agents-101 3.4): one model
  // call at a time, with what it saw, its note, what it did and what came back. Display only: it
  // reads the stored trace and never pauses a run. dev is a development or test run (a laptop,
  // the tests); staff is the carrier's own people on production. Both are on.
  stepThrough: { dev: boolean; staff: boolean };
  // Hard caps on one turn. Reaching any of them ends the turn with what it found so far.
  agentTurnLimits: {
    maxToolSteps: number;
    // Muse Spark makes about one tool call per response, so four ran out before the answer in
    // half the scored run; the cents cap and the clock still bound the turn.
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
  // On: a waiting proposal whose numbers the rules engine's own recompute did not match to the cent
  // (0045's engine_check) needs a person's written reason to approve, like a block, and the card
  // says it is held. A narrowing only: off, the mismatch is still shown and still keeps the
  // proposal out of Approve all clean.
  verifyEngineMismatchBlocks: boolean;
  // Any member approves a proposal up to adminAboveCents; above it, only an admin.
  approverRole: { adminAboveCents: number };
  // Document upload and the one Muse Spark read of each file. Off means the routes answer 404,
  // the pages say reading is off, and no model call is made (the reader re-checks it).
  documentsEnabled: boolean;
  // The crop step before a photo is read (src/lib/documents/crop.ts): one segmentation call finds
  // the paper and the server warps it flat. Off: the photo goes to the model as uploaded and no
  // segmentation call is made (the crop step re-checks it).
  documentCrop: boolean;
  // Upload limits: bytes per file, PDF pages, the per-read cost bound in cents (the wrapper's own
  // spend cap still applies) and uploads per carrier in any rolling 24 hours.
  documentLimits: {
    maxBytes: number;
    maxPdfPages: number;
    readMaxCostCents: number;
    perTenantPerDay: number;
  };
  // The marked copy of a document photo: the image model circles the line in question and writes
  // what the records say beside it, then a second read checks the copy before it is kept. On top
  // of documentsEnabled. Off: the block is hidden and the route refuses before any call.
  documentMarkupEnabled: boolean;
  // Per try: the edit's and the check's cost bounds in cents (the wrapper's spend cap still
  // applies), marked copies started per carrier per day, and the largest copy kept, in bytes
  // (also the markup_length CHECK in migration 0055: raise both together).
  markupLimits: {
    editMaxCostCents: number;
    checkMaxCostCents: number;
    perTenantPerDay: number;
    maxBytes: number;
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
  // Pay cards: a picture of a driver's approved week (take-home pay, earned, taken out, loads,
  // change from last week) drawn in the browser from the settlement's own engine figures, read
  // back by Muse Spark and kept only when every figure matches, for the clerk to save and send
  // from their phone. Off means the cards page shows the switched-off state, its link is hidden,
  // the routes refuse before any work and the driver view shows no card. aiEnabled must also be on
  // for a check to reach a model. Nothing is ever sent by the app.
  payCardsEnabled: boolean;
  payCardLimits: {
    // The cap on one read-back call, in cents.
    checkMaxCostCents: number;
    // The spend of one run of the cards page, in cents.
    maxBatchCents: number;
    // Cards one carrier may check in 24 hours, every outcome counted.
    cardsPerTenantPerDay: number;
    // The largest card picture the check takes, in bytes.
    // At most 400,000: the byte_length CHECK in migration 0052 refuses a larger card.
    maxPngBytes: number;
  };
  // The nine report tools in the chat and the report download route. Off: the agent is not
  // offered them, a call to one is refused as an unknown tool, and the route answers 404.
  reportsEnabled: boolean;
  // The IFTA quarter report (report_ifta_quarter and /api/reports/ifta_quarter): per-state miles
  // and gallons, fleet MPG and tax at SAMPLE rates. Off: the tool is not offered and a call is
  // refused as unknown, the route answers 404. reportsEnabled must also be on.
  iftaEnabled: boolean;
  // The year-end 1099 report (report_year_end_contractors and
  // /api/reports/year_end_contractors): contractor pay from paid settlements per calendar year,
  // against the 1099-NEC threshold. Nothing is filed. Off: the tool is not offered and a call is
  // refused as unknown, the route answers 404. reportsEnabled must also be on.
  yearEndEnabled: boolean;
  // The review trust meter (report_trust_meter and /api/reports/trust_meter): per action type and
  // pay week, how often a card a person caught as wrong had passed both checks, and whether the
  // record would support exception-only review. Display only: it changes nothing about who
  // approves. Off: the tool is not offered and a call is refused as unknown, the route answers 404.
  // reportsEnabled must also be on.
  trustMeterEnabled: boolean;
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
  // Pay rules from a policy document: a staff member uploads the carrier's driver pay policy (or
  // a sample), Muse Spark reads it into numbered sections and finds each pay rule with the
  // sentence it comes from, code checks every number against that sentence, and one card proposes
  // a new dated version for a person to approve. Off means the routes refuse before anything is
  // stored or read and an approval is refused before anything is written.
  policyOnboardEnabled: boolean;
  // Per run: the file's bytes and PDF pages, each call's cost bound in cents (the wrapper's own
  // spend cap still applies), runs per carrier in any rolling 24 hours, and each call's timeout,
  // short enough that one stage fits in one request.
  policyLimits: {
    maxBytes: number;
    maxPdfPages: number;
    readMaxCostCents: number;
    proposeMaxCostCents: number;
    perTenantPerDay: number;
    readTimeoutMs: number;
    proposeTimeoutMs: number;
  };
  // The pay sweep: checks one open week for every driver, drafts a pay correction for each
  // finding it can fix and lists the rest for a person. It only proposes; a person approves.
  // Off means the Sweep page shows its reason text and the routes refuse before any work.
  sweepEnabled: boolean;
  // The pay sweep opens the pay week holding today when no period holds it, so deliveries after
  // the seeded week draft. Off means the sweep only sweeps a week that already exists
  // (no_open_period once the seeded week has ended and been paid).
  payWeekRoll: { enabled: boolean };
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
  // and the worker, which re-checks it when it claims a run. aiEnabled must also be on. Ships off:
  // no runner is wired on the hosted site, so the page's only action would always refuse.
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
  // The Quarter review at /quarter: the calendar quarter so far (the carrier's own dates), from its
  // pay runs, invoices, payments, the agent's fixes and the detention it found, and "Write the
  // quarter review", which asks Muse Wonder to word those figures in four lists (a button press,
  // never a schedule). Off: the page shows its off state, the route answers 409 and the agent's read
  // tool is not offered. aiEnabled must also be on for the button to reach a model.
  quarterReviewEnabled: boolean;
  quarterReviewLimits: {
    // One review's worst case, checked by the wrapper before the request goes out. The Wonder cap
    // (AI_WONDER_CAP_CENTS) applies on top.
    maxReviewCents: number;
    // The review's output budget, reasoning included.
    maxOutputTokens: number;
    // The figure list the model is given stops here, cut from the bottom (per-driver rows go first).
    maxInputChars: number;
  };
  // Fuel checks: every fill-up held against the truck's tank, the load's route and the driver's
  // day, with a Muse Spark look at two receipt photos of a fill-up turned in twice. It only lists
  // and proposes; a person approves a pay correction on its card. Off means the Fuel checks page
  // is not found, its link is hidden, the routes and the service refuse before any work, no
  // receipt compare is called, and the agent's run_checks leaves fuel findings out. On, a check
  // runs only for the two demo carriers: the run route refuses any other carrier as disabled and
  // run_checks leaves its fuel findings out, because the start date below is the demo weeks'.
  fuelAnomalyEnabled: boolean;
  fuelAnomalyLimits: {
    // Tenant-local date: fill-ups before it are never listed. The release for the demo carriers set
    // it to the first day of the earlier seeded open week (Prairie Wind's, Sunday 2026-10-25), so
    // every planted fill-up lists again after a demo reset; fuel checks only list and propose, and
    // nothing goes outside. It is one date for every carrier, which is why only the demo carriers
    // run the checks; a carrier with real history needs its own go-live date before it can.
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
  // The demo carrier's visitor sign-in (the judge role, migration 0043). A judge reads, asks the
  // agent and proposes, and never approves or pays: every write route outside
  // src/lib/auth/judge-allowlist.ts refuses the role whatever this says. Off means a judge login's
  // password sign-in is refused before any cookie (src/app/sign-in/actions.ts), the sign-in card
  // does not render, its action refuses, and a judge's model calls are refused (no visit, no
  // budget). On, the visit limits below hold in the sign-in (src/app/sign-in/try-demo-action.ts),
  // the spend ledger (src/lib/ai/spend.ts) and the agent turn (src/lib/auth/demo-visit.ts).
  judgeAccess: {
    enabled: boolean;
    // One visit's model spend, in cents (spent plus reserved, demo_sessions).
    sessionCapCents: number;
    // Agent turns one visit may ask.
    turnsPerSession: number;
    // Every visit created in one UTC day, together, in cents.
    dayCapCents: number;
    // New visits from one address in an hour (best-effort: the client can set the address it is
    // counted by, src/lib/auth/demo-visit.ts ipHashOf), from everyone in a rolling hour, and from
    // everyone in a day.
    sessionsPerIpPerHour: number;
    sessionsPerHour: number;
    sessionsPerDay: number;
    // How long the visit's sign-in cookie lasts.
    cookieHours: number;
  };
  // Money codes (Test mode): a one-time code from the simulated fuel-card provider that a driver
  // gives a lumper or a repair shop, charged to the driver's week and reimbursed by the receipt.
  // enabled: the Money codes page, its menu item, the agent's two tools and approving a code; off,
  // the page shows the feature as off, the routes answer 404, the tools are not offered and the
  // kind has no executor. armed, capCents (inclusive: the most one code may be), perDriverPerDay
  // and startDate (YYYY-MM-DD, tenant-local; it gates issuing, never proposing) are asked again on
  // every approval, before the ledger reserves a row and by the issuer itself at the call, on top
  // of payoutsEnabled.
  moneyCodes: {
    enabled: boolean;
    armed: boolean;
    capCents: number;
    perDriverPerDay: number;
    startDate: string;
  };
  // Card check: compares the card provider's statement (Test mode: seeded rows), the bank and the
  // books with our own payment records, lists each difference with a plain sentence and a fix,
  // and drafts a card that matches an unknown card to a driver. Off: the page and menu item are
  // hidden, the routes answer 404, the two agent tools are not offered and an approved match card
  // does nothing. It writes only our own records: never money, never QuickBooks (reads only).
  cardRecon: {
    enabled: boolean;
    limits: {
      // Days back from the carrier's today, in its zone, for statement rows and payment records.
      windowDays: number;
      // Open differences one check keeps; past it the check says how many it left out.
      maxBreaks: number;
      // Payment records read back per outside system in one check; the rest are listed unchecked.
      maxReadBacksPerSystem: number;
      // One read-back's wait; past it the record is unchecked, never resolved.
      readBackTimeoutMs: number;
      // One plain-sentence explanation, in cents.
      maxExplainCents: number;
      // One driver pick for an unknown card, in cents.
      matchMaxCents: number;
      // All model calls of one check together, in cents; past it the sentences are fixed text.
      maxRunCents: number;
      // How long one request works before it answers "still checking" and the page asks again.
      sliceMs: number;
    };
  };
  // The desk loop: one loop per carrier, woken every 15 minutes by the kicker (or "Wake now"),
  // that finds new work in our own tables and hands each piece to the agent that already does it,
  // writing every step to an insert-only log it resumes from. Off: the internal route refuses
  // before reading the key and the wake button refuses. On and not armed: it wakes, finds work and
  // writes "would hand on" lines, and runs nothing. Armed: each handler runs, under its own switch
  // and caps. It never moves money and makes no model call of its own.
  deskLoop: {
    enabled: boolean;
    armed: boolean;
    // Rows created before this day (the carrier's local midnight) are never seen, so history is not
    // worked again.
    startDate: string;
    limits: {
      // How long one wake works before it answers "more" and the kicker asks again.
      sliceMs: number;
      // How long one wake holds the carrier's loop; longer than the route's own 30 s limit.
      leaseMs: number;
      // Pieces of work one wake looks at.
      eventsPerWake: number;
      // Pieces of work one carrier's loop looks at in 24 hours.
      eventsPerDay: number;
      // Tries at one piece of work before it is given up as abandoned.
      maxAttempts: number;
      // Model spend by this carrier since the wake started, in cents; past it the wake stops.
      wakeCents: number;
      // Model spend by this carrier in the last 24 hours, in cents; past it the wake stops.
      dayCents: number;
    };
  };
  // Factoring (Test mode): invoices sold to a simulated factoring partner for cash now, the rest
  // held back until the customer pays. enabled: the Factoring page, its menu item, the agent's
  // three tools and approving a "Factor these invoices" card through the partner; off, the page
  // shows the feature as off, the check route answers 404, the tools are not offered and the card
  // keeps Cash Friday's record-only behavior. armed, maxNetCents (inclusive: the most one request
  // may pay out), requirePacket (refuse an invoice whose rate confirmation, bill of lading or POD
  // is missing) and startDate (YYYY-MM-DD, tenant-local; it gates submitting, never proposing) are
  // asked again on every approval, before the ledger reserves a row, on top of payoutsEnabled. The
  // partner adapter asks enabled, armed, maxNetCents (against the one invoice it is sent) and
  // startDate again itself at each call; it is sent no papers, so requirePacket is the approval's.
  factoring: {
    enabled: boolean;
    armed: boolean;
    maxNetCents: number;
    requirePacket: boolean;
    startDate: string;
  };
  // The "How the models score" card on /models, read from src/lib/eval/results/latest.json. On
  // once a real run was recorded.
  evalCardEnabled: boolean;
  // The model eval script (npm run eval). It runs every case on a fresh local database that it
  // drops after, and only spends model cents on the developer's own ledger, never production's.
  evalRun: {
    enabled: boolean;
    // The most one run may spend, in cents, unless --max-cents asks for less.
    maxRunCents: number;
    // Cents the ledger must still have free after the run's own limit before a run starts.
    reserveCents: number;
  };
  // Fuel and tax rates: a person looks up this week's diesel price or a state's fuel tax rate (one
  // Muse Spark call with web search) and an admin pins one from its linked source. The agent only
  // reads pinned rates (get_pinned_rates); it never looks one up or pins one, and nothing is
  // recalculated, billed or paid from a pin in this release. Off means the Fuel and tax rates page
  // is not found, its link is hidden, the routes and the services refuse before any work, and the
  // read tool is not offered. Local mode may only turn it off: the demo path's tool list must not
  // change.
  groundedRatesEnabled: boolean;
  ratesLimits: {
    // The cap on one lookup call, in cents.
    lookupMaxCostCents: number;
    // Lookups one carrier may start in a rolling day (failed ones count).
    lookupsPerTenantPerDay: number;
    // Web searches one lookup may run (each is billed on top of the tokens).
    maxSearchCalls: 1 | 2 | 3;
  };
  // Verification made explicit (design-agents-102): the sweep checks the checklist it starts with
  // against the steps every run must list (a run whose list differs fails checklist_invalid before
  // any item is written) and records how much of the week its checks covered, with the second
  // opinion's drivers when it ran. Off means today's start and today's updates exactly: nothing
  // reads or writes sweep_runs.coverage. It moves no money, sends nothing and makes no model call.
  // The same switch runs the chat loop's checks inside the submit (design-agents-102 3.2): a card
  // whose citations are not in the record, or whose figure the engine does not recompute to the
  // cent, is refused before it is saved and the agent may revise it; after maxAttempts refused
  // tries of one propose tool (clamped to 1..3) the turn ends and goes to a person. Off means
  // today's prompt, today's loop and today's insert exactly.
  verification: { enabled: boolean; maxAttempts: number };
  // Rate confirmations into proposed loads (docs: RATECON-LOADS). A rate confirmation the first
  // read could not match to a load gets one more model read (src/lib/ratecon/read.ts, at most
  // readMaxCostCents, at most perTenantPerDay new readings per carrier per day) into a strict
  // format; code checks every field and makes a load_create card a person approves, and only the
  // approval's executor writes the load (planned, no driver). It moves no money and sends nothing.
  // A document uploaded before startDate (YYYY-MM-DD, the carrier's zone) never gets a card. Off
  // means the route answers 404, the read refuses before any call, and no executor is registered.
  ratecon: { enabled: boolean; startDate: string; readMaxCostCents: number; perTenantPerDay: number };
  // The phone line (docs: PHONE-LINE): a dispatcher's call with a driver, sent as short segments.
  // Each segment is transcribed (Muse Voice Transcribe, turns split at pauses), screened, and read
  // by one Muse Spark call into a case update per turn; the first advance request or pay question
  // in a segment becomes an ordinary voice note handed to the agent, which only reads and
  // proposes. A person approves on the card. Off means the call routes answer 403 disabled before
  // any read, and receiveSegment and endCall refuse at their top. The hand-off also needs
  // voiceIntakeEnabled, agentEnabled and aiEnabled (handOffVoiceNote checks them itself).
  phoneLineEnabled: boolean;
  phoneLineLimits: {
    // One segment's WAV (16 kHz mono PCM): 30 seconds is 960,044 bytes.
    maxSegmentBytes: number;
    // Longer segments are refused before anything is stored. Also the duration_ms CHECK in
    // migration 0068: raise both together.
    maxSegmentMs: number;
    // Segments one call may send (seq runs 0 to this less one): 120 is an hour of 30 s segments.
    maxSegmentsPerCall: number;
    // A call older than this takes no more segments.
    maxCallMs: number;
    // Calls one carrier may start in one of its local days, counted apart from voice notes.
    callsPerDay: number;
    // Turns one call may hand to the agent; later ones are recorded and not handed off.
    maxHandOffsPerCall: number;
    // The cap on one segment's case-update call, in cents.
    maxUpdateCents: number;
    // A call with no segment for this long takes no more (the next segment answers not_open).
    idleEndMs: number;
  };
  // Escrow release (Test mode, docs: ESCROW-RELEASE): a terminated driver's escrow balance goes
  // back to the driver by a bank payout to the one Stripe test connected account, once a person
  // approves the agent's card. enabled: the due list and statement tools, the propose tool, the
  // due route, the check route (reads back a payout whose outcome is unknown) and the kind's
  // executor; off, both routes answer 403 disabled, the tools are not offered and the kind has no
  // executor. armed, capCents (inclusive: the most one release may be) and startDate
  // (YYYY-MM-DD, tenant-local) are asked by the propose tool, again by the precheck, by the
  // executor before the release row is written and at the reserve, on top of payoutsEnabled.
  // Nothing is emailed: a driver due for release is only listed.
  escrowRelease: { enabled: boolean; armed: boolean; capCents: number; startDate: string };
  // Autopilot (src/lib/autopilot): the owner's rule per action kind (Off, Ask me, Auto within
  // limits, autopilot_rules) lets the carrier's autopilot login approve a proposal with no click,
  // only after the gateway, the rules engine's recompute (matched) and the auditor's pass, and
  // only inside the limits. The model never decides: a pure policy in code does. enabled: the desk
  // source, its handler and the pause route; off, nothing is found and nothing is approved. armed:
  // off, nothing is approved and no decision is written. startDate (YYYY-MM-DD, tenant-local): a
  // proposal made before it is never approved by the autopilot. kinds: the only kinds that may
  // ever be on Auto, each with a ceiling (inclusive, whole cents) over the owner's own limits; a
  // kind not listed stays with a person whatever its rule says. A listed kind is approved only
  // while its own armed is on too (each money kind is armed in its own release); an unarmed kind is
  // never found, decided or approved, and its proposals wait for a person. enabled, armed, startDate
  // and the ceilings are read by the desk handler and again by the approval gate, inside the
  // transaction that approves.
  autopilot: {
    enabled: boolean;
    armed: boolean;
    startDate: string;
    kinds: Partial<
      Record<"invoice_post" | "card_match" | "payment_reapply" | "advance_payout" | "money_code", AutopilotCeiling>
    >;
  };
  // The autopilot's rules from the app (docs: AUTOPILOT-RULES, D-094, 0089): Settings > Autopilot
  // shows each kind's Off, Ask me or Auto rule, its limits and the pause, and an admin saves a rule
  // there (GET and POST /api/autopilot/rules, src/lib/autopilot/rules-admin.ts). A save is refused
  // when it sets Auto on a kind a named person always approves, or a limit above the kind's ceiling
  // in autopilot.kinds (raising a ceiling stays its own PR). Every save and every Pause or Resume is
  // recorded in autopilot_changes in the same transaction. A saved rule only decides proposals not
  // yet decided; nothing here approves or moves money. The page and both routes ask enabled
  // themselves; the pause route stays on autopilot.enabled. It ships off.
  autopilotRules: { enabled: boolean };
  // Load movement from driver evidence (docs: LOAD-MOVEMENT, owner D-056): a load moves planned to
  // in transit once its pickup bill of lading is read in, and in transit to delivered once its
  // proof of delivery is (src/lib/loads/paperwork.ts decides from the stored reads, no model), or
  // once a driver's text or voice note names the whole load number and says so. Code writes the
  // status and one load_events row in one transaction; any case it cannot decide is a load_move
  // card a person taps. No money moves and nothing is sent. Every automatic path (the desk loop's
  // document source and its inbound message and voice note sources) asks enabled and startDate
  // (YYYY-MM-DD, the carrier's zone: evidence from before it never moves a load) itself, and the
  // load_move executor is registered only while enabled. A person's Mark picked up and Mark
  // delivered buttons and Settings > Demo's Move the fleet are people's presses and do not read it.
  loadMovement: { enabled: boolean; startDate: string };
  // The dispatch mirror (docs: TMS-MIRROR, 0075, owner D-071): a read-only copy of the tenant's
  // dispatch system (a TMS), walked by the desk loop at the top of each wake (src/lib/tms/sync.ts):
  // at most maxPagesPerWake list pages of pageSize rows and maxReadsPerWake full reads a wake.
  // Nothing is ever written to the TMS. A mirrored status event moves one of our loads only through
  // src/lib/loads/movement.ts, and only while loadMovement is on too; an event dated before
  // startDate (YYYY-MM-DD, the carrier's zone) is mirrored and never moves or asks. Settings >
  // Demo's Sync dispatch now re-checks enabled itself. demoFaultsEnabled lets the synthetic feed
  // play the faults a carrier switches on in tms_connections.demo_faults
  // (src/lib/adapters/tms-source/faults.ts), from Settings > Demo's Dispatch faults panel (admins
  // only) and POST /api/demo/tms-faults; the feed, the store and the route each re-check it, and
  // the sync never knows a fault exists. It ships off.
  tmsSync: {
    enabled: boolean;
    startDate: string;
    maxPagesPerWake: number;
    maxReadsPerWake: number;
    pageSize: number;
    demoFaultsEnabled: boolean;
  };
  // The dispatch system's webhook (docs: TMS-MIRROR T4, 0083, owner D-071): POST
  // /api/internal/tms-hook/<tenant>?token=<key> is a wake-up only. It reads two fields of the body
  // (record type and external id), keeps one tms_wakeups row per record while it waits, and wakes
  // the desk by 'webhook' under the loop's own lease; the next sync re-reads those records in full
  // first. Nothing in the payload is trusted for content. At most hookPerMinute calls a minute are
  // taken per carrier, then 429 (the wake-up is still kept, once). The route answers 409 unless
  // enabled and tmsSync.enabled are both on, and reads the key (TMS_HOOK_KEY_SECRET_NAME) only
  // after both. Settings > Demo's "Fire a wake-up twice" needs it too. It ships off; its own
  // one-line PR turns it on, after the owner stores the key.
  tmsHook: { enabled: boolean; hookPerMinute: number };
  // The sample dispatch system (docs: MOCK-TMS, 0088, owner D-087): /tms-demo, a plain stand-in for
  // a carrier's TMS on the demo carriers, where a person moves a seeded load through its statuses
  // (assign a driver, complete a stop, set a status) and each change writes one history row. The
  // desk reads it only through the read-only `mock` dispatch source, exactly as it would read a
  // real one; each change also calls our own webhook route over HTTP with the stored key (it needs
  // tmsHook and tmsSync on). While on, the seed and the demo reset put the demo carriers'
  // connection on it. At most maxEventsPerLoad history rows a load. It moves no money and sends
  // nothing anywhere else. It ships off; its own one-line PR turns it on.
  // newLoad: a "New load" form there (/tms-demo/loads/new) writes the sample system's load AND our
  // planned load with the same number, in one transaction, so the desk links the two on its next
  // read. It writes no money. At most maxNewLoads loads a carrier made there (the seeded board does
  // not count); a demo reset removes them. It needs enabled on too, and ships off on its own.
  mockTms: { enabled: boolean; newLoad: boolean; maxEventsPerLoad: number; maxNewLoads: number };
  // The invoice on finalize (docs: TMS-MIRROR, S3): when a mirrored status event says the dispatch
  // system finalized one of our delivered loads, the desk loop's tms_event source drafts that load's
  // one invoice_post card from our own loads row, the same card Refresh on the invoice queue drafts
  // (src/lib/invoices/finalize.ts), never from the dispatch system's revenue. It only drafts: the
  // owner's limit mode decides between a question and the autopilot, and approving it is the usual
  // route and gate. It acts only while tmsSync, loadMovement and invoicesEnabled are on too; an
  // event dated before startDate (YYYY-MM-DD, the carrier's zone) drafts nothing. The hook asks
  // enabled and startDate itself. It ships off; its own one-line PR turns it on.
  tmsFinalizeInvoice: { enabled: boolean; startDate: string };
  // The agent's questions (src/lib/asks, 0072): when the desk drafts a proposal of an asked kind
  // (advance_payout, invoice_post, detention_charge, settlement_approve, pay_correction, load_move)
  // and the autopilot would not do it by itself, code writes one question about it ("Should I send
  // Dana Reyes the 70% advance, $1,400.00?"); after the autopilot did one, a told line. Yes goes
  // through the usual approve route and gate. enabled: the questions are written, the asks route
  // and the snooze route answer, and the thread shows them; off, nothing is written and both routes
  // answer 409 asks_off. reasonEnabled: the desk's pass adds Muse Spark's one reason line beside a
  // question (caller ask_reason), at most reasonMaxCostCents and reasonMaxOutputTokens a call, one
  // try per question, at most reasonsPerWake calls a wake; a line naming any dollar figure but the
  // engine's is dropped. listLimit: the most questions one read of the asks route returns.
  agentAsks: {
    enabled: boolean;
    reasonEnabled: boolean;
    reasonMaxCostCents: number;
    reasonMaxOutputTokens: number;
    reasonsPerWake: number;
    listLimit: number;
  };
  // The advance at pickup (docs: ADVANCE-AT-PICKUP): when a load moves to in transit and its
  // carrier's advances unlock at pickup (pay_configs.advance_unlock_stage, 0073), the desk loop's
  // load_event source drafts one advance_payout card for the load's driver, at the amount the
  // rules engine suggests (src/lib/advances/at-pickup.ts). It only drafts: the card is approved by
  // a person, the advance payout switches and money_armed still apply, and nothing is paid here.
  // The handler asks enabled and startDate (YYYY-MM-DD, the carrier's zone: a move recorded
  // before it drafts nothing) itself.
  advanceAtPickup: { enabled: boolean; startDate: string };
  // The card load ruling (docs: CARD-LOAD-RULING): a fuel card load on the card statement with no
  // payment record behind it gets one card_load_ruling card from the desk loop's card_transaction
  // source. A record is any money_actions row but a failed one that fuel_card_sim settled naming
  // the load's id, any row still reserved, sent or unknown whose request id makes that load id, or
  // any such unsettled row on an advance paid to the load's card (ledgerRecordSql in
  // src/lib/card-loads/facts.ts): a payout in flight or unconfirmed is never "no record". A
  // named person rules on the card: Yes books a deficit for the full load amount, an edit to
  // owes_nothing records the ruling with none (src/lib/card-loads/ruling.ts, the executor in
  // src/lib/proposals/executors/card-load-ruling.ts). Never the autopilot's. The agent only reads
  // the loads (get_card_loads). startDate (YYYY-MM-DD, the carrier's zone): a statement row that
  // reached the records before it drafts nothing. Each path asks enabled itself.
  cardLoadRuling: { enabled: boolean; startDate: string };
  // Parked advances (touchpoint A5): a person's approval of an advance whose numbers no longer
  // hold when it runs (the card is gone, the card statement names someone else, no room is left,
  // or the approval went over a block or a mismatch) parks the advance with its reason instead of
  // failing the proposal (src/lib/advances/approve.ts). A person approves it again to pay it, the
  // same ledger key it would have had, or rejects it. Never the autopilot's: it never parks,
  // releases or approves a parked advance. startDate (YYYY-MM-DD, the carrier's zone): a proposal
  // made before it takes the old fail path. Each path asks enabled itself.
  advanceParking: { enabled: boolean; startDate: string };
  // The card pull-back (docs: RECOVERY, 0080): taking back a paid advance, or money loaded onto the
  // card of a driver whose truck broke down before the trip, pulls it back off the fuel card in test
  // mode once a person approves a card_pullback card. The rules engine sizes the pull from our own
  // records (src/lib/rules-engine/pullback.ts): confirmed loads and hand loads on the card, less
  // its fuel and earlier pulls, shown as the balance as of the newest statement day. A breakdown
  // pull the card cannot cover books the rest as a named deficit; a take-back the card cannot cover
  // stays owed on the advance. Staff approve up to approverRole.adminAboveCents, an admin above;
  // never the autopilot's. Needs payoutsEnabled and advanceTakeback.enabled too. startDate
  // (YYYY-MM-DD, the carrier's zone): a card made before it is refused. Each path asks enabled
  // itself: the propose tool, the take-back, the gate, the executor, the ledger hooks, the
  // simulated card provider and the Check route.
  cardPullback: { enabled: boolean; startDate: string };
  // Named stub lines (docs: design-s8, 0084): a staff member puts one reimbursement or deduction on
  // a driver's open draft paystub that cites one fuel purchase or load accessorial of that driver,
  // with their name on it (POST /api/settlements/[id]/lines, src/lib/settlements/named-line.ts). It
  // is written as a pay item and the rules engine makes the line, so the amount must equal the
  // record's at entry, and the pre-pay recheck compares every typed line with its record again at
  // every approval, and every insurance line's days with the day rows it cites
  // (src/lib/settlements/contradiction.ts): a difference parks the paystub as contradicting_line.
  // Moves no money. Asked by the route, the service and the recheck, each itself; off, the recheck
  // still compares a typed line already stored with its record (a rollback never skips that) and
  // only the insurance rule stops. The agent's explain_paystub shows the verdict only while it is
  // on, and null (not checked) while off. No start date: a line can only be typed
  // after the release, on an open draft.
  namedLines: { enabled: boolean };
  // Stub sent (docs: design-s10, 0086): a staff member records that they sent a driver's paid
  // paystub to the driver, when and who (POST /api/settlements/[id]/stub-sent,
  // src/lib/settlements/stub-sent.ts, and the "Mark stub sent" button on the record page). A click
  // is the only way a mark is made; nothing is ever sent by the app. Asked by the route, the
  // service and the page's button. Reading a mark already made is not switched: a fact a person
  // recorded stays visible after a rollback. No start date: a mark can only be made by a click
  // after the release.
  stubSent: { enabled: boolean };
  // Deficit recovery on pay day (docs: RECOVERY, 0080): a driver's named deficits (a card load
  // ruled owed, a pull-back the card could not cover) are taken back from pay after the advances,
  // oldest first, above the net pay floor and within the same advanceRecoveryCapCents, one cap on
  // everything recovered from a stub (src/lib/rules-engine/recovery.ts). A part taken stays owed on
  // the deficit for the next week. The engine reads no switch: the settlement input carries the
  // deficits only while enabled is on (src/lib/data/read.ts), and booking a paid stub that holds
  // deficit lines is refused while it is off (src/lib/settlements/book.ts), so a flip never
  // half-books: a stub approved while it was on and booked after a flip to off waits not_booked
  // until the switch is back on. startDate (YYYY-MM-DD, the carrier's zone): a period ending before it recovers
  // nothing, so turning it on never rewrites an old stub. The agent reads deficits with
  // get_driver_deficits only while it is on.
  deficitRecovery: { enabled: boolean; startDate: string };
  // Driver admin (docs: design-d1-drivers 5.1): an admin adds a driver on the Add driver page
  // (src/lib/drivers/create.ts, POST /api/drivers). A new driver starts not armed and with no
  // card, so no money can go to them until an admin adds a card and arms them on their page. The
  // same switch covers deactivating and reactivating a driver on their page
  // (src/lib/drivers/status.ts, POST /api/drivers/[id]/status, 5.3): deactivating disarms them in
  // the same transaction, reactivating never arms. The money gates refuse a driver past their last
  // day whatever this switch says. Moves no money. The pages, the routes and the services each
  // ask enabled themselves.
  driverAdmin: { enabled: boolean };
  // The activation checklist (docs: design-s9, 0085): before an admin arms a driver who is not
  // armed, three steps are on record with a person's name for the driver's default card
  // (driver_activation_steps): identity confirmed against the card on file, a zero-dollar test sent
  // to it, and its loads acknowledged (POST /api/drivers/[id]/activation-steps,
  // src/lib/advances/activation.ts). Code refuses the arm while a step is missing, while the card's
  // statement names someone else, or while a load on the driver's cards has no record and no
  // ruling. Only the false-to-true arm reads it: a driver armed today stays armed. Moves no money.
  // Asked by the route, the service and armDriver, each itself; off, arming is exactly as before
  // and the agent's get_driver_identity shows activation null. No start date: it only ever refuses
  // an arm.
  activationChecklist: { enabled: boolean };
  // The cancelled trip (docs: RECOVERY, 0080): a person may cancel a planned or in-transit load
  // (POST /api/loads/[id]/move with to "cancelled", or a load_move card from the dispatch sync's
  // withdrawn status, approved), and the desk then drafts one deficit_book card per paid advance
  // still owed on that load (src/lib/deficits/cancelled-trip.ts). A person approves the card; the
  // approval closes the advance line and books the same cents as a named deficit in one
  // transaction, so the driver owes them once. Nothing moves money. Read on every path that writes:
  // the staff move, the load-move executor, the route, the desk handler and the deficit executor.
  // The deficit card is drafted and approved only while deficitRecovery.enabled is on too, since
  // only then does pay take a deficit back. Off, a cancel is refused as validation, as before. startDate (YYYY-MM-DD, the carrier's zone):
  // a cancel recorded before it drafts nothing, so turning it on never reaches back.
  cancelledTrip: { enabled: boolean; startDate: string };
  // The morning digest (docs: S7, 0082): at 06:00 the carrier's local time the desk reads about ten
  // facts from SQL (src/lib/digest/facts.ts: what needs a person, what happened yesterday, the
  // billing lines, Fridays the week's paystubs, the 1st last month's tie-out counts), Muse Spark
  // words them into one line of at most 400 characters, every number checked against the facts,
  // and the line shows in the agent's ask card. A failed call or a refused number lands a line code
  // wrote from the same facts instead; a fact that could not be read says "not read", never 0.
  // Sends nothing and moves no money. startDate (YYYY-MM-DD, the carrier's zone): no day before it
  // is digested. maxCostCents and maxOutputTokens cap the one model call per carrier per day. The
  // desk's handler and the writer each ask enabled themselves.
  morningDigest: { enabled: boolean; startDate: string; maxCostCents: number; maxOutputTokens: number };
};

// One kind's ceiling over the owner's autopilot limits: one item, and the carrier's local day.
// driverDayMaxCents: one driver's local day, on a kind that pays a driver (advance_payout,
// money_code), where it is required. armed: whether the autopilot may approve this kind at all.
export type AutopilotCeiling = {
  maxCents: number;
  dayMaxCents: number;
  dayMaxCount: number;
  driverDayMaxCents?: number;
  armed: boolean;
};

export const flags: Flags = {
  aiEnabled: true,
  aiJobHourlyCapCents: 1000,
  aiProofRoute: false,
  triageProvider: "baseten",
  sparkOpenFallback: "off",
  payoutsEnabled: true,
  paymentProvider: "stripe_test",
  accountingEnabled: true,
  inboundEmailEnabled: true,
  screenOutputMode: "text",
  gatewayLimits: {
    payCorrectionMaxCents: 50_000,
    invoiceFixMaxCents: 250_000,
    detentionChargeMaxCents: 100_000,
    ruleChangeImpactMaxCents: 500_000,
  },
  agentEnabled: true,
  agentFocusEnabled: true,
  agentStreamMode: "sse",
  runLimits: {
    maxTurns: 30,
  },
  stepThrough: { dev: true, staff: true },
  agentTurnLimits: {
    maxToolSteps: 6,
    maxModelCalls: 6,
    maxTurnCents: 40,
    wallClockMs: 22_000,
    summaryChars: 10_000,
  },
  proposalMaxAgeDays: 7,
  auditorEnabled: true,
  auditorStart: "2026-10-27T00:00:00Z",
  auditorRequired: true,
  verifyEngineMismatchBlocks: true,
  approverRole: { adminAboveCents: 200_000 },
  documentsEnabled: true,
  documentCrop: true,
  documentLimits: { maxBytes: 700_000, maxPdfPages: 3, readMaxCostCents: 8, perTenantPerDay: 20 },
  documentMarkupEnabled: true,
  markupLimits: { editMaxCostCents: 2, checkMaxCostCents: 4, perTenantPerDay: 10, maxBytes: 700_000 },
  advancesEnabled: true,
  advancePayouts: { armed: true, capCents: 50_000, startDate: "2026-10-29" },
  advancesLimits: { proposalsPerDay: 30, maxPayoutAttempts: 3, legTwoMinRemainingMs: 12_000 },
  advanceTakeback: { enabled: true, maxCents: 100_000 },
  agentToolSearch: true,
  agentPromptCache: { enabled: true, retention: "in_memory" },
  driverNotesEnabled: true,
  driverNotesEmailEnabled: false,
  driverNotesEmailAllowlist: [],
  driverNotesEmailFrom: "2026-10-27",
  driverNoteLimits: { maxNoteCents: 3, maxBatchCents: 60, maxOutputTokens: 400 },
  payCardsEnabled: true,
  payCardLimits: { checkMaxCostCents: 3, maxBatchCents: 40, cardsPerTenantPerDay: 100, maxPngBytes: 400_000 },
  reportsEnabled: true,
  iftaEnabled: true,
  yearEndEnabled: true,
  trustMeterEnabled: true,
  invoicesEnabled: true,
  invoicesStart: "2026-10-05",
  invoiceLimits: { proposalsPerRun: 50, maxPostAttempts: 3 },
  customerPaymentsEnabled: true,
  customerPaymentLimits: { perDay: 50, maxCents: 5_000_000 },
  clipsEnabled: true,
  clipLimits: {
    bytes: 700_000,
    durationMs: 20_000,
    frames: 600,
    redactMaxCostCents: 13,
    readMaxCostCents: 10,
    perTenantPerDay: 20,
  },
  inboxEnabled: true,
  inboxLimits: { messagesPerDay: 50, maxChars: 20_000, maxAttempts: 3 },
  voiceIntakeEnabled: true,
  voiceLimits: { maxWavBytes: 2_000_000, maxOriginalBytes: 700_000, maxDurationMs: 60_000, voiceNotesPerDay: 20 },
  detentionEnabled: true,
  demoResetEnabled: true,
  rulesByTalkingEnabled: true,
  policyOnboardEnabled: true,
  policyLimits: {
    maxBytes: 700_000,
    maxPdfPages: 3,
    readMaxCostCents: 10,
    proposeMaxCostCents: 6,
    perTenantPerDay: 5,
    readTimeoutMs: 25_000,
    proposeTimeoutMs: 20_000,
  },
  sweepEnabled: true,
  payWeekRoll: { enabled: true },
  sweepScheduleEnabled: true,
  payCorrectionsEnabled: true,
  sweepLimits: { maxItems: 40, maxRunCents: 150, maxExplainCents: 5, sliceMs: 20_000, maxAuditAttempts: 3 },
  fanoutEnabled: true,
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
  cashFridayEnabled: true,
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
  settlementsEnabled: true,
  settlementsStart: "2026-10-05",
  settlementLimits: { driversPerRun: 200, maxPayoutAttempts: 3, legTwoMinRemainingMs: 12_000 },
  batchApproveEnabled: true,
  batchLimits: { maxItems: 50, maxTotalCents: 10_000_000, drainBudgetMs: 22_000 },
  invoiceReviewEnabled: true,
  collectionsEnabled: true,
  collectionsEmailEnabled: false,
  collectionsEmailAllowlist: [],
  collectionsEmailFrom: "",
  collectionsLimits: { maxDraftCents: 2, maxRunCents: 40, maxOutputTokens: 500, maxDraftsPerRun: 12, minDaysLate: 30 },
  profitBriefEnabled: true,
  profitBriefLimits: { maxBriefCents: 6, maxOutputTokens: 700, maxLanes: 10, maxCustomers: 12 },
  carrierMemoryEnabled: true,
  carrierMemoryLimits: { maxNotesPerTurn: 8, maxPromptChars: 1600, maxNoteChars: 300, maxNotesPerCarrier: 500 },
  carrierMemoryAgentLimits: { maxSuggestionsPerTurn: 2, maxSuggestionsWaiting: 20, maxAuditorNotes: 4 },
  quarterReviewEnabled: true,
  quarterReviewLimits: { maxReviewCents: 30, maxOutputTokens: 1600, maxInputChars: 40_000 },
  fuelAnomalyEnabled: true,
  fuelAnomalyLimits: {
    from: "2026-10-25",
    duplicateWindowMinutes: 60,
    chargebackMaxCents: 50_000,
    compareMaxCostCents: 5,
    compareMaxOutputTokens: 200,
    comparesPerRun: 10,
    comparesPerTenantPerDay: 20,
  },
  judgeAccess: {
    enabled: true,
    sessionCapCents: 100,
    turnsPerSession: 25,
    dayCapCents: 800,
    sessionsPerIpPerHour: 5,
    sessionsPerHour: 40,
    sessionsPerDay: 150,
    cookieHours: 2,
  },
  moneyCodes: { enabled: true, armed: true, capCents: 50_000, perDriverPerDay: 2, startDate: "2026-10-28" },
  cardRecon: {
    enabled: true,
    limits: {
      windowDays: 14,
      maxBreaks: 50,
      maxReadBacksPerSystem: 40,
      readBackTimeoutMs: 5_000,
      maxExplainCents: 3,
      matchMaxCents: 3,
      maxRunCents: 100,
      sliceMs: 20_000,
    },
  },
  deskLoop: {
    enabled: true,
    armed: true,
    startDate: "2026-10-30",
    limits: {
      sliceMs: 20_000,
      leaseMs: 55_000,
      eventsPerWake: 20,
      eventsPerDay: 300,
      maxAttempts: 3,
      wakeCents: 60,
      dayCents: 400,
    },
  },
  factoring: { enabled: true, armed: true, maxNetCents: 2_500_000, requirePacket: false, startDate: "2026-10-28" },
  evalCardEnabled: true,
  evalRun: { enabled: false, maxRunCents: 1_500, reserveCents: 4_000 },
  groundedRatesEnabled: true,
  ratesLimits: { lookupMaxCostCents: 5, lookupsPerTenantPerDay: 20, maxSearchCalls: 2 },
  verification: { enabled: true, maxAttempts: 3 },
  ratecon: { enabled: true, startDate: "2026-10-30", readMaxCostCents: 8, perTenantPerDay: 20 },
  phoneLineEnabled: true,
  phoneLineLimits: {
    maxSegmentBytes: 1_000_000,
    maxSegmentMs: 30_000,
    maxSegmentsPerCall: 120,
    maxCallMs: 3_600_000,
    callsPerDay: 20,
    maxHandOffsPerCall: 3,
    maxUpdateCents: 3,
    idleEndMs: 600_000,
  },
  escrowRelease: { enabled: true, armed: true, capCents: 500_000, startDate: "2026-10-30" },
  autopilot: {
    enabled: true,
    armed: true,
    startDate: "2026-10-31",
    kinds: {
      invoice_post: { maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, armed: true },
      card_match: { maxCents: 50_000, dayMaxCents: 300_000, dayMaxCount: 40, armed: true },
      payment_reapply: { maxCents: 200_000, dayMaxCents: 1_000_000, dayMaxCount: 25, armed: true },
      advance_payout: { maxCents: 30_000, dayMaxCents: 150_000, dayMaxCount: 10, driverDayMaxCents: 30_000, armed: false },
      money_code: { maxCents: 15_000, dayMaxCents: 60_000, dayMaxCount: 4, driverDayMaxCents: 30_000, armed: false },
    },
  },
  // On by the owner's call (D-071, D-094, 2026-11-02). It changes only the owner's rules and their record.
  autopilotRules: { enabled: true },
  // On by the owner's call (D-071, 2026-10-31). A load_move card is still a person's tap.
  loadMovement: { enabled: true, startDate: "2026-10-30" },
  // On by the owner's call (D-071, 2026-10-31). A load moves on it only while loadMovement is on too.
  tmsSync: {
    enabled: true,
    startDate: "2026-10-31",
    maxPagesPerWake: 3,
    maxReadsPerWake: 20,
    pageSize: 100,
    // On by the owner's call (D-071, 2026-10-31): the panel shows; every fault itself starts off.
    demoFaultsEnabled: true,
  },
  // On by the owner's call (D-071, 2026-11-01), after the owner stored payday-copilot/tms-hook-key.
  // A wake-up only: it reads, never writes to the dispatch system, and moves no money.
  tmsHook: { enabled: true, hookPerMinute: 60 },
  // On by the owner's call (D-071, D-087, 2026-11-01): the demo carriers' sample dispatch system. It
  // changes only its own tables and moves no money. 36 history rows a load stay readable with the
  // history_page_cut fault on (the sync reads at most MAX_HISTORY_PAGES pages of CUT_PAGE new rows,
  // the last one empty).
  // newLoad: on by the owner's call (D-071, D-089, 2026-11-01): staff and demo visitors may create at
  // most maxNewLoads loads a carrier there, each linked to our planned load; the demo reset clears them.
  mockTms: { enabled: true, newLoad: true, maxEventsPerLoad: 36, maxNewLoads: 40 },
  // On by the owner's call (D-071, 2026-10-31). It only drafts a card; approving it goes through the usual gate.
  tmsFinalizeInvoice: { enabled: true, startDate: "2026-10-31" },
  // On by the owner's call (D-071): Yes still goes through the usual approve route and gate.
  agentAsks: {
    enabled: true,
    reasonEnabled: true,
    reasonMaxCostCents: 2,
    reasonMaxOutputTokens: 80,
    reasonsPerWake: 3,
    listLimit: 5,
  },
  // On by the owner's call (D-071): it only drafts a card; approving it goes through the usual gate.
  advanceAtPickup: { enabled: true, startDate: "2026-10-31" },
  // Off until its own one-line enable PR. Nothing moves money: a ruling books what a driver owes.
  cardLoadRuling: { enabled: true, startDate: "2026-10-31" },
  // On by the owner's call (D-071, 2026-10-31). Parking moves no money; a release pays through the
  // usual ledger and payout switches.
  advanceParking: { enabled: true, startDate: "2026-11-02" },
  // Off until its own one-line enable PR. A pull is an outside write, in test mode only.
  cardPullback: { enabled: false, startDate: "2026-11-02" },
  // On by the owner's call (D-071, 2026-11-01). A typed line changes what an approval pays.
  namedLines: { enabled: true },
  // On by the owner's call (D-071, 2026-11-01). A mark records a person's send; nothing is sent.
  stubSent: { enabled: true },
  // On by the owner's call (D-071, 2026-11-01). Pay math only; nothing moves money on its own.
  deficitRecovery: { enabled: true, startDate: "2026-11-02" },
  // On by the owner's call (D-074, D-077, 2026-11-01). Adds a driver (not armed, no card),
  // deactivates (disarms) and reactivates (never arms) one; moves no money.
  driverAdmin: { enabled: true },
  // On by the owner's call (D-071, 2026-11-01). Only refuses an arm; nothing is paid or sent.
  activationChecklist: { enabled: true },
  // On by the owner's call (D-056, D-077, 2026-11-01). A person cancels and a person approves the
  // deficit; the autopilot never approves it.
  cancelledTrip: { enabled: true, startDate: "2026-11-02" },
  // On by the owner's call (D-071, 2026-11-01). One model call per carrier per day; sends nothing.
  morningDigest: { enabled: true, startDate: "2026-11-02", maxCostCents: 4, maxOutputTokens: 400 },
};

applyLocalOverrides(flags);

// Whether the trace panel offers "Step through", read on the server and handed to the page: in a
// development or test run while dev is on, and anywhere else (production) only once staff is on.
// An unset or unknown NODE_ENV counts as production.
export function stepThroughShown(
  f: Pick<Flags, "stepThrough"> = flags,
  env: { NODE_ENV?: string } = process.env,
): boolean {
  const dev = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  return f.stepThrough.staff || (f.stepThrough.dev && dev);
}
