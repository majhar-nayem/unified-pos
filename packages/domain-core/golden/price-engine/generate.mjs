// Generates the F3 golden cases (one JSON file per case) next to this script.
//
//   node packages/domain-core/golden/price-engine/generate.mjs
//
// Expected values are NOT taken from the engine. They are either literals worked out by hand (the
// description of each case shows the arithmetic) or come from the tiny independent oracles below
// (half-up division, Hamilton allocation, the RBA 5c rule) written with plain integer maths.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as prettier from 'prettier';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(dir)) if (/^\d{3}-.*\.json$/.test(f)) rmSync(join(dir, f));
mkdirSync(dir, { recursive: true });

// ---- independent oracles -------------------------------------------------------------------
const div = (a, b) => Math.floor((2 * a + b) / (2 * b)); // half-up, positive operands
const gstOf = (inclusiveAmount) => div(inclusiveAmount * 10, 110);
const cashRound = (n) => {
  const r = n % 5;
  return r === 0 ? n : r <= 2 ? n - r : n + (5 - r);
};
function hamilton(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const floors = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

// ---- builders ------------------------------------------------------------------------------
const AT_MON_1PM = '2026-10-19T02:00:00Z'; // Monday 13:00 in Sydney (AEDT, UTC+11)
const AT_MON_430PM = '2026-10-19T05:30:00Z'; // Monday 16:30 in Sydney
const baseContext = (extra = {}) => ({
  at: AT_MON_1PM,
  timezone: 'Australia/Sydney',
  locationId: 'loc-syd',
  orgUnitPath: ['ou-nsw', 'ou-root'],
  channel: 'pos',
  jurisdiction: { country: 'AU', region: 'NSW' },
  ...extra,
});
const line = (id, variantId, quantity, price, extra = {}) => ({
  id,
  variantId,
  quantity: String(quantity),
  defaultUnitPriceMinor: price,
  ...extra,
});
const draft = (lines, extra = {}) => ({ currency: 'AUD', lines, ...extra });
const GST_RULES = [
  {
    id: 'gst-std',
    name: 'GST',
    taxClassId: null,
    rate: '0.10',
    inclusiveDefault: true,
    country: 'AU',
  },
  {
    id: 'gst-free',
    name: 'GST-free',
    taxClassId: 'free',
    rate: '0',
    inclusiveDefault: true,
    country: 'AU',
  },
];
const promo = (id, kind, rules, extra = {}) => ({
  id,
  name: id,
  kind,
  rules: { version: 1, ...rules },
  validFrom: '2026-01-01T00:00:00Z',
  status: 'active',
  ...extra,
});
const all = { all: true };

let counter = 0;
const pending = [];
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
function emit({
  name,
  description,
  tags = [],
  draft: d,
  context = baseContext(),
  taxRules,
  stackTaxRules,
  expected,
  error,
}) {
  counter += 1;
  const file = `${String(counter).padStart(3, '0')}-${slug(name)}.json`;
  const body = {
    name,
    description,
    tags,
    input: {
      draft: d,
      context,
      ...(taxRules ? { taxRules } : {}),
      ...(stackTaxRules ? { stackTaxRules } : {}),
    },
    ...(error ? { expectError: error } : { expected }),
  };
  pending.push([file, body]);
}

// ======================================================================================
// A. Brief: burger meal deal
// ======================================================================================
const BURGER = 1400;
const FRIES = 600;
const DRINK = 450;
const mealDeal = (extra = {}) =>
  promo(
    'meal-deal',
    'fixed_price',
    {
      targets: all,
      effect: {
        kind: 'fixed_price',
        priceMinor: 1800,
        bundle: [
          { targets: { variantIds: ['v-burger'] }, quantity: 1 },
          { targets: { variantIds: ['v-fries'] }, quantity: 1 },
          { targets: { variantIds: ['v-drink'] }, quantity: 1 },
        ],
      },
    },
    extra,
  );
const mealLines = (b, f, d) => [
  line('l1', 'v-burger', b, BURGER, { itemId: 'i-burger' }),
  line('l2', 'v-fries', f, FRIES, { itemId: 'i-fries' }),
  line('l3', 'v-drink', d, DRINK, { itemId: 'i-drink' }),
];

emit({
  name: 'burger meal deal: burger + fries + drink for $18.00',
  description:
    'Burger 1400 + fries 600 + drink 450 = 2450; bundle price 1800 so the discount is 650. Largest remainder over [1400,600,450]: floors 371,159,119 (sum 649), remainders 1050,450,950 so the burger takes the spare cent: 372,159,119. Nets 1028,441,331. GST inclusive: 1028/11=93.45->93, 441/11=40.09->40, 331/11=30.09->30.',
  tags: ['brief', 'bundle', 'allocation'],
  draft: draft(mealLines(1, 1, 1)),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: {
    subtotalMinor: 2450,
    promotionDiscountMinor: 650,
    discountMinor: 650,
    totalMinor: 1800,
    taxMinor: 93 + 40 + 30,
    amountDueMinor: 1800,
    lines: [
      { id: 'l1', promotionDiscountMinor: 372, netMinor: 1028, taxMinor: 93 },
      { id: 'l2', promotionDiscountMinor: 159, netMinor: 441, taxMinor: 40 },
      { id: 'l3', promotionDiscountMinor: 119, netMinor: 331, taxMinor: 30 },
    ],
    promotions: [{ promotionId: 'meal-deal', amountMinor: 650, applications: 1 }],
  },
});
emit({
  name: 'burger meal deal twice for two of each',
  description: 'Two complete sets: two bundles, discount 2 x 650 = 1300, total 4900 - 1300 = 3600.',
  tags: ['brief', 'bundle'],
  draft: draft(mealLines(2, 2, 2)),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: {
    promotionDiscountMinor: 1300,
    totalMinor: 3600,
    promotions: [{ promotionId: 'meal-deal', amountMinor: 1300, applications: 2 }],
    lines: [
      { promotionDiscountMinor: 744 },
      { promotionDiscountMinor: 318 },
      { promotionDiscountMinor: 238 },
    ],
  },
});
emit({
  name: 'burger meal deal leaves the extra burger at full price',
  description:
    'Two burgers, one fries, one drink: one bundle (650 off), the second burger stays 1400. Total 3850 - 650 = 3200.',
  tags: ['brief', 'bundle'],
  draft: draft(mealLines(2, 1, 1)),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: { promotionDiscountMinor: 650, totalMinor: 3200, promotions: [{ applications: 1 }] },
});
emit({
  name: 'burger meal deal not triggered without the drink',
  description:
    'Burger + fries only: the drink component cannot be filled, so no bundle and total 2000.',
  tags: ['brief', 'bundle'],
  draft: draft([mealLines(1, 1, 0)[0], mealLines(1, 1, 0)[1]]),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: {
    promotionDiscountMinor: 0,
    totalMinor: 2000,
    promotions: [],
    skippedPromotions: [{ promotionId: 'meal-deal', reason: 'no_effect' }],
  },
});
emit({
  name: 'burger meal deal bundle price above the parts gives no discount',
  description:
    'Cheap combo: 450 + 450 + 450 = 1350 which is below the 1800 bundle price: nothing applies.',
  tags: ['brief', 'bundle'],
  draft: draft([
    line('l1', 'v-burger', 1, 450),
    line('l2', 'v-fries', 1, 450),
    line('l3', 'v-drink', 1, 450),
  ]),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: { promotionDiscountMinor: 0, totalMinor: 1350 },
});
emit({
  name: 'burger meal deal with a modifier priced into the burger',
  description:
    'Burger 1400 + bacon 200 = 1600 unit, fries 600, drink 450 = 2650; discount 850. Hamilton over [1600,600,450]: 1600*850/2650=513.2, 192.45, 144.3: floors 513,192,144 (849), remainders by 1600*850 mod 2650 = 1360000-513*2650=1360000-1359450=550, 510000-192*2650=510000-508800=1200, 382500-144*2650=382500-381600=900: largest 1200 -> fries: 513,193,144.',
  tags: ['brief', 'bundle', 'modifier'],
  draft: draft([
    line('l1', 'v-burger', 1, BURGER, { modifiers: [{ id: 'bacon', priceMinor: 200 }] }),
    line('l2', 'v-fries', 1, FRIES),
    line('l3', 'v-drink', 1, DRINK),
  ]),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: {
    subtotalMinor: 2650,
    promotionDiscountMinor: 850,
    totalMinor: 1800,
    lines: [
      { promotionDiscountMinor: 513 },
      { promotionDiscountMinor: 193 },
      { promotionDiscountMinor: 144 },
    ],
  },
});
emit({
  name: 'burger meal deal stacked with a 10 percent staff discount at order level',
  description:
    'Meal deal brings 2450 to 1800; a 10% order discount then takes 180 off the remaining 1800 (allocated 1028/441/331 -> 103,44,33 by largest remainder: exact 102.8,44.1,33.1 -> floors 102,44,33 = 179, spare to .8 -> 103,44,33). Total 1620.',
  tags: ['brief', 'bundle', 'order-discount'],
  draft: draft(mealLines(1, 1, 1), {
    manualDiscounts: [
      {
        id: 'staff',
        kind: 'percent',
        value: '10',
        authorization: { authorizedBy: 'mgr-1', method: 'pin' },
      },
    ],
  }),
  context: baseContext({ promotions: [mealDeal()] }),
  expected: {
    orderDiscountMinor: 180,
    totalMinor: 1620,
    discountMinor: 830,
    lines: [{ orderDiscountMinor: 103 }, { orderDiscountMinor: 44 }, { orderDiscountMinor: 33 }],
  },
});

// ======================================================================================
// B. Price resolution
// ======================================================================================
const list = (id, price, assignments, extra = {}) => ({
  id,
  currency: 'AUD',
  taxInclusive: true,
  status: 'active',
  entries: [{ id: `${id}-e1`, variantId: 'v-1', priceMinor: price }],
  assignments,
  ...extra,
});
const one = (extra = {}) => draft([line('l1', 'v-1', 1, 1000, extra)]);

emit({
  name: 'price: variant default when nothing else applies',
  description: '1000 GST inclusive: tax 1000/11 = 90.9 -> 91.',
  tags: ['price'],
  draft: one(),
  expected: {
    totalMinor: 1000,
    taxMinor: 91,
    lines: [{ priceSource: { kind: 'variant_default' } }],
  },
});
emit({
  name: 'price: authorised override beats lists and default',
  description: 'Override 800 x 2 = 1600 (tax 145.45 -> 145). The source records who authorised it.',
  tags: ['price', 'override'],
  draft: draft([
    line('l1', 'v-1', 2, 1000, {
      priceOverride: {
        unitPriceMinor: 800,
        reason: 'damaged box',
        authorization: { authorizedBy: 'mgr-7', approvalId: 'ap-9', method: 'pin' },
      },
    }),
  ]),
  context: baseContext({ priceLists: [list('pl', 900, [{ scopeKind: 'tenant' }])] }),
  expected: {
    totalMinor: 1600,
    taxMinor: 145,
    lines: [
      {
        baseUnitPriceMinor: 800,
        priceSource: { kind: 'override', authorizedBy: 'mgr-7', approvalId: 'ap-9' },
      },
    ],
    trace: undefined,
  },
});
emit({
  name: 'price: tenant price list beats the variant default',
  description: 'List price 900.',
  tags: ['price', 'list'],
  draft: one(),
  context: baseContext({ priceLists: [list('pl', 900, [{ scopeKind: 'tenant' }])] }),
  expected: {
    totalMinor: 900,
    lines: [{ priceSource: { kind: 'price_list', priceListId: 'pl', entryId: 'pl-e1' } }],
  },
});
emit({
  name: 'price: location list beats tenant list at equal priority',
  description: 'Same assignment and list priority: the more specific scope (location) wins: 850.',
  tags: ['price', 'list', 'scope'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('tenant-list', 900, [{ scopeKind: 'tenant' }]),
      list('loc-list', 850, [{ scopeKind: 'location', scopeId: 'loc-syd' }]),
    ],
  }),
  expected: { totalMinor: 850, lines: [{ priceSource: { priceListId: 'loc-list' } }] },
});
emit({
  name: 'price: nearer org unit beats a farther one',
  description: 'orgUnitPath is nearest first, so ou-nsw (850) beats ou-root (900).',
  tags: ['price', 'list', 'scope'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('root-list', 900, [{ scopeKind: 'org_unit', scopeId: 'ou-root' }]),
      list('nsw-list', 850, [{ scopeKind: 'org_unit', scopeId: 'ou-nsw' }]),
    ],
  }),
  expected: { totalMinor: 850, lines: [{ priceSource: { priceListId: 'nsw-list' } }] },
});
emit({
  name: 'price: lower assignment priority number wins over scope specificity',
  description: 'Tenant assignment priority 10 beats location assignment priority 100: 900.',
  tags: ['price', 'list', 'priority'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('tenant-first', 900, [{ scopeKind: 'tenant', priority: 10 }]),
      list('loc-list', 850, [{ scopeKind: 'location', scopeId: 'loc-syd', priority: 100 }]),
    ],
  }),
  expected: { totalMinor: 900, lines: [{ priceSource: { priceListId: 'tenant-first' } }] },
});
emit({
  name: 'price: list priority breaks a tie between assignments',
  description: 'Both tenant-wide, list priority 50 beats 100.',
  tags: ['price', 'list', 'priority'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('slow', 900, [{ scopeKind: 'tenant' }], { priority: 100 }),
      list('fast', 880, [{ scopeKind: 'tenant' }], { priority: 50 }),
    ],
  }),
  expected: { totalMinor: 880, lines: [{ priceSource: { priceListId: 'fast' } }] },
});
emit({
  name: 'price: customer group list beats the location list',
  description:
    'Member list (customer group tier) 800 beats location list 850 regardless of priority.',
  tags: ['price', 'list', 'customer'],
  draft:
    one() &&
    draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c-1', groupIds: ['g-member'] } }),
  context: baseContext({
    priceLists: [
      list('loc-list', 850, [{ scopeKind: 'location', scopeId: 'loc-syd', priority: 1 }]),
      list('member', 800, [{ scopeKind: 'customer_group', scopeId: 'g-member' }], {
        kind: 'member',
      }),
    ],
  }),
  expected: { totalMinor: 800, lines: [{ priceSource: { priceListId: 'member' } }] },
});
emit({
  name: 'price: customer-specific list beats the group list',
  description: 'Customer assignment (specificity 30) beats group (20): 700.',
  tags: ['price', 'list', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c-1', groupIds: ['g-member'] } }),
  context: baseContext({
    priceLists: [
      list('member', 800, [{ scopeKind: 'customer_group', scopeId: 'g-member' }]),
      list('vip', 700, [{ scopeKind: 'customer', scopeId: 'c-1' }]),
    ],
  }),
  expected: { totalMinor: 700, lines: [{ priceSource: { priceListId: 'vip' } }] },
});
emit({
  name: 'price: non-member falls back to the location list',
  description: 'Customer without the group does not see the member list.',
  tags: ['price', 'list', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c-2', groupIds: [] } }),
  context: baseContext({
    priceLists: [
      list('loc-list', 850, [{ scopeKind: 'location', scopeId: 'loc-syd' }]),
      list('member', 800, [{ scopeKind: 'customer_group', scopeId: 'g-member' }]),
    ],
  }),
  expected: { totalMinor: 850 },
});
emit({
  name: 'price: channel list applies only on its channel',
  description: 'Online list ignored at the POS channel: default 1000.',
  tags: ['price', 'list', 'channel'],
  draft: one(),
  context: baseContext({
    priceLists: [list('online', 900, [{ scopeKind: 'channel', scopeValue: 'online' }])],
  }),
  expected: { totalMinor: 1000, lines: [{ priceSource: { kind: 'variant_default' } }] },
});
emit({
  name: 'price: channel list applies on its channel',
  description: 'Same list with channel pos: 900.',
  tags: ['price', 'list', 'channel'],
  draft: one(),
  context: baseContext({
    priceLists: [list('pos-list', 900, [{ scopeKind: 'channel', scopeValue: 'pos' }])],
  }),
  expected: { totalMinor: 900 },
});
emit({
  name: 'price: tiered entries pick the highest reached minimum quantity',
  description: 'Tiers 1:1000, 6:900, 12:800. Quantity 6 -> 900 each = 5400.',
  tags: ['price', 'tier'],
  draft: draft([line('l1', 'v-1', 6, 1000)]),
  context: baseContext({
    priceLists: [
      list('tiers', 0, [{ scopeKind: 'tenant' }], {
        entries: [
          { id: 't1', variantId: 'v-1', priceMinor: 1000, minQuantity: '1' },
          { id: 't6', variantId: 'v-1', priceMinor: 900, minQuantity: '6' },
          { id: 't12', variantId: 'v-1', priceMinor: 800, minQuantity: '12' },
        ],
      }),
    ],
  }),
  expected: {
    subtotalMinor: 5400,
    lines: [{ baseUnitPriceMinor: 900, priceSource: { entryId: 't6' } }],
  },
});
emit({
  name: 'price: a list with only a higher tier falls through to the default',
  description: 'Entry needs 10 units; 3 bought, so the variant default 1000 x 3 = 3000.',
  tags: ['price', 'tier'],
  draft: draft([line('l1', 'v-1', 3, 1000)]),
  context: baseContext({
    priceLists: [
      list('bulk', 0, [{ scopeKind: 'tenant' }], {
        entries: [{ id: 'b10', variantId: 'v-1', priceMinor: 700, minQuantity: '10' }],
      }),
    ],
  }),
  expected: { subtotalMinor: 3000, lines: [{ priceSource: { kind: 'variant_default' } }] },
});
emit({
  name: 'price: expired entry is ignored',
  description: 'validTo is before the sale time.',
  tags: ['price', 'validity'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('old', 0, [{ scopeKind: 'tenant' }], {
        entries: [{ id: 'e', variantId: 'v-1', priceMinor: 500, validTo: '2026-10-01T00:00:00Z' }],
      }),
    ],
  }),
  expected: { totalMinor: 1000, lines: [{ priceSource: { kind: 'variant_default' } }] },
});
emit({
  name: 'price: future entry is ignored',
  description: 'validFrom after the sale time.',
  tags: ['price', 'validity'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('soon', 0, [{ scopeKind: 'tenant' }], {
        entries: [
          { id: 'e', variantId: 'v-1', priceMinor: 500, validFrom: '2026-11-01T00:00:00Z' },
        ],
      }),
    ],
  }),
  expected: { totalMinor: 1000 },
});
emit({
  name: 'price: the latest validFrom wins among valid entries of equal tier',
  description: 'Two valid entries: the newer (700) replaces the older (800).',
  tags: ['price', 'validity'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('seasonal', 0, [{ scopeKind: 'tenant' }], {
        entries: [
          { id: 'old', variantId: 'v-1', priceMinor: 800, validFrom: '2026-01-01T00:00:00Z' },
          { id: 'new', variantId: 'v-1', priceMinor: 700, validFrom: '2026-10-01T00:00:00Z' },
        ],
      }),
    ],
  }),
  expected: { totalMinor: 700, lines: [{ priceSource: { entryId: 'new' } }] },
});
emit({
  name: 'price: draft, archived and foreign-currency lists never apply',
  description: 'Only the active AUD list (900) counts.',
  tags: ['price', 'list', 'status'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('draft', 100, [{ scopeKind: 'tenant', priority: 1 }], { status: 'draft' }),
      list('archived', 100, [{ scopeKind: 'tenant', priority: 1 }], { status: 'archived' }),
      list('usd', 100, [{ scopeKind: 'tenant', priority: 1 }], { currency: 'USD' }),
      list('live', 900, [{ scopeKind: 'tenant', priority: 50 }]),
    ],
  }),
  expected: { totalMinor: 900, lines: [{ priceSource: { priceListId: 'live' } }] },
});
emit({
  name: 'price: list without an entry for the variant falls through to the next list',
  description: 'Higher-ranked list prices another variant; the lower-ranked one prices v-1 at 880.',
  tags: ['price', 'list'],
  draft: one(),
  context: baseContext({
    priceLists: [
      list('other', 100, [{ scopeKind: 'tenant', priority: 1 }], {
        entries: [{ id: 'x', variantId: 'v-other', priceMinor: 100 }],
      }),
      list('mine', 880, [{ scopeKind: 'tenant', priority: 2 }]),
    ],
  }),
  expected: { totalMinor: 880 },
});
emit({
  name: 'price: tax-exclusive price list adds GST on top',
  description: 'List price 1000 exclusive at 10%: tax 100, total 1100.',
  tags: ['price', 'tax'],
  draft: one(),
  context: baseContext({
    priceLists: [list('excl', 1000, [{ scopeKind: 'tenant' }], { taxInclusive: false })],
  }),
  expected: { totalMinor: 1100, taxMinor: 100, netMinor: 1000, lines: [{ taxInclusive: false }] },
});
emit({
  name: 'price: modifiers add per unit',
  description: 'Burger 1400 + bacon 200 + 2 x cheese 100 = 1800 per unit; two burgers = 3600.',
  tags: ['price', 'modifier'],
  draft: draft([
    line('l1', 'v-burger', 2, 1400, {
      modifiers: [
        { id: 'bacon', priceMinor: 200 },
        { id: 'cheese', priceMinor: 100, quantity: '2' },
      ],
    }),
  ]),
  expected: { subtotalMinor: 3600, lines: [{ modifiersUnitMinor: 400, unitPriceMinor: 1800 }] },
});
emit({
  name: 'price: negative modifier (no onions) reduces the unit price',
  description: 'Item 1000 with a -50 modifier: 950.',
  tags: ['price', 'modifier'],
  draft: draft([line('l1', 'v-1', 1, 1000, { modifiers: [{ id: 'none', priceMinor: -50 }] })]),
  expected: { subtotalMinor: 950, totalMinor: 950 },
});
emit({
  name: 'price: weighed quantity rounds the line gross half up',
  description: '599 x 1.2550 = 751.745 -> 752, GST-free class.',
  tags: ['price', 'weighed'],
  draft: draft([line('l1', 'v-apple', '1.2550', 599, { taxClassId: 'free' })]),
  taxRules: GST_RULES,
  expected: { subtotalMinor: 752, taxMinor: 0, totalMinor: 752 },
});
emit({
  name: 'price: missing price everywhere is an error',
  description: 'No override, no list, no default.',
  tags: ['price', 'error'],
  draft: draft([{ id: 'l1', variantId: 'v-1', quantity: '1' }]),
  error: 'no price list prices variant',
});

// ======================================================================================
// C. Manual discounts and order-level allocation
// ======================================================================================
emit({
  name: 'discount: line percent with authorisation trace',
  description: '10% of 1000 = 100. The trace records the authoriser, method and approval.',
  tags: ['discount', 'trace'],
  draft: one({
    manualDiscount: {
      id: 'd1',
      kind: 'percent',
      value: '10',
      reason: 'loyal',
      authorization: { authorizedBy: 'mgr-7', method: 'pin', approvalId: 'ap-1' },
    },
  }),
  expected: {
    lineDiscountMinor: 100,
    totalMinor: 900,
    $traceIncludes: [
      {
        step: 'line_discount',
        ref: 'l1',
        amountMinor: -100,
        detail: '10% reason: loyal authorized by mgr-7 via pin approval ap-1',
      },
    ],
  },
});
emit({
  name: 'discount: line amount',
  description: '250 off 1000.',
  tags: ['discount'],
  draft: one({ manualDiscount: { id: 'd1', kind: 'amount', value: 250 } }),
  expected: { lineDiscountMinor: 250, totalMinor: 750 },
});
emit({
  name: 'discount: amount larger than the line is capped',
  description: '5000 off 1000 -> 1000, net 0, tax 0.',
  tags: ['discount', 'cap'],
  draft: one({ manualDiscount: { id: 'd1', kind: 'amount', value: 5000 } }),
  expected: { lineDiscountMinor: 1000, totalMinor: 0, taxMinor: 0, netMinor: 0 },
});
emit({
  name: 'discount: 100 percent makes the line free',
  description: '100% of 1000.',
  tags: ['discount', 'cap'],
  draft: one({ manualDiscount: { id: 'd1', kind: 'percent', value: '100' } }),
  expected: { lineDiscountMinor: 1000, totalMinor: 0 },
});
emit({
  name: 'discount: fractional percent rounds half up',
  description: '12.5% of 999 = 124.875 -> 125.',
  tags: ['discount', 'rounding'],
  draft: draft([
    line('l1', 'v-1', 1, 999, { manualDiscount: { id: 'd1', kind: 'percent', value: '12.5' } }),
  ]),
  expected: { lineDiscountMinor: 125, totalMinor: 874 },
});
emit({
  name: 'discount: percent above 100 is rejected',
  description: 'Validation error.',
  tags: ['discount', 'error'],
  draft: one({ manualDiscount: { id: 'd1', kind: 'percent', value: '101' } }),
  error: 'percent must be between 0 and 100',
});
emit({
  name: 'discount: negative amount is rejected',
  description: 'Validation error.',
  tags: ['discount', 'error'],
  draft: one({ manualDiscount: { id: 'd1', kind: 'amount', value: -1 } }),
  error: 'must not be negative',
});
emit({
  name: 'order discount: 10 percent allocated across two lines',
  description: '1000 + 500 = 1500; 10% = 150 allocated [1000,500] -> 100, 50.',
  tags: ['order-discount', 'allocation'],
  draft: draft([line('l1', 'v-1', 1, 1000), line('l2', 'v-2', 1, 500)], {
    manualDiscounts: [{ id: 'od', kind: 'percent', value: '10' }],
  }),
  expected: {
    orderDiscountMinor: 150,
    totalMinor: 1350,
    lines: [{ orderDiscountMinor: 100 }, { orderDiscountMinor: 50 }],
  },
});
emit({
  name: 'order discount: 100 across three equal lines goes 34,33,33',
  description:
    '333 x 3 = 999; 100 -> floors 33,33,33, spare unit to the first line (equal remainders, lowest index).',
  tags: ['order-discount', 'allocation'],
  draft: draft([line('l1', 'v-1', 1, 333), line('l2', 'v-2', 1, 333), line('l3', 'v-3', 1, 333)], {
    manualDiscounts: [{ id: 'od', kind: 'amount', value: 100 }],
  }),
  expected: {
    orderDiscountMinor: 100,
    totalMinor: 899,
    lines: [{ orderDiscountMinor: 34 }, { orderDiscountMinor: 33 }, { orderDiscountMinor: 33 }],
  },
});
emit({
  name: 'order discount: two discounts apply in sequence on the remaining base',
  description: '10% of 1500 = 150, then 100 off the remaining 1350: total discount 250.',
  tags: ['order-discount', 'sequence'],
  draft: draft([line('l1', 'v-1', 1, 1000), line('l2', 'v-2', 1, 500)], {
    manualDiscounts: [
      { id: 'od1', kind: 'percent', value: '10' },
      { id: 'od2', kind: 'amount', value: 100 },
    ],
  }),
  expected: {
    orderDiscountMinor: 250,
    totalMinor: 1250,
    orderDiscounts: [
      { id: 'od1', amountMinor: 150 },
      { id: 'od2', amountMinor: 100 },
    ],
  },
});
emit({
  name: 'order discount: capped at what is left after line discounts',
  description:
    'Line discount takes 600 of 1000; an order discount of 900 is capped at the remaining 400.',
  tags: ['order-discount', 'cap'],
  draft: draft(
    [line('l1', 'v-1', 1, 1000, { manualDiscount: { id: 'ld', kind: 'amount', value: 600 } })],
    { manualDiscounts: [{ id: 'od', kind: 'amount', value: 900 }] },
  ),
  expected: { lineDiscountMinor: 600, orderDiscountMinor: 400, totalMinor: 0 },
});
emit({
  name: 'order discount: authorisation is carried onto the applied discount',
  description: 'The applied order discount keeps who authorised it.',
  tags: ['order-discount', 'trace'],
  draft:
    one() &&
    draft([line('l1', 'v-1', 1, 1000)], {
      manualDiscounts: [
        {
          id: 'od',
          kind: 'amount',
          value: 100,
          authorization: { authorizedBy: 'mgr-2', approvalId: 'ap-5' },
        },
      ],
    }),
  expected: {
    orderDiscounts: [
      { id: 'od', amountMinor: 100, authorization: { authorizedBy: 'mgr-2', approvalId: 'ap-5' } },
    ],
  },
});
emit({
  name: 'order discount: zero base gives zero discount',
  description: 'A free line leaves nothing to discount.',
  tags: ['order-discount', 'cap'],
  draft: draft([line('l1', 'v-1', 1, 0)], {
    manualDiscounts: [{ id: 'od', kind: 'percent', value: '50' }],
  }),
  expected: { orderDiscountMinor: 0, totalMinor: 0 },
});

// ======================================================================================
// D. Promotions by kind
// ======================================================================================
const pctDrinks = (percent, extra = {}) =>
  promo(
    'p-drinks',
    'percent_off',
    { targets: { categoryIds: ['cat-drinks'] }, effect: { kind: 'percent_off', percent } },
    extra,
  );
emit({
  name: 'promo percent_off: 20 percent off a category',
  description: 'Two drinks at 450 = 900; 20% = 180. The burger is untouched.',
  tags: ['promo', 'percent_off'],
  draft: draft([
    line('l1', 'v-drink', 2, 450, { categoryIds: ['cat-drinks'] }),
    line('l2', 'v-burger', 1, 1400, { categoryIds: ['cat-burgers'] }),
  ]),
  context: baseContext({ promotions: [pctDrinks('20')] }),
  expected: {
    promotionDiscountMinor: 180,
    totalMinor: 900 - 180 + 1400,
    promotions: [
      { promotionId: 'p-drinks', amountMinor: 180, lines: [{ lineId: 'l1', amountMinor: 180 }] },
    ],
  },
});
emit({
  name: 'promo percent_off: maximum amount cap scales the discount',
  description: '50% of 3000 = 1500, capped at 1000.',
  tags: ['promo', 'percent_off', 'cap'],
  draft: draft([line('l1', 'v-1', 1, 3000)]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        effect: { kind: 'percent_off', percent: '50', maxAmountMinor: 1000 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 1000, totalMinor: 2000 },
});
emit({
  name: 'promo percent_off: item and tag selectors with exclusions',
  description:
    'Targets tag hot but excludes variant v-soup: only the coffee (500) is discounted 10% = 50.',
  tags: ['promo', 'percent_off', 'selector'],
  draft: draft([
    line('l1', 'v-coffee', 1, 500, { tags: ['hot'] }),
    line('l2', 'v-soup', 1, 900, { tags: ['hot'] }),
  ]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: { tags: ['hot'], excludeVariantIds: ['v-soup'] },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 50, totalMinor: 1350 },
});
emit({
  name: 'promo amount_off per unit',
  description: '100 off each of three hot items (400 each): 300.',
  tags: ['promo', 'amount_off'],
  draft: draft([line('l1', 'v-coffee', 3, 400, { tags: ['hot'] })]),
  context: baseContext({
    promotions: [
      promo('p', 'amount_off', {
        targets: { tags: ['hot'] },
        effect: { kind: 'amount_off', amountMinor: 100, per: 'unit' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 300, totalMinor: 900 },
});
emit({
  name: 'promo amount_off per line',
  description: '100 off each targeted line once: two lines -> 200.',
  tags: ['promo', 'amount_off'],
  draft: draft([
    line('l1', 'v-a', 3, 400, { tags: ['x'] }),
    line('l2', 'v-b', 1, 300, { tags: ['x'] }),
  ]),
  context: baseContext({
    promotions: [
      promo('p', 'amount_off', {
        targets: { tags: ['x'] },
        effect: { kind: 'amount_off', amountMinor: 100, per: 'line' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 200, totalMinor: 1500 - 200 },
});
emit({
  name: 'promo amount_off per order is allocated by largest remainder',
  description:
    '500 over [900, 600, 300] (1800): exact 250, 166.67, 83.33 -> floors 250,166,83 (499), spare to 166.67 -> 250,167,83.',
  tags: ['promo', 'amount_off', 'allocation'],
  draft: draft([line('l1', 'v-a', 1, 900), line('l2', 'v-b', 1, 600), line('l3', 'v-c', 1, 300)]),
  context: baseContext({
    promotions: [
      promo('p', 'amount_off', {
        targets: all,
        effect: { kind: 'amount_off', amountMinor: 500, per: 'order' },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 500,
    totalMinor: 1300,
    lines: [
      { promotionDiscountMinor: 250 },
      { promotionDiscountMinor: 167 },
      { promotionDiscountMinor: 83 },
    ],
  },
});
emit({
  name: 'promo amount_off larger than the lines is capped',
  description: '5000 per order on a 700 basket removes 700.',
  tags: ['promo', 'amount_off', 'cap'],
  draft: draft([line('l1', 'v-a', 1, 700)]),
  context: baseContext({
    promotions: [
      promo('p', 'amount_off', {
        targets: all,
        effect: { kind: 'amount_off', amountMinor: 5000, per: 'order' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 700, totalMinor: 0 },
});
emit({
  name: 'promo fixed_price per unit',
  description: 'Special price 500 each; three units at 700 = 2100 -> 1500, discount 600.',
  tags: ['promo', 'fixed_price'],
  draft: draft([line('l1', 'v-1', 3, 700)]),
  context: baseContext({
    promotions: [
      promo('p', 'fixed_price', {
        targets: { variantIds: ['v-1'] },
        effect: { kind: 'fixed_price', priceMinor: 500 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 600, totalMinor: 1500 },
});
emit({
  name: 'promo fixed_price above the current price has no effect',
  description: 'Fixed price 900 on a 700 item: skipped with no_effect.',
  tags: ['promo', 'fixed_price'],
  draft: draft([line('l1', 'v-1', 1, 700)]),
  context: baseContext({
    promotions: [
      promo('p', 'fixed_price', { targets: all, effect: { kind: 'fixed_price', priceMinor: 900 } }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 0,
    totalMinor: 700,
    skippedPromotions: [{ promotionId: 'p', reason: 'no_effect' }],
  },
});
emit({
  name: 'promo bogo: buy one get one free, two units',
  description: '2 x 500: second free, discount 500.',
  tags: ['promo', 'bogo'],
  draft: draft([line('l1', 'v-1', 2, 500)]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: all,
        effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 500, totalMinor: 500 },
});
emit({
  name: 'promo bogo: three units give one free',
  description: 'One complete pair in three units.',
  tags: ['promo', 'bogo'],
  draft: draft([line('l1', 'v-1', 3, 500)]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: all,
        effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 500, totalMinor: 1000 },
});
emit({
  name: 'promo bogo: buy two get the cheapest of three free across variants',
  description: 'Units 600, 500, 400: the cheapest (400) is free.',
  tags: ['promo', 'bogo'],
  draft: draft([line('l1', 'v-a', 1, 600), line('l2', 'v-b', 1, 500), line('l3', 'v-c', 1, 400)]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: all,
        effect: { kind: 'bogo', buyQuantity: 2, getQuantity: 1 },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 400,
    totalMinor: 1100,
    lines: [
      { promotionDiscountMinor: 0 },
      { promotionDiscountMinor: 0 },
      { promotionDiscountMinor: 400 },
    ],
  },
});
emit({
  name: 'promo bogo: 50 percent off the second',
  description: '2 x 999: the second is 50% = 499.5 -> 500 (half up): discount 500.',
  tags: ['promo', 'bogo', 'rounding'],
  draft: draft([line('l1', 'v-1', 2, 999)]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: all,
        effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 1, percentOff: '50' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 500, totalMinor: 1498 },
});
emit({
  name: 'promo bogo: buy a burger, get a drink free',
  description: 'Two burgers and one drink: the drink is free (450).',
  tags: ['promo', 'bogo', 'cross-item'],
  draft: draft([
    line('l1', 'v-burger', 2, 1400, { itemId: 'i-burger' }),
    line('l2', 'v-drink', 1, 450, { itemId: 'i-drink' }),
  ]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: { variantIds: ['v-burger'] },
        effect: {
          kind: 'bogo',
          buyQuantity: 1,
          getQuantity: 1,
          getTargets: { variantIds: ['v-drink'] },
        },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 450,
    totalMinor: 2800,
    lines: [{ promotionDiscountMinor: 0 }, { promotionDiscountMinor: 450 }],
  },
});
emit({
  name: 'promo bogo: buy a burger, get a drink free, one burger two drinks',
  description: 'One pair only: one drink free.',
  tags: ['promo', 'bogo', 'cross-item'],
  draft: draft([line('l1', 'v-burger', 1, 1400), line('l2', 'v-drink', 2, 450)]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: { variantIds: ['v-burger'] },
        effect: {
          kind: 'bogo',
          buyQuantity: 1,
          getQuantity: 1,
          getTargets: { variantIds: ['v-drink'] },
        },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 450, totalMinor: 1400 + 900 - 450 },
});
emit({
  name: 'promo bogo: maxApplications limits the sets',
  description: '6 x 500 would give 3 free, limited to 1.',
  tags: ['promo', 'bogo', 'cap'],
  draft: draft([line('l1', 'v-1', 6, 500)]),
  context: baseContext({
    promotions: [
      promo('p', 'bogo', {
        targets: all,
        effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 1, maxApplications: 1 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 500, totalMinor: 2500 },
});
emit({
  name: 'promo multibuy: 3 for 10 dollars with exactly three units',
  description: '3 x 400 = 1200 for 1000: discount 200.',
  tags: ['promo', 'multibuy'],
  draft: draft([line('l1', 'v-1', 3, 400)]),
  context: baseContext({
    promotions: [
      promo('p', 'multibuy', {
        targets: all,
        effect: { kind: 'multibuy', quantity: 3, priceMinor: 1000 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 200, totalMinor: 1000 },
});
emit({
  name: 'promo multibuy: the fourth unit stays full price',
  description: '4 x 400: one group of three (discount 200), the fourth pays 400: total 1400.',
  tags: ['promo', 'multibuy'],
  draft: draft([line('l1', 'v-1', 4, 400)]),
  context: baseContext({
    promotions: [
      promo('p', 'multibuy', {
        targets: all,
        effect: { kind: 'multibuy', quantity: 3, priceMinor: 1000 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 200, totalMinor: 1400 },
});
emit({
  name: 'promo multibuy: mixed prices split the discount by largest remainder',
  description: 'Units 500,400,300 = 1200 for 1000: discount 200 over [500,400,300] -> 83, 67, 50.',
  tags: ['promo', 'multibuy', 'allocation'],
  draft: draft([line('l1', 'v-a', 1, 500), line('l2', 'v-b', 1, 400), line('l3', 'v-c', 1, 300)]),
  context: baseContext({
    promotions: [
      promo('p', 'multibuy', {
        targets: all,
        effect: { kind: 'multibuy', quantity: 3, priceMinor: 1000 },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 200,
    lines: [
      { promotionDiscountMinor: 83 },
      { promotionDiscountMinor: 67 },
      { promotionDiscountMinor: 50 },
    ],
  },
});
emit({
  name: 'promo multibuy: group price at or above the parts gives nothing',
  description: '3 x 300 = 900 against a 1000 group price.',
  tags: ['promo', 'multibuy'],
  draft: draft([line('l1', 'v-1', 3, 300)]),
  context: baseContext({
    promotions: [
      promo('p', 'multibuy', {
        targets: all,
        effect: { kind: 'multibuy', quantity: 3, priceMinor: 1000 },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 0, totalMinor: 900 },
});
const thresholdPromo = (extra = {}) =>
  promo(
    'p',
    'threshold',
    {
      targets: all,
      effect: {
        kind: 'threshold',
        tiers: [
          { minSubtotalMinor: 5000, percent: '10' },
          { minSubtotalMinor: 10000, percent: '15' },
        ],
      },
    },
    extra,
  );
emit({
  name: 'promo threshold: first tier at 7000',
  description: '7000 reaches the 5000 tier: 10% = 700.',
  tags: ['promo', 'threshold'],
  draft: draft([line('l1', 'v-a', 1, 4000), line('l2', 'v-b', 1, 3000)]),
  context: baseContext({ promotions: [thresholdPromo()] }),
  expected: {
    promotionDiscountMinor: 700,
    totalMinor: 6300,
    lines: [{ promotionDiscountMinor: 400 }, { promotionDiscountMinor: 300 }],
  },
});
emit({
  name: 'promo threshold: below the first tier nothing applies',
  description: '4999 < 5000.',
  tags: ['promo', 'threshold'],
  draft: draft([line('l1', 'v-a', 1, 4999)]),
  context: baseContext({ promotions: [thresholdPromo()] }),
  expected: { promotionDiscountMinor: 0, totalMinor: 4999 },
});
emit({
  name: 'promo threshold: exactly on the tier boundary applies',
  description: '5000 -> 10% = 500.',
  tags: ['promo', 'threshold'],
  draft: draft([line('l1', 'v-a', 1, 5000)]),
  context: baseContext({ promotions: [thresholdPromo()] }),
  expected: { promotionDiscountMinor: 500, totalMinor: 4500 },
});
emit({
  name: 'promo threshold: the highest reached tier wins',
  description: '12000 reaches 10000: 15% = 1800.',
  tags: ['promo', 'threshold'],
  draft: draft([line('l1', 'v-a', 1, 12000)]),
  context: baseContext({ promotions: [thresholdPromo()] }),
  expected: { promotionDiscountMinor: 1800, totalMinor: 10200 },
});
emit({
  name: 'promo threshold: amount tier is capped at the subtotal',
  description: 'Spend 1000 get 1500 off on a 1200 basket: 1200.',
  tags: ['promo', 'threshold', 'cap'],
  draft: draft([line('l1', 'v-a', 1, 1200)]),
  context: baseContext({
    promotions: [
      promo('p', 'threshold', {
        targets: all,
        effect: { kind: 'threshold', tiers: [{ minSubtotalMinor: 1000, amountMinor: 1500 }] },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 1200, totalMinor: 0 },
});
emit({
  name: 'promo condition: minimum quantity',
  description: 'Needs 3 units; two bought: skipped with conditions_not_met.',
  tags: ['promo', 'condition'],
  draft: draft([line('l1', 'v-1', 2, 500)]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        conditions: { minQuantity: '3' },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ promotionId: 'p', reason: 'conditions_not_met', detail: 'min_quantity' }],
  },
});
emit({
  name: 'promo condition: minimum subtotal uses the amount left after earlier discounts',
  description: 'Basket 1000 with a 300 line discount leaves 700, below the 800 minimum.',
  tags: ['promo', 'condition'],
  draft: draft([
    line('l1', 'v-1', 1, 1000, { manualDiscount: { id: 'd', kind: 'amount', value: 300 } }),
  ]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        conditions: { minSubtotalMinor: 800 },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ reason: 'conditions_not_met', detail: 'min_subtotal' }],
  },
});
emit({
  name: 'promo condition: channel restriction',
  description: 'Promotion for online only, sale at pos.',
  tags: ['promo', 'condition'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        conditions: { channels: ['online'] },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ detail: 'channel' }] },
});
emit({
  name: 'promo condition: customer group',
  description: 'Member-only promotion for a member: 10% of 1000.',
  tags: ['promo', 'condition', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c1', groupIds: ['g-member'] } }),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        conditions: { customerGroupIds: ['g-member'] },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'promo condition: customer group missing for an anonymous sale',
  description: 'No customer: skipped.',
  tags: ['promo', 'condition', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        conditions: { customerGroupIds: ['g-member'] },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ detail: 'customer_group' }] },
});
emit({
  name: 'promo condition: manual discounts block when not allowed',
  description: 'allowWithManualDiscount false: the discounted line is not targeted.',
  tags: ['promo', 'condition', 'manual'],
  draft: draft([
    line('l1', 'v-1', 1, 1000, { manualDiscount: { id: 'd', kind: 'amount', value: 100 } }),
    line('l2', 'v-2', 1, 500),
  ]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        conditions: { allowWithManualDiscount: false },
        effect: { kind: 'percent_off', percent: '10' },
      }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 50,
    lines: [{ promotionDiscountMinor: 0 }, { promotionDiscountMinor: 50 }],
  },
});
emit({
  name: 'promo condition: lines flagged promotionsExcluded are never targeted',
  description: 'The gift card line is excluded.',
  tags: ['promo', 'condition'],
  draft: draft([
    line('l1', 'v-gift', 1, 5000, { promotionsExcluded: true }),
    line('l2', 'v-2', 1, 1000),
  ]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', { targets: all, effect: { kind: 'percent_off', percent: '10' } }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 100,
    lines: [{ promotionDiscountMinor: 0 }, { promotionDiscountMinor: 100 }],
  },
});

// ======================================================================================
// E. Stacking, priority, exclusions, coupons, schedules, scopes, limits
// ======================================================================================
const tenOff = (id, extra = {}) =>
  promo(id, 'percent_off', { targets: all, effect: { kind: 'percent_off', percent: '10' } }, extra);
emit({
  name: 'stacking: promotions in different groups apply in sequence',
  description: '10% of 2000 = 200; then 100 off the remaining 1800: 300 total.',
  tags: ['stacking'],
  draft: draft([line('l1', 'v-1', 1, 2000)]),
  context: baseContext({
    promotions: [
      tenOff('a', { priority: 10, stackGroup: 'g1' }),
      promo(
        'b',
        'amount_off',
        { targets: all, effect: { kind: 'amount_off', amountMinor: 100, per: 'order' } },
        { priority: 20, stackGroup: 'g2' },
      ),
    ],
  }),
  expected: {
    promotionDiscountMinor: 300,
    totalMinor: 1700,
    promotions: [
      { promotionId: 'a', amountMinor: 200 },
      { promotionId: 'b', amountMinor: 100 },
    ],
  },
});
emit({
  name: 'stacking: the same stack group applies only the first by priority',
  description: 'Both in group "seasonal"; priority 10 (10%) wins, the 20% one is skipped.',
  tags: ['stacking', 'stack-group'],
  draft: draft([line('l1', 'v-1', 1, 2000)]),
  context: baseContext({
    promotions: [
      promo(
        'big',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '20' } },
        { priority: 20, stackGroup: 'seasonal' },
      ),
      tenOff('small', { priority: 10, stackGroup: 'seasonal' }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 200,
    promotions: [{ promotionId: 'small' }],
    skippedPromotions: [{ promotionId: 'big', reason: 'stack_group_taken', detail: 'seasonal' }],
  },
});
emit({
  name: 'stacking: priority order changes the result (amount first, then percent)',
  description: 'A: 500 off per order (priority 10) then B: 10% (priority 20): 500 + 150 = 650.',
  tags: ['stacking', 'priority'],
  draft: draft([line('l1', 'v-1', 1, 2000)]),
  context: baseContext({
    promotions: [
      tenOff('b', { priority: 20 }),
      promo(
        'a',
        'amount_off',
        { targets: all, effect: { kind: 'amount_off', amountMinor: 500, per: 'order' } },
        { priority: 10 },
      ),
    ],
  }),
  expected: {
    promotionDiscountMinor: 650,
    promotions: [
      { promotionId: 'a', amountMinor: 500 },
      { promotionId: 'b', amountMinor: 150 },
    ],
  },
});
emit({
  name: 'stacking: priority order reversed (percent first, then amount)',
  description: 'B: 10% first (200) then A: 500: 700.',
  tags: ['stacking', 'priority'],
  draft: draft([line('l1', 'v-1', 1, 2000)]),
  context: baseContext({
    promotions: [
      tenOff('b', { priority: 10 }),
      promo(
        'a',
        'amount_off',
        { targets: all, effect: { kind: 'amount_off', amountMinor: 500, per: 'order' } },
        { priority: 20 },
      ),
    ],
  }),
  expected: {
    promotionDiscountMinor: 700,
    promotions: [
      { promotionId: 'b', amountMinor: 200 },
      { promotionId: 'a', amountMinor: 500 },
    ],
  },
});
emit({
  name: 'stacking: equal priority breaks the tie by creation time then id',
  description: 'Both in one group, same priority: the older (createdAt) wins.',
  tags: ['stacking', 'priority'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo(
        'newer',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '30' } },
        { stackGroup: 'g', createdAt: '2026-06-01T00:00:00Z' },
      ),
      promo(
        'older',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '10' } },
        { stackGroup: 'g', createdAt: '2026-01-01T00:00:00Z' },
      ),
    ],
  }),
  expected: { promotionDiscountMinor: 100, promotions: [{ promotionId: 'older' }] },
});
emit({
  name: 'exclusions: a promotion that excludes an applied one is skipped',
  description: 'B excludes A; A applied first, B skipped.',
  tags: ['exclusion'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      tenOff('a', { priority: 10 }),
      promo(
        'b',
        'amount_off',
        {
          targets: all,
          conditions: { excludesPromotionIds: ['a'] },
          effect: { kind: 'amount_off', amountMinor: 50, per: 'order' },
        },
        { priority: 20 },
      ),
    ],
  }),
  expected: {
    promotionDiscountMinor: 100,
    promotions: [{ promotionId: 'a' }],
    skippedPromotions: [{ promotionId: 'b', reason: 'excluded_by_promotion' }],
  },
});
emit({
  name: 'exclusions: the exclusion works in both directions',
  description:
    'A (priority 20) declares it excludes B (priority 10); B applied first so A is skipped.',
  tags: ['exclusion'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo(
        'a',
        'amount_off',
        {
          targets: all,
          conditions: { excludesPromotionIds: ['b'] },
          effect: { kind: 'amount_off', amountMinor: 50, per: 'order' },
        },
        { priority: 20 },
      ),
      tenOff('b', { priority: 10 }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 100,
    promotions: [{ promotionId: 'b' }],
    skippedPromotions: [{ promotionId: 'a', reason: 'excluded_by_promotion' }],
  },
});
emit({
  name: 'exclusions: an excluded promotion that did not apply does not block',
  description: 'B excludes A but A does not apply (wrong category), so B applies.',
  tags: ['exclusion'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo(
        'a',
        'percent_off',
        { targets: { categoryIds: ['cat-none'] }, effect: { kind: 'percent_off', percent: '10' } },
        { priority: 10 },
      ),
      promo(
        'b',
        'amount_off',
        {
          targets: all,
          conditions: { excludesPromotionIds: ['a'] },
          effect: { kind: 'amount_off', amountMinor: 50, per: 'order' },
        },
        { priority: 20 },
      ),
    ],
  }),
  expected: { promotionDiscountMinor: 50, promotions: [{ promotionId: 'b' }] },
});
emit({
  name: 'exclusive: an exclusive promotion applies alone and stops the rest',
  description: 'Exclusive 5% first; the later 10% is skipped.',
  tags: ['exclusive'],
  draft: draft([line('l1', 'v-1', 1, 2000)]),
  context: baseContext({
    promotions: [
      promo(
        'only',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '5' } },
        { priority: 10, isExclusive: true },
      ),
      tenOff('later', { priority: 20 }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 100,
    promotions: [{ promotionId: 'only' }],
    skippedPromotions: [{ promotionId: 'later', reason: 'exclusive_conflict' }],
  },
});
emit({
  name: 'exclusive: skipped when another promotion already applied',
  description: 'The exclusive one comes second and is skipped.',
  tags: ['exclusive'],
  draft: draft([line('l1', 'v-1', 1, 2000)]),
  context: baseContext({
    promotions: [
      tenOff('first', { priority: 10 }),
      promo(
        'only',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '50' } },
        { priority: 20, isExclusive: true },
      ),
    ],
  }),
  expected: {
    promotionDiscountMinor: 200,
    promotions: [{ promotionId: 'first' }],
    skippedPromotions: [{ promotionId: 'only', reason: 'exclusive_conflict' }],
  },
});
const couponPromo = (extra = {}) =>
  promo(
    'cp',
    'percent_off',
    { targets: all, effect: { kind: 'percent_off', percent: '10' } },
    { requiresCoupon: true, ...extra },
  );
const coupon = (extra = {}) => ({
  id: 'cu1',
  promotionId: 'cp',
  code: 'SAVE10',
  status: 'active',
  maxUses: 1,
  usesCount: 0,
  ...extra,
});
emit({
  name: 'coupon: required promotion is skipped without a code',
  description: 'No code presented.',
  tags: ['coupon'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon()] }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ promotionId: 'cp', reason: 'coupon_required' }],
  },
});
emit({
  name: 'coupon: valid code applies (case-insensitive) and is recorded',
  description: '10% of 1000, the application names the coupon.',
  tags: ['coupon'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['save10'] }),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon()] }),
  expected: { promotionDiscountMinor: 100, promotions: [{ promotionId: 'cp', couponId: 'cu1' }] },
});
emit({
  name: 'coupon: unknown code',
  description:
    'Code does not match any coupon for the promotion: coupon_required (nothing matched).',
  tags: ['coupon'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['NOPE'] }),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon()] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'coupon_required' }] },
});
emit({
  name: 'coupon: expired coupon is invalid',
  description: 'expiresAt before the sale.',
  tags: ['coupon'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['SAVE10'] }),
  context: baseContext({
    promotions: [couponPromo()],
    coupons: [coupon({ expiresAt: '2026-10-01T00:00:00Z' })],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'coupon_invalid' }] },
});
emit({
  name: 'coupon: used-up coupon is invalid',
  description: 'usesCount reached maxUses.',
  tags: ['coupon'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['SAVE10'] }),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon({ usesCount: 1 })] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'coupon_invalid' }] },
});
emit({
  name: 'coupon: bound to another customer is invalid',
  description: 'Coupon issued to c-9, sale to c-1.',
  tags: ['coupon', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['SAVE10'], customer: { id: 'c-1' } }),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon({ customerId: 'c-9' })] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'coupon_invalid' }] },
});
emit({
  name: 'coupon: bound to this customer applies',
  description: 'Coupon issued to c-1.',
  tags: ['coupon', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['SAVE10'], customer: { id: 'c-1' } }),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon({ customerId: 'c-1' })] }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'coupon: void coupon is invalid',
  description: 'status void.',
  tags: ['coupon'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { couponCodes: ['SAVE10'] }),
  context: baseContext({ promotions: [couponPromo()], coupons: [coupon({ status: 'void' })] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'coupon_invalid' }] },
});
const happyHour = (extra = {}) =>
  tenOff('hh', {
    schedule: { daysOfWeek: [1, 2, 3, 4, 5], windows: [{ from: '16:00', to: '18:00' }] },
    ...extra,
  });
emit({
  name: 'schedule: happy hour applies inside the local window',
  description: 'Monday 16:30 Sydney time (05:30Z in AEDT).',
  tags: ['schedule'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ at: AT_MON_430PM, promotions: [happyHour()] }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'schedule: happy hour is skipped outside the window',
  description: 'Monday 13:00 Sydney.',
  tags: ['schedule'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [happyHour()] }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ promotionId: 'hh', reason: 'outside_schedule' }],
  },
});
emit({
  name: 'schedule: the window end is exclusive',
  description: 'Exactly 18:00 local (07:00Z) is outside [16:00, 18:00).',
  tags: ['schedule'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ at: '2026-10-19T07:00:00Z', promotions: [happyHour()] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'outside_schedule' }] },
});
emit({
  name: 'schedule: weekday filter excludes Sunday',
  description: '2026-10-18 is a Sunday.',
  tags: ['schedule'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ at: '2026-10-18T05:30:00Z', promotions: [happyHour()] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'outside_schedule' }] },
});
emit({
  name: 'schedule: a window that crosses midnight wraps',
  description: 'Late night 22:00-02:00; 23:30 Sydney Monday is inside.',
  tags: ['schedule'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    at: '2026-10-19T12:30:00Z',
    promotions: [tenOff('late', { schedule: { windows: [{ from: '22:00', to: '02:00' }] } })],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'schedule: the local zone, not UTC, decides',
  description:
    '02:00Z is 13:00 Sydney but 02:00 London-ish UTC; a 12:00-14:00 window applies in Sydney.',
  tags: ['schedule', 'timezone'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [tenOff('lunch', { schedule: { windows: [{ from: '12:00', to: '14:00' }] } })],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'validity: promotion ended before the sale',
  description: 'validTo earlier than the sale time.',
  tags: ['validity'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [tenOff('p', { validTo: '2026-10-19T00:00:00Z' })] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'outside_validity' }] },
});
emit({
  name: 'validity: promotion not started',
  description: 'validFrom in the future.',
  tags: ['validity'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [tenOff('p', { validFrom: '2026-12-01T00:00:00Z' })] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'outside_validity' }] },
});
emit({
  name: 'validity: paused and draft promotions never apply',
  description: 'Status paused and draft are inactive.',
  tags: ['validity', 'status'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [tenOff('p1', { status: 'paused' }), tenOff('p2', { status: 'draft' })],
  }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ reason: 'inactive' }, { reason: 'inactive' }],
  },
});
emit({
  name: 'scope: location-scoped promotion applies at its location',
  description: 'Scope location loc-syd.',
  tags: ['scope'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [tenOff('p', { scopes: [{ scopeKind: 'location', scopeId: 'loc-syd' }] })],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'scope: location-scoped promotion is skipped elsewhere',
  description: 'Scope location loc-mel, sale at loc-syd.',
  tags: ['scope'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [tenOff('p', { scopes: [{ scopeKind: 'location', scopeId: 'loc-mel' }] })],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'out_of_scope' }] },
});
emit({
  name: 'scope: an ancestor org unit reaches the location',
  description: 'Scope org unit ou-root is on the location path.',
  tags: ['scope'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [tenOff('p', { scopes: [{ scopeKind: 'org_unit', scopeId: 'ou-root' }] })],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'scope: any one scope of a kind is enough',
  description: 'Two locations listed, one matches.',
  tags: ['scope'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      tenOff('p', {
        scopes: [
          { scopeKind: 'location', scopeId: 'loc-mel' },
          { scopeKind: 'location', scopeId: 'loc-syd' },
        ],
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'scope: different scope kinds must all match',
  description: 'Location matches but the channel scope (online) does not.',
  tags: ['scope'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      tenOff('p', {
        scopes: [
          { scopeKind: 'location', scopeId: 'loc-syd' },
          { scopeKind: 'channel', scopeValue: 'online' },
        ],
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'out_of_scope' }] },
});
emit({
  name: 'scope: customer group scope',
  description: 'Scope customer_group g-member, customer is a member.',
  tags: ['scope', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c', groupIds: ['g-member'] } }),
  context: baseContext({
    promotions: [tenOff('p', { scopes: [{ scopeKind: 'customer_group', scopeId: 'g-member' }] })],
  }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'limits: total usage reached',
  description: 'maxUsesTotal 100, usesCount 100.',
  tags: ['limits'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [tenOff('p', { maxUsesTotal: 100, usesCount: 100 })] }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ reason: 'usage_limit', detail: 'total' }],
  },
});
emit({
  name: 'limits: per-customer usage reached',
  description: 'Customer already used it once, limit 1.',
  tags: ['limits', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c', promotionUses: { p: 1 } } }),
  context: baseContext({ promotions: [tenOff('p', { maxUsesPerCustomer: 1 })] }),
  expected: {
    promotionDiscountMinor: 0,
    skippedPromotions: [{ reason: 'usage_limit', detail: 'customer' }],
  },
});
emit({
  name: 'limits: per-customer usage below the limit applies',
  description: 'Used 1 of 2.',
  tags: ['limits', 'customer'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c', promotionUses: { p: 1 } } }),
  context: baseContext({ promotions: [tenOff('p', { maxUsesPerCustomer: 2 })] }),
  expected: { promotionDiscountMinor: 100 },
});
emit({
  name: 'limits: exhausted budget',
  description: 'budget 500, spent 500.',
  tags: ['limits', 'budget'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [tenOff('p', { budgetMinor: 500, spentMinor: 500 })] }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'budget_exhausted' }] },
});
emit({
  name: 'limits: remaining budget caps the discount',
  description: 'Budget 500, spent 420: only 80 left of the 100 discount.',
  tags: ['limits', 'budget'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [tenOff('p', { budgetMinor: 500, spentMinor: 420 })] }),
  expected: { promotionDiscountMinor: 80, totalMinor: 920 },
});
emit({
  name: 'rules: effect that disagrees with the kind is skipped as invalid',
  description: 'kind percent_off carrying an amount_off effect.',
  tags: ['rules'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo('p', 'percent_off', {
        targets: all,
        effect: { kind: 'amount_off', amountMinor: 100, per: 'order' },
      }),
    ],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'invalid_rules' }] },
});
emit({
  name: 'rules: reserved kinds are unsupported in v1',
  description: 'loyalty_price is not evaluated yet.',
  tags: ['rules'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo('p', 'loyalty_price', { targets: all, effect: { kind: 'percent_off', percent: '10' } }),
    ],
  }),
  expected: { promotionDiscountMinor: 0, skippedPromotions: [{ reason: 'unsupported' }] },
});
emit({
  name: 'rules: a promotion never takes more than the line has left',
  description: '100% off then another 100% off: the second finds nothing left.',
  tags: ['rules', 'cap'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({
    promotions: [
      promo(
        'a',
        'percent_off',
        { targets: all, effect: { kind: 'percent_off', percent: '100' } },
        { priority: 1 },
      ),
      tenOff('b', { priority: 2 }),
    ],
  }),
  expected: {
    promotionDiscountMinor: 1000,
    totalMinor: 0,
    skippedPromotions: [{ promotionId: 'b', reason: 'no_effect' }],
  },
});
emit({
  name: 'promo then order discount: the order discount allocates over what remains',
  description: '10% promo on [1000, 500] leaves [900, 450]; a 135 order discount splits 90, 45.',
  tags: ['promo', 'order-discount', 'allocation'],
  draft: draft([line('l1', 'v-1', 1, 1000), line('l2', 'v-2', 1, 500)], {
    manualDiscounts: [{ id: 'od', kind: 'amount', value: 135 }],
  }),
  context: baseContext({ promotions: [tenOff('p')] }),
  expected: {
    promotionDiscountMinor: 150,
    orderDiscountMinor: 135,
    totalMinor: 1500 - 150 - 135,
    lines: [{ orderDiscountMinor: 90 }, { orderDiscountMinor: 45 }],
  },
});
emit({
  name: 'promo skipped promotions leave a trace entry',
  description: 'Skips are recorded in the ordered trace.',
  tags: ['promo', 'trace'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  context: baseContext({ promotions: [tenOff('p', { status: 'paused' })] }),
  expected: { $traceIncludes: [{ step: 'promotion_skipped', ref: 'p', detail: 'inactive' }] },
});

// ======================================================================================
// F. Tax
// ======================================================================================
emit({
  name: 'tax: mixed GST and GST-free basket',
  description:
    'Coffee 480 (GST) + bread 2 x 350 (free): tax only on the coffee, 480/11 = 43.6 -> 44. Total 1180.',
  tags: ['tax', 'mixed-rates'],
  draft: draft([
    line('l1', 'v-coffee', 1, 480),
    line('l2', 'v-bread', 2, 350, { taxClassId: 'free' }),
  ]),
  taxRules: GST_RULES,
  expected: {
    totalMinor: 1180,
    taxMinor: 44,
    taxSummary: [
      { name: 'GST-free', rate: '0', taxMinor: 0, taxableMinor: 700 },
      { name: 'GST', rate: '0.10', taxMinor: 44, taxableMinor: 436 },
    ],
  },
});
emit({
  name: 'tax: exclusive pricing adds GST on top',
  description: 'Exclusive rule: 1000 + 100 = 1100.',
  tags: ['tax', 'exclusive'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  taxRules: [
    { id: 'gst-ex', name: 'GST', taxClassId: null, rate: '0.10', inclusiveDefault: false },
  ],
  expected: {
    totalMinor: 1100,
    taxMinor: 100,
    netMinor: 1000,
    lines: [{ taxInclusive: false, totalMinor: 1100 }],
  },
});
emit({
  name: 'tax: exempt customer on an inclusive line pays the tax-free amount',
  description: '1100 inclusive includes 100 GST; exempt customer pays 1000, taxExempt 100.',
  tags: ['tax', 'exempt'],
  draft: draft([line('l1', 'v-1', 1, 1100)], {
    customer: { id: 'c', taxExempt: true, taxExemptionReason: 'diplomat' },
  }),
  expected: {
    totalMinor: 1000,
    taxMinor: 0,
    taxExemptMinor: 100,
    lines: [{ taxExemptMinor: 100, totalMinor: 1000 }],
    $traceIncludes: [{ step: 'tax_exemption', detail: 'diplomat' }],
  },
});
emit({
  name: 'tax: exempt customer on an exclusive line pays no tax',
  description:
    '1000 exclusive: the 100 GST that would have been added is recorded as exempt, none is charged.',
  tags: ['tax', 'exempt'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { customer: { id: 'c', taxExempt: true } }),
  taxRules: [
    { id: 'gst-ex', name: 'GST', taxClassId: null, rate: '0.10', inclusiveDefault: false },
  ],
  expected: {
    totalMinor: 1000,
    taxMinor: 0,
    taxExemptMinor: 100,
    lines: [{ taxExemptMinor: 100, totalMinor: 1000 }],
  },
});
emit({
  name: 'tax: stacked state and city rates, exclusive',
  description: '10000 at 6% + 2%: 600 + 200 = 800, total 10800.',
  tags: ['tax', 'multi-rate'],
  draft: draft([line('l1', 'v-1', 1, 10000)]),
  stackTaxRules: true,
  taxRules: [
    {
      id: 'state',
      name: 'State',
      taxClassId: null,
      rate: '0.06',
      inclusiveDefault: false,
      priority: 100,
    },
    {
      id: 'city',
      name: 'City',
      taxClassId: null,
      rate: '0.02',
      inclusiveDefault: false,
      priority: 99,
    },
  ],
  expected: { totalMinor: 10800, taxMinor: 800 },
});
emit({
  name: 'tax: stacked rates, inclusive split sums exactly',
  description: '10800 inclusive at 6% + 2% -> tax 10800 x 0.08/1.08 = 800 split 600/200.',
  tags: ['tax', 'multi-rate'],
  draft: draft([line('l1', 'v-1', 1, 10800)]),
  stackTaxRules: true,
  taxRules: [
    {
      id: 'state',
      name: 'State',
      taxClassId: null,
      rate: '0.06',
      inclusiveDefault: true,
      priority: 100,
    },
    {
      id: 'city',
      name: 'City',
      taxClassId: null,
      rate: '0.02',
      inclusiveDefault: true,
      priority: 99,
    },
  ],
  expected: {
    totalMinor: 10800,
    taxMinor: 800,
    lines: [
      {
        taxes: [
          { ruleId: 'state', amountMinor: 600 },
          { ruleId: 'city', amountMinor: 200 },
        ],
      },
    ],
  },
});
emit({
  name: 'tax: compound excise then GST, exclusive',
  description: 'Excise 10% = 100, GST 10% on 1100 = 110: tax 210, total 1210.',
  tags: ['tax', 'compound'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  stackTaxRules: true,
  taxRules: [
    {
      id: 'excise',
      name: 'Excise',
      taxClassId: null,
      rate: '0.10',
      inclusiveDefault: false,
      priority: 100,
    },
    {
      id: 'gst',
      name: 'GST',
      taxClassId: null,
      rate: '0.10',
      inclusiveDefault: false,
      compound: true,
      priority: 99,
    },
  ],
  expected: { totalMinor: 1210, taxMinor: 210 },
});
emit({
  name: 'tax: compound rates, inclusive round trip',
  description: '1210 inclusive of excise + compound GST extracts 210.',
  tags: ['tax', 'compound'],
  draft: draft([line('l1', 'v-1', 1, 1210)]),
  stackTaxRules: true,
  taxRules: [
    {
      id: 'excise',
      name: 'Excise',
      taxClassId: null,
      rate: '0.10',
      inclusiveDefault: true,
      priority: 100,
    },
    {
      id: 'gst',
      name: 'GST',
      taxClassId: null,
      rate: '0.10',
      inclusiveDefault: true,
      compound: true,
      priority: 99,
    },
  ],
  expected: {
    totalMinor: 1210,
    taxMinor: 210,
    lines: [{ taxes: [{ amountMinor: 100 }, { amountMinor: 110 }] }],
  },
});
emit({
  name: 'tax: no rule at all means no tax and an inclusive price',
  description: 'Empty rule table.',
  tags: ['tax'],
  draft: draft([line('l1', 'v-1', 1, 1000)]),
  taxRules: [],
  expected: { totalMinor: 1000, taxMinor: 0 },
});
emit({
  name: 'tax: one cent line has no GST after rounding',
  description: '1/11 = 0.09 -> 0.',
  tags: ['tax', 'rounding'],
  draft: draft([line('l1', 'v-1', 1, 1)]),
  expected: { totalMinor: 1, taxMinor: 0 },
});
emit({
  name: 'tax: GST is computed after discounts on the net',
  description: '1000 less a 100 discount = 900; 900/11 = 81.8 -> 82.',
  tags: ['tax', 'discount'],
  draft: one({ manualDiscount: { id: 'd', kind: 'amount', value: 100 } }),
  expected: { totalMinor: 900, taxMinor: 82 },
});
emit({
  name: 'tax: rounding per line, not on the total',
  description:
    'Three lines of 999: each 999/11 = 90.8 -> 91, total tax 273 (not 2997/11 = 272.45 -> 272).',
  tags: ['tax', 'rounding'],
  draft: draft([line('l1', 'v-1', 1, 999), line('l2', 'v-2', 1, 999), line('l3', 'v-3', 1, 999)]),
  expected: { totalMinor: 2997, taxMinor: 273 },
});
emit({
  name: 'tax: the tax class is passed to the resolver',
  description: 'Class "free" is GST-free, the default class is taxed.',
  tags: ['tax', 'class'],
  draft: draft([line('l1', 'v-1', 1, 1100, { taxClassId: 'free' }), line('l2', 'v-2', 1, 1100)]),
  taxRules: GST_RULES,
  expected: { taxMinor: 100, lines: [{ taxMinor: 0 }, { taxMinor: 100 }] },
});

// ======================================================================================
// G. Charges
// ======================================================================================
emit({
  name: 'charge: 10 percent service charge, GST inclusive',
  description: 'Lines 5348; charge 534.8 -> 535 (tax 535/11 = 48.6 -> 49). Total 5883.',
  tags: ['charge'],
  draft: draft(
    [
      line('l1', 'v-1', 2, 1850),
      line('l2', 'v-2', 1, 1200),
      line('l3', 'v-3', 1, 448, { taxClassId: 'free' }),
    ],
    { charges: [{ id: 'sc', kind: 'service_charge', percent: '10' }] },
  ),
  taxRules: GST_RULES,
  expected: {
    subtotalMinor: 5348,
    chargesMinor: 535,
    totalMinor: 5883,
    charges: [{ amountMinor: 535, taxMinor: 49, totalMinor: 535 }],
  },
});
emit({
  name: 'charge: service charge is computed after discounts',
  description: '1000 less 200 = 800 net; 10% = 80.',
  tags: ['charge', 'discount'],
  draft: draft([line('l1', 'v-1', 1, 1000)], {
    manualDiscounts: [{ id: 'od', kind: 'amount', value: 200 }],
    charges: [{ id: 'sc', kind: 'service_charge', percent: '10' }],
  }),
  expected: { chargesMinor: 80, totalMinor: 880 },
});
emit({
  name: 'charge: fixed delivery fee with an exclusive tax rate',
  description: '500 + 10% = 550.',
  tags: ['charge', 'tax'],
  draft: draft([line('l1', 'v-1', 1, 1000)], {
    charges: [
      { id: 'dl', kind: 'delivery_fee', amountMinor: 500, taxRate: '0.10', taxInclusive: false },
    ],
  }),
  expected: {
    chargesMinor: 550,
    totalMinor: 1550,
    taxMinor: 91 + 50,
    charges: [{ taxMinor: 50, totalMinor: 550 }],
  },
});
emit({
  name: 'charge: tax class resolved through the resolver (GST-free fee)',
  description: 'Fee 300 in the free class: no tax.',
  tags: ['charge', 'tax'],
  draft: draft([line('l1', 'v-1', 1, 1000)], {
    charges: [{ id: 'fee', kind: 'surcharge', amountMinor: 300, taxClassId: 'free' }],
  }),
  taxRules: GST_RULES,
  expected: { chargesMinor: 300, totalMinor: 1300, charges: [{ taxMinor: 0 }] },
});
emit({
  name: 'charge: tax-exempt customer does not pay GST on a charge',
  description: '110 inclusive charge, tax 10 exempt: total 100 for the charge.',
  tags: ['charge', 'exempt'],
  draft: draft([line('l1', 'v-1', 1, 1100)], {
    customer: { id: 'c', taxExempt: true },
    charges: [{ id: 'fee', kind: 'surcharge', amountMinor: 110 }],
  }),
  expected: {
    totalMinor: 1000 + 100,
    taxExemptMinor: 110,
    charges: [{ taxExemptMinor: 10, totalMinor: 100 }],
  },
});
emit({
  name: 'charge: both amount and percent is rejected',
  description: 'Validation error.',
  tags: ['charge', 'error'],
  draft: draft([line('l1', 'v-1', 1, 1000)], {
    charges: [{ id: 'c', kind: 'surcharge', amountMinor: 10, percent: '5' }],
  }),
  error: 'either amountMinor or percent',
});
emit({
  name: 'charge: neither amount nor percent is rejected',
  description: 'Validation error.',
  tags: ['charge', 'error'],
  draft: draft([line('l1', 'v-1', 1, 1000)], { charges: [{ id: 'c', kind: 'surcharge' }] }),
  error: 'amountMinor or percent is required',
});

// ======================================================================================
// H. Cash rounding and tenders
// ======================================================================================
for (let cents = 0; cents < 10; cents++) {
  const total = 1000 + cents;
  const rounding = cashRound(total) - total;
  emit({
    name: `cash rounding: ${total} on a cash tender`,
    description: `RBA rule for the last digit ${cents}: rounding ${rounding >= 0 ? '+' : ''}${rounding}.`,
    tags: ['cash-rounding'],
    draft: draft([line('l1', 'v-1', 1, total)], { tenders: [{ method: 'cash' }] }),
    expected: { totalMinor: total, roundingMinor: rounding, amountDueMinor: total + rounding },
  });
}
emit({
  name: 'cash rounding: card tender is never rounded',
  description: '1003 on card stays 1003.',
  tags: ['cash-rounding', 'tender'],
  draft: draft([line('l1', 'v-1', 1, 1003)], { tenders: [{ method: 'card' }] }),
  expected: { roundingMinor: 0, amountDueMinor: 1003 },
});
emit({
  name: 'cash rounding: no tender means no rounding',
  description: 'Quote only.',
  tags: ['cash-rounding', 'tender'],
  draft: draft([line('l1', 'v-1', 1, 1003)]),
  expected: { roundingMinor: 0, amountDueMinor: 1003 },
});
emit({
  name: 'cash rounding: split tender rounds only the cash remainder',
  description: 'Total 2003, card pays 1000, cash remainder 1003 -> 1005 (+2).',
  tags: ['cash-rounding', 'tender', 'split'],
  draft: draft([line('l1', 'v-1', 1, 2003)], {
    tenders: [{ method: 'card', amountMinor: 1000 }, { method: 'cash' }],
  }),
  expected: { roundingMinor: 2, amountDueMinor: 2005 },
});
emit({
  name: 'cash rounding: split tender whose cash remainder is already on a 5c boundary',
  description: 'Total 2005, card 1000, cash 1005: no rounding.',
  tags: ['cash-rounding', 'tender', 'split'],
  draft: draft([line('l1', 'v-1', 1, 2005)], {
    tenders: [{ method: 'card', amountMinor: 1000 }, { method: 'cash' }],
  }),
  expected: { roundingMinor: 0, amountDueMinor: 2005 },
});
emit({
  name: 'cash rounding: gift card covers everything, no cash',
  description: 'Gift card for the full 1003.',
  tags: ['cash-rounding', 'tender'],
  draft: draft([line('l1', 'v-1', 1, 1003)], {
    tenders: [{ method: 'gift_card', amountMinor: 1003 }, { method: 'cash' }],
  }),
  expected: { roundingMinor: 0 },
});
emit({
  name: 'cash rounding: explicit cash amount',
  description: 'Cash tender of 1003 stated explicitly: 1005.',
  tags: ['cash-rounding', 'tender'],
  draft: draft([line('l1', 'v-1', 1, 2003)], {
    tenders: [
      { method: 'cash', amountMinor: 1003 },
      { method: 'card', amountMinor: 1000 },
    ],
  }),
  expected: { roundingMinor: 2 },
});
emit({
  name: 'cash rounding: disabled by tenant configuration',
  description: 'cashRounding null.',
  tags: ['cash-rounding', 'config'],
  draft: draft([line('l1', 'v-1', 1, 1003)], { tenders: [{ method: 'cash' }] }),
  context: baseContext({ cashRounding: null }),
  expected: { roundingMinor: 0, amountDueMinor: 1003 },
});
emit({
  name: 'cash rounding: tenant rule 10c nearest (NZD style)',
  description: 'Interval 10, 1005 -> 1010 half up.',
  tags: ['cash-rounding', 'config'],
  draft: draft([line('l1', 'v-1', 1, 1005)], { tenders: [{ method: 'cash' }] }),
  context: baseContext({ cashRounding: { intervalMinor: 10, mode: 'NEAREST_HALF_UP' } }),
  expected: { roundingMinor: 5, amountDueMinor: 1010 },
});
emit({
  name: 'cash rounding: tenant rule always down to 1 dollar',
  description: 'Interval 100 DOWN: 1099 -> 1000.',
  tags: ['cash-rounding', 'config'],
  draft: draft([line('l1', 'v-1', 1, 1099)], { tenders: [{ method: 'cash' }] }),
  context: baseContext({ cashRounding: { intervalMinor: 100, mode: 'DOWN' } }),
  expected: { roundingMinor: -99, amountDueMinor: 1000 },
});
emit({
  name: 'cash rounding: a currency without a cash rule is untouched',
  description: 'USD has no cash rounding in the registry.',
  tags: ['cash-rounding', 'currency'],
  draft: { currency: 'USD', lines: [line('l1', 'v-1', 1, 1003)], tenders: [{ method: 'cash' }] },
  expected: { roundingMinor: 0 },
});
emit({
  name: 'cash rounding: zero total',
  description: 'A fully discounted order owes nothing in cash.',
  tags: ['cash-rounding'],
  draft: draft(
    [line('l1', 'v-1', 1, 1000, { manualDiscount: { id: 'd', kind: 'percent', value: '100' } })],
    { tenders: [{ method: 'cash' }] },
  ),
  expected: { totalMinor: 0, roundingMinor: 0 },
});
emit({
  name: 'cash rounding: totals before rounding stay exact with discounts and charges',
  description:
    'Lines 1500, 10% order discount 150, 10% service charge on 1350 = 135: total 1485 (already on the 5c grid) -> no rounding. Tax: lines 1350/11 = 122.7 -> 123, charge 135/11 = 12.3 -> 12.',
  tags: ['cash-rounding', 'charge', 'discount'],
  draft: draft([line('l1', 'v-1', 1, 1000), line('l2', 'v-2', 1, 500)], {
    manualDiscounts: [{ id: 'od', kind: 'percent', value: '10' }],
    charges: [{ id: 'sc', kind: 'service_charge', percent: '10' }],
    tenders: [{ method: 'cash' }],
  }),
  expected: { totalMinor: 1485, roundingMinor: 0, taxMinor: 135 },
});
emit({
  name: 'tender: non-cash tenders above the total are rejected',
  description: 'Card 2000 on an order of 1000.',
  tags: ['tender', 'error'],
  draft: draft([line('l1', 'v-1', 1, 1000)], {
    tenders: [{ method: 'card', amountMinor: 2000 }, { method: 'cash' }],
  }),
  error: 'exceed the order total',
});

// ======================================================================================
// I. Edge and validation
// ======================================================================================
emit({
  name: 'edge: an empty order prices to zero',
  description: 'No lines.',
  tags: ['edge'],
  draft: draft([]),
  expected: {
    subtotalMinor: 0,
    totalMinor: 0,
    taxMinor: 0,
    amountDueMinor: 0,
    lines: [],
    trace: [],
  },
});
emit({
  name: 'edge: zero quantity line',
  description: 'Quantity 0 contributes nothing.',
  tags: ['edge'],
  draft: draft([line('l1', 'v-1', 0, 1000)]),
  expected: { subtotalMinor: 0, totalMinor: 0 },
});
emit({
  name: 'edge: duplicate line ids are rejected',
  description: 'Two lines named l1.',
  tags: ['edge', 'error'],
  draft: draft([line('l1', 'v-1', 1, 1000), line('l1', 'v-2', 1, 1000)]),
  error: 'Duplicate line id',
});
emit({
  name: 'edge: unknown currency is rejected',
  description: 'ZZZ.',
  tags: ['edge', 'error'],
  draft: { currency: 'ZZZ', lines: [line('l1', 'v-1', 1, 1000)] },
  error: 'Unknown currency',
});
emit({
  name: 'edge: negative quantity is rejected',
  description: 'Returns are separate orders.',
  tags: ['edge', 'error'],
  draft: draft([line('l1', 'v-1', -1, 1000)]),
  error: 'quantity must not be negative',
});
emit({
  name: 'edge: JPY has no minor units',
  description: '1000 yen, 10% GST-like tax inclusive: 1000/11 = 90.9 -> 91.',
  tags: ['edge', 'currency'],
  draft: { currency: 'JPY', lines: [line('l1', 'v-1', 1, 1000)] },
  expected: { totalMinor: 1000, taxMinor: 91 },
});
emit({
  name: 'edge: the trace lists the pipeline steps in order',
  description: 'Sequence numbers increase from 1 and steps follow the pipeline order.',
  tags: ['edge', 'trace'],
  draft: draft(
    [line('l1', 'v-1', 1, 1000, { manualDiscount: { id: 'd', kind: 'amount', value: 100 } })],
    {
      manualDiscounts: [{ id: 'od', kind: 'amount', value: 50 }],
      charges: [{ id: 'sc', kind: 'service_charge', amountMinor: 110 }],
      tenders: [{ method: 'cash' }],
    },
  ),
  context: baseContext({ promotions: [tenOff('p')] }),
  expected: {
    $stepOrder: [
      'price_resolution',
      'line_discount',
      'promotion',
      'order_discount',
      'allocation',
      'tax',
      'charge',
      'tax',
      'cash_rounding',
    ],
  },
});
emit({
  name: 'edge: cash-rounding uses only the cash portion of charges and discounts together',
  description: '1004 total in cash rounds up to 1005.',
  tags: ['edge', 'cash-rounding'],
  draft: draft([line('l1', 'v-1', 1, 1004)], { tenders: [{ method: 'cash' }] }),
  expected: { roundingMinor: 1, amountDueMinor: 1005 },
});

// ======================================================================================
// J. Re-pricing (idempotent) cases: the runner re-prices the output with resolved prices as overrides
// ======================================================================================
emit({
  name: 'repricing: lists, discounts, charge and cash rounding are stable',
  description:
    'Pricing the output again with the resolved unit prices as overrides gives the same totals.',
  tags: ['repricing'],
  draft: draft(
    [
      line('l1', 'v-1', 3, 1000, {
        modifiers: [{ id: 'm', priceMinor: 50 }],
        manualDiscount: { id: 'd', kind: 'percent', value: '15' },
      }),
      line('l2', 'v-2', 2, 333),
    ],
    {
      manualDiscounts: [{ id: 'od', kind: 'amount', value: 77 }],
      charges: [{ id: 'sc', kind: 'service_charge', percent: '10' }],
      tenders: [{ method: 'cash' }],
    },
  ),
  context: baseContext({ priceLists: [list('pl', 950, [{ scopeKind: 'tenant' }])] }),
  expected: {},
});
emit({
  name: 'repricing: weighed and GST-free lines',
  description: 'Stable re-pricing with a free class and decimals.',
  tags: ['repricing'],
  draft: draft(
    [line('l1', 'v-apple', '1.2550', 599, { taxClassId: 'free' }), line('l2', 'v-coffee', 3, 480)],
    { manualDiscounts: [{ id: 'od', kind: 'percent', value: '7.5' }] },
  ),
  taxRules: GST_RULES,
  expected: {},
});
emit({
  name: 'repricing: exclusive tax lines',
  description: 'Stable re-pricing in exclusive mode.',
  tags: ['repricing'],
  draft: draft([line('l1', 'v-1', 2, 1000), line('l2', 'v-2', 1, 1555)], {
    manualDiscounts: [{ id: 'od', kind: 'amount', value: 321 }],
  }),
  taxRules: [
    { id: 'gst-ex', name: 'GST', taxClassId: null, rate: '0.10', inclusiveDefault: false },
  ],
  expected: {},
});

// ======================================================================================
// K. Parametric families with independent oracles
// ======================================================================================
// K1 inclusive / exclusive parity: price N (multiple of 10) exclusive == N + N/10 inclusive.
for (const [n, qty] of [
  [1000, 1],
  [2500, 1],
  [990, 2],
  [1240, 3],
  [7770, 1],
  [10, 1],
  [50, 4],
  [12340, 1],
  [3330, 3],
  [9990, 2],
  [600, 5],
  [450, 2],
  [1800, 1],
  [20, 7],
  [88880, 1],
  [4500, 2],
  [3100, 1],
  [770, 9],
  [1230, 1],
  [6000, 6],
]) {
  const inclusivePrice = n + n / 10;
  const net = n * qty;
  const tax = net / 10;
  const common = {
    totalMinor: net + tax,
    taxMinor: tax,
    netMinor: net + tax === net + tax ? undefined : undefined,
  };
  void common;
  emit({
    name: `parity: ${qty} x ${n} exclusive equals ${qty} x ${inclusivePrice} inclusive`,
    description: `Exclusive ${net} + ${tax} GST = ${net + tax}; inclusive ${inclusivePrice * qty} holds the same ${tax} GST.`,
    tags: ['parity', 'tax'],
    draft: draft([line('l1', 'v-1', qty, n)]),
    taxRules: [
      { id: 'gst-ex', name: 'GST', taxClassId: null, rate: '0.10', inclusiveDefault: false },
    ],
    expected: { totalMinor: net + tax, taxMinor: tax, lines: [{ taxInclusive: false }] },
  });
}
for (const [n, qty] of [
  [1000, 1],
  [2500, 1],
  [990, 2],
  [1240, 3],
  [7770, 1],
  [10, 1],
  [50, 4],
  [12340, 1],
  [3330, 3],
  [9990, 2],
  [600, 5],
  [450, 2],
  [1800, 1],
  [20, 7],
  [88880, 1],
  [4500, 2],
  [3100, 1],
  [770, 9],
  [1230, 1],
  [6000, 6],
]) {
  const inclusivePrice = n + n / 10;
  const total = inclusivePrice * qty;
  emit({
    name: `parity: inclusive ${qty} x ${inclusivePrice} matches the exclusive twin`,
    description: `Inclusive ${total} extracts ${gstOf(total)} GST, equal to the exclusive twin's ${(n * qty) / 10}.`,
    tags: ['parity', 'tax'],
    draft: draft([line('l1', 'v-1', qty, inclusivePrice)]),
    expected: { totalMinor: total, taxMinor: (n * qty) / 10, lines: [{ taxInclusive: true }] },
  });
}
// K2 cash rounding across a wider price range.
for (let total = 2995; total < 3015; total++) {
  const rounding = cashRound(total) - total;
  emit({
    name: `cash rounding sweep ${total}`,
    description: `Oracle: ${total} -> ${cashRound(total)}.`,
    tags: ['cash-rounding', 'sweep'],
    draft: draft([line('l1', 'v-1', 1, total)], { tenders: [{ method: 'cash' }] }),
    expected: { roundingMinor: rounding, amountDueMinor: cashRound(total) },
  });
}
// K3 order discount allocation against the Hamilton oracle.
const allocationCases = [
  [[333, 333, 334], 100],
  [[1, 1, 1], 2],
  [[1000, 1, 1], 500],
  [[999, 1], 500],
  [[700, 200, 100], 333],
  [[250, 250, 250, 250], 7],
  [[1999, 2999, 3999], 1234],
  [[5, 15, 80], 99],
  [[101, 103, 107], 50],
  [[1234, 5678], 4321],
  [[10, 20, 30, 40], 99],
  [[77, 77, 77], 100],
  [[499, 501], 77],
  [[1500, 2500, 6000], 999],
  [[3, 3, 3, 3, 3], 14],
  [[8888, 1111], 5000],
  [[60, 30, 10], 1],
  [[900, 800, 700, 600], 1501],
  [[123, 456, 789], 600],
  [[2000, 1], 2000],
];
allocationCases.forEach(([prices, discount], i) => {
  const shares = hamilton(discount, prices);
  const total = prices.reduce((a, b) => a + b, 0);
  emit({
    name: `allocation ${String(i + 1).padStart(2, '0')}: ${discount} over ${prices.join('/')}`,
    description: `Hamilton oracle: ${shares.join(' + ')} = ${discount}.`,
    tags: ['allocation', 'order-discount'],
    draft: draft(
      prices.map((p, k) => line(`l${k + 1}`, `v-${k + 1}`, 1, p)),
      { manualDiscounts: [{ id: 'od', kind: 'amount', value: discount }] },
    ),
    expected: {
      orderDiscountMinor: discount,
      totalMinor: total - discount,
      lines: shares.map((s) => ({ orderDiscountMinor: s })),
    },
  });
});
// K4 percent promotions on a basket: exact discount per line, rounded half up per line.
for (const [percent, prices] of [
  [10, [999, 501]],
  [15, [1999]],
  [25, [333, 333]],
  [5, [1000, 1000, 1000]],
  [33, [100, 200]],
  [50, [1, 3, 5]],
  [12, [4567]],
  [20, [2495, 1255]],
  [7, [10, 20, 30]],
  [100, [499]],
]) {
  const per = prices.map((p) => div(p * percent, 100));
  emit({
    name: `promo percent ${percent} on ${prices.join('/')}`,
    description: `Per line half-up: ${per.join(' + ')}.`,
    tags: ['promo', 'percent_off', 'sweep'],
    draft: draft(prices.map((p, k) => line(`l${k + 1}`, `v-${k + 1}`, 1, p))),
    context: baseContext({
      promotions: [
        promo('p', 'percent_off', {
          targets: all,
          effect: { kind: 'percent_off', percent: String(percent) },
        }),
      ],
    }),
    expected: {
      promotionDiscountMinor: per.reduce((a, b) => a + b, 0),
      lines: per.map((d) => ({ promotionDiscountMinor: d })),
    },
  });
}
// K5 multibuy 3 for 1000 at 400 each: groups of three.
for (let qty = 1; qty <= 9; qty++) {
  const groups = Math.floor(qty / 3);
  emit({
    name: `multibuy 3 for 1000: ${qty} units at 400`,
    description: `${groups} full group(s) x 200 off.`,
    tags: ['promo', 'multibuy', 'sweep'],
    draft: draft([line('l1', 'v-1', qty, 400)]),
    context: baseContext({
      promotions: [
        promo('p', 'multibuy', {
          targets: all,
          effect: { kind: 'multibuy', quantity: 3, priceMinor: 1000 },
        }),
      ],
    }),
    expected: { promotionDiscountMinor: groups * 200, totalMinor: qty * 400 - groups * 200 },
  });
}
// K6 bogo 1+1: floor(q/2) free.
for (let qty = 1; qty <= 8; qty++) {
  emit({
    name: `bogo 1+1 free: ${qty} units at 500`,
    description: `${Math.floor(qty / 2)} free unit(s).`,
    tags: ['promo', 'bogo', 'sweep'],
    draft: draft([line('l1', 'v-1', qty, 500)]),
    context: baseContext({
      promotions: [
        promo('p', 'bogo', {
          targets: all,
          effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
        }),
      ],
    }),
    expected: {
      promotionDiscountMinor: Math.floor(qty / 2) * 500,
      totalMinor: qty * 500 - Math.floor(qty / 2) * 500,
    },
  });
}
// K7 meal deal counts: bundles = min(b, f, d), 650 each.
for (const [b, f, d] of [
  [1, 1, 1],
  [3, 1, 1],
  [1, 3, 2],
  [2, 2, 1],
  [3, 3, 3],
  [4, 2, 3],
  [0, 2, 2],
  [1, 0, 1],
  [5, 5, 2],
  [2, 6, 6],
]) {
  const bundles = Math.min(b, f, d);
  const lines = [];
  if (b) lines.push(line('l1', 'v-burger', b, BURGER));
  if (f) lines.push(line('l2', 'v-fries', f, FRIES));
  if (d) lines.push(line('l3', 'v-drink', d, DRINK));
  const total = b * BURGER + f * FRIES + d * DRINK;
  emit({
    name: `meal deal counts: ${b} burger, ${f} fries, ${d} drink`,
    description: `${bundles} bundle(s) x 650 off.`,
    tags: ['brief', 'bundle', 'sweep'],
    draft: draft(lines),
    context: baseContext({ promotions: [mealDeal()] }),
    expected: { promotionDiscountMinor: bundles * 650, totalMinor: total - bundles * 650 },
  });
}
// K8 tier pricing sweep.
for (const qty of [1, 2, 5, 6, 7, 11, 12, 13]) {
  const unit = qty >= 12 ? 800 : qty >= 6 ? 900 : 1000;
  emit({
    name: `tier pricing: quantity ${qty}`,
    description: `Tiers 1:1000, 6:900, 12:800: ${unit} each.`,
    tags: ['price', 'tier', 'sweep'],
    draft: draft([line('l1', 'v-1', qty, 1234)]),
    context: baseContext({
      priceLists: [
        list('tiers', 0, [{ scopeKind: 'tenant' }], {
          entries: [
            { id: 't1', variantId: 'v-1', priceMinor: 1000, minQuantity: '1' },
            { id: 't6', variantId: 'v-1', priceMinor: 900, minQuantity: '6' },
            { id: 't12', variantId: 'v-1', priceMinor: 800, minQuantity: '12' },
          ],
        }),
      ],
    }),
    expected: { subtotalMinor: unit * qty, lines: [{ baseUnitPriceMinor: unit }] },
  });
}
// K9 manual percent discounts, half-up per line.
for (const [percent, price] of [
  [10, 999],
  [15, 333],
  [20, 1],
  [33, 100],
  [7, 1285],
  [50, 3],
  [12.5, 8],
  [2.5, 1000],
  [99, 101],
  [1, 49],
]) {
  const p100 = Math.round(percent * 100);
  const discount = Math.floor((2 * price * p100 + 10000) / 20000);
  emit({
    name: `manual percent ${percent} of ${price}`,
    description: `${price} x ${percent}% half up = ${discount}.`,
    tags: ['discount', 'sweep'],
    draft: draft([
      line('l1', 'v-1', 1, price, {
        manualDiscount: { id: 'd', kind: 'percent', value: String(percent) },
      }),
    ]),
    expected: { lineDiscountMinor: discount, totalMinor: price - discount },
  });
}

// Written through the repository's Prettier config so `pnpm format:check` stays green.
const options = { ...((await prettier.resolveConfig(join(dir, 'x.json'))) ?? {}), parser: 'json' };
for (const [file, body] of pending) {
  writeFileSync(join(dir, file), await prettier.format(JSON.stringify(body), options));
}
console.log(`wrote ${counter} golden cases`);
