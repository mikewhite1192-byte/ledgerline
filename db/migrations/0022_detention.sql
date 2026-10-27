-- Unbilled detention: the agent finds a load whose stop times earned detention the carrier never
-- billed and proposes the charge; a person approves; the executor adds one detention accessorial
-- to the load and raises its open, unposted invoice by the same cents, in one transaction.
--
-- 1. The proposal kind detention_charge. 0009 declared the kind check inline, so Postgres named it
--    proposals_kind_check; no later merged migration re-creates it. The list below is every kind
--    allowed before this file plus the new one. A later migration that adds a kind re-lists all of
--    them, this one included.
ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('advance_payout', 'pay_correction', 'invoice_fix', 'detention_charge'));

-- 2. The proposal an accessorial came from, null for every row a person or the seed wrote. At most
--    one accessorial per proposal, so the same approval run twice writes once. The reference is
--    the same tenant's proposal; deleting the proposal (a reseed clears the agent's rows first)
--    only clears the link, so a charge that was billed stays billed.
ALTER TABLE load_accessorials ADD COLUMN proposal_id uuid;
CREATE UNIQUE INDEX load_accessorials_one_per_proposal
  ON load_accessorials (tenant_id, proposal_id) WHERE proposal_id IS NOT NULL;
ALTER TABLE load_accessorials ADD CONSTRAINT load_accessorials_proposal_fk
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id)
  ON DELETE SET NULL (proposal_id);

-- 3. Grants: none needed. 0004 grants payday_app SELECT, INSERT, UPDATE and DELETE on
--    load_accessorials (a new column is covered by a table grant) and 0005 the same on invoices.
--    Row security on both tables is unchanged: tenant_isolation already scopes every row,
--    proposal_id included, to current_tenant_id().
