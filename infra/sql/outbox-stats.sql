-- PROPOSED MIGRATION for the integration lead (packages/db is owned by another stream; S-INFRA could not add it).
-- Exact outbox totals for the worker's gauges `pos.outbox.backlog` and `pos.outbox.oldest_age.seconds`.
-- audit.outbox_events is under FORCE ROW LEVEL SECURITY, so the application role sees nothing without a tenant
-- context; like the relay functions in migration 0002 this runs as the migration role (superuser or BYPASSRLS).
--
-- Also add 'audit.fn_outbox_stats' to the EXECUTE grant list next to 'audit.fn_claim_outbox_batch' in
-- packages/db/src/roles.ts, and to the migration manifest in packages/db/src/migrations.ts.
--
-- Until it is applied the worker logs one warning and reports relay-observed lower bounds
-- (apps/worker/src/telemetry/outbox-stats.ts).

CREATE OR REPLACE FUNCTION audit.fn_outbox_stats()
RETURNS TABLE (backlog bigint, oldest_age_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT count(*)::bigint,
         COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::double precision
  FROM audit.outbox_events
  WHERE published_at IS NULL;      -- dead-lettered rows are marked published and are excluded
$$;

REVOKE ALL ON FUNCTION audit.fn_outbox_stats() FROM PUBLIC;
