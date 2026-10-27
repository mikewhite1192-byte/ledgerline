-- Muse Spark Open's standby host. A model_calls row records which host served the call, and the
-- wrapper (src/lib/ai/standby.ts) may now make one attempt on Fireworks after Baseten fails for a
-- reason that is Baseten's own, behind flags.sparkOpenFallback. Each attempt is its own row, so
-- the provider list gains 'fireworks'. Additive: every existing row still passes.
--
-- The constraint was created in 0002 on ai_calls and kept its name when 0003 renamed the table;
-- ai_calls_provider_check was read from a fresh database built from these migrations. No IF
-- EXISTS: a database where it is named otherwise fails this migration instead of keeping the old
-- list beside the new one. The new constraint takes the table's current name.
ALTER TABLE model_calls
  DROP CONSTRAINT ai_calls_provider_check,
  ADD CONSTRAINT model_calls_provider_check CHECK (provider IN ('meta', 'baseten', 'fireworks'));
