# Database migrations

- Plain SQL in `db/migrations/`, forward-only: a merged migration is never edited; a fix is a new
  migration.
- Named `NNNN_short_name.sql` (for example `0001_tenants.sql`) and applied in filename order.
- Every tenant table gets row-level security, with its policies, in the same migration that
  creates it.
- The app talks to Aurora PostgreSQL Serverless v2 through the Data API. Local and CI tests use a
  plain Postgres 16 database built fresh from these files (`npm run test:db`, with `DATABASE_URL`
  pointing at the local database).
