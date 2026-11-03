# LedgerLine: the AI back office for trucking carriers

An AI operator for a trucking carrier's money desk. It takes driver advance requests, invoices
delivered loads, runs weekly settlements and payouts, and records every step in QuickBooks Online.
Meta models read each request, check it against the rules, explain every exception and propose
the action. A person approves, or the owner's own autopilot rules do inside limits the owner sets;
the engine executes.

Built from scratch for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026), Indie track,
"Build for Your World" theme.

Runs with no outside account: press "Try the demo carrier" on the hosted sign-in page, or run
`npm run e2e` locally (a local Postgres only), where the models answer from a recording. See
[Try it](#try-it).

## Trucking pay in one week

A trucking company is paid by customers to haul loads, and it pays the drivers who haul them. Money
in: a delivered load becomes a customer invoice. Money out: every Friday, each driver's week becomes
a paystub. Monique's week at Blue Ridge Freight Lines, a fictional carrier in the demo: three loads
$2,400.00, fuel and tolls back $180.00, an advance taken Wednesday -$200.00, insurance for five days
-$55.00, escrow -$100.00, net pay $2,225.00. The numbers live in the dispatch system, the fuel cards,
text messages, spreadsheets and QuickBooks. One advance logged twice leaves her $200.00 short.
LedgerLine reads all of it, finds the problems, explains each one and proposes the fix. A person
approves it, or an autopilot rule the owner set approves it inside that rule's limits. Only then is
anything paid or sent.

The app tells the same story, line by line, on its public page `/help/how-pay-works` (no sign-in).

## Safety by design

Every agent action is checked before it can touch money: the gateway lets the agent read and
propose, never execute; the rules engine recomputes every number in integer cents; Muse Wonder
audits the proposal in a fresh context; then it is approved, by a person or by the owner's autopilot
policy (see Autopilot below), checked in code and never by a model. Every untrusted input (a driver's
message, a document, a voice note, a web page) is screened on Muse Spark Open before the agent
reads it. Every outside write targets test mode or the QuickBooks sandbox; a production key is
refused at startup. A ledger row is reserved before any call, so the same event can never pay
twice. A demo visitor (the "Try the demo carrier" button on the sign-in page) can ask the agent and
propose but never approve, pay, post or send.

## Built on open weights

Muse Spark Open, served through Baseten, runs the jobs that see every untrusted
byte first: input screening on every message, document and voice note the agent reads, and the
broker portal's answer screen. Triage runs on it too: it sorts every driver message and voice note
into a case (one switch moves triage back to Muse Spark). It is cheap, fast, and can run on a
carrier's own hardware, which matters for a shop that will not send its pay data to a cloud model.
Its screening and triage scores are in the next section.

## How the models score

Each operator model takes the same 28 cases: 26 planted pay, payment, fuel and detention problems
on the two invented carriers, plus 2 planted injection attempts. Each model gets its own freshly
seeded database; every case runs through the real operator turn and the real second check, and is
scored from the tables by fixed rules. `npm run eval` writes `src/lib/eval/results/latest.json`;
`npm run eval:readme` copies it here.

<!-- eval:start -->
Run on the seed of 2026-11-02, every case. The second check runs on `muse-wonder-1.0` in every row.

| Operator model | Cases scored | Right answer | Right amount | Right fix | Seconds per case | Cents per case | Cents in all |
|---|---|---|---|---|---|---|---|
| Muse Spark (as shipped) (`muse-spark-1.3`) | 26 of 30 | 15 of 24 | 12 of 16 | 20 of 24 | 13.5 | 7.51 | 225.27 |
| Muse Wonder (`muse-wonder-1.0`) | 30 of 30 | 17 of 28 | 13 of 20 | 21 of 28 | 9.3 | 8.03 | 240.80 |
| Muse Spark Open (`meta-models/muse-spark-open-1026`) | 30 of 30 | 12 of 28 | 10 of 20 | 19 of 28 | 9.2 | 2.80 | 83.78 |

When the operator and the second check agreed they were right 30 of 31 times; when they disagreed the second check was right 0 of 0 times.

Muse Spark (as shipped): the screen flagged the planted messages 2 of 2 times; no change was proposed from them 2 of 2 times.
Muse Wonder: the screen flagged the planted messages 2 of 2 times; no change was proposed from them 2 of 2 times.
Muse Spark Open: the screen flagged the planted messages 2 of 2 times; no change was proposed from them 2 of 2 times.

Muse Spark Open screening (`meta-models/muse-spark-open-1026`): 12 of 12 inputs sorted right (flagged or clean as planted).
Muse Spark Open triage (`meta-models/muse-spark-open-1026`): category 25 of 26, amount 24 of 24, dates 14 of 14, driver 14 of 14.
<!-- eval:end -->

The cents columns cover the scored cases only. The whole run cost 614.37 cents: Muse Spark's 4 cases
that ran out of time kept 52.98 cents of reserved spend, and Muse Spark Open's screening and triage
calls added 11.55 cents.

In the app, every pay sweep prints the live version: how many drivers were checked a second time
and how many of the engine's problems the second check also found.

## Meta models in this project

Each model below is reached through one wrapper (`src/lib/ai/`) with a hard spend cap, and every
model call writes one ledger row with its model, usage, latency and cost. The jobs are what each
model does here.

| Model | Job in LedgerLine |
|---|---|
| **Muse Spark 1.3** | The operator agent: calls tools over drivers, loads, pay items and the rules engine, returns structured proposals, and reads receipts, bills of lading and rate confirmations from photos and PDFs |
| **Muse Wonder** | The auditor: independently re-checks every money proposal before a person can approve it |
| **Muse Voice Transcribe** | Turns driver voice notes, in English or Spanish, into requests the agent can act on |
| **Muse Spark Open** (open weights, via Baseten) | Triages every inbound email, text and voice note into a case |
| **SAM 3.1** | Cuts the document out of a cab photo before it is read |
| **Muse Image** | Makes the synthetic sample receipt photos, pay card backgrounds and dock clip stills, run once from scripts in `scripts/` (not by the app at runtime) |

Every answer and every proposal card has a "How this was worked out" panel (closed until opened):
the steps in order with who did each, its time and cost, and the models used. The Models and spend
page (`/models`) shows each model's calls, spend and typical time for the week.

## How it is built

- The AI proposes, a person (or the owner's autopilot policy) approves, the engine executes. Pay
  math is deterministic, in integer cents, and every number cites its source record.
- Every money action is reserved in a ledger with an idempotency key before it runs, so the same
  event never pays or posts twice.
- Adapters keep vendors at the edge: a read-only dispatch source (the sample dispatch system), a
  payment adapter (test mode only) and an accounting adapter for the QuickBooks Online sandbox.
- Multi-tenant: every carrier's data is isolated with Postgres row-level security, scoped in
  each transaction to the tenant in the signed-in user's verified token.
- Runs on AWS (us-east-2): the Next.js app on Amplify Hosting, data in Aurora PostgreSQL
  Serverless v2 through the Data API, sign-in with Cognito, inbound email through SES, S3 and
  Lambda. All infrastructure is code, with the CDK.
- Dependencies: `npm audit` reports two findings, both from the postcss that `next` 15.5 bundles
  (one moderate, one high, in how it reads CSS source maps). The fix is the Next 16 upgrade, queued
  after judging.

## Layout

- `src/`: the Next.js app (App Router, TypeScript).
- `db/migrations/`: plain SQL migrations, forward-only, applied in filename order.
- `infra/`: the CDK app for every AWS resource.
- `scripts/`: the migration runner, the demo carriers and the fresh test database.

## Try it

Start here, no login needed:

1. Read `/help/how-pay-works` (public) for the pay week in one page.
2. On the sign-in page press "Try the demo carrier": a visit as a demo judge on a fictional
   carrier. It reads what staff read, asks the agent, requests an advance (`/advances/new`), asks
   for a second check on a card, and moves loads on the sample dispatch board (`/tms-demo`, below).
   It cannot approve, pay, post, send or change a setting. A visit lasts 2 hours, 25 agent turns
   and $1.00 of model spend, and the demo is capped at $8.00 a day, so a visit can end early.
3. Ask the agent about a driver's advance, then open "How this was worked out" under the answer.

With the walkthrough switched on (`signInTour`, off until released), every sign-in opens a short
panel at the top of Home: the agent's morning line, then what waits for a person, the pay week,
the autopilot rules, the dispatch board and the live feed, each with the carrier's own number and
an "Ask about this" that fills the agent's box. "Show me around" opens it again.

The demo has two synthetic carriers, each with its own login, and each sees only its own data.
The logins that can approve cards and change settings are in the submission notes.

All data is synthetic. No real money moves: payouts run in test mode and accounting posts to a
QuickBooks sandbox company.

To walk the demo path locally (a local Postgres running): `npx playwright install chromium` once,
then `npm run e2e`. The models answer from a recording, so nothing leaves the machine. The run
drops and recreates the `payday_e2e` database each time (`E2E_ADMIN_DATABASE_URL` overrides it).

## Advances: how a request becomes a payout

1. A request arrives: a person fills in the request desk (`/advances/new`) or asks in the chat.
2. The agent checks the pay rules through the gateway (earned, unpaid pay; the driver's limit;
   the carrier's minimum and share; a possible duplicate) and proposes one advance. It cannot
   pay: its tools only read and propose.
3. A person approves the card. Only then does an advance row exist. The approval asks the pay
   rules again, so numbers that changed since the proposal stop it with nothing paid.
4. The engine reserves one ledger row and sends the payout in test mode. Pressing approve twice,
   or two people at once, still pays once. A payout with no answer stays unknown until it is
   read back (Check pending on the advance's page); only a definite failure offers Retry.
5. A paid advance posts to the QuickBooks sandbox as the advance plus its fee, once.

Every step is behind its own switches and limits: advances, payouts, an arm switch, a per-payout
cap and a start date. Payouts go to Stripe test mode only. Auto for advances is not switched on in
this release, so every advance still waits for a person.

## Voice intake: a driver's voice note, in English or Spanish

Staff add a driver's voice note on `/voice-notes`: record it in the browser or pick a clip. Each
step is its own request, and a stopped step can be pressed again from the note's page.

1. **Transcribe.** The browser makes 16 kHz mono audio and **Muse Voice Transcribe** writes it
   down, biased to Spanish and English. The transcript is stored as untrusted input; the original
   clip (up to 700 KB) is kept for playback.
2. **Screen, translate, sort.** **Muse Spark Open** screens the transcript first; a held note goes
   no further and no model reads its words. Then **Muse Spark** names the language and writes an
   English copy, and the triage model sorts the note. The amount the driver said is read by code,
   never by a model.
3. **Hand to the agent.** One agent turn reads the note and, for an advance, proposes it like any
   other request. A flagged note makes its card need the second confirm. The agent never pays.
4. **Reply draft.** A fixed sentence per outcome with the engine's numbers, translated back for a
   Spanish note (a changed dollar figure is thrown out). Nothing is sent: staff copy it.

The note's page shows each model call with its latency and cost. Voice intake is on behind its own
switch, with a per-carrier daily limit and caps on clip size and length.
`scripts/voice/make-samples.sh` (macOS only) makes the synthetic sample clips in `public/samples/`.

## Autopilot: the owner's rules

The owner decides what may be approved without a person. Settings > Autopilot
(`/settings/autopilot`) lists each kind of work with a rule: Off (the autopilot leaves it and nobody
is pinged; it waits on its own page), Ask me (a person approves), or Auto within limits (most each
time, most each day, a daily count, and for driver pay a per-driver daily cap). Only an admin saves
rules, and a limit above the ceiling set in code is refused. Every save and every pause is recorded.

1. Code decides, never a model. A card is approved by the autopilot only if its rule is Auto, no
   check flagged it, the gateway, the rules-engine recompute and the Muse Wonder audit all passed,
   and the amount and the day's totals are inside the limits. Anything else goes to a person.
2. Auto is offered for posting invoices and moving payments (on in this release), and for driver
   advances and money codes (offered, but not switched on, so those still wait for a person). A
   card match is always Ask me, because the engine cannot recompute it. Every other kind is always
   a person: weekly settlements, load moves, card pull-backs, deficits, card load rulings and
   escrow releases.
3. A Pause switch stops the autopilot at once; an admin resumes it.

## The desk: an always-on loop

For each carrier a desk loop wakes (on a 15 minute schedule defined in `infra/`, when the dispatch
system calls the webhook, or from a button), finds work newer than the carrier's start date, and
hands each piece to the agent that already handles it: card transactions, inbound messages and
voice notes, customer payments, second checks, the pay sweep, collections drafts, the Friday cash
check, documents, load events, dispatch status events, the autopilot's look at each card and the
morning digest. Every step goes into an insert-only log it resumes from, so a retry never repeats
work. A carrier's loop takes at most 20 pieces a wake and 300 a day, and stops at 60 cents of model
spend a wake or $4.00 a day.

It never moves money itself, never makes a model call of its own, and never writes to the dispatch
system. Each handler re-checks its own switch. Cards it drafts wait for a person or the autopilot
policy above. Outside sends stay off (driver note and collections email show "would send" lines),
and so does the broker portal runner.

## Live feed

One page, `/activity`, lists every step the agent, the desk, the autopilot and people take with
money, newest first: drafts, second checks, approvals and rejections, payouts and QuickBooks
sandbox posts with their outcomes, autopilot pauses and rule changes, and batch approvals. Home
shows its newest three lines. It is read only: it reads the records those steps already leave and
writes nothing. An open page refreshes every 15 seconds while its tab is visible. Each line names
who acted by role (Admin, Staff, Demo visitor, Autopilot, Agent, Desk) and never shows ids, logins,
notes or error text. The feed has its own switch and stays off until it is turned on.

## Recovering money

The agent proposes, the rules engine sizes every amount in integer cents, a named person approves
(never the autopilot).

1. **Card pull-back.** When a card load is taken back or stranded (for example a truck that broke
   down before the trip), the engine sizes the pull from our own records: confirmed loads and hand
   loads on the card, less its fuel and earlier pulls. The agent drafts one card; staff approve up
   to a set amount and an admin above it. Approving reserves a ledger row, then pulls once, in test
   mode. What the card cannot cover is booked as a named deficit, or stays owed on the advance.
2. **Deficits.** A driver's named deficits are taken back from later pay after advances, oldest
   first, above the net pay floor and inside the same recovery cap. A part taken stays owed for the
   next week. A deficit never rewrites a stub from before the start date.
3. **Cancelled trips.** A person cancels a load (or approves the load move that a withdrawn
   dispatch status drafts). For each paid advance still owed on it, the desk drafts one card; the
   engine computes the cents; a person approves, and the driver owes them exactly once.

Pay controls ride with these: staff can add a named line to a draft stub that cites one record (a
line that contradicts it parks the stub), and mark a paid stub as sent (the app sends nothing). An
admin cannot arm a driver until the activation checklist (identity, a zero-dollar test, loads
acknowledged) is on record with a person's name.

## Dispatch sync and the sample dispatch board

`/tms-demo` is a plain stand-in for a carrier's dispatch system on the demo carriers. LedgerLine
reads it only through its read-only dispatch connection, as it would read a real one.

1. Sign in (a demo visit works), open `/tms-demo` and pick a load. Assign a driver, complete a
   stop or set a status. "New load" adds one (at most 40 a carrier); the demo reset clears them.
2. Each change writes a history row there and calls LedgerLine's webhook, a wake-up only: the desk
   re-reads the record in full and trusts nothing in the call.
3. The desk moves the matching LedgerLine load when the evidence is clear; a case it cannot decide
   becomes a card a person taps. Nothing is written back to the dispatch system and no money moves.

An admin on a demo carrier also has Settings > Demo: "Sync dispatch now" reads the dispatch system
once, and a faults panel makes the feed misbehave (a cut history page, a repeated wake-up).

## The morning digest

At 06:00 carrier time the desk reads about ten facts from SQL (what needs a person, what happened
yesterday, the billing lines; Fridays the week's paystubs). Muse Spark words them into one line of
at most 400 characters, in one call a carrier a day capped at 4 cents, and every number in it is
checked against the facts. If the call fails or a number does not match, a line written by code
from the same facts is used. A fact that could not be read says "not read", never zero. The line
shows in the agent's ask card until a person presses Got it. It sends nothing.

## Payout rails

Two rails, one doorway: advances load to the driver's fuel card; weekly settlements go to the
driver's bank. Both run through the same executor: a person approves, one ledger row is reserved
with an idempotency key, the provider is called once, the outcome is read back if unclear, and the
same QuickBooks entry is posted. Today the fuel-card rail is a simulated provider in test mode
(deterministic, in process, no key, no network), and the bank rail is Stripe in test mode. Each
rail is one adapter behind `PaymentAdapter`; the ones a carrier would plug in next are WEX/EFS,
Comdata and AtoB for fuel cards, and TriumphPay for factoring payouts. A production key is refused
at startup. This section is the only place in the repo that names a fuel card or factoring provider.
