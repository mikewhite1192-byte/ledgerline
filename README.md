# LedgerLine

An AI operator for a trucking carrier's money desk. It takes driver advance requests, invoices
delivered loads, runs weekly settlements and payouts, and records every step in QuickBooks Online.
Meta models read each request, check it against the rules, explain every exception and propose
the action. A person approves; the engine executes.

Built from scratch for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026), Indie track,
"Build for Your World" theme.

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

Planned: every answer will show which model did each step, with latency and cost, and an
evaluation will compare Muse Spark, Muse Spark Open and Muse Wonder on planted pay problems.

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
