-- =====================================================================
-- Part 2 of 3: catalog, pricing, inventory, orders
-- Requires schema.sql (part 1) applied first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- catalog: categories, tax classes, items, variants, barcodes, modifiers,
--          menus, availability, recipes, suppliers
-- ---------------------------------------------------------------------

CREATE TABLE catalog.tax_classes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id),
  code        text NOT NULL,                                      -- standard, gst_free, input_taxed, reduced
  name        text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE catalog.categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES platform.tenants(id),
  parent_id    uuid,
  kind         text NOT NULL CHECK (kind IN ('retail','menu','ingredient','service')),
  code         text,
  name         text NOT NULL,
  path         text NOT NULL,                                     -- materialized path "/food/burgers"
  display_order integer NOT NULL DEFAULT 0,
  image_uri    text,
  default_tax_class_id uuid,
  kitchen_tags text[] NOT NULL DEFAULT '{}',                      -- routing hints
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES catalog.categories(tenant_id, id),
  FOREIGN KEY (tenant_id, default_tax_class_id) REFERENCES catalog.tax_classes(tenant_id, id)
);
CREATE INDEX idx_categories_path ON catalog.categories (tenant_id, path text_pattern_ops);

CREATE TABLE catalog.items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES platform.tenants(id),
  kind             text NOT NULL CHECK (kind IN ('product','menu_item','ingredient','service','gift_card','fee','combo')),
  name             text NOT NULL,
  short_name       text,                                          -- receipt/KDS label
  description      text,
  category_id      uuid,
  brand_name       text,
  manufacturer     text,
  tax_class_id     uuid,
  sold_by          text NOT NULL DEFAULT 'unit' CHECK (sold_by IN ('unit','weight','volume','length')),
  unit_of_measure  text NOT NULL DEFAULT 'each',
  track_inventory  boolean NOT NULL DEFAULT true,
  is_age_restricted boolean NOT NULL DEFAULT false,
  min_age          smallint,
  images           jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes       jsonb NOT NULL DEFAULT '{}'::jsonb,            -- size/colour/material definitions, custom fields
  allergens        text[] NOT NULL DEFAULT '{}',
  dietary_tags     text[] NOT NULL DEFAULT '{}',
  kitchen_tags     text[] NOT NULL DEFAULT '{}',
  prep_time_seconds integer,
  search_vector    tsvector,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','discontinued','archived')),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)  REFERENCES catalog.categories(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_class_id) REFERENCES catalog.tax_classes(tenant_id, id)
);
CREATE INDEX idx_items_search ON catalog.items USING gin (search_vector);
CREATE INDEX idx_items_name_trgm ON catalog.items USING gin (lower(name) gin_trgm_ops);
CREATE INDEX idx_items_category ON catalog.items (tenant_id, status, category_id);
CREATE INDEX idx_items_kind ON catalog.items (tenant_id, kind, status);

CREATE TABLE catalog.item_variants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  item_id             uuid NOT NULL,
  sku                 text,
  name                text,                                       -- "Large / Red"
  option_values       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default          boolean NOT NULL DEFAULT false,
  default_price_minor bigint,                                     -- fallback when no price list applies
  cost_minor          bigint,                                     -- standard cost; actual cost lives on balances/layers
  weight_grams        integer,
  dimensions          jsonb,
  track_serials       boolean NOT NULL DEFAULT false,
  track_lots          boolean NOT NULL DEFAULT false,
  shelf_life_days     integer,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','discontinued','archived')),
  version             integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku),
  FOREIGN KEY (tenant_id, item_id) REFERENCES catalog.items(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_item_variants_item ON catalog.item_variants (tenant_id, item_id);
CREATE INDEX idx_item_variants_options ON catalog.item_variants USING gin (option_values);
CREATE UNIQUE INDEX uq_item_variants_default ON catalog.item_variants (item_id) WHERE is_default;

CREATE TABLE catalog.barcodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  variant_id    uuid NOT NULL,
  code          text NOT NULL,
  kind          text NOT NULL DEFAULT 'ean13' CHECK (kind IN ('ean13','ean8','upca','upce','code128','code39','qr','plu','internal','gs1_databar')),
  pack_quantity numeric(14,4) NOT NULL DEFAULT 1 CHECK (pack_quantity > 0),
  is_primary    boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES catalog.item_variants(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_barcodes_variant ON catalog.barcodes (tenant_id, variant_id);

CREATE TABLE catalog.units_of_measure (
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id),
  code        text NOT NULL,                                      -- each, kg, g, l, ml, m, case
  name        text NOT NULL,
  dimension   text NOT NULL CHECK (dimension IN ('count','mass','volume','length')),
  PRIMARY KEY (tenant_id, code)
);

CREATE TABLE catalog.unit_conversions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  variant_id  uuid,                                               -- NULL = generic (kg→g)
  from_unit   text NOT NULL,
  to_unit     text NOT NULL,
  factor      numeric(18,8) NOT NULL CHECK (factor > 0),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES catalog.item_variants(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_unit_conversions ON catalog.unit_conversions
  (tenant_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), from_unit, to_unit);

-- Bundles, kits, combos: parent variant composed of child variants
CREATE TABLE catalog.item_components (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  parent_variant_id uuid NOT NULL,
  child_variant_id  uuid NOT NULL,
  quantity          numeric(14,4) NOT NULL CHECK (quantity > 0),
  component_group   text,                                         -- "side", "drink" for combo choices
  is_optional       boolean NOT NULL DEFAULT false,
  price_delta_minor bigint NOT NULL DEFAULT 0,
  display_order     integer NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, parent_variant_id) REFERENCES catalog.item_variants(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, child_variant_id)  REFERENCES catalog.item_variants(tenant_id, id),
  CHECK (parent_variant_id <> child_variant_id)
);
CREATE INDEX idx_item_components_parent ON catalog.item_components (tenant_id, parent_variant_id);

CREATE TABLE catalog.modifier_groups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES platform.tenants(id),
  name           text NOT NULL,
  prompt         text,                                            -- "Choose your size"
  selection_min  smallint NOT NULL DEFAULT 0 CHECK (selection_min >= 0),
  selection_max  smallint CHECK (selection_max IS NULL OR selection_max >= selection_min),
  allow_repeat   boolean NOT NULL DEFAULT false,                  -- "extra extra cheese"
  display_order  integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version        integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.modifiers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  group_id           uuid NOT NULL,
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'add' CHECK (kind IN ('add','remove','substitute','instruction')),
  price_delta_minor  bigint NOT NULL DEFAULT 0,
  linked_variant_id  uuid,                                        -- stock deduction when no recipe effect
  is_default         boolean NOT NULL DEFAULT false,
  max_quantity       smallint NOT NULL DEFAULT 1,
  kitchen_label      text,
  display_order      integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id)          REFERENCES catalog.modifier_groups(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, linked_variant_id) REFERENCES catalog.item_variants(tenant_id, id)
);
CREATE INDEX idx_modifiers_group ON catalog.modifiers (tenant_id, group_id);

CREATE TABLE catalog.item_modifier_groups (
  tenant_id     uuid NOT NULL,
  item_id       uuid NOT NULL,
  group_id      uuid NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  overrides     jsonb NOT NULL DEFAULT '{}'::jsonb,               -- per-item min/max/price overrides
  PRIMARY KEY (item_id, group_id),
  FOREIGN KEY (tenant_id, item_id)  REFERENCES catalog.items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, group_id) REFERENCES catalog.modifier_groups(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE catalog.menus (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id),
  name        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version     integer NOT NULL DEFAULT 1,                         -- bumped on publish; devices pull by version
  published_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE catalog.menu_sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  menu_id           uuid NOT NULL,
  parent_section_id uuid,
  name              text NOT NULL,
  display_order     integer NOT NULL DEFAULT 0,
  layout            jsonb NOT NULL DEFAULT '{}'::jsonb,           -- grid colour, columns
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_id)           REFERENCES catalog.menus(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_section_id) REFERENCES catalog.menu_sections(tenant_id, id)
);

CREATE TABLE catalog.menu_section_items (
  tenant_id            uuid NOT NULL,
  section_id           uuid NOT NULL,
  item_id              uuid NOT NULL,
  display_order        integer NOT NULL DEFAULT 0,
  price_override_minor bigint,
  label_override       text,
  PRIMARY KEY (section_id, item_id),
  FOREIGN KEY (tenant_id, section_id) REFERENCES catalog.menu_sections(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id)    REFERENCES catalog.items(tenant_id, id)
);

-- Where/when/which channel a menu applies. Resolver picks highest priority active row.
CREATE TABLE catalog.menu_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  menu_id     uuid NOT NULL,
  scope_kind  text NOT NULL CHECK (scope_kind IN ('tenant','org_unit','location','register')),
  scope_id    uuid NOT NULL,
  channel     text NOT NULL DEFAULT 'all' CHECK (channel IN ('all','dine_in','takeaway','delivery','online','kiosk','qr','drive_through')),
  schedule    jsonb NOT NULL DEFAULT '{}'::jsonb,                 -- {days:[1..7], windows:[{from:'06:00',to:'11:00'}]}
  valid_from  timestamptz,
  valid_to    timestamptz,
  priority    integer NOT NULL DEFAULT 100,
  FOREIGN KEY (tenant_id, menu_id) REFERENCES catalog.menus(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_menu_assignments_scope ON catalog.menu_assignments (tenant_id, scope_kind, scope_id, channel);

-- The "86" list: availability independent from inventory balances
CREATE TABLE catalog.item_availability (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  item_id       uuid,
  variant_id    uuid,
  is_available  boolean NOT NULL DEFAULT true,
  snoozed_until timestamptz,
  reason        text,
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id)     REFERENCES catalog.items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id)  REFERENCES catalog.item_variants(tenant_id, id) ON DELETE CASCADE,
  CHECK (item_id IS NOT NULL OR variant_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_item_availability ON catalog.item_availability
  (location_id, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE catalog.recipes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  output_variant_id uuid NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  yield_quantity  numeric(14,4) NOT NULL DEFAULT 1 CHECK (yield_quantity > 0),
  yield_unit      text NOT NULL DEFAULT 'each',
  consume_on      text NOT NULL DEFAULT 'completed' CHECK (consume_on IN ('fired','completed','production')),
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, output_variant_id, version),
  FOREIGN KEY (tenant_id, output_variant_id) REFERENCES catalog.item_variants(tenant_id, id)
);
CREATE UNIQUE INDEX uq_recipes_active ON catalog.recipes (output_variant_id) WHERE is_active;

CREATE TABLE catalog.recipe_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  recipe_id             uuid NOT NULL,
  ingredient_variant_id uuid NOT NULL,
  quantity              numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit                  text NOT NULL,
  waste_factor          numeric(6,4) NOT NULL DEFAULT 0 CHECK (waste_factor >= 0 AND waste_factor < 1),
  is_substitutable      boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id, recipe_id)             REFERENCES catalog.recipes(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_variant_id) REFERENCES catalog.item_variants(tenant_id, id)
);
CREATE INDEX idx_recipe_lines_recipe ON catalog.recipe_lines (tenant_id, recipe_id);

CREATE TABLE catalog.modifier_recipe_effects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  modifier_id           uuid NOT NULL,
  ingredient_variant_id uuid NOT NULL,
  quantity_delta        numeric(14,4) NOT NULL,                   -- negative for "no onion"
  unit                  text NOT NULL,
  FOREIGN KEY (tenant_id, modifier_id)           REFERENCES catalog.modifiers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, ingredient_variant_id) REFERENCES catalog.item_variants(tenant_id, id)
);

CREATE TABLE catalog.suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES platform.tenants(id),
  code            text,
  name            text NOT NULL,
  contacts        jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_terms   text,
  lead_time_days  integer,
  min_order_minor bigint,
  currency        char(3),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE catalog.supplier_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  supplier_id     uuid NOT NULL,
  variant_id      uuid NOT NULL,
  supplier_sku    text,
  cost_minor      bigint NOT NULL,
  currency        char(3) NOT NULL,
  pack_size       numeric(14,4) NOT NULL DEFAULT 1,
  purchase_unit   text NOT NULL DEFAULT 'each',
  moq             numeric(14,4),
  lead_time_days  integer,
  is_preferred    boolean NOT NULL DEFAULT false,
  valid_from      date,
  valid_to        date,
  UNIQUE (supplier_id, variant_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id)  REFERENCES catalog.item_variants(tenant_id, id)
);

-- ---------------------------------------------------------------------
-- pricing: tax rules, price lists, promotions, coupons
-- ---------------------------------------------------------------------

CREATE TABLE pricing.tax_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  name                 text NOT NULL,
  jurisdiction_country char(2) NOT NULL,
  jurisdiction_region  text,                                      -- state/province, NULL = whole country
  tax_class_id         uuid,                                      -- NULL = default for jurisdiction
  kind                 text NOT NULL CHECK (kind IN ('vat_gst','sales_tax','excise','levy')),
  rate                 numeric(9,6) NOT NULL CHECK (rate >= 0),
  inclusive_default    boolean NOT NULL DEFAULT true,             -- AU: prices include GST
  compound             boolean NOT NULL DEFAULT false,
  priority             integer NOT NULL DEFAULT 100,
  valid_from           date NOT NULL,
  valid_to             date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, tax_class_id) REFERENCES catalog.tax_classes(tenant_id, id)
);
CREATE INDEX idx_tax_rules_lookup ON pricing.tax_rules (tenant_id, jurisdiction_country, jurisdiction_region, tax_class_id, valid_from);

CREATE TABLE pricing.price_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES platform.tenants(id),
  name        text NOT NULL,
  currency    char(3) NOT NULL,
  kind        text NOT NULL DEFAULT 'retail' CHECK (kind IN ('retail','wholesale','member','channel','clearance','employee')),
  tax_inclusive boolean NOT NULL DEFAULT true,
  priority    integer NOT NULL DEFAULT 100,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE pricing.price_list_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  price_list_id  uuid NOT NULL,
  variant_id     uuid NOT NULL,
  price_minor    bigint NOT NULL CHECK (price_minor >= 0),
  min_quantity   numeric(14,4) NOT NULL DEFAULT 1,                -- tiered pricing
  valid_from     timestamptz,
  valid_to       timestamptz,
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES pricing.price_lists(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id)    REFERENCES catalog.item_variants(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_price_entries ON pricing.price_list_entries (price_list_id, variant_id, min_quantity, COALESCE(valid_from, '-infinity'::timestamptz));
CREATE INDEX idx_price_entries_variant ON pricing.price_list_entries (tenant_id, variant_id);

CREATE TABLE pricing.price_list_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  price_list_id  uuid NOT NULL,
  scope_kind     text NOT NULL CHECK (scope_kind IN ('tenant','org_unit','location','channel','customer_group','customer')),
  scope_id       uuid,                                            -- NULL for channel (use scope_value)
  scope_value    text,                                            -- channel name
  priority       integer NOT NULL DEFAULT 100,
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES pricing.price_lists(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_price_assignments_scope ON pricing.price_list_assignments (tenant_id, scope_kind, scope_id);

CREATE TABLE pricing.promotions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES platform.tenants(id),
  code            text,
  name            text NOT NULL,
  description     text,
  kind            text NOT NULL CHECK (kind IN ('percent_off','amount_off','fixed_price','bogo','multibuy','bundle','threshold','loyalty_price','employee')),
  rules           jsonb NOT NULL,                                 -- contracts: PromotionRules DSL (conditions + effects)
  priority        integer NOT NULL DEFAULT 100,
  stack_group     text,                                           -- promotions in same group don't stack
  is_exclusive    boolean NOT NULL DEFAULT false,
  requires_coupon boolean NOT NULL DEFAULT false,
  max_uses_total  integer,
  max_uses_per_customer integer,
  uses_count      integer NOT NULL DEFAULT 0,
  budget_minor    bigint,
  spent_minor     bigint NOT NULL DEFAULT 0,
  schedule        jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','paused','ended','archived')),
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_promotions_active ON pricing.promotions (tenant_id, status, valid_from, valid_to);

CREATE TABLE pricing.promotion_scopes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  promotion_id uuid NOT NULL,
  scope_kind   text NOT NULL CHECK (scope_kind IN ('tenant','org_unit','location','channel','customer_group')),
  scope_id     uuid,
  scope_value  text,
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES pricing.promotions(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_promotion_scopes ON pricing.promotion_scopes
  (promotion_id, scope_kind, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(scope_value, ''));

CREATE TABLE pricing.coupons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  promotion_id  uuid NOT NULL,
  code          text NOT NULL,
  customer_id   uuid,                                             -- customers.customers (FK in part 3)
  max_uses      integer NOT NULL DEFAULT 1,
  uses_count    integer NOT NULL DEFAULT 0,
  expires_at    timestamptz,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','expired','void')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, promotion_id) REFERENCES pricing.promotions(tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- inventory: locations/bins, balances, ledger, lots, serials, reservations,
--            reorder rules, purchasing, transfers, counts, cost layers
-- ---------------------------------------------------------------------

CREATE TABLE inventory.inventory_locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'sellable' CHECK (kind IN ('sellable','backroom','quarantine','damaged','in_transit','production')),
  is_default   boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, location_id, code),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);
CREATE UNIQUE INDEX uq_inventory_locations_default ON inventory.inventory_locations (location_id) WHERE is_default;

CREATE TABLE inventory.lots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  variant_id   uuid NOT NULL,
  lot_number   text NOT NULL,
  expires_at   date,
  received_at  timestamptz NOT NULL DEFAULT now(),
  supplier_id  uuid,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','recalled','depleted')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, variant_id, lot_number),
  FOREIGN KEY (tenant_id, variant_id)  REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers(tenant_id, id)
);
CREATE INDEX idx_lots_expiry ON inventory.lots (tenant_id, expires_at) WHERE status = 'active';

CREATE TABLE inventory.serials (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL,
  variant_id                    uuid NOT NULL,
  serial_number                 text NOT NULL,
  status                        text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','reserved','sold','returned','in_transit','damaged','written_off')),
  current_inventory_location_id uuid,
  sold_order_line_id            uuid,
  warranty_until                date,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, variant_id, serial_number),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, current_inventory_location_id) REFERENCES inventory.inventory_locations(tenant_id, id)
);

-- Append-only ledger. Partitioned monthly by occurred_at. No FKs point at this table.
CREATE TABLE inventory.inventory_movements (
  id                    uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  variant_id            uuid NOT NULL,
  inventory_location_id uuid NOT NULL,
  quantity_delta        numeric(14,4) NOT NULL,
  unit_cost_minor       bigint,
  cost_delta_minor      bigint,                                   -- landed cost allocations without qty change
  reason                text NOT NULL CHECK (reason IN (
                          'sale','return','receipt','transfer_out','transfer_in','adjustment','count_variance',
                          'waste','damage','write_off','production_in','production_out','recipe_consumption',
                          'reservation_release','opening_balance','staff_meal','comp')),
  reference_kind        text,                                     -- order_line, goods_receipt_line, transfer_line, count_line, waste_record
  reference_id          uuid,
  lot_id                uuid,
  serial_id             uuid,
  performed_by          uuid,
  device_id             uuid,
  client_command_id     text,
  notes                 text,
  occurred_at           timestamptz NOT NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at),
  FOREIGN KEY (tenant_id, variant_id)            REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_location_id) REFERENCES inventory.inventory_locations(tenant_id, id),
  CHECK (quantity_delta <> 0 OR cost_delta_minor IS NOT NULL)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_inv_movements_variant ON inventory.inventory_movements (tenant_id, variant_id, inventory_location_id, occurred_at);
CREATE INDEX idx_inv_movements_ref ON inventory.inventory_movements (tenant_id, reference_kind, reference_id);
CREATE INDEX idx_inv_movements_lot ON inventory.inventory_movements (tenant_id, lot_id) WHERE lot_id IS NOT NULL;
CREATE TRIGGER trg_inv_movements_append_only BEFORE UPDATE OR DELETE ON inventory.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();
-- pg_partman manages partitions; a default partition catches stragglers.
CREATE TABLE inventory.inventory_movements_default PARTITION OF inventory.inventory_movements DEFAULT;

-- Derived projection, updated in the same transaction as each movement; proven nightly.
CREATE TABLE inventory.inventory_balances (
  tenant_id             uuid NOT NULL,
  variant_id            uuid NOT NULL,
  inventory_location_id uuid NOT NULL,
  on_hand               numeric(14,4) NOT NULL DEFAULT 0,
  reserved              numeric(14,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  avg_cost_minor        bigint,
  last_movement_id      uuid,
  last_counted_at       timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, inventory_location_id),
  FOREIGN KEY (tenant_id, variant_id)            REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_location_id) REFERENCES inventory.inventory_locations(tenant_id, id)
);
CREATE INDEX idx_inv_balances_location ON inventory.inventory_balances (tenant_id, inventory_location_id);
CREATE INDEX idx_inv_balances_low ON inventory.inventory_balances (tenant_id, inventory_location_id, on_hand);

CREATE TABLE inventory.stock_reservations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  variant_id            uuid NOT NULL,
  inventory_location_id uuid NOT NULL,
  quantity              numeric(14,4) NOT NULL CHECK (quantity > 0),
  reference_kind        text NOT NULL,                            -- order, external_order, transfer, layby
  reference_id          uuid NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','fulfilled','expired')),
  expires_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  released_at           timestamptz,
  FOREIGN KEY (tenant_id, variant_id)            REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_location_id) REFERENCES inventory.inventory_locations(tenant_id, id)
);
CREATE INDEX idx_reservations_active ON inventory.stock_reservations (tenant_id, variant_id, inventory_location_id) WHERE status = 'active';
CREATE INDEX idx_reservations_ref ON inventory.stock_reservations (tenant_id, reference_kind, reference_id);

CREATE TABLE inventory.reorder_rules (
  tenant_id             uuid NOT NULL,
  variant_id            uuid NOT NULL,
  location_id           uuid NOT NULL,
  min_level             numeric(14,4) NOT NULL DEFAULT 0,
  max_level             numeric(14,4),
  safety_stock          numeric(14,4) NOT NULL DEFAULT 0,
  preferred_supplier_id uuid,
  auto_suggest          boolean NOT NULL DEFAULT true,
  PRIMARY KEY (variant_id, location_id),
  FOREIGN KEY (tenant_id, variant_id)  REFERENCES catalog.item_variants(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, preferred_supplier_id) REFERENCES catalog.suppliers(tenant_id, id)
);

CREATE TABLE inventory.purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  location_id    uuid NOT NULL,                                   -- deliver-to
  supplier_id    uuid NOT NULL,
  number         text NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','sent','partially_received','received','closed','cancelled')),
  currency       char(3) NOT NULL,
  expected_at    date,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  tax_minor      bigint NOT NULL DEFAULT 0,
  total_minor    bigint NOT NULL DEFAULT 0,
  notes          text,
  created_by     uuid,
  approved_by    uuid,
  approved_at    timestamptz,
  sent_at        timestamptz,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers(tenant_id, id)
);
CREATE INDEX idx_po_status ON inventory.purchase_orders (tenant_id, location_id, status);

CREATE TABLE inventory.purchase_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  purchase_order_id  uuid NOT NULL,
  variant_id         uuid NOT NULL,
  quantity_ordered   numeric(14,4) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received  numeric(14,4) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  purchase_unit      text NOT NULL DEFAULT 'each',
  unit_cost_minor    bigint NOT NULL,
  tax_minor          bigint NOT NULL DEFAULT 0,
  supplier_sku       text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES inventory.purchase_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id)        REFERENCES catalog.item_variants(tenant_id, id)
);
CREATE INDEX idx_po_lines_po ON inventory.purchase_order_lines (tenant_id, purchase_order_id);

CREATE TABLE inventory.goods_receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  purchase_order_id  uuid,
  location_id        uuid NOT NULL,
  number             text NOT NULL,
  supplier_invoice_ref text,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  received_by        uuid,
  received_at        timestamptz NOT NULL DEFAULT now(),
  posted_at          timestamptz,
  landed_cost_minor  bigint NOT NULL DEFAULT 0,                   -- allocated across lines on post
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES inventory.purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)       REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE inventory.goods_receipt_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  goods_receipt_id        uuid NOT NULL,
  purchase_order_line_id  uuid,
  variant_id              uuid NOT NULL,
  inventory_location_id   uuid NOT NULL,
  quantity                numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_cost_minor         bigint NOT NULL,
  lot_id                  uuid,
  expires_at              date,
  FOREIGN KEY (tenant_id, goods_receipt_id)       REFERENCES inventory.goods_receipts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, purchase_order_line_id) REFERENCES inventory.purchase_order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id)             REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_location_id)  REFERENCES inventory.inventory_locations(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id)                 REFERENCES inventory.lots(tenant_id, id)
);

CREATE TABLE inventory.stock_transfers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  number            text NOT NULL,
  from_location_id  uuid NOT NULL,
  to_location_id    uuid NOT NULL,
  status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','picking','dispatched','partially_received','received','cancelled')),
  requested_by      uuid,
  approved_by       uuid,
  dispatched_at     timestamptz,
  received_at       timestamptz,
  notes             text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, from_location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, to_location_id)   REFERENCES tenancy.locations(tenant_id, id),
  CHECK (from_location_id <> to_location_id)
);

CREATE TABLE inventory.stock_transfer_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  transfer_id          uuid NOT NULL,
  variant_id           uuid NOT NULL,
  quantity_requested   numeric(14,4) NOT NULL CHECK (quantity_requested > 0),
  quantity_dispatched  numeric(14,4) NOT NULL DEFAULT 0,
  quantity_received    numeric(14,4) NOT NULL DEFAULT 0,
  lot_id               uuid,
  FOREIGN KEY (tenant_id, transfer_id) REFERENCES inventory.stock_transfers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id)  REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id)      REFERENCES inventory.lots(tenant_id, id),
  CHECK (quantity_received <= quantity_dispatched)
);

CREATE TABLE inventory.stock_counts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('cycle','full','spot')),
  is_blind      boolean NOT NULL DEFAULT true,
  scope         jsonb NOT NULL DEFAULT '{}'::jsonb,               -- categories / bins included
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','review','approved','cancelled')),
  started_at    timestamptz,
  completed_at  timestamptz,
  approved_by   uuid,
  approved_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE inventory.stock_count_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  count_id              uuid NOT NULL,
  variant_id            uuid NOT NULL,
  inventory_location_id uuid NOT NULL,
  lot_id                uuid,
  expected_quantity     numeric(14,4),                            -- snapshot at count start (hidden if blind)
  counted_quantity      numeric(14,4),
  variance              numeric(14,4) GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED,
  counted_by            uuid,
  counted_at            timestamptz,
  recount_requested     boolean NOT NULL DEFAULT false,
  FOREIGN KEY (tenant_id, count_id)              REFERENCES inventory.stock_counts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, variant_id)            REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_location_id) REFERENCES inventory.inventory_locations(tenant_id, id)
);
CREATE UNIQUE INDEX uq_stock_count_lines ON inventory.stock_count_lines
  (count_id, variant_id, inventory_location_id, COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- FIFO cost layers (only for tenants with costing_method = 'fifo')
CREATE TABLE inventory.cost_layers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  variant_id            uuid NOT NULL,
  inventory_location_id uuid NOT NULL,
  source_movement_id    uuid NOT NULL,
  quantity_initial      numeric(14,4) NOT NULL CHECK (quantity_initial > 0),
  quantity_remaining    numeric(14,4) NOT NULL CHECK (quantity_remaining >= 0),
  unit_cost_minor       bigint NOT NULL,
  received_at           timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, variant_id)            REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_location_id) REFERENCES inventory.inventory_locations(tenant_id, id)
);
CREATE INDEX idx_cost_layers_fifo ON inventory.cost_layers (tenant_id, variant_id, inventory_location_id, received_at) WHERE quantity_remaining > 0;

CREATE TABLE inventory.waste_records (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  location_id           uuid NOT NULL,
  variant_id            uuid NOT NULL,
  quantity              numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit                  text NOT NULL,
  reason                text NOT NULL CHECK (reason IN ('spoilage','overproduction','prep_waste','dropped','expired','customer_return','other')),
  cost_minor            bigint,
  recorded_by           uuid,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  notes                 text,
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id)  REFERENCES catalog.item_variants(tenant_id, id)
);

-- ---------------------------------------------------------------------
-- orders: orders, checks, lines, modifiers, taxes, discounts, charges,
--         events, receipts, number sequences
-- ---------------------------------------------------------------------

CREATE TABLE orders.order_number_sequences (
  tenant_id     uuid NOT NULL,
  location_id   uuid NOT NULL,
  business_date date NOT NULL,
  next_value    integer NOT NULL DEFAULT 1,
  PRIMARY KEY (location_id, business_date),
  FOREIGN KEY (tenant_id, location_id) REFERENCES tenancy.locations(tenant_id, id)
);

CREATE TABLE orders.orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  location_id          uuid NOT NULL,
  register_id          uuid,
  device_id            uuid,
  order_number         integer,                                   -- canonical per location/business date, assigned on server
  client_order_ref     text,                                      -- offline ref "R1-000123"
  business_date        date NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('retail_sale','return','exchange','layby','special_order',
                                                    'dine_in','takeaway','pickup','delivery','counter','drive_through',
                                                    'online','phone','catering','staff_meal')),
  channel              text NOT NULL DEFAULT 'pos' CHECK (channel IN ('pos','kiosk','qr','online','marketplace','delivery_platform','phone','api')),
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','suspended','completed','cancelled','voided')),
  fulfillment_status   text NOT NULL DEFAULT 'unfulfilled' CHECK (fulfillment_status IN ('unfulfilled','in_preparation','partially_ready','ready','fulfilled','not_applicable')),
  payment_status       text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partially_paid','paid','partially_refunded','refunded','not_applicable')),
  customer_id          uuid,                                      -- FK in part 3
  table_session_id     uuid,                                      -- FK in part 3
  guest_count          smallint,
  employee_id          uuid,                                      -- cashier/server
  currency             char(3) NOT NULL,
  pricing_mode         text NOT NULL DEFAULT 'tax_inclusive' CHECK (pricing_mode IN ('tax_inclusive','tax_exclusive')),
  price_list_id        uuid,
  config_version       integer,                                   -- catalog/pricing config version used by client
  subtotal_minor       bigint NOT NULL DEFAULT 0,
  discount_minor       bigint NOT NULL DEFAULT 0,
  tax_minor            bigint NOT NULL DEFAULT 0,
  charges_minor        bigint NOT NULL DEFAULT 0,
  tip_minor            bigint NOT NULL DEFAULT 0,
  rounding_minor       bigint NOT NULL DEFAULT 0,
  total_minor          bigint NOT NULL DEFAULT 0,
  paid_minor           bigint NOT NULL DEFAULT 0,
  refunded_minor       bigint NOT NULL DEFAULT 0,
  source_order_id      uuid,                                      -- for returns/exchanges
  external_ref         text,                                      -- online/delivery platform id
  scheduled_for        timestamptz,
  notes                text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  placed_at            timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  voided_at            timestamptz,
  void_reason          text,
  void_approval_id     uuid,
  reopened_at          timestamptz,                               -- completed -> open, allowed only when an offline card payment was declined after forwarding
  reopened_reason      text CHECK (reopened_reason IN ('offline_payment_declined','offline_payment_expired')),
  client_created_at    timestamptz,
  synced_at            timestamptz,
  settlement_pending   boolean NOT NULL DEFAULT false,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id)     REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, register_id)     REFERENCES tenancy.registers(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES workforce.employees(tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id)   REFERENCES pricing.price_lists(tenant_id, id),
  FOREIGN KEY (tenant_id, source_order_id) REFERENCES orders.orders(tenant_id, id),
  CHECK (total_minor = subtotal_minor - discount_minor + CASE WHEN pricing_mode = 'tax_exclusive' THEN tax_minor ELSE 0 END + charges_minor + tip_minor + rounding_minor)
);
CREATE UNIQUE INDEX uq_orders_number ON orders.orders (tenant_id, location_id, business_date, order_number) WHERE order_number IS NOT NULL;
CREATE UNIQUE INDEX uq_orders_client_ref ON orders.orders (tenant_id, location_id, client_order_ref) WHERE client_order_ref IS NOT NULL;
CREATE INDEX idx_orders_day ON orders.orders (tenant_id, location_id, business_date);
CREATE INDEX idx_orders_open ON orders.orders (tenant_id, location_id, status) WHERE status IN ('open','suspended','draft');
CREATE INDEX idx_orders_customer ON orders.orders (tenant_id, customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_orders_table_session ON orders.orders (tenant_id, table_session_id) WHERE table_session_id IS NOT NULL;
CREATE INDEX idx_orders_external ON orders.orders (tenant_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX idx_orders_settlement_pending ON orders.orders (tenant_id, location_id) WHERE settlement_pending;

CREATE TABLE orders.checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  order_id        uuid NOT NULL,
  number          smallint NOT NULL DEFAULT 1,
  label           text,                                           -- "Seat 2", "Alice"
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','voided')),
  subtotal_minor  bigint NOT NULL DEFAULT 0,
  discount_minor  bigint NOT NULL DEFAULT 0,
  tax_minor       bigint NOT NULL DEFAULT 0,
  charges_minor   bigint NOT NULL DEFAULT 0,
  tip_minor       bigint NOT NULL DEFAULT 0,
  rounding_minor  bigint NOT NULL DEFAULT 0,
  total_minor     bigint NOT NULL DEFAULT 0,
  paid_minor      bigint NOT NULL DEFAULT 0,
  refunded_minor  bigint NOT NULL DEFAULT 0,
  closed_at       timestamptz,
  closed_by       uuid,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (order_id, number),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders.orders(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE orders.order_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  order_id              uuid NOT NULL,
  check_id              uuid NOT NULL,
  seq                   integer NOT NULL,
  parent_line_id        uuid,                                     -- combo/bundle component
  variant_id            uuid,                                     -- NULL for open/custom items
  item_snapshot         jsonb NOT NULL,                           -- {item_id, name, sku, kind, tax_class_code, category_path}
  quantity              numeric(14,4) NOT NULL CHECK (quantity > 0),
  unit_of_measure       text NOT NULL DEFAULT 'each',
  list_price_minor      bigint NOT NULL,                          -- resolved base price before overrides/discounts
  unit_price_minor      bigint NOT NULL,                          -- price actually charged per unit (after override)
  price_override_reason text,
  price_override_approval_id uuid,
  discount_minor        bigint NOT NULL DEFAULT 0,
  tax_minor             bigint NOT NULL DEFAULT 0,
  total_minor           bigint NOT NULL,                          -- quantity*unit_price - discount (+ tax if exclusive)
  cost_minor            bigint,                                   -- COGS snapshot at sale
  seat_number           smallint,
  course_number         smallint,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided','returned','cancelled')),
  void_reason           text,
  voided_by             uuid,
  void_approval_id      uuid,
  voided_at             timestamptz,
  kitchen_status        text CHECK (kitchen_status IN ('not_sent','held','sent','in_progress','ready','served','cancelled')),
  fulfillment_mode      text NOT NULL DEFAULT 'take' CHECK (fulfillment_mode IN ('take','pickup','ship','deliver','dine_in')),
  return_of_line_id     uuid,
  returned_quantity     numeric(14,4) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  serial_id             uuid,
  lot_id                uuid,
  notes                 text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (order_id, seq),
  FOREIGN KEY (tenant_id, order_id)          REFERENCES orders.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, check_id)          REFERENCES orders.checks(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_line_id)    REFERENCES orders.order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id)        REFERENCES catalog.item_variants(tenant_id, id),
  FOREIGN KEY (tenant_id, return_of_line_id) REFERENCES orders.order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, serial_id)         REFERENCES inventory.serials(tenant_id, id),
  FOREIGN KEY (tenant_id, lot_id)            REFERENCES inventory.lots(tenant_id, id),
  CHECK (returned_quantity <= quantity)
);
CREATE INDEX idx_order_lines_order ON orders.order_lines (tenant_id, order_id);
CREATE INDEX idx_order_lines_check ON orders.order_lines (tenant_id, check_id);
CREATE INDEX idx_order_lines_variant ON orders.order_lines (tenant_id, variant_id, created_at) WHERE variant_id IS NOT NULL;
CREATE INDEX idx_order_lines_return_of ON orders.order_lines (tenant_id, return_of_line_id) WHERE return_of_line_id IS NOT NULL;

CREATE TABLE orders.order_line_modifiers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  order_line_id      uuid NOT NULL,
  modifier_id        uuid,
  group_name         text,
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'add',
  quantity           smallint NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_delta_minor  bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES orders.order_lines(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, modifier_id)   REFERENCES catalog.modifiers(tenant_id, id)
);
CREATE INDEX idx_order_line_modifiers_line ON orders.order_line_modifiers (tenant_id, order_line_id);

CREATE TABLE orders.order_line_taxes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  order_line_id  uuid NOT NULL,
  tax_rule_id    uuid,
  tax_name       text NOT NULL,
  rate           numeric(9,6) NOT NULL,
  taxable_minor  bigint NOT NULL,
  tax_minor      bigint NOT NULL,
  inclusive      boolean NOT NULL,
  exempt_reason  text,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES orders.order_lines(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tax_rule_id)   REFERENCES pricing.tax_rules(tenant_id, id)
);
CREATE INDEX idx_order_line_taxes_line ON orders.order_line_taxes (tenant_id, order_line_id);

CREATE TABLE orders.order_discounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  order_id       uuid NOT NULL,
  order_line_id  uuid,                                            -- NULL = order-level
  kind           text NOT NULL CHECK (kind IN ('promotion','manual','coupon','loyalty','employee','price_match','markdown')),
  promotion_id   uuid,
  coupon_id      uuid,
  description    text NOT NULL,
  percent        numeric(7,4),
  amount_minor   bigint NOT NULL CHECK (amount_minor >= 0),
  approval_id    uuid,
  applied_by     uuid,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  trace          jsonb,                                           -- rule evaluation trace from domain-core
  FOREIGN KEY (tenant_id, order_id)      REFERENCES orders.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES orders.order_lines(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, promotion_id)  REFERENCES pricing.promotions(tenant_id, id),
  FOREIGN KEY (tenant_id, coupon_id)     REFERENCES pricing.coupons(tenant_id, id)
);
CREATE INDEX idx_order_discounts_order ON orders.order_discounts (tenant_id, order_id);
CREATE INDEX idx_order_discounts_promotion ON orders.order_discounts (tenant_id, promotion_id, applied_at) WHERE promotion_id IS NOT NULL;

CREATE TABLE orders.order_charges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  order_id      uuid NOT NULL,
  check_id      uuid,
  kind          text NOT NULL CHECK (kind IN ('service_charge','surcharge','delivery_fee','packaging_fee','gratuity','deposit','other')),
  description   text NOT NULL,
  amount_minor  bigint NOT NULL,
  tax_minor     bigint NOT NULL DEFAULT 0,
  is_gratuity   boolean NOT NULL DEFAULT false,
  distribution  jsonb,                                            -- tip pooling / employee allocation
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders.orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, check_id) REFERENCES orders.checks(tenant_id, id)
);
CREATE INDEX idx_order_charges_order ON orders.order_charges (tenant_id, order_id);

-- Append-only lifecycle, partitioned monthly
CREATE TABLE orders.order_events (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  order_id       uuid NOT NULL,
  kind           text NOT NULL,                                   -- created, line_added, line_voided, discount_applied, placed, fired, suspended, resumed, check_split, check_merged, payment_applied, completed, voided, returned, note_added, transferred, reopened_offline_decline
  from_status    text,
  to_status      text,
  actor_user_id  uuid,
  device_id      uuid,
  approval_id    uuid,
  client_command_id text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_order_events_order ON orders.order_events (tenant_id, order_id, occurred_at);
CREATE TRIGGER trg_order_events_append_only BEFORE UPDATE OR DELETE ON orders.order_events
  FOR EACH ROW EXECUTE FUNCTION platform.fn_forbid_mutation();
CREATE TABLE orders.order_events_default PARTITION OF orders.order_events DEFAULT;

CREATE TABLE orders.receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  order_id       uuid NOT NULL,
  check_id       uuid,
  number         text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('sale','refund','reprint','gift','proforma','kitchen','void')),
  template_key   text NOT NULL,
  rendered_uri   text,                                            -- S3 object
  delivered_via  text[] NOT NULL DEFAULT '{}',                    -- print, email, sms, qr
  fiscal_data    jsonb,                                           -- fiscalization signature if any
  printed_by     uuid,
  device_id      uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, check_id) REFERENCES orders.checks(tenant_id, id)
);
CREATE INDEX idx_receipts_order ON orders.receipts (tenant_id, order_id);

-- Return merchandise authorizations (Phase 3)
CREATE TABLE orders.return_authorizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  source_order_id  uuid,
  customer_id      uuid,
  number           text NOT NULL,
  status           text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','received','refunded','rejected','cancelled')),
  reason           text,
  lines            jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, location_id)    REFERENCES tenancy.locations(tenant_id, id),
  FOREIGN KEY (tenant_id, source_order_id) REFERENCES orders.orders(tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'catalog.categories','catalog.items','catalog.item_variants','catalog.modifier_groups','catalog.menus','catalog.suppliers',
    'pricing.price_lists','pricing.promotions',
    'inventory.inventory_balances','inventory.purchase_orders','inventory.stock_transfers',
    'orders.orders','orders.checks']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.fn_set_updated_at()',
                   replace(t, '.', '_'), t);
  END LOOP;
END $$;

-- Full-text maintenance for items
CREATE OR REPLACE FUNCTION catalog.fn_items_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.short_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.brand_name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER trg_items_search_vector BEFORE INSERT OR UPDATE OF name, short_name, brand_name, description ON catalog.items
  FOR EACH ROW EXECUTE FUNCTION catalog.fn_items_search_vector();

-- End of part 2. Continue with schema_part3.sql (payments, cash, tables, kitchen, customers, devices, audit, integrations, reporting, RLS).
