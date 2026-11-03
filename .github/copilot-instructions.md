# Review instructions

LedgerLine is a multi-tenant payroll and back-office app for trucking carriers (Next.js App Router, TypeScript,
Aurora PostgreSQL with row-level security per tenant). An agent reads, explains and proposes; a deterministic rules
engine computes every number; money moves only through the payment and accounting adapters, in test mode.

Review like a careful senior engineer on a money system. Report real defects with a concrete failure scenario
(inputs or state, then the wrong result). Rank by severity. Skip style nits the linters already enforce.

## Danger zones: read every line

- `db/migrations/`: every table has RLS enabled and forced with a tenant policy (USING and WITH CHECK); grants are
  the narrowest that work (no UPDATE or DELETE on a record that only grows); a CHECK added to an existing table is
  NOT VALID first, then validated; a new column or constraint matches what the code actually writes.
- `src/lib/rules-engine/`: pay math is integer cents only (no floats, no rounding drift); every rule is per tenant
  and configured, never hard-coded; dates use the tenant's named timezone.
- `src/lib/money/`: every outside write has an idempotency key and a ledger row reserved BEFORE the call; a
  timeout or 5xx is an unknown outcome, never success or failure, until read back; production keys are refused.
- `src/lib/agent/` and the gateway: agent tools only read and propose. Agent code must never import a writer
  (payments, accounting, ledger, autopilot rules or pause state). The model never decides an amount.
- `src/lib/autopilot/`: execution is allowed only by the owner's rules, checked in code under a row lock, with
  the rule version re-read at the gate; a pause stops everything; limits never exceed the configured ceilings.
- Auth and roles (`src/lib/auth/`, `src/lib/roles.ts`, every route): admin, staff and judge (a read-only demo
  visitor). Every write route refuses cross-site requests and judges before any database read, checks the role
  server-side (never only in the UI), and service logins cannot act as a person.
- `infra/`: least-privilege IAM, no wildcard resources on writes, no secrets in code or outputs.

## Check on every PR

1. A create that can fail before its id is stored: reserve first, fail closed, leave a marker to adopt it later.
2. A retry or resume that skips unfinished work instead of reconciling stored state; unbounded retries.
3. An ambiguous outcome (timeout, 5xx, thrown fetch) treated as known.
4. Partial-match comparisons (substring, prefix) where a whole value must match.
5. Raw upstream error text reaching a user, a stored reason or a response; clients get categories only.
6. Each path to an outside write (payment, accounting, email, message) re-checks its own feature switch.
7. The same event processed twice must give exactly one write; name the dedupe key, check races (two requests
   on one version, a row lock that locks nothing because the row does not exist yet).
8. Money in integer cents; dates in a named timezone.
9. Secrets, login ids and personal data never reach logs, errors or the client.
10. Tests that depend on the wall clock or on rows left by another test.
11. A field, column, endpoint or library call that does not exist.
12. Anything older than a feature's start date being touched, re-sent or re-notified.
13. Tests that leave temp files, rows or tenants behind, failure paths included.
14. Tenant isolation: every query runs inside the tenant's scope; no query reads another tenant's rows.
15. Optimistic versions: a stale version writes nothing and is refused, even when the values look equal.
16. UI state that can disagree with the server after an action (stale server render, a timer that never ends).

## House rules

- New behavior that touches the outside world ships behind a switch in `src/config/flags.ts`, off by default.
- No em or en dash characters in added lines. American English.
- The repo is public: flag any real company name, credential, personal data or real driver data.
