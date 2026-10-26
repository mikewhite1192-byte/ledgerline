# LedgerLine

An AI operator for a trucking carrier's money desk. It takes driver advance requests, invoices
delivered loads, runs weekly settlements and payouts, and records every step in QuickBooks Online.
Meta models read each request, check it against the rules, explain every exception and propose
the action. A person approves; the engine executes.

Built from scratch for the Meta Global AI Developer Hackathon (Oct 26 to Nov 4, 2026), Indie track,
"Build for Your World" theme.

## Meta models in this project

- **Muse Spark** (Meta Model API): the operator agent. It calls tools over drivers, loads, pay
  items and the rules engine; checks advance eligibility; explains settlement exceptions; answers
  "why is this driver's pay short?"; and drafts every proposal a person approves.
- **Muse Spark Open** (open weights, via Baseten): triages inbound driver and staff email into
  cases (advance request, pay question, dispute) and extracts the driver, amount and dates.

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
