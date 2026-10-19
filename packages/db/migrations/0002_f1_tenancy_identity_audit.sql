-- =====================================================================
-- Migration 0002 — Phase 1 slice F1: tenancy, identity, access, audit plumbing
-- Expand-only. Closes the schema gaps found while planning F1 (docs/releases/f1.md):
--   A. version columns for optimistic concurrency on org_units / legal_entities / departments
--   B. closure-table trigger: cycle guard on reparent, materialised subtree
--   C. RLS on identity.role_permissions keyed through identity.roles
--   D. role_assignments / permission_limits may only reference system roles or own-tenant roles
--   E. polymorphic scope_id on role_assignments / config_entries must exist in the same tenant
--   F. tenancy.fn_scope_path(kind, id): nearest-first ancestor path for scope checks and config
--   G. SECURITY DEFINER functions for cross-tenant work (outbox relay, idempotency purge,
--      tenant provisioning, access-catalog seed). Owner must be superuser or BYPASSRLS because
--      every tenant table FORCEs row level security.
--   H. identity columns for passkeys and refresh-token rotation; outbox claim lease
--   I. invariants: one open business day per location; audit (tenant_id, seq) index
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. optimistic concurrency
-- ---------------------------------------------------------------------
ALTER TABLE tenancy.org_units      ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE tenancy.legal_entities ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE tenancy.departments    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------
-- B. closure table maintenance with cycle guard
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.fn_org_unit_paths_maintain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tenancy.org_unit_paths (tenant_id, ancestor_id, descendant_id, depth)
    VALUES (NEW.tenant_id, NEW.id, NEW.id, 0);
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO tenancy.org_unit_paths (tenant_id, ancestor_id, descendant_id, depth)
      SELECT p.tenant_id, p.ancestor_id, NEW.id, p.depth + 1
      FROM tenancy.org_unit_paths p
      WHERE p.tenant_id = NEW.tenant_id AND p.descendant_id = NEW.parent_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    IF NEW.parent_id IS NOT NULL AND (
         NEW.parent_id = NEW.id
      OR EXISTS (SELECT 1 FROM tenancy.org_unit_paths
                 WHERE tenant_id = NEW.tenant_id AND ancestor_id = NEW.id AND descendant_id = NEW.parent_id)
    ) THEN
      RAISE EXCEPTION 'org unit % cannot be reparented under its own subtree', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- detach the subtree from every ancestor that is not inside the subtree itself
    WITH subtree AS MATERIALIZED (
      SELECT descendant_id FROM tenancy.org_unit_paths
      WHERE tenant_id = NEW.tenant_id AND ancestor_id = NEW.id
    )
    DELETE FROM tenancy.org_unit_paths p
    USING subtree s
    WHERE p.tenant_id = NEW.tenant_id
      AND p.descendant_id = s.descendant_id
      AND p.ancestor_id NOT IN (SELECT descendant_id FROM subtree);
    -- attach it under the new ancestors
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO tenancy.org_unit_paths (tenant_id, ancestor_id, descendant_id, depth)
      SELECT a.tenant_id, a.ancestor_id, d.descendant_id, a.depth + d.depth + 1
      FROM tenancy.org_unit_paths a
      CROSS JOIN tenancy.org_unit_paths d
      WHERE a.tenant_id = NEW.tenant_id AND a.descendant_id = NEW.parent_id
        AND d.tenant_id = NEW.tenant_id AND d.ancestor_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX IF NOT EXISTS idx_org_unit_paths_anc ON tenancy.org_unit_paths (tenant_id, ancestor_id, depth);

-- ---------------------------------------------------------------------
-- C. role_permissions: readable for system roles and own roles, writable for own roles only
-- ---------------------------------------------------------------------
ALTER TABLE identity.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY rp_select ON identity.role_permissions FOR SELECT
  USING (EXISTS (SELECT 1 FROM identity.roles r
                 WHERE r.id = role_id AND (r.tenant_id IS NULL OR r.tenant_id = platform.current_tenant())));
CREATE POLICY rp_insert ON identity.role_permissions FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM identity.roles r
                      WHERE r.id = role_id AND r.tenant_id = platform.current_tenant()));
CREATE POLICY rp_update ON identity.role_permissions FOR UPDATE
  USING (EXISTS (SELECT 1 FROM identity.roles r WHERE r.id = role_id AND r.tenant_id = platform.current_tenant()))
  WITH CHECK (EXISTS (SELECT 1 FROM identity.roles r WHERE r.id = role_id AND r.tenant_id = platform.current_tenant()));
CREATE POLICY rp_delete ON identity.role_permissions FOR DELETE
  USING (EXISTS (SELECT 1 FROM identity.roles r WHERE r.id = role_id AND r.tenant_id = platform.current_tenant()));

-- ---------------------------------------------------------------------
-- D. roles referenced by assignments / limits must be system roles or belong to the same tenant
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.fn_assert_role_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF NEW.role_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.tenant_id INTO v_tenant FROM identity.roles r WHERE r.id = NEW.role_id;
  IF NOT FOUND OR (v_tenant IS NOT NULL AND v_tenant <> NEW.tenant_id) THEN
    RAISE EXCEPTION 'role % is not available to tenant %', NEW.role_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_role_assignments_role_tenant
  BEFORE INSERT OR UPDATE OF role_id, tenant_id ON identity.role_assignments
  FOR EACH ROW EXECUTE FUNCTION identity.fn_assert_role_tenant();
CREATE TRIGGER trg_permission_limits_role_tenant
  BEFORE INSERT OR UPDATE OF role_id, tenant_id ON identity.permission_limits
  FOR EACH ROW EXECUTE FUNCTION identity.fn_assert_role_tenant();

-- ---------------------------------------------------------------------
-- E. polymorphic scope references
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.fn_assert_scope_ref() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := false;
BEGIN
  CASE NEW.scope_kind
    WHEN 'tenant'     THEN v_ok := NEW.scope_id = NEW.tenant_id;
    WHEN 'org_unit'   THEN v_ok := EXISTS (SELECT 1 FROM tenancy.org_units   WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id);
    WHEN 'location'   THEN v_ok := EXISTS (SELECT 1 FROM tenancy.locations   WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id);
    WHEN 'department' THEN v_ok := EXISTS (SELECT 1 FROM tenancy.departments WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id);
    WHEN 'register'   THEN v_ok := EXISTS (SELECT 1 FROM tenancy.registers   WHERE tenant_id = NEW.tenant_id AND id = NEW.scope_id);
    ELSE v_ok := false;
  END CASE;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'scope % % does not exist in tenant %', NEW.scope_kind, NEW.scope_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_role_assignments_scope_ref
  BEFORE INSERT OR UPDATE OF scope_kind, scope_id ON identity.role_assignments
  FOR EACH ROW EXECUTE FUNCTION tenancy.fn_assert_scope_ref();
CREATE TRIGGER trg_config_entries_scope_ref
  BEFORE INSERT OR UPDATE OF scope_kind, scope_id ON tenancy.config_entries
  FOR EACH ROW EXECUTE FUNCTION tenancy.fn_assert_scope_ref();

-- ---------------------------------------------------------------------
-- F. scope path: register → department → location → org-unit chain (nearest first) → tenant
--    Invoker rights, so RLS applies; returns no rows for unknown or foreign ids.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.fn_scope_path(p_kind text, p_id uuid)
RETURNS TABLE (kind text, id uuid, ord integer)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenant     uuid := platform.current_tenant();
  v_department uuid;
  v_location   uuid;
  v_org_unit   uuid;
  v_ord        integer := 0;
  r            record;
BEGIN
  IF v_tenant IS NULL OR p_kind IS NULL OR p_id IS NULL THEN
    RETURN;
  END IF;

  IF p_kind = 'register' THEN
    SELECT reg.location_id, reg.department_id INTO v_location, v_department
    FROM tenancy.registers reg WHERE reg.tenant_id = v_tenant AND reg.id = p_id;
    IF NOT FOUND THEN RETURN; END IF;
    kind := 'register'; id := p_id; ord := v_ord; RETURN NEXT; v_ord := v_ord + 1;
  ELSIF p_kind = 'department' THEN
    v_department := p_id;
  ELSIF p_kind = 'location' THEN
    v_location := p_id;
  ELSIF p_kind = 'org_unit' THEN
    v_org_unit := p_id;
  ELSIF p_kind = 'tenant' THEN
    IF p_id <> v_tenant THEN RETURN; END IF;
  ELSE
    RETURN;
  END IF;

  IF v_department IS NOT NULL THEN
    SELECT d.location_id INTO v_location
    FROM tenancy.departments d WHERE d.tenant_id = v_tenant AND d.id = v_department;
    IF NOT FOUND THEN RETURN; END IF;
    kind := 'department'; id := v_department; ord := v_ord; RETURN NEXT; v_ord := v_ord + 1;
  END IF;

  IF v_location IS NOT NULL THEN
    SELECT l.org_unit_id INTO v_org_unit
    FROM tenancy.locations l WHERE l.tenant_id = v_tenant AND l.id = v_location;
    IF NOT FOUND THEN RETURN; END IF;
    kind := 'location'; id := v_location; ord := v_ord; RETURN NEXT; v_ord := v_ord + 1;
  END IF;

  IF v_org_unit IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM tenancy.org_units ou WHERE ou.tenant_id = v_tenant AND ou.id = v_org_unit) THEN
      RETURN;
    END IF;
    FOR r IN
      SELECT p.ancestor_id FROM tenancy.org_unit_paths p
      WHERE p.tenant_id = v_tenant AND p.descendant_id = v_org_unit
      ORDER BY p.depth
    LOOP
      kind := 'org_unit'; id := r.ancestor_id; ord := v_ord; RETURN NEXT; v_ord := v_ord + 1;
    END LOOP;
  END IF;

  kind := 'tenant'; id := v_tenant; ord := v_ord; RETURN NEXT;
  RETURN;
END $$;

-- ---------------------------------------------------------------------
-- G. SECURITY DEFINER functions (owner: migration role, which must be superuser or BYPASSRLS)
-- ---------------------------------------------------------------------
ALTER TABLE audit.outbox_events ADD COLUMN IF NOT EXISTS claimed_until timestamptz;

CREATE OR REPLACE FUNCTION audit.fn_claim_outbox_batch(p_limit integer, p_max_attempts integer DEFAULT 10)
RETURNS SETOF audit.outbox_events
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE audit.outbox_events e
  SET attempts = e.attempts + 1,
      claimed_until = now() + interval '60 seconds'
  WHERE (e.id, e.occurred_at) IN (
    SELECT o.id, o.occurred_at
    FROM audit.outbox_events o
    WHERE o.published_at IS NULL
      AND o.attempts < p_max_attempts
      AND (o.claimed_until IS NULL OR o.claimed_until < now())
    ORDER BY o.occurred_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED)
  RETURNING e.*;
$$;

CREATE OR REPLACE FUNCTION audit.fn_mark_outbox_published(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE audit.outbox_events
  SET published_at = now(), last_error = NULL, claimed_until = NULL
  WHERE id = ANY (p_ids) AND published_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION audit.fn_mark_outbox_failed(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE audit.outbox_events
  SET last_error = p_error, claimed_until = NULL
  WHERE id = p_id AND published_at IS NULL;
$$;

-- Give up on a row: it is marked published (never reclaimed) and keeps the final error for diagnostics.
CREATE OR REPLACE FUNCTION audit.fn_mark_outbox_dead(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE audit.outbox_events
  SET published_at = now(), last_error = p_error, claimed_until = NULL
  WHERE id = p_id AND published_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION audit.fn_purge_idempotency_keys()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM audit.idempotency_keys WHERE expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION platform.fn_provision_tenant(
  p_id uuid, p_slug citext, p_name text, p_region text, p_currency char(3), p_locale text, p_timezone text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO platform.tenants (id, slug, name, status, region, default_currency, default_locale, default_timezone)
  VALUES (p_id, p_slug, p_name, 'provisioning',
          COALESCE(p_region, 'ap-southeast-2'), COALESCE(p_currency, 'AUD'),
          COALESCE(p_locale, 'en-AU'), COALESCE(p_timezone, 'Australia/Sydney'))
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION platform.fn_activate_tenant(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count integer;
BEGIN
  UPDATE platform.tenants SET status = 'active', updated_at = now()
  WHERE id = p_id AND status = 'provisioning';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END $$;

-- Permission catalog + system roles are code (packages/auth catalog); this upserts them idempotently.
-- p_permissions: [{key, module, description, isSensitive}]  p_roles: [{key, name, description, permissions: [key]}]
CREATE OR REPLACE FUNCTION identity.fn_seed_access_catalog(p_permissions jsonb, p_roles jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r       jsonb;
  v_role  uuid;
BEGIN
  INSERT INTO identity.permissions (key, module, description, is_sensitive)
  SELECT p->>'key', p->>'module', p->>'description', COALESCE((p->>'isSensitive')::boolean, false)
  FROM jsonb_array_elements(p_permissions) p
  ON CONFLICT (key) DO UPDATE
    SET module = EXCLUDED.module, description = EXCLUDED.description, is_sensitive = EXCLUDED.is_sensitive;

  FOR r IN SELECT * FROM jsonb_array_elements(p_roles) LOOP
    INSERT INTO identity.roles (tenant_id, key, name, description, is_system)
    VALUES (NULL, r->>'key', r->>'name', r->>'description', true)
    ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), key) DO UPDATE
      SET name = EXCLUDED.name, description = EXCLUDED.description, is_system = true, updated_at = now()
    RETURNING id INTO v_role;

    DELETE FROM identity.role_permissions rp
    WHERE rp.role_id = v_role
      AND NOT (rp.permission_key IN (SELECT jsonb_array_elements_text(r->'permissions')));

    INSERT INTO identity.role_permissions (role_id, permission_key)
    SELECT v_role, k FROM jsonb_array_elements_text(r->'permissions') k
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION audit.fn_claim_outbox_batch(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.fn_mark_outbox_published(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.fn_mark_outbox_failed(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.fn_mark_outbox_dead(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.fn_purge_idempotency_keys() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.fn_provision_tenant(uuid, citext, text, text, char(3), text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.fn_activate_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.fn_seed_access_catalog(jsonb, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------
-- H. identity: passkey metadata, refresh-token rotation
-- ---------------------------------------------------------------------
ALTER TABLE identity.user_credentials
  ADD COLUMN IF NOT EXISTS sign_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transports text[],
  ADD COLUMN IF NOT EXISTS aaguid uuid,
  ADD COLUMN IF NOT EXISTS backed_up boolean;
COMMENT ON COLUMN identity.user_credentials.secret_hash IS
  'Argon2id hash (password, pos_pin); for totp the AES-256-GCM sealed secret: v1.<kid>.<iv>.<ct>.<tag>';

ALTER TABLE identity.auth_sessions
  ADD COLUMN IF NOT EXISTS prev_refresh_token_hash text,
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS amr text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS location_id uuid;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_prev_refresh ON identity.auth_sessions (prev_refresh_token_hash)
  WHERE prev_refresh_token_hash IS NOT NULL;

ALTER TABLE devices.device_enrollment_codes
  ADD CONSTRAINT chk_enrollment_code_length CHECK (char_length(code) >= 10);

CREATE INDEX IF NOT EXISTS idx_approval_requests_expiry ON identity.approval_requests (expires_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- I. invariants and indexes
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_days_open ON tenancy.business_days (location_id)
  WHERE status IN ('open', 'closing');
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_seq ON audit.audit_log (tenant_id, seq);

-- End of migration 0002.
