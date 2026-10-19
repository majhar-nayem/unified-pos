-- =====================================================================
-- Unified Retail & Restaurant POS Platform — PostgreSQL 16 schema
-- Part 1 of 3: extensions, helpers, platform, tenancy, identity, workforce
-- Conventions: see docs/02-database-design.md
--   * uuid PKs (UUIDv7 from the application; gen_random_uuid() fallback)
--   * tenant_id on every tenant table, composite FKs (tenant_id, id)
--   * money in bigint minor units, quantities numeric(14,4)
--   * status columns are text + CHECK, ledgers are append-only
-- Files: schema.sql (this), schema_part2.sql, schema_part3.sql — apply in order.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS tenancy;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS workforce;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS pricing;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS orders;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS cash;
CREATE SCHEMA IF NOT EXISTS tables;
CREATE SCHEMA IF NOT EXISTS kitchen;
CREATE SCHEMA IF NOT EXISTS customers;
CREATE SCHEMA IF NOT EXISTS devices;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS integrations;
CREATE SCHEMA IF NOT EXISTS reporting;

-- Application role: owns nothing, so RLS is enforced. Created by infra, shown here for clarity.
-- CREATE ROLE app_rw LOGIN PASSWORD '...';
-- GRANT USAGE ON SCHEMA ... TO app_rw; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ... TO app_rw;

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION platform.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION platform.fn_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION platform.fn_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not permitted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- ---------------------------------------------------------------------
-- platform: operators, tenants, feature flags
-- ---------------------------------------------------------------------

CREATE TABLE platform.operators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mfa_enforced  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.tenants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              citext NOT NULL UNIQUE,
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning','active','suspended','closed')),
  plan              text NOT NULL DEFAULT 'standard',
  region            text NOT NULL DEFAULT 'ap-southeast-2',     -- data residency pin
  default_currency  char(3) NOT NULL DEFAULT 'AUD',
  default_locale    text NOT NULL DEFAULT 'en-AU',
  default_timezone  text NOT NULL DEFAULT 'Australia/Sydney',
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,         -- contracts: TenantSettings
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.feature_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  tenant_id   uuid REFERENCES platform.tenants(id),              -- NULL = platform default
  scope_kind  text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('platform','tenant','org_unit','location')),
  scope_id    uuid,
  enabled     boolean NOT NULL DEFAULT false,
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_feature_flags_scope ON platform.feature_flags
  (key, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------
-- tenancy: hierarchy, legal entities, locations, registers, config
-- ---------------------------------------------------------------------

CREATE TABLE tenancy.legal_entities (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES platform.tenants(id),
  name                      text NOT NULL,
  country_code              char(2) NOT NULL,
  registration_number       text,                                -- e.g. ABN
  tax_registration_number   text,                                -- e.g. GST registration
  address                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_legal_text        text,
  fiscal_settings           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- fiscalization provider config (no-op in AU)
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE tenancy.org_units (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES platform.tenants(id),
  parent_id          uuid,
  kind               text NOT NULL CHECK (kind IN ('company','brand','region','business_entity','franchise_group','division')),
  code               text NOT NULL,
  name               text NOT NULL,
  legal_entity_id    uuid,
  reporting_boundary boolean NOT NULL DEFAULT false,            -- franchise: stop upward detail flow
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES tenancy.org_units(tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES tenancy.legal_entities(tenant_id, id)
);

-- Closure table: every (ancestor, descendant) pair including self (depth 0)
CREATE TABLE tenancy.org_unit_paths (
  tenant_id     uuid NOT NULL,
  ancestor_id   uuid NOT NULL,
  descendant_id uuid NOT NULL,
  depth         integer NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_id, descendant_id),
  FOREIGN KEY (tenant_id, ancestor_id)   REFERENCES tenancy.org_units(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, descendant_id) REFERENCES tenancy.org_units(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_org_unit_paths_desc ON tenancy.org_unit_paths (tenant_id, descendant_id, depth);

CREATE OR REPLACE FUNCTION tenancy.fn_org_unit_paths_maintain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tenancy.org_unit_paths (tenant_id, ancestor_id, descendant_id, depth)
    VALUES (NEW.tenant_id, NEW.id, NEW.id, 0);
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO tenancy.org_unit_paths (tenant_id, ancestor_id, descendant_id, depth)
      SELECT p.tenant_id, p.ancestor_id, NEW.id, p.depth + 1
      FROM tenancy.org_unit_paths p WHERE p.descendant_id = NEW.parent_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    -- detach subtree from old ancestors
    DELETE FROM tenancy.org_unit_paths
    WHERE descendant_id IN (SELECT descendant_id FROM tenancy.org_unit_paths WHERE ancestor_id = NEW.id)
      AND ancestor_id NOT IN (SELECT descendant_id FROM tenancy.org_unit_paths WHERE ancestor_id = NEW.id);
    -- attach to new ancestors
    IF NEW.parent_id IS NOT NULL THEN
      INSERT INTO tenancy.org_unit_paths (tenant_id, ancestor_id, descendant_id, depth)
      SELECT a.tenant_id, a.ancestor_id, d.descendant_id, a.depth + d.depth + 1
      FROM tenancy.org_unit_paths a
      CROSS JOIN tenancy.org_unit_paths d
      WHERE a.descendant_id = NEW.parent_id AND d.ancestor_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_org_units_paths
AFTER INSERT OR UPDATE OF parent_id ON tenancy.org_units
FOR EACH ROW EXECUTE FUNCTION tenancy.fn_org_unit_paths_maintain();

CREATE TABLE tenancy.locations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES platform.tenants(id),
  org_unit_id            uuid NOT NULL,
  legal_entity_id        uuid,
  code                   text NOT NULL,
  name                   text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('store','restaurant','warehouse','central_kitchen','dark_store','popup')),
  deployment_profile     text NOT NULL DEFAULT 'device_autonomous'
                           CHECK (deployment_profile IN ('cloud_only','device_autonomous','store_hub')),
  timezone               text NOT NULL,
  currency               char(3) NOT NULL,
  locale                 text NOT NULL DEFAULT 'en-AU',
  business_day_boundary  time NOT NULL DEFAULT '04:00',
  address                jsonb NOT NULL DEFAULT '{}'::jsonb,
  geo                    point,
  business_hours         jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings               jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding','active','closed','archived')),
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, org_unit_id)     REFERENCES tenancy.org_units(tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES tenancy.legal_entities(tenant_id, id)
);
CREATE INDEX idx_locations_org_unit ON tenancy.locations (tenant_id, org_unit_id);

CREATE TABLE tenancy.departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'general' CHECK (kind IN ('general','retail','restaurant','bar','bakery','warehouse')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, code),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE tenancy.registers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  department_id   uuid,
  code            text NOT NULL,                                 -- used in offline order refs, e.g. "R1"
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'pos' CHECK (kind IN ('pos','kiosk','handheld','online','virtual')),
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,            -- layout, receipt routing, drawer, CFD
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, code),
  FOREIGN KEY (tenant_id, location_id)   REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES tenancy.departments(tenant_id, id)
);

-- Versioned, scoped configuration. Effective value resolved by nearest scope on the path.
CREATE TABLE tenancy.config_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES platform.tenants(id),
  scope_kind     text NOT NULL CHECK (scope_kind IN ('tenant','org_unit','location','department','register')),
  scope_id       uuid NOT NULL,
  key            text NOT NULL,
  value          jsonb NOT NULL,
  version        integer NOT NULL,
  is_current     boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  reason         text
);
CREATE UNIQUE INDEX uq_config_current ON tenancy.config_entries (tenant_id, scope_kind, scope_id, key) WHERE is_current;
CREATE INDEX idx_config_history ON tenancy.config_entries (tenant_id, scope_kind, scope_id, key, version DESC);

CREATE TABLE tenancy.business_days (
  tenant_id      uuid NOT NULL,
  location_id    uuid NOT NULL,
  business_date  date NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','closed')),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  closed_by      uuid,
  PRIMARY KEY (location_id, business_date),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

-- ---------------------------------------------------------------------
-- identity: users, credentials, sessions, RBAC/ABAC, approvals, API clients
-- ---------------------------------------------------------------------

CREATE TABLE identity.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES platform.tenants(id),
  email         citext,
  display_name  text NOT NULL,
  locale        text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended','deactivated')),
  mfa_enabled   boolean NOT NULL DEFAULT false,
  external_idp_subject text,                                      -- SSO subject
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE identity.user_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('password','passkey','totp','pos_pin')),
  location_id   uuid,                                             -- pos_pin is per location
  secret_hash   text,                                             -- Argon2id (password, pin); TOTP secret encrypted
  public_key    bytea,                                            -- passkey
  credential_id bytea,                                            -- passkey
  label         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  FOREIGN KEY (tenant_id, user_id)     REFERENCES identity.users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);
CREATE INDEX idx_user_credentials_user ON identity.user_credentials (tenant_id, user_id, kind);
-- One active PIN hash cannot be looked up by value; the app fetches candidates per location and verifies.
CREATE UNIQUE INDEX uq_pos_pin_per_location ON identity.user_credentials (tenant_id, user_id, location_id)
  WHERE kind = 'pos_pin' AND status = 'active';

CREATE TABLE identity.auth_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  user_id            uuid NOT NULL,
  device_id          uuid,                                        -- devices.devices (FK added in part 3)
  kind               text NOT NULL CHECK (kind IN ('web','pos','api')),
  refresh_token_hash text NOT NULL UNIQUE,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text,
  ip                 inet,
  user_agent         text,
  FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_user ON identity.auth_sessions (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.login_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid,
  email_tried citext,
  outcome     text NOT NULL CHECK (outcome IN ('success','bad_credentials','locked','mfa_required','mfa_failed','revoked')),
  method      text NOT NULL,
  ip          inet,
  user_agent  text,
  device_id   uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_events_user ON identity.login_events (tenant_id, user_id, occurred_at DESC);

-- Global permission catalog (seeded from code; not tenant-scoped)
CREATE TABLE identity.permissions (
  key         text PRIMARY KEY,                                   -- e.g. orders.void
  module      text NOT NULL,
  description text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false                     -- requires MFA / confirmation
);

CREATE TABLE identity.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES platform.tenants(id),                -- NULL = system role
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX uq_roles_key ON identity.roles (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE identity.role_permissions (
  role_id        uuid NOT NULL REFERENCES identity.roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES identity.permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE identity.role_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL REFERENCES identity.roles(id),
  scope_kind  text NOT NULL CHECK (scope_kind IN ('tenant','org_unit','location','register')),
  scope_id    uuid NOT NULL,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,                                        -- temporary elevation
  granted_by  uuid,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users(tenant_id, id) ON DELETE CASCADE,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX idx_role_assignments_user ON identity.role_assignments (tenant_id, user_id);
CREATE INDEX idx_role_assignments_scope ON identity.role_assignments (tenant_id, scope_kind, scope_id);

-- ABAC limits, attached to a role (tenant-wide) or to a specific assignment
CREATE TABLE identity.permission_limits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES platform.tenants(id),
  role_id            uuid REFERENCES identity.roles(id) ON DELETE CASCADE,
  role_assignment_id uuid REFERENCES identity.role_assignments(id) ON DELETE CASCADE,
  key                text NOT NULL,                               -- e.g. orders.discount.max_percent
  value              jsonb NOT NULL,
  CHECK ((role_id IS NOT NULL) <> (role_assignment_id IS NOT NULL))
);
CREATE INDEX idx_permission_limits_role ON identity.permission_limits (tenant_id, role_id, key);

CREATE TABLE identity.approval_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  location_id    uuid,
  kind           text NOT NULL,                                   -- discount_over_limit, refund_over_limit, void, price_override, no_receipt_return, cash_paid_out ...
  subject_kind   text NOT NULL,
  subject_id     uuid,
  payload        jsonb NOT NULL,
  payload_hash   text NOT NULL,
  requested_by   uuid NOT NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  device_id      uuid,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text,
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);
CREATE INDEX idx_approval_requests_pending ON identity.approval_requests (tenant_id, location_id, status) WHERE status = 'pending';

CREATE TABLE identity.api_clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES platform.tenants(id),
  name           text NOT NULL,
  client_id      text NOT NULL UNIQUE,
  secret_hash    text NOT NULL,
  scopes         text[] NOT NULL DEFAULT '{}',
  location_scope uuid[],                                          -- optional restriction to locations
  rate_limit_per_minute integer NOT NULL DEFAULT 600,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  UNIQUE (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- workforce: employees, assignments, shifts, tasks
-- ---------------------------------------------------------------------

CREATE TABLE workforce.employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  user_id          uuid,                                          -- NULL for staff without login (kitchen hands)
  employee_number  text,
  display_name     text NOT NULL,
  job_title        text,
  external_payroll_ref text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','terminated')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_number),
  FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users(tenant_id, id)
);

CREATE TABLE workforce.employee_assignments (
  tenant_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  location_id  uuid NOT NULL,
  is_primary   boolean NOT NULL DEFAULT false,
  job_role     text,                                              -- server, host, bartender, cashier ...
  PRIMARY KEY (employee_id, location_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES workforce.employees(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE workforce.shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  employee_id   uuid NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  business_date date NOT NULL,
  source        text NOT NULL DEFAULT 'pos' CHECK (source IN ('pos','integration','manual')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','handed_over')),
  handed_over_to uuid,
  notes         text,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES workforce.employees(tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX idx_shifts_open ON workforce.shifts (tenant_id, location_id, status) WHERE status = 'open';

CREATE TABLE workforce.tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('checklist','task','inspection','incident')),
  title         text NOT NULL,
  template_id   uuid,
  due_at        timestamptz,
  assigned_to   uuid,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','skipped','overdue')),
  items         jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_by  uuid,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);
CREATE INDEX idx_tasks_location_status ON workforce.tasks (tenant_id, location_id, status, due_at);

-- updated_at triggers for mutable tables in this part
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'platform.tenants','tenancy.legal_entities','tenancy.org_units','tenancy.locations','tenancy.registers',
    'identity.users','identity.roles','workforce.employees']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.fn_set_updated_at()',
                   replace(t, '.', '_'), t);
  END LOOP;
END $$;

-- End of part 1. Continue with schema_part2.sql (catalog, pricing, inventory, orders).
