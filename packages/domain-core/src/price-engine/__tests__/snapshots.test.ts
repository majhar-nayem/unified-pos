import { describe, expect, it } from 'vitest';

import { priceOrder } from '../price-order.js';
import { FixedTaxRuleResolver } from '../tax-resolver.js';
import { ctx, line, order, promo } from './helpers.js';

/**
 * Full-output regression snapshots. Each scenario was reviewed line by line against the pipeline
 * rules in docs/01-system-architecture.md §7.2 when it was recorded; a change to any amount,
 * trace entry or skip reason must be a deliberate, reviewed edit.
 */
describe('full output snapshots', () => {
  it('restaurant check: bundle, stacked promotions, skips, discounts, charge, split tender', () => {
    const meal = promo(
      'meal',
      'fixed_price',
      {
        targets: { all: true },
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
      { priority: 10, code: 'MEAL' },
    );
    const tenOff = promo(
      'ten',
      'percent_off',
      { targets: { tags: ['dessert'] }, effect: { kind: 'percent_off', percent: '10' } },
      { priority: 20, stackGroup: 'g' },
    );
    const out = priceOrder(
      order(
        [
          line('b', 1, 1400, { variantId: 'v-burger' }),
          line('f', 1, 600, { variantId: 'v-fries' }),
          line('d', 1, 450, { variantId: 'v-drink' }),
          line('c', 2, 700, {
            variantId: 'v-cake',
            tags: ['dessert'],
            manualDiscount: {
              id: 'staff',
              kind: 'amount',
              value: 100,
              authorization: { authorizedBy: 'mgr', method: 'pin' },
            },
          }),
        ],
        {
          manualDiscounts: [{ id: 'loyalty', kind: 'percent', value: '5' }],
          charges: [{ id: 'sc', kind: 'service_charge', percent: '10' }],
          tenders: [{ method: 'card', amountMinor: 1000 }, { method: 'cash' }],
        },
      ),
      ctx({
        promotions: [
          meal,
          tenOff,
          promo(
            'late',
            'percent_off',
            { targets: { tags: ['dessert'] }, effect: { kind: 'percent_off', percent: '50' } },
            { priority: 30, stackGroup: 'g' },
          ),
          promo(
            'paused',
            'percent_off',
            { targets: { all: true }, effect: { kind: 'percent_off', percent: '5' } },
            { priority: 40, status: 'paused' },
          ),
          promo(
            'coupon',
            'percent_off',
            { targets: { all: true }, effect: { kind: 'percent_off', percent: '5' } },
            { priority: 50, requiresCoupon: true },
          ),
        ],
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "amountDueMinor": 3105n,
        "at": "2026-10-19T02:00:00Z",
        "charges": [
          {
            "amountMinor": 282n,
            "id": "sc",
            "kind": "service_charge",
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 26n,
            "taxes": [
              {
                "amountMinor": 26n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "au-gst",
              },
            ],
            "totalMinor": 282n,
          },
        ],
        "chargesMinor": 282n,
        "currency": "AUD",
        "discountMinor": 1029n,
        "lineDiscountMinor": 100n,
        "lines": [
          {
            "baseUnitPriceMinor": 1400n,
            "discounts": [
              {
                "amountMinor": 372n,
                "kind": "promotion",
                "ref": "meal",
              },
              {
                "amountMinor": 51n,
                "kind": "order",
                "ref": "loyalty",
              },
            ],
            "grossMinor": 1400n,
            "id": "b",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 0n,
            "netMinor": 977n,
            "orderDiscountMinor": 51n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 372n,
            "quantity": "1",
            "taxClassId": null,
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 89n,
            "taxes": [
              {
                "amountMinor": 89n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "au-gst",
              },
            ],
            "totalMinor": 977n,
            "unitPriceMinor": 1400n,
            "variantId": "v-burger",
          },
          {
            "baseUnitPriceMinor": 600n,
            "discounts": [
              {
                "amountMinor": 159n,
                "kind": "promotion",
                "ref": "meal",
              },
              {
                "amountMinor": 22n,
                "kind": "order",
                "ref": "loyalty",
              },
            ],
            "grossMinor": 600n,
            "id": "f",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 0n,
            "netMinor": 419n,
            "orderDiscountMinor": 22n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 159n,
            "quantity": "1",
            "taxClassId": null,
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 38n,
            "taxes": [
              {
                "amountMinor": 38n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "au-gst",
              },
            ],
            "totalMinor": 419n,
            "unitPriceMinor": 600n,
            "variantId": "v-fries",
          },
          {
            "baseUnitPriceMinor": 450n,
            "discounts": [
              {
                "amountMinor": 119n,
                "kind": "promotion",
                "ref": "meal",
              },
              {
                "amountMinor": 17n,
                "kind": "order",
                "ref": "loyalty",
              },
            ],
            "grossMinor": 450n,
            "id": "d",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 0n,
            "netMinor": 314n,
            "orderDiscountMinor": 17n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 119n,
            "quantity": "1",
            "taxClassId": null,
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 29n,
            "taxes": [
              {
                "amountMinor": 29n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "au-gst",
              },
            ],
            "totalMinor": 314n,
            "unitPriceMinor": 450n,
            "variantId": "v-drink",
          },
          {
            "baseUnitPriceMinor": 700n,
            "discounts": [
              {
                "amountMinor": 100n,
                "kind": "manual",
                "ref": "staff",
              },
              {
                "amountMinor": 130n,
                "kind": "promotion",
                "ref": "ten",
              },
              {
                "amountMinor": 59n,
                "kind": "order",
                "ref": "loyalty",
              },
            ],
            "grossMinor": 1400n,
            "id": "c",
            "lineDiscountMinor": 100n,
            "modifiersUnitMinor": 0n,
            "netMinor": 1111n,
            "orderDiscountMinor": 59n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 130n,
            "quantity": "2",
            "taxClassId": null,
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 101n,
            "taxes": [
              {
                "amountMinor": 101n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "au-gst",
              },
            ],
            "totalMinor": 1111n,
            "unitPriceMinor": 700n,
            "variantId": "v-cake",
          },
        ],
        "netMinor": 2821n,
        "orderDiscountMinor": 149n,
        "orderDiscounts": [
          {
            "amountMinor": 149n,
            "id": "loyalty",
          },
        ],
        "promotionDiscountMinor": 780n,
        "promotions": [
          {
            "amountMinor": 650n,
            "applications": 1,
            "code": "MEAL",
            "couponId": null,
            "kind": "fixed_price",
            "lines": [
              {
                "amountMinor": 372n,
                "lineId": "b",
                "units": 1,
              },
              {
                "amountMinor": 159n,
                "lineId": "f",
                "units": 1,
              },
              {
                "amountMinor": 119n,
                "lineId": "d",
                "units": 1,
              },
            ],
            "name": "meal",
            "promotionId": "meal",
            "stackGroup": null,
          },
          {
            "amountMinor": 130n,
            "applications": 1,
            "code": null,
            "couponId": null,
            "kind": "percent_off",
            "lines": [
              {
                "amountMinor": 130n,
                "lineId": "c",
              },
            ],
            "name": "ten",
            "promotionId": "ten",
            "stackGroup": "g",
          },
        ],
        "roundingMinor": 2n,
        "skippedPromotions": [
          {
            "detail": "g",
            "promotionId": "late",
            "reason": "stack_group_taken",
          },
          {
            "promotionId": "paused",
            "reason": "inactive",
          },
          {
            "promotionId": "coupon",
            "reason": "coupon_required",
          },
        ],
        "subtotalMinor": 3850n,
        "taxExemptMinor": 0n,
        "taxMinor": 283n,
        "taxSummary": [
          {
            "name": "GST",
            "rate": "0.10",
            "ruleId": "au-gst",
            "taxMinor": 283n,
            "taxableMinor": 2820n,
          },
        ],
        "totalMinor": 3103n,
        "trace": [
          {
            "amountMinor": 1400n,
            "detail": "variant default",
            "ref": "b",
            "seq": 1,
            "step": "price_resolution",
          },
          {
            "amountMinor": 600n,
            "detail": "variant default",
            "ref": "f",
            "seq": 2,
            "step": "price_resolution",
          },
          {
            "amountMinor": 450n,
            "detail": "variant default",
            "ref": "d",
            "seq": 3,
            "step": "price_resolution",
          },
          {
            "amountMinor": 700n,
            "detail": "variant default",
            "ref": "c",
            "seq": 4,
            "step": "price_resolution",
          },
          {
            "amountMinor": -100n,
            "detail": "100 minor authorized by mgr via pin",
            "ref": "c",
            "seq": 5,
            "step": "line_discount",
          },
          {
            "amountMinor": -650n,
            "detail": "fixed_price "meal" ×1",
            "ref": "meal",
            "seq": 6,
            "step": "promotion",
          },
          {
            "amountMinor": -130n,
            "detail": "percent_off "ten" ×1",
            "ref": "ten",
            "seq": 7,
            "step": "promotion",
          },
          {
            "amountMinor": 0n,
            "detail": "stack_group_taken: g",
            "ref": "late",
            "seq": 8,
            "step": "promotion_skipped",
          },
          {
            "amountMinor": 0n,
            "detail": "inactive",
            "ref": "paused",
            "seq": 9,
            "step": "promotion_skipped",
          },
          {
            "amountMinor": 0n,
            "detail": "coupon_required",
            "ref": "coupon",
            "seq": 10,
            "step": "promotion_skipped",
          },
          {
            "amountMinor": -149n,
            "detail": "5%",
            "ref": "loyalty",
            "seq": 11,
            "step": "order_discount",
          },
          {
            "amountMinor": -51n,
            "detail": "loyalty",
            "ref": "b",
            "seq": 12,
            "step": "allocation",
          },
          {
            "amountMinor": -22n,
            "detail": "loyalty",
            "ref": "f",
            "seq": 13,
            "step": "allocation",
          },
          {
            "amountMinor": -17n,
            "detail": "loyalty",
            "ref": "d",
            "seq": 14,
            "step": "allocation",
          },
          {
            "amountMinor": -59n,
            "detail": "loyalty",
            "ref": "c",
            "seq": 15,
            "step": "allocation",
          },
          {
            "amountMinor": 89n,
            "detail": "GST 0.10",
            "ref": "b",
            "seq": 16,
            "step": "tax",
          },
          {
            "amountMinor": 38n,
            "detail": "GST 0.10",
            "ref": "f",
            "seq": 17,
            "step": "tax",
          },
          {
            "amountMinor": 29n,
            "detail": "GST 0.10",
            "ref": "d",
            "seq": 18,
            "step": "tax",
          },
          {
            "amountMinor": 101n,
            "detail": "GST 0.10",
            "ref": "c",
            "seq": 19,
            "step": "tax",
          },
          {
            "amountMinor": 282n,
            "detail": "service_charge",
            "ref": "sc",
            "seq": 20,
            "step": "charge",
          },
          {
            "amountMinor": 26n,
            "ref": "sc",
            "seq": 21,
            "step": "tax",
          },
          {
            "amountMinor": 2n,
            "detail": "cash 2103 → 2105",
            "ref": "tender",
            "seq": 22,
            "step": "cash_rounding",
          },
        ],
      }
    `);
  });

  it('retail basket: price lists, bogo, multibuy, threshold, coupon, customer group', () => {
    const out = priceOrder(
      order(
        [
          line('a', 3, 1000, { variantId: 'v-a', categoryIds: ['cat-x'] }),
          line('b', 4, 400, { variantId: 'v-b', tags: ['snack'] }),
          line('c', '1.2550', 599, { variantId: 'v-c', taxClassId: 'free' }),
        ],
        {
          couponCodes: ['save5'],
          customer: { id: 'cust', groupIds: ['member'] },
          tenders: [{ method: 'cash' }],
        },
      ),
      ctx({
        priceLists: [
          {
            id: 'member-list',
            currency: 'AUD',
            taxInclusive: true,
            entries: [{ id: 'e-a', variantId: 'v-a', priceMinor: 900 }],
            assignments: [{ scopeKind: 'customer_group', scopeId: 'member' }],
          },
        ],
        promotions: [
          promo(
            'bogo',
            'bogo',
            {
              targets: { variantIds: ['v-a'] },
              effect: { kind: 'bogo', buyQuantity: 1, getQuantity: 1 },
            },
            { priority: 1 },
          ),
          promo(
            'mb',
            'multibuy',
            {
              targets: { tags: ['snack'] },
              effect: { kind: 'multibuy', quantity: 3, priceMinor: 1000 },
            },
            { priority: 2 },
          ),
          promo(
            'th',
            'threshold',
            {
              targets: { all: true },
              effect: { kind: 'threshold', tiers: [{ minSubtotalMinor: 2000, percent: '5' }] },
            },
            { priority: 3 },
          ),
          promo(
            'cp',
            'amount_off',
            {
              targets: { all: true },
              effect: { kind: 'amount_off', amountMinor: 50, per: 'order' },
            },
            { priority: 4, requiresCoupon: true },
          ),
        ],
        coupons: [{ id: 'cu', promotionId: 'cp', code: 'SAVE5' }],
        taxResolver: new FixedTaxRuleResolver({
          components: [{ ruleId: 'r', name: 'GST', rate: '0.10' }],
          inclusiveDefault: true,
        }),
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "amountDueMinor": 3705n,
        "at": "2026-10-19T02:00:00Z",
        "charges": [],
        "chargesMinor": 0n,
        "currency": "AUD",
        "discountMinor": 1348n,
        "lineDiscountMinor": 0n,
        "lines": [
          {
            "baseUnitPriceMinor": 900n,
            "discounts": [
              {
                "amountMinor": 900n,
                "kind": "promotion",
                "ref": "bogo",
              },
              {
                "amountMinor": 90n,
                "kind": "promotion",
                "ref": "th",
              },
              {
                "amountMinor": 23n,
                "kind": "promotion",
                "ref": "cp",
              },
            ],
            "grossMinor": 2700n,
            "id": "a",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 0n,
            "netMinor": 1687n,
            "orderDiscountMinor": 0n,
            "priceSource": {
              "entryId": "e-a",
              "kind": "price_list",
              "priceListId": "member-list",
            },
            "promotionDiscountMinor": 1013n,
            "quantity": "3",
            "taxClassId": null,
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 153n,
            "taxes": [
              {
                "amountMinor": 153n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "r",
              },
            ],
            "totalMinor": 1687n,
            "unitPriceMinor": 900n,
            "variantId": "v-a",
          },
          {
            "baseUnitPriceMinor": 400n,
            "discounts": [
              {
                "amountMinor": 200n,
                "kind": "promotion",
                "ref": "mb",
              },
              {
                "amountMinor": 70n,
                "kind": "promotion",
                "ref": "th",
              },
              {
                "amountMinor": 18n,
                "kind": "promotion",
                "ref": "cp",
              },
            ],
            "grossMinor": 1600n,
            "id": "b",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 0n,
            "netMinor": 1312n,
            "orderDiscountMinor": 0n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 288n,
            "quantity": "4",
            "taxClassId": null,
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 119n,
            "taxes": [
              {
                "amountMinor": 119n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "r",
              },
            ],
            "totalMinor": 1312n,
            "unitPriceMinor": 400n,
            "variantId": "v-b",
          },
          {
            "baseUnitPriceMinor": 599n,
            "discounts": [
              {
                "amountMinor": 38n,
                "kind": "promotion",
                "ref": "th",
              },
              {
                "amountMinor": 9n,
                "kind": "promotion",
                "ref": "cp",
              },
            ],
            "grossMinor": 752n,
            "id": "c",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 0n,
            "netMinor": 705n,
            "orderDiscountMinor": 0n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 47n,
            "quantity": "1.2550",
            "taxClassId": "free",
            "taxExemptMinor": 0n,
            "taxInclusive": true,
            "taxMinor": 64n,
            "taxes": [
              {
                "amountMinor": 64n,
                "name": "GST",
                "rate": "0.10",
                "ruleId": "r",
              },
            ],
            "totalMinor": 705n,
            "unitPriceMinor": 599n,
            "variantId": "v-c",
          },
        ],
        "netMinor": 3704n,
        "orderDiscountMinor": 0n,
        "orderDiscounts": [],
        "promotionDiscountMinor": 1348n,
        "promotions": [
          {
            "amountMinor": 900n,
            "applications": 1,
            "code": null,
            "couponId": null,
            "kind": "bogo",
            "lines": [
              {
                "amountMinor": 900n,
                "lineId": "a",
                "units": 2,
              },
            ],
            "name": "bogo",
            "promotionId": "bogo",
            "stackGroup": null,
          },
          {
            "amountMinor": 200n,
            "applications": 1,
            "code": null,
            "couponId": null,
            "kind": "multibuy",
            "lines": [
              {
                "amountMinor": 200n,
                "lineId": "b",
                "units": 3,
              },
            ],
            "name": "mb",
            "promotionId": "mb",
            "stackGroup": null,
          },
          {
            "amountMinor": 198n,
            "applications": 1,
            "code": null,
            "couponId": null,
            "kind": "threshold",
            "lines": [
              {
                "amountMinor": 90n,
                "lineId": "a",
              },
              {
                "amountMinor": 70n,
                "lineId": "b",
              },
              {
                "amountMinor": 38n,
                "lineId": "c",
              },
            ],
            "name": "th",
            "promotionId": "th",
            "stackGroup": null,
          },
          {
            "amountMinor": 50n,
            "applications": 1,
            "code": null,
            "couponId": "cu",
            "kind": "amount_off",
            "lines": [
              {
                "amountMinor": 23n,
                "lineId": "a",
              },
              {
                "amountMinor": 18n,
                "lineId": "b",
              },
              {
                "amountMinor": 9n,
                "lineId": "c",
              },
            ],
            "name": "cp",
            "promotionId": "cp",
            "stackGroup": null,
          },
        ],
        "roundingMinor": 1n,
        "skippedPromotions": [],
        "subtotalMinor": 5052n,
        "taxExemptMinor": 0n,
        "taxMinor": 336n,
        "taxSummary": [
          {
            "name": "GST",
            "rate": "0.10",
            "ruleId": "r",
            "taxMinor": 336n,
            "taxableMinor": 3368n,
          },
        ],
        "totalMinor": 3704n,
        "trace": [
          {
            "amountMinor": 900n,
            "detail": "price list member-list entry e-a",
            "ref": "a",
            "seq": 1,
            "step": "price_resolution",
          },
          {
            "amountMinor": 400n,
            "detail": "variant default",
            "ref": "b",
            "seq": 2,
            "step": "price_resolution",
          },
          {
            "amountMinor": 599n,
            "detail": "variant default",
            "ref": "c",
            "seq": 3,
            "step": "price_resolution",
          },
          {
            "amountMinor": -900n,
            "detail": "bogo "bogo" ×1",
            "ref": "bogo",
            "seq": 4,
            "step": "promotion",
          },
          {
            "amountMinor": -200n,
            "detail": "multibuy "mb" ×1",
            "ref": "mb",
            "seq": 5,
            "step": "promotion",
          },
          {
            "amountMinor": -198n,
            "detail": "threshold "th" ×1",
            "ref": "th",
            "seq": 6,
            "step": "promotion",
          },
          {
            "amountMinor": -50n,
            "detail": "amount_off "cp" ×1 coupon cu",
            "ref": "cp",
            "seq": 7,
            "step": "promotion",
          },
          {
            "amountMinor": 153n,
            "detail": "GST 0.10",
            "ref": "a",
            "seq": 8,
            "step": "tax",
          },
          {
            "amountMinor": 119n,
            "detail": "GST 0.10",
            "ref": "b",
            "seq": 9,
            "step": "tax",
          },
          {
            "amountMinor": 64n,
            "detail": "GST 0.10",
            "ref": "c",
            "seq": 10,
            "step": "tax",
          },
          {
            "amountMinor": 1n,
            "detail": "cash 3704 → 3705",
            "ref": "tender",
            "seq": 11,
            "step": "cash_rounding",
          },
        ],
      }
    `);
  });

  it('tax-exempt customer with exclusive pricing, a charge and a custom cash rule', () => {
    const out = priceOrder(
      order([line('a', 2, 1999, { variantId: 'v-a', modifiers: [{ id: 'm', priceMinor: 100 }] })], {
        customer: { id: 'c', taxExempt: true, taxExemptionReason: 'diplomat' },
        charges: [
          {
            id: 'fee',
            kind: 'delivery_fee',
            name: 'Delivery',
            amountMinor: 500,
            taxRate: '0.1',
            taxInclusive: false,
          },
        ],
        tenders: [{ method: 'cash' }],
      }),
      ctx({
        taxResolver: new FixedTaxRuleResolver({
          components: [{ ruleId: 'r', name: 'GST', rate: '0.10' }],
          inclusiveDefault: false,
        }),
        cashRounding: { intervalMinor: 10, mode: 'NEAREST_HALF_UP' },
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "amountDueMinor": 4700n,
        "at": "2026-10-19T02:00:00Z",
        "charges": [
          {
            "amountMinor": 500n,
            "id": "fee",
            "kind": "delivery_fee",
            "name": "Delivery",
            "taxExemptMinor": 50n,
            "taxInclusive": false,
            "taxMinor": 0n,
            "taxes": [],
            "totalMinor": 500n,
          },
        ],
        "chargesMinor": 500n,
        "currency": "AUD",
        "discountMinor": 0n,
        "lineDiscountMinor": 0n,
        "lines": [
          {
            "baseUnitPriceMinor": 1999n,
            "discounts": [],
            "grossMinor": 4198n,
            "id": "a",
            "lineDiscountMinor": 0n,
            "modifiersUnitMinor": 100n,
            "netMinor": 4198n,
            "orderDiscountMinor": 0n,
            "priceSource": {
              "kind": "variant_default",
            },
            "promotionDiscountMinor": 0n,
            "quantity": "2",
            "taxClassId": null,
            "taxExemptMinor": 420n,
            "taxInclusive": false,
            "taxMinor": 0n,
            "taxes": [],
            "totalMinor": 4198n,
            "unitPriceMinor": 2099n,
            "variantId": "v-a",
          },
        ],
        "netMinor": 4198n,
        "orderDiscountMinor": 0n,
        "orderDiscounts": [],
        "promotionDiscountMinor": 0n,
        "promotions": [],
        "roundingMinor": 2n,
        "skippedPromotions": [],
        "subtotalMinor": 4198n,
        "taxExemptMinor": 470n,
        "taxMinor": 0n,
        "taxSummary": [],
        "totalMinor": 4698n,
        "trace": [
          {
            "amountMinor": 1999n,
            "detail": "variant default",
            "ref": "a",
            "seq": 1,
            "step": "price_resolution",
          },
          {
            "amountMinor": 100n,
            "detail": "m",
            "ref": "a",
            "seq": 2,
            "step": "modifier",
          },
          {
            "amountMinor": -420n,
            "detail": "diplomat",
            "ref": "a",
            "seq": 3,
            "step": "tax_exemption",
          },
          {
            "amountMinor": 0n,
            "ref": "a",
            "seq": 4,
            "step": "tax",
          },
          {
            "amountMinor": 500n,
            "detail": "delivery_fee",
            "ref": "fee",
            "seq": 5,
            "step": "charge",
          },
          {
            "amountMinor": -50n,
            "detail": "diplomat",
            "ref": "fee",
            "seq": 6,
            "step": "tax_exemption",
          },
          {
            "amountMinor": 0n,
            "ref": "fee",
            "seq": 7,
            "step": "tax",
          },
          {
            "amountMinor": 2n,
            "detail": "cash 4698 → 4700",
            "ref": "tender",
            "seq": 8,
            "step": "cash_rounding",
          },
        ],
      }
    `);
  });
});
