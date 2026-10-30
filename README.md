# LedgerLine

An AI operator for a trucking carrier's money desk. It takes driver advance requests, invoices
delivered loads, runs weekly settlements and payouts, and records every step in QuickBooks Online.
Meta models read each request, check it against the rules, explain every exception and propose
the action. A person approves; the engine executes.

Built from scratch for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026), Indie track,
"Build for Your World" theme.

## Trucking pay in one week

A trucking company is paid by customers to haul loads, and it pays the drivers who haul them. Money
in: a delivered load becomes a customer invoice. Money out: every Friday, each driver's week becomes
a paystub. Monique's week at Blue Ridge Freight Lines, a fictional carrier in the demo: three loads
$2,400.00, fuel and tolls back $180.00, an advance taken Wednesday -$200.00, insurance for five days
-$55.00, escrow -$100.00, net pay $2,225.00. The numbers live in the dispatch system, the fuel cards,
text messages, spreadsheets and QuickBooks. One advance logged twice leaves her $200.00 short.
LedgerLine reads all of it, finds the problems, explains each one and proposes the fix. A person
approves. Only then is anything paid or sent.

The app tells the same story, line by line, on its public page `/help/how-pay-works` (no sign-in).

## Safety by design

Every agent action is checked four ways before it can touch money: the gateway lets the agent read
and propose, never execute; the rules engine recomputes every number in integer cents; Muse Wonder
audits the proposal in a fresh context; a person approves. Every untrusted input (a driver's
message, a document, a voice note, a web page) is screened on Muse Spark Open before the agent
reads it. Every outside write targets test mode or the QuickBooks sandbox; a production key is
refused at startup. A ledger row is reserved before any call, so the same event can never pay
twice. A demo login for judges and visitors, one that can propose but not approve, is being added.

## Built on open weights

Muse Spark Open, served through Baseten, runs the jobs that see every untrusted
byte first: input screening on every message, document and voice note the agent reads, and the
broker portal's answer screen. Triage runs on it too: it sorts every driver message and voice note
into a case (one switch moves triage back to Muse Spark). It is cheap, fast, and can run on a
carrier's own hardware, which matters for a shop that will not send its pay data to a cloud model.
Its screening and triage scores are in the next section.

## How the models score

Each operator model takes the same 30 cases: 28 planted pay, payment, fuel and detention problems
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
model is being built into.

| Model | Job in LedgerLine |
|---|---|
| **Muse Spark 1.3** | The operator agent: calls tools over drivers, loads, pay items and the rules engine, returns structured proposals, and reads receipts, bills of lading and rate confirmations from photos and PDFs |
| **Muse Wonder** | The auditor: independently re-checks every money proposal before a person can approve it |
| **Muse Voice Transcribe** | Turns driver voice notes, in English or Spanish, into requests the agent can act on |
| **Muse Spark Open** (open weights, via Baseten) | Triages every inbound email, text and voice note into a case |
| **SAM 3.1** | Cuts the document out of a cab photo before it is read |
| **Muse Image** | Will generate the synthetic sample documents for the demo data |

Planned: every answer will show which model did each step, with latency and cost.

## How it is built

- The AI proposes, a person approves, the engine executes. Pay math is deterministic, in integer
  cents, and every number cites its source record.
- Every money action is reserved in a ledger with an idempotency key before it runs, so the same
  event never pays or posts twice.
- Adapters keep vendors at the edge: a TMS adapter (mock), a payment adapter (test mode only) and
  an accounting adapter for the QuickBooks Online sandbox.
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

The demo has two synthetic carriers, each with its own login, and each sees only its own data.
Demo logins are in the submission notes.

All data is synthetic. No real money moves: payouts run in test mode and accounting posts to a
QuickBooks sandbox company.

To walk the demo path in a browser (a local Postgres running): `npx playwright install chromium`
once, then `npm run e2e`. The models answer from a recording, so nothing leaves the machine.
`E2E_ADMIN_DATABASE_URL` names a local Postgres superuser (the default is the 127.0.0.1:5432 trust
URL in `e2e/env.local-mode.ts`), and the run drops and recreates the `payday_e2e` database each time.

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

Every step is behind switches that ship off: advances, payouts, an arm switch, a per-payout cap
and a start date.

## Voice intake: a driver's voice note, in English or Spanish

Staff add a driver's voice note on `/voice-notes`: record it in the browser or pick a clip. Each
step is its own request, so a slow model never times out the rest, and a stopped step can be
pressed again from the note's page.

1. **Transcribe.** The browser turns the clip into 16 kHz mono audio and **Muse Voice Transcribe**
   writes it down, biased to Spanish and English. The transcript is stored as untrusted input with
   its note first; the original clip (up to 700 KB) is then kept for playback on its own, so a
   recording the database refuses never costs the note. A failed transcription keeps no recording.
2. **Screen, translate, sort.** The gateway's safety screen (**Muse Spark Open**) reads the
   transcript first. A held note goes no further and no model reads its words. Then **Muse Spark**
   names the language and writes an English copy, and the triage model sorts the note through the
   gateway's classify tool. The amount the driver said is read from the transcript by code, never
   by a model.
3. **Hand to the agent.** One agent turn reads the note through a screened tool and, for an
   advance, proposes it like any other request. A note the screen flagged makes its card need the
   second confirm. The agent never pays.
4. **Reply draft.** A fixed sentence per outcome, with the engine's numbers, translated back for a
   Spanish note. A translation that changes or drops a dollar figure is thrown away for the
   English sentence. Nothing is sent: staff copy it.

The note's page shows who did what: each model call with its latency and cost. Voice intake ships
off behind its own switch, with a per-carrier daily limit and caps on clip size and length.
`scripts/voice/make-samples.sh` (macOS only) makes the synthetic sample clips in `public/samples/`.

## Payout rails

Two rails, one doorway: advances load to the driver's fuel card; weekly settlements go to the
driver's bank. Both run through the same executor: a person approves, one ledger row is reserved
with an idempotency key, the provider is called once, the outcome is read back if unclear, and the
same QuickBooks entry is posted. Today the fuel-card rail is a simulated provider in test mode
(deterministic, in process, no key, no network), and the bank rail is Stripe in test mode. Each
rail is one adapter behind `PaymentAdapter`; the ones a carrier would plug in next are WEX/EFS,
Comdata and AtoB for fuel cards, and TriumphPay for factoring payouts. A production key is refused
at startup. This section is the only place in the repo that names a fuel card or factoring provider.
