import { orders } from '@pos/domain-core';
import { describe, expect, it } from 'vitest';

import {
  AddChargeSchema,
  AddOrderLineSchema,
  ApplyDiscountSchema,
  CREATABLE_ORDER_KINDS,
  CreateOrderSchema,
  CreateReceiptSchema,
  CreateReturnSchema,
  ListOrdersQuerySchema,
  ORDER_EVENT_NAMES,
  OrderStatusSchema,
  PlaceOrderSchema,
  QuantityInputSchema,
  RenderReceiptQuerySchema,
  SplitChecksSchema,
  UpdateOrderLineSchema,
  VoidOrderSchema,
} from './orders.js';

const id = '0190f8a0-0000-7000-8000-000000000001';
const id2 = '0190f8a0-0000-7000-8000-000000000002';

describe('order contracts', () => {
  it('enums are the domain-core enums (one source of truth with the CHECK constraints)', () => {
    expect(OrderStatusSchema.options).toEqual([...orders.ORDER_STATUSES]);
    expect(CREATABLE_ORDER_KINDS).not.toContain('return');
    expect(CREATABLE_ORDER_KINDS).not.toContain('exchange');
    expect(CREATABLE_ORDER_KINDS).toContain('dine_in');
    expect(ORDER_EVENT_NAMES).toContain('order.returned');
  });

  it('quantities: positive, at most four decimals, text only', () => {
    for (const ok of ['1', '0.5', '1.2550', '9999999999.9999'])
      expect(QuantityInputSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['0', '0.0000', '-1', '1.00001', '1e3', 1, '', 'abc'])
      expect(QuantityInputSchema.safeParse(bad).success, String(bad)).toBe(false);
  });

  it('create order: defaults to a retail sale and refuses return kinds', () => {
    expect(CreateOrderSchema.parse({ locationId: id }).kind).toBe('retail_sale');
    expect(CreateOrderSchema.safeParse({ locationId: id, kind: 'return' }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ locationId: id, kind: 'exchange' }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ locationId: 'x' }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ locationId: id, clientOrderRef: '' }).success).toBe(false);
    const withLines = CreateOrderSchema.parse({
      locationId: id,
      kind: 'dine_in',
      lines: [{ item: { name: 'Soup' }, listPriceMinor: '900', quantity: '1' }],
    });
    expect(withLines.lines).toHaveLength(1);
  });

  it('add line: money is an integer string, never a number or a negative price', () => {
    const ok = { item: { name: 'Latte' }, listPriceMinor: '550', quantity: '2' };
    expect(AddOrderLineSchema.safeParse(ok).success).toBe(true);
    expect(AddOrderLineSchema.safeParse({ ...ok, listPriceMinor: 550 }).success).toBe(false);
    expect(AddOrderLineSchema.safeParse({ ...ok, listPriceMinor: '-1' }).success).toBe(false);
    expect(AddOrderLineSchema.safeParse({ ...ok, unitPriceMinor: '4.5' }).success).toBe(false);
    expect(
      AddOrderLineSchema.safeParse({ ...ok, modifiers: [{ name: 'Oat', priceDeltaMinor: '-50' }] })
        .success,
    ).toBe(true);
    expect(
      AddOrderLineSchema.safeParse({ ...ok, modifiers: [{ name: 'x', quantity: 0 }] }).success,
    ).toBe(false);
    expect(AddOrderLineSchema.safeParse({ ...ok, seatNumber: 0 }).success).toBe(false);
  });

  it('update line needs at least one field', () => {
    expect(UpdateOrderLineSchema.safeParse({}).success).toBe(false);
    expect(UpdateOrderLineSchema.safeParse({ quantity: '3' }).success).toBe(true);
    expect(UpdateOrderLineSchema.safeParse({ notes: null }).success).toBe(true);
  });

  it('discounts and charges take exactly one of percent or amount', () => {
    expect(ApplyDiscountSchema.safeParse({ description: 'x', percent: '10' }).success).toBe(true);
    expect(
      ApplyDiscountSchema.safeParse({ description: 'x', amountMinor: '100', lineId: id }).success,
    ).toBe(true);
    expect(ApplyDiscountSchema.safeParse({ description: 'x' }).success).toBe(false);
    expect(
      ApplyDiscountSchema.safeParse({ description: 'x', percent: '10', amountMinor: '5' }).success,
    ).toBe(false);
    expect(ApplyDiscountSchema.safeParse({ description: 'x', percent: '10.12345' }).success).toBe(
      false,
    );
    expect(
      AddChargeSchema.safeParse({ kind: 'service_charge', description: 's', percent: '10' })
        .success,
    ).toBe(true);
    expect(
      AddChargeSchema.safeParse({ kind: 'nope', description: 's', percent: '10' }).success,
    ).toBe(false);
    expect(AddChargeSchema.safeParse({ kind: 'surcharge', description: 's' }).success).toBe(false);
  });

  it('place has an optional body; void needs a reason', () => {
    expect(PlaceOrderSchema.parse(undefined)).toEqual({});
    expect(PlaceOrderSchema.parse({ approvalId: id })).toEqual({ approvalId: id });
    expect(VoidOrderSchema.safeParse({ reason: 'x' }).success).toBe(true);
    expect(VoidOrderSchema.safeParse({}).success).toBe(false);
    expect(VoidOrderSchema.safeParse({ reason: '' }).success).toBe(false);
  });

  it('split checks: three modes, each with its own shape', () => {
    expect(
      SplitChecksSchema.safeParse({ mode: 'lines', fromCheckId: id, lineIds: [id2] }).success,
    ).toBe(true);
    expect(
      SplitChecksSchema.safeParse({ mode: 'lines', fromCheckId: id, lineIds: [] }).success,
    ).toBe(false);
    expect(
      SplitChecksSchema.safeParse({ mode: 'seats', fromCheckId: id, seatNumbers: [1, 2] }).success,
    ).toBe(true);
    expect(SplitChecksSchema.safeParse({ mode: 'share', lineId: id, parts: 3 }).success).toBe(true);
    expect(
      SplitChecksSchema.safeParse({
        mode: 'share',
        lineId: id,
        shares: [{ quantity: '0.5' }, { quantity: '0.5', label: 'Bob' }],
      }).success,
    ).toBe(true);
    expect(SplitChecksSchema.safeParse({ mode: 'share', lineId: id, parts: 1 }).success).toBe(
      false,
    );
    expect(SplitChecksSchema.safeParse({ mode: 'nope' }).success).toBe(false);
  });

  it('returns need at least one line; kind defaults to return', () => {
    expect(CreateReturnSchema.parse({ lines: [{ sourceLineId: id, quantity: '1' }] }).kind).toBe(
      'return',
    );
    expect(CreateReturnSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(
      CreateReturnSchema.safeParse({ kind: 'sale', lines: [{ sourceLineId: id, quantity: '1' }] })
        .success,
    ).toBe(false);
  });

  it('list query and receipt requests', () => {
    expect(ListOrdersQuerySchema.parse({ locationId: id }).limit).toBe(50);
    expect(ListOrdersQuerySchema.safeParse({}).success).toBe(false);
    expect(ListOrdersQuerySchema.safeParse({ locationId: id, status: 'nope' }).success).toBe(false);
    expect(
      CreateReceiptSchema.safeParse({ kind: 'gift', deliveredVia: ['print', 'email'] }).success,
    ).toBe(true);
    expect(CreateReceiptSchema.safeParse({ kind: 'reprint' }).success).toBe(false);
    expect(RenderReceiptQuerySchema.parse({}).format).toBe('html');
    expect(RenderReceiptQuerySchema.parse({ format: 'escpos', columns: '32' }).columns).toBe(32);
    expect(RenderReceiptQuerySchema.safeParse({ format: 'docx' }).success).toBe(false);
  });
});
