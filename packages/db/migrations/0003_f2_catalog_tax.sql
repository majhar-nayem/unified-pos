-- =====================================================================
-- Migration 0003 — Phase 1 slice F2: catalog and tax
-- Expand-only. Closes the schema gaps found while planning F2 (docs/releases/f2.md):
--   A. version columns for optimistic concurrency on categories, tax classes, suppliers, tax rules
--   B. catalog.items.search_vector maintenance: item fields + variant SKUs + barcodes, kept
--      current by triggers on items, item_variants and barcodes (docs/02 §2.2: tsvector + pg_trgm)
--   C. catalog.import_jobs: CSV import jobs with their validation report (RLS like every tenant table)
--   D. lookup indexes: availability by location, unit conversions by variant, tax rules by class
--   E. catalog.fn_search_items: the fuzzy search as a tenant-pinned SECURITY DEFINER function. Under FORCE
--      row level security the planner will not push non-leakproof operators (tsvector @@, pg_trgm <%) into
--      index conditions, so the same query as app_rw is a sequential scan (measured: 200 ms at 100k items,
--      Bitmap Index Scans and 10 ms as the owner). The function filters explicitly by platform.current_tenant()
--      (the verified session tenant) and returns nothing when no tenant is set.
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. optimistic concurrency
-- ---------------------------------------------------------------------
ALTER TABLE catalog.categories  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE catalog.tax_classes ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE catalog.suppliers   ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE pricing.tax_rules   ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------
-- B. search vector: name (A), short name / brand / SKUs / barcodes (B), description (C).
--    'simple' configuration: product names are multilingual and brand-like; stemming would hurt.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.fn_item_search_vector(
  p_tenant_id uuid, p_item_id uuid, p_name text, p_short_name text, p_brand text, p_description text)
RETURNS tsvector
LANGUAGE sql STABLE AS $$
  SELECT setweight(to_tsvector('simple', COALESCE(p_name, '')), 'A')
      || setweight(to_tsvector('simple', COALESCE(p_short_name, '') || ' ' || COALESCE(p_brand, '')), 'B')
      || setweight(to_tsvector('simple', COALESCE((
           SELECT string_agg(COALESCE(v.sku, '') || ' ' || COALESCE(v.name, '') || ' ' || COALESCE(b.codes, ''), ' ')
           FROM catalog.item_variants v
           LEFT JOIN LATERAL (
             SELECT string_agg(bc.code, ' ') AS codes
             FROM catalog.barcodes bc WHERE bc.tenant_id = v.tenant_id AND bc.variant_id = v.id
           ) b ON true
           WHERE v.tenant_id = p_tenant_id AND v.item_id = p_item_id), '')), 'B')
      || setweight(to_tsvector('simple', COALESCE(p_description, '')), 'C');
$$;

CREATE OR REPLACE FUNCTION catalog.fn_items_search_vector_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := catalog.fn_item_search_vector(
    NEW.tenant_id, NEW.id, NEW.name, NEW.short_name, NEW.brand_name, NEW.description);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_items_search_vector ON catalog.items;
CREATE TRIGGER trg_items_search_vector BEFORE INSERT OR UPDATE OF name, short_name, brand_name, description
  ON catalog.items FOR EACH ROW EXECUTE FUNCTION catalog.fn_items_search_vector_trigger();

-- Variants and barcodes refresh the parent item's vector (the items trigger recomputes it).
CREATE OR REPLACE FUNCTION catalog.fn_refresh_item_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid;
  v_item   uuid;
BEGIN
  IF TG_TABLE_NAME = 'item_variants' THEN
    v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    v_item   := COALESCE(NEW.item_id, OLD.item_id);
  ELSE
    SELECT v.tenant_id, v.item_id INTO v_tenant, v_item
    FROM catalog.item_variants v
    WHERE v.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND v.id = COALESCE(NEW.variant_id, OLD.variant_id);
  END IF;
  IF v_item IS NOT NULL THEN
    UPDATE catalog.items i
       SET search_vector = catalog.fn_item_search_vector(i.tenant_id, i.id, i.name, i.short_name, i.brand_name, i.description)
     WHERE i.tenant_id = v_tenant AND i.id = v_item;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_item_variants_search_vector ON catalog.item_variants;
CREATE TRIGGER trg_item_variants_search_vector AFTER INSERT OR DELETE OR UPDATE OF sku, name
  ON catalog.item_variants FOR EACH ROW EXECUTE FUNCTION catalog.fn_refresh_item_search_vector();
DROP TRIGGER IF EXISTS trg_barcodes_search_vector ON catalog.barcodes;
CREATE TRIGGER trg_barcodes_search_vector AFTER INSERT OR DELETE OR UPDATE OF code
  ON catalog.barcodes FOR EACH ROW EXECUTE FUNCTION catalog.fn_refresh_item_search_vector();

-- Backfill anything inserted before the trigger existed.
UPDATE catalog.items i
   SET search_vector = catalog.fn_item_search_vector(i.tenant_id, i.id, i.name, i.short_name, i.brand_name, i.description)
 WHERE i.search_vector IS NULL;

-- ---------------------------------------------------------------------
-- C. CSV import jobs (items / variants / barcodes) with the validation report
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog.import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id),
  file_name   text NOT NULL,
  status      text NOT NULL CHECK (status IN ('validated','applied','rejected')),
  dry_run     boolean NOT NULL DEFAULT false,
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,                 -- {rows, items, variants, barcodes, errors}
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,                 -- [{line, column, code, message}]
  report_csv  text NOT NULL,                                      -- downloadable validation report
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_tenant ON catalog.import_jobs (tenant_id, created_at DESC);
ALTER TABLE catalog.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON catalog.import_jobs;
CREATE POLICY tenant_isolation ON catalog.import_jobs
  USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant());

-- ---------------------------------------------------------------------
-- D. lookup indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_item_availability_location ON catalog.item_availability (tenant_id, location_id);
CREATE INDEX IF NOT EXISTS idx_unit_conversions_variant ON catalog.unit_conversions (tenant_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_tax_rules_class ON pricing.tax_rules (tenant_id, tax_class_id);
CREATE INDEX IF NOT EXISTS idx_supplier_items_variant ON catalog.supplier_items (tenant_id, variant_id);

-- ---------------------------------------------------------------------
-- E. fuzzy item search that can use the GIN indexes (see header)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION catalog.fn_search_items(
  p_query text, p_limit integer, p_kind text DEFAULT NULL, p_status text DEFAULT NULL, p_threshold real DEFAULT 0.5)
RETURNS TABLE (id uuid, text_rank real, similarity real, score real)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid := platform.current_tenant();
  v_tsq    tsquery := plainto_tsquery('simple', p_query);
  v_needle text := lower(p_query);
BEGIN
  IF v_tenant IS NULL OR p_limit IS NULL OR p_limit < 1 THEN RETURN; END IF;
  PERFORM set_config('pg_trgm.word_similarity_threshold', p_threshold::text, true);
  RETURN QUERY
  SELECT i.id,
         COALESCE(ts_rank_cd(i.search_vector, v_tsq), 0)::real,
         word_similarity(v_needle, lower(i.name))::real,
         GREATEST(LEAST(COALESCE(ts_rank_cd(i.search_vector, v_tsq), 0), 1), word_similarity(v_needle, lower(i.name)))::real
  FROM catalog.items i
  WHERE i.tenant_id = v_tenant
    AND (i.search_vector @@ v_tsq OR v_needle <% lower(i.name))
    AND (p_kind IS NULL OR i.kind = p_kind)
    AND (p_status IS NULL OR i.status = p_status)
  ORDER BY 4 DESC, i.name, i.id
  LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION catalog.fn_search_items(text, integer, text, text, real) FROM PUBLIC;
