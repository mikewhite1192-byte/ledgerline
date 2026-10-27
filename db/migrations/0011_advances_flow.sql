-- The advance flow: a person approves the agent's advance proposal, and only then does an advances
-- row exist (design D2). The row names the proposal it came from, the outside message the ask
-- arrived in (when there was one), and the member whose approval reserved the payout.
--
-- No new table, so no new row-level security statement: advances already has ENABLE and FORCE,
-- the one tenant_isolation policy and its grants from 0005. Those grants keep DELETE, because the
-- seed's replace mode clears advances as the app role. Every new reference is a composite foreign
-- key on (tenant_id, x_id), so a flow row can never point at another carrier's proposal, input or
-- member (the insert fails with 23503).
--
-- The references take the default NO ACTION, checked at the end of the statement: deleting a
-- proposal or a member a flow row still names fails, while deleting a tenant (which cascades to
-- both ends in one statement) still works. A deleted input only clears source_input_id.

ALTER TABLE advances
  ADD COLUMN proposal_id uuid,
  ADD COLUMN source_input_id uuid,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decided_by_membership_id uuid;

ALTER TABLE advances
  ADD CONSTRAINT advances_proposal_fk
    FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id);

ALTER TABLE advances
  ADD CONSTRAINT advances_source_input_fk
    FOREIGN KEY (tenant_id, source_input_id) REFERENCES untrusted_inputs (tenant_id, id)
    ON DELETE SET NULL (source_input_id);

ALTER TABLE advances
  ADD CONSTRAINT advances_decided_by_fk
    FOREIGN KEY (tenant_id, decided_by_membership_id) REFERENCES memberships (tenant_id, id);

-- One advance per proposal: a second approval of the same proposal finds this row and carries on
-- from its state instead of writing another.
CREATE UNIQUE INDEX advances_proposal_uq ON advances (tenant_id, proposal_id)
  WHERE proposal_id IS NOT NULL;

-- A driver's voice note is the fourth way an ask arrives.
ALTER TABLE advances DROP CONSTRAINT advances_source_check;
ALTER TABLE advances ADD CONSTRAINT advances_source_check
  CHECK (source IN ('ui', 'email', 'seed', 'voice'));

-- A seeded advance is history and never comes from a proposal; a decision names both its time
-- and its member, or neither.
ALTER TABLE advances ADD CONSTRAINT advances_flow_not_seed
  CHECK (proposal_id IS NULL OR source <> 'seed');
ALTER TABLE advances ADD CONSTRAINT advances_decided_pair
  CHECK ((decided_at IS NULL) = (decided_by_membership_id IS NULL));

COMMENT ON COLUMN advances.request_ref IS
  'ADV- plus the first 12 hex characters of proposal_id for flow rows; seed rows keep theirs';
