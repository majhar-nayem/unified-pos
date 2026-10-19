-- =====================================================================
-- Part 3 of 3: payments, cash, tables, kitchen, customers, devices,
--              audit, integrations, reporting, deferred FKs, RLS
-- Requires schema.sql and schema_part2.sql applied first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------

CREATE TABLE payments.payment_provider_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES platform.tenants(id),
  provider         text NOT NULL CHECK (provider IN ('stripe','adyen','tyro','windcave','linkly','square','manual','mock')),
  name             text NOT NULL,
  scope_kind       text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('tenant','org_unit','location')),
  scope_id         uuid,
  merchant_ref     text,                                          -- provider merchant/account id (not secret)
  credentials_ref  text NOT NULL,                                 -- Secrets Manager key; never the secret
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,            -- offline floor limits/count caps, capture mode, surcharge rules (non-AU / Amex only after 1 Oct 2026)
  capabilities     jsonb NOT NULL DEFAULT '{}'::jsonb,            -- contracts: ProviderCapabilities {cardPresent, cardNotPresent, preAuth, tipAdjust, offlineModes:['local_terminal_api'|'sdk'|'none'], offlineExcludedSchemes[], leastCostRouting, surcharging, refundsWithoutOriginal, certificationStatus, currencies[]}
  currencies       char(3)[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','disabled')),
  health           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE payments.payment_terminals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  provider_account_id  uuid NOT NULL,
  serial_number        text NOT NULL,
  model                text,
  pairing_ref          text,                                      -- provider-side terminal id
  connection_mode      text NOT NULL CHECK (connection_mode IN ('cloud','lan','sdk')),
  address              text,                                      -- LAN ip/host
  assigned_register_id uuid,
  status               text NOT NULL DEFAULT 'unpaired' CHECK (status IN ('unpaired','paired','offline','faulty','retired')),
  last_seen_at         timestamptz,
  firmware             text,
  UNIQUE (tenant_id, id),
  UNIQUE (provider_account_id, serial_number),
  FOREIGN KEY (tenant_id, location_id)          REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id)  REFERENCES payments.payment_provider_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_register_id) REFERENCES tenancy.registers(tenant_id, id)
);

CREATE TABLE payments.payment_intents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  order_id             uuid NOT NULL,
  check_id             uuid NOT NULL,
  idempotency_key      text NOT NULL,                             -- (device, client_intent_id) or API key
  method               text NOT NULL CHECK (method IN ('cash','card_present','card_not_present','wallet','qr','gift_card','store_credit','loyalty','bank_transfer','bnpl','external','deposit_applied')),
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  tip_minor            bigint NOT NULL DEFAULT 0 CHECK (tip_minor >= 0),
  surcharge_minor      bigint NOT NULL DEFAULT 0 CHECK (surcharge_minor >= 0),
  cashback_minor       bigint NOT NULL DEFAULT 0,
  currency             char(3) NOT NULL,
  status               text NOT NULL DEFAULT 'created' CHECK (status IN ('created','processing','authorized','captured','partially_refunded','refunded','reversed','failed','cancelled','uncertain')),
  settlement_status    text NOT NULL DEFAULT 'unsettled' CHECK (settlement_status IN ('unsettled','settled','disputed','not_applicable')),
  provider_account_id  uuid,
  terminal_id          uuid,
  provider_reference   text,                                      -- provider's transaction id
  authorized_minor     bigint NOT NULL DEFAULT 0,
  captured_minor       bigint NOT NULL DEFAULT 0,
  refunded_minor       bigint NOT NULL DEFAULT 0,
  offline              boolean NOT NULL DEFAULT false,            -- store-and-forward / offline tender
  settlement_pending   boolean NOT NULL DEFAULT false,
  -- Offline (store-and-forward) lifecycle. Providers approve locally, forward later, and the issuer may still decline.
  offline_collected_at timestamptz,                               -- terminal/SDK approved offline at this time
  offline_expires_at   timestamptz,                               -- provider/tenant window after which the stored payment cannot be forwarded (e.g. 24 h, 72 h, 7 d)
  offline_device_seq   integer,                                   -- position in the device's offline queue; caps on count/sum are enforced at the Payments Edge and proven nightly
  forwarded_at         timestamptz,                               -- stored payment reached the provider
  forward_outcome      text CHECK (forward_outcome IN ('pending','approved','declined','expired','rescue_in_progress')),
  gift_card_id         uuid,
  customer_id          uuid,
  device_id            uuid,
  created_by           uuid,
  last_error           jsonb,
  expires_at           timestamptz,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, location_id)         REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)            REFERENCES orders.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, check_id)            REFERENCES orders.checks(tenant_id, id),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES payments.payment_provider_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, terminal_id)         REFERENCES payments.payment_terminals(tenant_id, id),
  CHECK (refunded_minor <= captured_minor),
  CHECK (captured_minor <= amount_minor + tip_minor + surcharge_minor),
  CHECK (forward_outcome IS NULL OR offline)                      -- forwarding lifecycle only exists for offline-collected payments
);
CREATE INDEX idx_payment_intents_check ON payments.payment_intents (tenant_id, check_id);
CREATE INDEX idx_payment_intents_offline_open ON payments.payment_intents (tenant_id, location_id, offline_expires_at)
  WHERE offline AND forward_outcome IN ('pending','rescue_in_progress');
CREATE INDEX idx_payment_intents_order ON payments.payment_intents (tenant_id, order_id);
CREATE INDEX idx_payment_intents_stuck ON payments.payment_intents (tenant_id, status, updated_at) WHERE status IN ('processing','uncertain');
CREATE INDEX idx_payment_intents_provider_ref ON payments.payment_intents (provider_account_id, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX idx_payment_intents_unsettled ON payments.payment_intents (tenant_id, provider_account_id, settlement_status) WHERE status IN ('captured','partially_refunded','refunded') AND settlement_status = 'unsettled';

CREATE TABLE payments.payment_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  intent_id           uuid NOT NULL,
  attempt_no          smallint NOT NULL,
  operation           text NOT NULL CHECK (operation IN ('sale','auth','capture','refund','reverse','status_query','cancel')),
  provider_request_id text,
  provider_idempotency_key text,
  status              text NOT NULL CHECK (status IN ('started','succeeded','declined','error','timeout')),
  request_redacted    jsonb,                                      -- never PAN/CVV/track data
  response_redacted   jsonb,
  error_code          text,
  error_message       text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  UNIQUE (intent_id, attempt_no, operation),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.payment_intents(tenant_id, id) ON DELETE CASCADE
);

-- Append-only audit of record for payment state; intent.status is a projection.
CREATE TABLE payments.payment_events (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  intent_id     uuid NOT NULL,
  attempt_id    uuid,
  kind          text NOT NULL,                                    -- submitted, authorized, captured, declined, timeout, status_confirmed, refunded, reversed, cancelled, webhook_received, reconciled
  from_status   text,
  to_status     text,
  source        text NOT NULL CHECK (source IN ('pos','api','provider_webhook','terminal','reconciliation','admin','system')),
  amount_minor  bigint,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  device_id     uuid,
  occurred_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_payment_events_intent ON payments.payment_events (tenant_id, intent_id, occurred_at);
CREATE TRIGGER trg_payment_events_append_only BEFORE UPDATE OR DELETE ON payments.payment_events
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();
CREATE TABLE payments.payment_events_default PARTITION OF payments.payment_events DEFAULT;

CREATE TABLE payments.refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  intent_id           uuid NOT NULL,
  order_id            uuid NOT NULL,                              -- the return/refund order
  idempotency_key     text NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  reason              text,
  method              text NOT NULL,                              -- original, cash, store_credit, gift_card
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed','uncertain','cancelled')),
  provider_reference  text,
  approval_id         uuid,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.payment_intents(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)  REFERENCES orders.orders(tenant_id, id)
);
CREATE INDEX idx_refunds_intent ON payments.refunds (tenant_id, intent_id);

-- Scheme-permitted receipt data only. NO PAN, NO CVV, NO track data, NO expiry. CI scans this table's columns.
CREATE TABLE payments.card_payment_details (
  intent_id          uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  card_brand         text,
  last4              char(4),
  entry_mode         text,                                        -- contactless, chip, swipe, manual_keyed(provider side), ecom
  auth_code          text,
  aid                text,
  application_label  text,
  token_ref          text,                                        -- provider token for refunds/recurring
  scheme_reference   text,
  cardholder_verification text,
  issuer_bank        text,                                        -- as returned by the terminal (receipt requirement in some schemes)
  terminal_receipt_text text,                                     -- printable EMV receipt block returned by the terminal, printed verbatim
  receipt_fields     jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.payment_intents(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE payments.webhook_inbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid,                                        -- resolved after parsing
  provider           text NOT NULL,
  provider_account_id uuid,
  external_event_id  text NOT NULL,
  event_type         text,
  signature_valid    boolean NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  status             text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed','invalid_signature')),
  attempts           smallint NOT NULL DEFAULT 0,
  error              text,
  payload            jsonb NOT NULL,
  UNIQUE (provider, external_event_id)
);
CREATE INDEX idx_webhook_inbox_pending ON payments.webhook_inbox (status, received_at) WHERE status IN ('received','failed');

CREATE TABLE payments.settlements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  provider_account_id  uuid NOT NULL,
  external_id          text NOT NULL,
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,
  currency             char(3) NOT NULL,
  gross_minor          bigint NOT NULL,
  fees_minor           bigint NOT NULL,
  refunds_minor        bigint NOT NULL DEFAULT 0,
  chargebacks_minor    bigint NOT NULL DEFAULT 0,
  net_minor            bigint NOT NULL,
  paid_out_at          timestamptz,
  status               text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','reconciling','reconciled','exceptions')),
  imported_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider_account_id, external_id),
  FOREIGN KEY (tenant_id, provider_account_id) REFERENCES payments.payment_provider_accounts(tenant_id, id)
);

CREATE TABLE payments.settlement_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  settlement_id  uuid NOT NULL,
  intent_id      uuid,
  refund_id      uuid,
  external_ref   text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('capture','refund','chargeback','fee','adjustment')),
  amount_minor   bigint NOT NULL,
  fee_minor      bigint NOT NULL DEFAULT 0,
  occurred_at    timestamptz,
  matched        boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES payments.settlements(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, intent_id)     REFERENCES payments.payment_intents(tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id)     REFERENCES payments.refunds(tenant_id, id)
);
CREATE INDEX idx_settlement_lines_unmatched ON payments.settlement_lines (tenant_id, settlement_id) WHERE NOT matched;

CREATE TABLE payments.reconciliation_exceptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES platform.tenants(id),
  domain              text NOT NULL CHECK (domain IN ('payments','inventory','cash','loyalty','gift_card','reporting','audit')),
  kind                text NOT NULL,                              -- missing_in_settlement, missing_in_platform, amount_mismatch, fee_mismatch, duplicate_capture_suspected, uncertain_aged, offline_declined, offline_expired, offline_cap_exceeded, balance_drift, projection_drift, chain_broken
  severity            text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  subject_kind        text,
  subject_id          uuid,
  details             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','accepted')),
  resolved_by         uuid,
  resolved_at         timestamptz,
  resolution_note     text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_recon_exceptions_open ON payments.reconciliation_exceptions (tenant_id, domain, status) WHERE status IN ('open','investigating');

CREATE TABLE payments.disputes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  intent_id           uuid NOT NULL,
  provider_reference  text NOT NULL,
  amount_minor        bigint NOT NULL,
  currency            char(3) NOT NULL,
  reason_code         text,
  status              text NOT NULL CHECK (status IN ('opened','evidence_required','submitted','won','lost','withdrawn')),
  evidence_due_at     timestamptz,
  opened_at           timestamptz NOT NULL,
  closed_at           timestamptz,
  FOREIGN KEY (tenant_id, intent_id) REFERENCES payments.payment_intents(tenant_id, id)
);

-- ---------------------------------------------------------------------
-- cash
-- ---------------------------------------------------------------------

CREATE TABLE cash.cash_drawers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  register_id  uuid,
  name         text NOT NULL,
  peripheral_id uuid,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES tenancy.registers(tenant_id, id)
);

CREATE TABLE cash.cash_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  register_id          uuid NOT NULL,
  drawer_id            uuid,
  business_date        date NOT NULL,
  currency             char(3) NOT NULL,
  opened_by            uuid NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  opening_float_minor  bigint NOT NULL DEFAULT 0,
  expected_minor       bigint,                                    -- opening + Σ movements, computed on close
  counted_minor        bigint,
  variance_minor       bigint,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closing','closed','approved')),
  closed_by            uuid,
  closed_at            timestamptz,
  approved_by          uuid,
  approved_at          timestamptz,
  variance_note        text,
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES tenancy.registers(tenant_id, id),
  FOREIGN KEY (tenant_id, drawer_id)   REFERENCES cash.cash_drawers(tenant_id, id)
);
CREATE UNIQUE INDEX uq_cash_sessions_open ON cash.cash_sessions (register_id) WHERE status IN ('open','closing');
CREATE INDEX idx_cash_sessions_day ON cash.cash_sessions (tenant_id, location_id, business_date);

CREATE TABLE cash.cash_movements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  session_id         uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('sale','refund','change','paid_in','paid_out','float_in','float_out','drop','transfer_in','transfer_out','adjustment','rounding','tip_out')),
  amount_minor       bigint NOT NULL,                             -- signed: + into drawer, - out
  payment_intent_id  uuid,
  refund_id          uuid,
  reference_kind     text,
  reference_id       uuid,
  reason             text,
  performed_by       uuid NOT NULL,
  approval_id        uuid,
  device_id          uuid,
  client_command_id  text,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id)        REFERENCES cash.cash_sessions(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_intent_id) REFERENCES payments.payment_intents(tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id)         REFERENCES payments.refunds(tenant_id, id)
);
CREATE INDEX idx_cash_movements_session ON cash.cash_movements (tenant_id, session_id, occurred_at);
CREATE TRIGGER trg_cash_movements_append_only BEFORE UPDATE OR DELETE ON cash.cash_movements
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();

CREATE TABLE cash.cash_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  session_id     uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('opening','mid','closing','recount')),
  is_blind       boolean NOT NULL DEFAULT true,
  denominations  jsonb NOT NULL DEFAULT '{}'::jsonb,              -- {"5000": 3, "2000": 10, ...} minor-unit keys
  total_minor    bigint NOT NULL,
  counted_by     uuid NOT NULL,
  counted_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES cash.cash_sessions(tenant_id, id)
);

-- ---------------------------------------------------------------------
-- tables: floor plans, tables, sessions, reservations, waitlist
-- ---------------------------------------------------------------------

CREATE TABLE tables.floor_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  name         text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  canvas       jsonb NOT NULL DEFAULT '{}'::jsonb,                -- width/height/background
  version      integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE tables.dining_areas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  floor_plan_id  uuid NOT NULL,
  name           text NOT NULL,                                   -- Main, Patio, Bar
  display_order  integer NOT NULL DEFAULT 0,
  service_charge_rule jsonb,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, floor_plan_id) REFERENCES tables.floor_plans(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE tables.tables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  dining_area_id  uuid NOT NULL,
  number          text NOT NULL,
  name            text,
  capacity_min    smallint NOT NULL DEFAULT 1,
  capacity_max    smallint NOT NULL DEFAULT 4,
  shape           text NOT NULL DEFAULT 'rect' CHECK (shape IN ('rect','round','booth','bar_seat','custom')),
  geometry        jsonb NOT NULL DEFAULT '{}'::jsonb,             -- {x,y,w,h,rotation}
  status          text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','reserved','dirty','blocked')),
  qr_code_ref     text,
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, number),
  FOREIGN KEY (tenant_id, location_id)    REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, dining_area_id) REFERENCES tables.dining_areas(tenant_id, id),
  CHECK (capacity_max >= capacity_min)
);
CREATE INDEX idx_tables_location_status ON tables.tables (tenant_id, location_id, status);

CREATE TABLE tables.reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  customer_id     uuid,
  guest_name      text NOT NULL,
  guest_phone_enc bytea,
  guest_email_enc bytea,
  party_size      smallint NOT NULL CHECK (party_size > 0),
  slot            tstzrange NOT NULL,
  status          text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','seated','completed','no_show','cancelled')),
  source          text NOT NULL DEFAULT 'pos' CHECK (source IN ('pos','phone','web','integration','walk_in')),
  external_ref    text,
  seating_preferences text,
  occasion        text,
  notes           text,
  reminder_sent_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);
CREATE INDEX idx_reservations_slot ON tables.reservations USING gist (location_id, slot);

CREATE TABLE tables.reservation_tables (
  tenant_id       uuid NOT NULL,
  reservation_id  uuid NOT NULL,
  table_id        uuid NOT NULL,
  slot            tstzrange NOT NULL,
  status          text NOT NULL,                                  -- mirrors reservation status for the exclusion predicate
  PRIMARY KEY (reservation_id, table_id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES tables.reservations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, table_id)       REFERENCES tables.tables(tenant_id, id),
  EXCLUDE USING gist (table_id WITH =, slot WITH &&) WHERE (status IN ('confirmed','seated'))
);

CREATE TABLE tables.table_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  reservation_id       uuid,
  server_employee_id   uuid,
  guest_count          smallint NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'seated' CHECK (status IN ('seated','ordering','dining','paying','closed')),
  seated_at            timestamptz NOT NULL DEFAULT now(),
  first_order_at       timestamptz,
  closed_at            timestamptz,
  merged_into_session_id uuid,
  notes                text,
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)        REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id)     REFERENCES tables.reservations(tenant_id, id),
  FOREIGN KEY (tenant_id, server_employee_id) REFERENCES workforce.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_session_id) REFERENCES tables.table_sessions(tenant_id, id)
);
CREATE INDEX idx_table_sessions_open ON tables.table_sessions (tenant_id, location_id) WHERE status <> 'closed';

-- Which physical tables a session occupies over time (merge = several active rows; transfer = close one, open another)
CREATE TABLE tables.table_session_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  session_id  uuid NOT NULL,
  table_id    uuid NOT NULL,
  from_at     timestamptz NOT NULL DEFAULT now(),
  to_at       timestamptz,
  FOREIGN KEY (tenant_id, session_id) REFERENCES tables.table_sessions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, table_id)   REFERENCES tables.tables(tenant_id, id)
);
CREATE UNIQUE INDEX uq_table_session_tables_active ON tables.table_session_tables (table_id) WHERE to_at IS NULL;
CREATE INDEX idx_table_session_tables_session ON tables.table_session_tables (tenant_id, session_id);

CREATE TABLE tables.waitlist_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  guest_name      text NOT NULL,
  guest_phone_enc bytea,
  party_size      smallint NOT NULL CHECK (party_size > 0),
  quoted_minutes  smallint,
  status          text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','notified','seated','left','removed')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  notified_at     timestamptz,
  seated_at       timestamptz,
  table_session_id uuid,
  notes           text,
  FOREIGN KEY (tenant_id, location_id)      REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, table_session_id) REFERENCES tables.table_sessions(tenant_id, id)
);
CREATE INDEX idx_waitlist_active ON tables.waitlist_entries (tenant_id, location_id, joined_at) WHERE status IN ('waiting','notified');

-- ---------------------------------------------------------------------
-- kitchen
-- ---------------------------------------------------------------------

CREATE TABLE kitchen.kitchen_stations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  location_id    uuid NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL DEFAULT 'prep' CHECK (kind IN ('prep','grill','fry','saute','cold','bar','dessert','pizza','expo','packing')),
  display_order  integer NOT NULL DEFAULT 0,
  fallback_printer_peripheral_id uuid,
  target_prep_seconds integer,
  is_expo        boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, name),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE kitchen.kitchen_routing_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  station_id  uuid NOT NULL,
  priority    integer NOT NULL DEFAULT 100,
  match       jsonb NOT NULL,                                     -- {category_ids:[], item_ids:[], kitchen_tags:[], channels:[], modifiers:[]}
  is_active   boolean NOT NULL DEFAULT true,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, station_id)  REFERENCES kitchen.kitchen_stations(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_routing_rules_location ON kitchen.kitchen_routing_rules (tenant_id, location_id, priority) WHERE is_active;

CREATE TABLE kitchen.kitchen_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  order_id         uuid NOT NULL,
  station_id       uuid NOT NULL,
  course_number    smallint NOT NULL DEFAULT 1,
  ticket_number    integer NOT NULL,                              -- per location per business date
  business_date    date NOT NULL,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','held','fired','acknowledged','in_progress','ready','bumped','recalled','cancelled')),
  priority         smallint NOT NULL DEFAULT 0,                   -- rush = higher
  order_summary    jsonb NOT NULL,                                -- {order_number, kind, table, server, guest_count, notes, allergen_flags}
  fired_at         timestamptz,
  target_ready_at  timestamptz,
  acknowledged_at  timestamptz,
  ready_at         timestamptz,
  bumped_at        timestamptz,
  bumped_by        uuid,
  printed_fallback boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)    REFERENCES orders.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, station_id)  REFERENCES kitchen.kitchen_stations(tenant_id, id)
);
CREATE INDEX idx_kitchen_tickets_queue ON kitchen.kitchen_tickets (tenant_id, station_id, priority DESC, fired_at)
  WHERE status NOT IN ('bumped','cancelled');
CREATE INDEX idx_kitchen_tickets_order ON kitchen.kitchen_tickets (tenant_id, order_id);
CREATE INDEX idx_kitchen_tickets_day ON kitchen.kitchen_tickets (tenant_id, location_id, business_date);

CREATE TABLE kitchen.kitchen_ticket_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  ticket_id          uuid NOT NULL,
  order_line_id      uuid NOT NULL,
  quantity           numeric(14,4) NOT NULL CHECK (quantity > 0),
  name               text NOT NULL,
  modifiers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes              text,
  seat_number        smallint,
  allergen_flags     text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','ready','bumped','cancelled','voided')),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id)     REFERENCES kitchen.kitchen_tickets(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES orders.order_lines(tenant_id, id)
);
CREATE INDEX idx_kitchen_ticket_items_ticket ON kitchen.kitchen_ticket_items (tenant_id, ticket_id);
CREATE INDEX idx_kitchen_ticket_items_line ON kitchen.kitchen_ticket_items (tenant_id, order_line_id);

-- PG16 does not allow identity columns on partitioned tables; explicit sequences are used instead.
CREATE SEQUENCE kitchen.kitchen_events_seq;
CREATE TABLE kitchen.kitchen_events (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  seq             bigint NOT NULL DEFAULT nextval('kitchen.kitchen_events_seq'),  -- replay cursor for stations
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  station_id      uuid NOT NULL,
  ticket_id       uuid NOT NULL,
  ticket_item_id  uuid,
  kind            text NOT NULL,                                  -- routed, fired, acknowledged, started, ready, bumped, recalled, cancelled, modified, printed_fallback
  from_status     text,
  to_status       text,
  actor_user_id   uuid,
  device_id       uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_kitchen_events_station_seq ON kitchen.kitchen_events (tenant_id, station_id, seq);
CREATE INDEX idx_kitchen_events_ticket ON kitchen.kitchen_events (tenant_id, ticket_id, occurred_at);
CREATE TRIGGER trg_kitchen_events_append_only BEFORE UPDATE OR DELETE ON kitchen.kitchen_events
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();
CREATE TABLE kitchen.kitchen_events_default PARTITION OF kitchen.kitchen_events DEFAULT;

CREATE TABLE kitchen.kitchen_station_cursors (
  tenant_id       uuid NOT NULL,
  station_id      uuid NOT NULL,
  device_id       uuid NOT NULL,
  last_event_seq  bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (station_id, device_id),
  FOREIGN KEY (tenant_id, station_id) REFERENCES kitchen.kitchen_stations(tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- customers & loyalty
-- ---------------------------------------------------------------------

CREATE TABLE customers.customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES platform.tenants(id),
  external_ref     text,
  first_name       text,
  last_name        text,
  display_name     text,
  email_enc        bytea,                                         -- application-side envelope encryption
  email_hash       bytea,                                         -- blind index (HMAC) for lookup
  phone_enc        bytea,
  phone_hash       bytea,
  date_of_birth_enc bytea,
  locale           text,
  tags             text[] NOT NULL DEFAULT '{}',
  home_location_id uuid,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','erased','blocked')),
  merged_into_id   uuid,
  erased_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, home_location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into_id)   REFERENCES customers.customers(tenant_id, id)
);
CREATE INDEX idx_customers_email_hash ON customers.customers (tenant_id, email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX idx_customers_phone_hash ON customers.customers (tenant_id, phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX idx_customers_name_trgm ON customers.customers USING gin (lower(coalesce(display_name, first_name || ' ' || last_name)) gin_trgm_ops);

CREATE TABLE customers.customer_identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  customer_id  uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('loyalty_card','ecommerce_id','delivery_platform_id','membership_number','external')),
  provider     text,
  value_hash   bytea NOT NULL,
  value_last4  text,
  verified     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_customer_identities ON customers.customer_identities (tenant_id, kind, COALESCE(provider, ''), value_hash);

CREATE TABLE customers.customer_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','segment','tier','wholesale','employee')),
  rules       jsonb,                                              -- dynamic segment definition
  UNIQUE (tenant_id, id)
);

CREATE TABLE customers.customer_group_members (
  tenant_id    uuid NOT NULL,
  group_id     uuid NOT NULL,
  customer_id  uuid NOT NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, customer_id),
  FOREIGN KEY (tenant_id, group_id)    REFERENCES customers.customer_groups(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id) ON DELETE CASCADE
);

-- Append-only; current consent = latest row per purpose
CREATE TABLE customers.consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  customer_id  uuid NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('marketing_email','marketing_sms','push','profiling','birthday_rewards','data_sharing_partners','loyalty_terms')),
  granted      boolean NOT NULL,
  source       text NOT NULL,                                     -- pos, web, import, api
  evidence     jsonb,
  recorded_by  uuid,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_consents_customer ON customers.consents (tenant_id, customer_id, purpose, recorded_at DESC);
CREATE TRIGGER trg_consents_append_only BEFORE UPDATE OR DELETE ON customers.consents
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();

CREATE TABLE customers.customer_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  customer_id  uuid NOT NULL,
  body         text NOT NULL,
  visibility   text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('staff','managers','support_only')),
  author_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE customers.loyalty_programs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES platform.tenants(id),
  name               text NOT NULL,
  scope_kind         text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('tenant','org_unit')),
  scope_id           uuid,
  currency           char(3) NOT NULL,
  earn_rules         jsonb NOT NULL,                              -- {points_per_minor, excluded_categories, multipliers}
  redeem_rules       jsonb NOT NULL,                              -- {minor_per_point, min_points, max_percent_of_check}
  tier_rules         jsonb NOT NULL DEFAULT '[]'::jsonb,
  points_expiry_days integer,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','ended')),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE customers.loyalty_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  program_id       uuid NOT NULL,
  customer_id      uuid NOT NULL,
  points_balance   bigint NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  lifetime_points  bigint NOT NULL DEFAULT 0,
  tier             text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (program_id, customer_id),
  FOREIGN KEY (tenant_id, program_id)  REFERENCES customers.loyalty_programs(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id)
);

CREATE TABLE customers.loyalty_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  account_id       uuid NOT NULL,
  delta_points     bigint NOT NULL CHECK (delta_points <> 0),
  kind             text NOT NULL CHECK (kind IN ('earn','redeem','adjust','expire','reverse','bonus','migrate')),
  order_id         uuid,
  refund_id        uuid,
  idempotency_key  text NOT NULL,                                 -- earn:<order_id>, reverse:<refund_id>
  expires_at       timestamptz,
  note             text,
  actor_user_id    uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customers.loyalty_accounts(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)   REFERENCES orders.orders(tenant_id, id)
);
CREATE INDEX idx_loyalty_ledger_account ON customers.loyalty_ledger (tenant_id, account_id, occurred_at);
CREATE TRIGGER trg_loyalty_ledger_append_only BEFORE UPDATE OR DELETE ON customers.loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();

CREATE TABLE customers.rewards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  program_id    uuid NOT NULL,
  name          text NOT NULL,
  cost_points   bigint NOT NULL CHECK (cost_points > 0),
  benefit       jsonb NOT NULL,                                   -- {kind:'free_item'|'amount_off'|'percent_off', ...}
  valid_from    timestamptz,
  valid_to      timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  FOREIGN KEY (tenant_id, program_id) REFERENCES customers.loyalty_programs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE customers.gift_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES platform.tenants(id),
  code_hash        bytea NOT NULL,
  code_last4       text NOT NULL,
  currency         char(3) NOT NULL,
  balance_minor    bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  initial_minor    bigint NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('inactive','active','depleted','expired','void')),
  issued_order_id  uuid,
  issued_location_id uuid,
  customer_id      uuid,
  expires_at       timestamptz,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code_hash),
  FOREIGN KEY (tenant_id, issued_order_id)    REFERENCES orders.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, issued_location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)        REFERENCES customers.customers(tenant_id, id)
);

CREATE TABLE customers.gift_card_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  gift_card_id       uuid NOT NULL,
  delta_minor        bigint NOT NULL CHECK (delta_minor <> 0),
  kind               text NOT NULL CHECK (kind IN ('issue','load','redeem','refund_to_card','adjust','expire','void')),
  payment_intent_id  uuid,
  order_id           uuid,
  idempotency_key    text NOT NULL,
  offline            boolean NOT NULL DEFAULT false,
  actor_user_id      uuid,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, gift_card_id)      REFERENCES customers.gift_cards(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_intent_id) REFERENCES payments.payment_intents(tenant_id, id)
);
CREATE INDEX idx_gift_card_ledger_card ON customers.gift_card_ledger (tenant_id, gift_card_id, occurred_at);
CREATE TRIGGER trg_gift_card_ledger_append_only BEFORE UPDATE OR DELETE ON customers.gift_card_ledger
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();

CREATE TABLE customers.store_credit_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  customer_id      uuid NOT NULL,
  currency         char(3) NOT NULL,
  delta_minor      bigint NOT NULL CHECK (delta_minor <> 0),
  kind             text NOT NULL CHECK (kind IN ('issue','redeem','adjust','expire','refund')),
  order_id         uuid,
  payment_intent_id uuid,
  idempotency_key  text NOT NULL,
  expires_at       timestamptz,
  actor_user_id    uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id)
);
CREATE INDEX idx_store_credit_customer ON customers.store_credit_ledger (tenant_id, customer_id, currency);
CREATE TRIGGER trg_store_credit_append_only BEFORE UPDATE OR DELETE ON customers.store_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();

-- ---------------------------------------------------------------------
-- devices & sync
-- ---------------------------------------------------------------------

CREATE TABLE devices.devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  location_id        uuid NOT NULL,
  register_id        uuid,
  kind               text NOT NULL CHECK (kind IN ('pos','kds','cfd','handheld','kiosk','store_hub','admin_browser')),
  name               text NOT NULL,
  platform           text,                                        -- windows, android, ios, macos, linux, web
  app_version        text,
  schema_version     integer,                                     -- local SQLite schema version
  enrollment_status  text NOT NULL DEFAULT 'pending' CHECK (enrollment_status IN ('pending','enrolled','revoked','wiped')),
  public_key         bytea,
  enrolled_at        timestamptz,
  revoked_at         timestamptz,
  wipe_requested_at  timestamptz,
  last_seen_at       timestamptz,
  health             jsonb NOT NULL DEFAULT '{}'::jsonb,          -- storage, battery, printer, terminal, pending_commands, offline_payment_count, offline_payment_sum_minor (caps enforced at the Payments Edge)
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, register_id) REFERENCES tenancy.registers(tenant_id, id)
);
CREATE INDEX idx_devices_location ON devices.devices (tenant_id, location_id, kind);
CREATE INDEX idx_devices_stale ON devices.devices (last_seen_at) WHERE enrollment_status = 'enrolled';

CREATE TABLE devices.device_enrollment_codes (
  code          text PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  register_id   uuid,
  kind          text NOT NULL,
  created_by    uuid NOT NULL,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  used_by_device_id uuid,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE devices.peripherals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  location_id    uuid NOT NULL,
  device_id      uuid,                                            -- host device (NULL = network peripheral owned by hub)
  kind           text NOT NULL CHECK (kind IN ('receipt_printer','kitchen_printer','label_printer','scanner','cash_drawer','scale','customer_display','payment_terminal','rfid_reader')),
  make_model     text,
  connection     text NOT NULL CHECK (connection IN ('usb','bluetooth','network','serial','builtin')),
  address        text,
  driver         text,                                            -- escpos, star_line, zebra_zpl, hid, ...
  capabilities   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline','error','paper_out','cover_open')),
  last_seen_at   timestamptz,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)   REFERENCES devices.devices(tenant_id, id)
);

CREATE TABLE devices.sync_cursors (
  tenant_id   uuid NOT NULL,
  device_id   uuid NOT NULL,
  stream      text NOT NULL,                                      -- catalog, config, customers, orders, kitchen, tables
  cursor      bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, stream),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices.devices(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE devices.sync_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  device_id        uuid NOT NULL,
  client_batch_id  text NOT NULL,
  command_count    integer NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','partial','failed')),
  results          jsonb,                                         -- per command: applied | duplicate | rejected{code}
  UNIQUE (device_id, client_batch_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices.devices(tenant_id, id)
);

CREATE TABLE devices.sync_commands_processed (
  device_id          uuid NOT NULL,
  client_command_id  text NOT NULL,
  result             text NOT NULL CHECK (result IN ('applied','rejected')),
  server_entity_id   uuid,
  processed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, client_command_id)
);

CREATE TABLE devices.sync_conflicts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  device_id        uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('pricing_mismatch','stale_edit','permission_rejected','duplicate_order_number','unknown_entity','validation_failed')),
  entity_kind      text NOT NULL,
  entity_id        uuid,
  client_command_id text,
  client_payload   jsonb NOT NULL,
  server_payload   jsonb,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_client','resolved_server','resolved_manual','dismissed')),
  resolved_by      uuid,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, device_id)   REFERENCES devices.devices(tenant_id, id)
);
CREATE INDEX idx_sync_conflicts_open ON devices.sync_conflicts (tenant_id, location_id) WHERE status = 'open';

-- Download stream for devices. Partitioned monthly, retained 90 days.
CREATE SEQUENCE devices.change_feed_seq;
CREATE TABLE devices.change_feed (
  seq          bigint NOT NULL DEFAULT nextval('devices.change_feed_seq'),
  tenant_id    uuid NOT NULL,
  location_id  uuid,                                              -- NULL = tenant-wide (catalog, config)
  stream       text NOT NULL,
  entity_kind  text NOT NULL,
  entity_id    uuid NOT NULL,
  op           text NOT NULL CHECK (op IN ('upsert','delete')),
  version      integer,
  payload      jsonb,                                             -- full row projection for small entities; NULL = fetch by id
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seq, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_change_feed_tenant_stream ON devices.change_feed (tenant_id, stream, seq);
CREATE INDEX idx_change_feed_location_stream ON devices.change_feed (tenant_id, location_id, stream, seq);
CREATE TABLE devices.change_feed_default PARTITION OF devices.change_feed DEFAULT;

-- ---------------------------------------------------------------------
-- audit, idempotency, outbox
-- ---------------------------------------------------------------------

CREATE SEQUENCE audit.audit_log_seq;
CREATE TABLE audit.audit_log (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  seq            bigint NOT NULL DEFAULT nextval('audit.audit_log_seq'),
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user','device','system','api_client','operator')),
  actor_id       uuid,
  on_behalf_of   uuid,                                            -- approver when action was approved
  device_id      uuid,
  location_id    uuid,
  action         text NOT NULL,                                   -- orders.void, catalog.price.changed, identity.role.granted ...
  resource_kind  text NOT NULL,
  resource_id    uuid,
  before         jsonb,
  after          jsonb,
  reason         text,
  approval_id    uuid,
  correlation_id uuid,
  ip             inet,
  prev_hash      bytea,
  hash           bytea NOT NULL,                                  -- sha256(prev_hash || canonical(row))
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_audit_log_tenant_time ON audit.audit_log (tenant_id, occurred_at);
CREATE INDEX idx_audit_log_resource ON audit.audit_log (tenant_id, resource_kind, resource_id);
CREATE INDEX idx_audit_log_actor ON audit.audit_log (tenant_id, actor_id, occurred_at);
CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();
CREATE TABLE audit.audit_log_default PARTITION OF audit.audit_log DEFAULT;

CREATE TABLE audit.audit_chain_heads (
  tenant_id   uuid PRIMARY KEY,
  head_hash   bytea NOT NULL,
  head_seq    bigint NOT NULL,
  anchored_at timestamptz,                                        -- last S3 Object Lock anchor
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit.idempotency_keys (
  tenant_id        uuid NOT NULL,
  scope            text NOT NULL,                                 -- principal or api client id + route
  key              text NOT NULL,
  request_hash     text NOT NULL,
  response_status  smallint,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, scope, key)
);
CREATE INDEX idx_idempotency_expiry ON audit.idempotency_keys (expires_at);

CREATE TABLE audit.outbox_events (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  location_id     uuid,
  aggregate_kind  text NOT NULL,
  aggregate_id    uuid NOT NULL,
  aggregate_version integer,
  event_type      text NOT NULL,                                  -- order.completed, payment.captured ...
  payload         jsonb NOT NULL,
  headers         jsonb NOT NULL DEFAULT '{}'::jsonb,             -- correlation_id, causation_id, actor
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        smallint NOT NULL DEFAULT 0,
  last_error      text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_outbox_unpublished ON audit.outbox_events (occurred_at) WHERE published_at IS NULL;
CREATE TABLE audit.outbox_events_default PARTITION OF audit.outbox_events DEFAULT;

CREATE TABLE audit.processed_events (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- ---------------------------------------------------------------------
-- integrations: webhooks out, connectors, external order links, fulfillments, notifications
-- ---------------------------------------------------------------------

CREATE TABLE integrations.webhook_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES platform.tenants(id),
  api_client_id uuid,
  name          text NOT NULL,
  url           text NOT NULL,
  secret_ref    text NOT NULL,
  event_types   text[] NOT NULL,
  location_filter uuid[],
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled_failures')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, api_client_id) REFERENCES identity.api_clients(tenant_id, id)
);

CREATE TABLE integrations.webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  event_id         uuid NOT NULL,
  event_type       text NOT NULL,
  attempt          smallint NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','exhausted')),
  response_code    smallint,
  response_ms      integer,
  error            text,
  next_retry_at    timestamptz,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id, attempt),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES integrations.webhook_subscriptions(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_webhook_deliveries_retry ON integrations.webhook_deliveries (next_retry_at) WHERE status IN ('pending','failed');

CREATE TABLE integrations.connectors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES platform.tenants(id),
  kind             text NOT NULL CHECK (kind IN ('accounting','erp','ecommerce','delivery','marketplace','tax','fiscalization','loyalty','marketing','payroll','scheduling','reservations','support','bi')),
  provider         text NOT NULL,                                 -- xero, myob, shopify, uber_eats, deliverect ...
  name             text NOT NULL,
  credentials_ref  text,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,            -- location mappings, account mappings
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','error','disabled')),
  health           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE integrations.external_order_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  connector_id    uuid NOT NULL,
  order_id        uuid,
  external_id     text NOT NULL,
  external_status text,
  raw             jsonb,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, external_id),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES integrations.connectors(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id)     REFERENCES orders.orders(tenant_id, id)
);

CREATE TABLE integrations.fulfillments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  order_id      uuid NOT NULL,
  location_id   uuid NOT NULL,                                    -- fulfilling location (ship-from-store)
  kind          text NOT NULL CHECK (kind IN ('pickup','ship','deliver','endless_aisle')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picking','packed','ready','dispatched','delivered','collected','cancelled','failed')),
  lines         jsonb NOT NULL,                                   -- [{order_line_id, quantity}]
  carrier       text,
  tracking_ref  text,
  promised_at   timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id)    REFERENCES orders.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);
CREATE INDEX idx_fulfillments_location_status ON integrations.fulfillments (tenant_id, location_id, status);

CREATE TABLE integrations.notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES platform.tenants(id),
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('customer','user','employee')),
  recipient_id   uuid NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('email','sms','push','in_app')),
  template_key   text NOT NULL,
  payload        jsonb NOT NULL,
  consent_checked boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','suppressed')),
  provider_ref   text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);
CREATE INDEX idx_notifications_queue ON integrations.notifications (status, created_at) WHERE status = 'queued';

CREATE TABLE integrations.report_exports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES platform.tenants(id),
  report_key     text NOT NULL,
  params         jsonb NOT NULL,
  format         text NOT NULL CHECK (format IN ('csv','xlsx','pdf','json')),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  file_uri       text,
  row_count      integer,
  requested_by   uuid NOT NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  expires_at     timestamptz
);

-- ---------------------------------------------------------------------
-- reporting read models (idempotent upserts by consumers)
-- ---------------------------------------------------------------------

CREATE TABLE reporting.freshness (
  tenant_id        uuid NOT NULL,
  stream           text NOT NULL,
  last_event_seq   bigint,
  last_event_at    timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream)
);

CREATE TABLE reporting.rm_sales_daily (
  tenant_id             uuid NOT NULL,
  location_id           uuid NOT NULL,
  business_date         date NOT NULL,
  channel               text NOT NULL,
  order_kind            text NOT NULL,
  currency              char(3) NOT NULL,
  order_count           integer NOT NULL DEFAULT 0,
  guest_count           integer NOT NULL DEFAULT 0,
  gross_minor           bigint NOT NULL DEFAULT 0,
  discount_minor        bigint NOT NULL DEFAULT 0,
  refund_minor          bigint NOT NULL DEFAULT 0,
  net_minor             bigint NOT NULL DEFAULT 0,
  tax_minor             bigint NOT NULL DEFAULT 0,
  tip_minor             bigint NOT NULL DEFAULT 0,
  service_charge_minor  bigint NOT NULL DEFAULT 0,
  cogs_minor            bigint NOT NULL DEFAULT 0,
  void_count            integer NOT NULL DEFAULT 0,
  void_minor            bigint NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, business_date, channel, order_kind, currency)
);
CREATE INDEX idx_rm_sales_daily_tenant ON reporting.rm_sales_daily (tenant_id, business_date);

CREATE TABLE reporting.rm_item_sales_daily (
  tenant_id       uuid NOT NULL,
  location_id     uuid NOT NULL,
  business_date   date NOT NULL,
  variant_id      uuid NOT NULL,
  item_name       text NOT NULL,
  category_path   text,
  quantity        numeric(14,4) NOT NULL DEFAULT 0,
  gross_minor     bigint NOT NULL DEFAULT 0,
  discount_minor  bigint NOT NULL DEFAULT 0,
  net_minor       bigint NOT NULL DEFAULT 0,
  cogs_minor      bigint NOT NULL DEFAULT 0,
  returned_qty    numeric(14,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, variant_id)
);
CREATE INDEX idx_rm_item_sales_tenant ON reporting.rm_item_sales_daily (tenant_id, business_date);

CREATE TABLE reporting.rm_payment_method_daily (
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  business_date    date NOT NULL,
  method           text NOT NULL,
  provider         text NOT NULL DEFAULT '',                      -- '' = no provider (cash, gift card)
  currency         char(3) NOT NULL,
  count            integer NOT NULL DEFAULT 0,
  captured_minor   bigint NOT NULL DEFAULT 0,
  refunded_minor   bigint NOT NULL DEFAULT 0,
  tip_minor        bigint NOT NULL DEFAULT 0,
  surcharge_minor  bigint NOT NULL DEFAULT 0,
  settled_minor    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, method, provider, currency)
);

CREATE TABLE reporting.rm_cash_variance_daily (
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  business_date    date NOT NULL,
  register_id      uuid NOT NULL,
  sessions         integer NOT NULL DEFAULT 0,
  expected_minor   bigint NOT NULL DEFAULT 0,
  counted_minor    bigint NOT NULL DEFAULT 0,
  variance_minor   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, register_id)
);

CREATE TABLE reporting.rm_kitchen_times_daily (
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  business_date        date NOT NULL,
  station_id           uuid NOT NULL,
  hour_of_day          smallint NOT NULL,
  tickets              integer NOT NULL DEFAULT 0,
  avg_prep_seconds     integer,
  p95_prep_seconds     integer,
  late_tickets         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, station_id, hour_of_day)
);

CREATE TABLE reporting.rm_inventory_valuation_daily (
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  business_date    date NOT NULL,
  category_path    text NOT NULL,
  on_hand_units    numeric(18,4) NOT NULL DEFAULT 0,
  value_minor      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, category_path)
);

-- ---------------------------------------------------------------------
-- Deferred cross-module FKs (declared after both sides exist)
-- ---------------------------------------------------------------------

ALTER TABLE orders.orders
  ADD FOREIGN KEY (tenant_id, customer_id)      REFERENCES customers.customers(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, table_session_id) REFERENCES tables.table_sessions(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, device_id)        REFERENCES devices.devices(tenant_id, id);

ALTER TABLE pricing.coupons
  ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id);

ALTER TABLE payments.payment_intents
  ADD FOREIGN KEY (tenant_id, gift_card_id) REFERENCES customers.gift_cards(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, customer_id)  REFERENCES customers.customers(tenant_id, id),
  ADD FOREIGN KEY (tenant_id, device_id)    REFERENCES devices.devices(tenant_id, id);

ALTER TABLE identity.auth_sessions
  ADD FOREIGN KEY (tenant_id, device_id) REFERENCES devices.devices(tenant_id, id);

ALTER TABLE tables.reservations
  ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id);

ALTER TABLE kitchen.kitchen_stations
  ADD FOREIGN KEY (tenant_id, fallback_printer_peripheral_id) REFERENCES devices.peripherals(tenant_id, id);

ALTER TABLE cash.cash_drawers
  ADD FOREIGN KEY (tenant_id, peripheral_id) REFERENCES devices.peripherals(tenant_id, id);

ALTER TABLE orders.return_authorizations
  ADD FOREIGN KEY (tenant_id, customer_id) REFERENCES customers.customers(tenant_id, id);

-- updated_at triggers for mutable tables in this part
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payments.payment_provider_accounts','payments.payment_intents',
    'tables.floor_plans','tables.reservations',
    'kitchen.kitchen_tickets','kitchen.kitchen_ticket_items',
    'customers.customers','integrations.fulfillments']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.fn_set_updated_at()',
                   replace(t, '.', '_'), t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Row-Level Security: every table with a tenant_id column in the module schemas.
-- platform.* is operator-only and excluded. audit.processed_events and
-- devices.sync_commands_processed have no tenant_id and are internal.
-- ---------------------------------------------------------------------

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_schema IN ('tenancy','identity','workforce','catalog','pricing','inventory','orders','payments',
                             'cash','tables','kitchen','customers','devices','audit','integrations','reporting')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = platform.current_tenant()) WITH CHECK (tenant_id = platform.current_tenant())',
      r.table_schema, r.table_name);
  END LOOP;
END $$;

-- System roles (identity.roles with tenant_id NULL) must be readable by every tenant: a second permissive policy.
CREATE POLICY system_roles_readable ON identity.roles FOR SELECT USING (tenant_id IS NULL);
-- payments.webhook_inbox rows arrive before the tenant is known; the payments deployable uses a bypass role for intake only.
-- (GRANT ... TO payments_intake; ALTER TABLE payments.webhook_inbox ... policy for that role is defined in infra.)

-- ---------------------------------------------------------------------
-- Seed: Australian GST baseline (per tenant, run by provisioning; shown as reference)
-- ---------------------------------------------------------------------
-- INSERT INTO catalog.tax_classes (tenant_id, code, name) VALUES ($t,'standard','GST standard'),($t,'gst_free','GST-free'),($t,'input_taxed','Input taxed');
-- INSERT INTO pricing.tax_rules (tenant_id, name, jurisdiction_country, tax_class_id, kind, rate, inclusive_default, valid_from)
--   SELECT $t, 'GST 10%', 'AU', id, 'vat_gst', 0.10, true, DATE '2000-07-01' FROM catalog.tax_classes WHERE tenant_id=$t AND code='standard';
-- INSERT INTO pricing.tax_rules (...) 0.00 for gst_free and input_taxed.

-- End of schema.
