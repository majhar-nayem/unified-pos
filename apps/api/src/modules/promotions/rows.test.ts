import { describe, expect, it } from 'vitest';

import {
  toAssignmentDto,
  toCouponDto,
  toEntryDto,
  toPriceListDto,
  toPromotionDto,
  toScopeDto,
} from './rows.js';

const at = new Date('2026-10-19T02:00:00Z');

describe('row mappers', () => {
  it('price list: trims the char(3) currency and renders ISO timestamps', () => {
    const dto = toPriceListDto({
      id: 'i',
      tenant_id: 't',
      name: 'n',
      currency: 'AUD ',
      kind: 'member',
      tax_inclusive: true,
      priority: 5,
      status: 'active',
      version: 3,
      created_at: at,
      updated_at: at,
    });
    expect(dto).toMatchObject({
      currency: 'AUD',
      createdAt: '2026-10-19T02:00:00.000Z',
      taxInclusive: true,
      version: 3,
    });
  });

  it('entry: int8 may arrive as bigint or string and always leaves as a string', () => {
    const row = {
      id: 'i',
      tenant_id: 't',
      price_list_id: 'l',
      variant_id: 'v',
      min_quantity: '1.0000',
      valid_from: null,
      valid_to: at,
      price_list_version: 4,
    };
    expect(toEntryDto({ ...row, price_minor: 995n }).priceMinor).toBe('995');
    expect(toEntryDto({ ...row, price_minor: '995' }).priceMinor).toBe('995');
    expect(toEntryDto({ ...row, price_minor: 1n })).toMatchObject({
      validFrom: null,
      validTo: '2026-10-19T02:00:00.000Z',
      priceListVersion: 4,
    });
  });

  it('assignment and scope carry the owning aggregate version', () => {
    expect(
      toAssignmentDto({
        id: 'i',
        tenant_id: 't',
        price_list_id: 'l',
        scope_kind: 'channel',
        scope_id: null,
        scope_value: 'online',
        priority: 7,
        price_list_version: 9,
      }),
    ).toEqual({
      id: 'i',
      tenantId: 't',
      priceListId: 'l',
      scopeKind: 'channel',
      scopeId: null,
      scopeValue: 'online',
      priority: 7,
      priceListVersion: 9,
    });
    expect(
      toScopeDto({
        id: 'i',
        tenant_id: 't',
        promotion_id: 'p',
        scope_kind: 'location',
        scope_id: 'x',
        scope_value: null,
        promotion_version: 2,
      }),
    ).toEqual({
      id: 'i',
      tenantId: 't',
      promotionId: 'p',
      scopeKind: 'location',
      scopeId: 'x',
      scopeValue: null,
      promotionVersion: 2,
    });
  });

  it('promotion: budget is nullable, spent is always a string', () => {
    const row = {
      id: 'i',
      tenant_id: 't',
      code: null,
      name: 'n',
      description: null,
      kind: 'percent_off' as const,
      rules: {
        version: 1 as const,
        targets: { all: true },
        effect: { kind: 'percent_off' as const, percent: '10' },
      },
      priority: 100,
      stack_group: null,
      is_exclusive: false,
      requires_coupon: true,
      max_uses_total: null,
      max_uses_per_customer: 2,
      uses_count: 3,
      budget_minor: null,
      spent_minor: 0n,
      schedule: {},
      valid_from: at,
      valid_to: null,
      status: 'draft' as const,
      version: 1,
      created_by: null,
      created_at: at,
      updated_at: at,
    };
    expect(toPromotionDto(row)).toMatchObject({
      budgetMinor: null,
      spentMinor: '0',
      requiresCoupon: true,
      maxUsesPerCustomer: 2,
      validTo: null,
    });
    expect(toPromotionDto({ ...row, budget_minor: 5000n, spent_minor: '120' })).toMatchObject({
      budgetMinor: '5000',
      spentMinor: '120',
    });
  });

  it('coupon', () => {
    expect(
      toCouponDto({
        id: 'i',
        tenant_id: 't',
        promotion_id: 'p',
        code: 'C',
        customer_id: null,
        max_uses: 1,
        uses_count: 0,
        expires_at: null,
        status: 'active',
        created_at: at,
      }),
    ).toEqual({
      id: 'i',
      tenantId: 't',
      promotionId: 'p',
      code: 'C',
      customerId: null,
      maxUses: 1,
      usesCount: 0,
      expiresAt: null,
      status: 'active',
      createdAt: '2026-10-19T02:00:00.000Z',
    });
  });
});
