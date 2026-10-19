import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as contracts from '@pos/contracts';
import { mirroredTables } from '@pos/db';
import { FORBIDDEN_FIELD_PATTERNS, isForbiddenFieldName } from '@pos/payments-sdk';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';

/**
 * PCI scope guard (docs/01 §11, R7): no PAN, CVV, track data or expiry may exist as a column or a
 * contract field. This test fails the build if a name matching those patterns is added anywhere in
 * the payments data model: Drizzle mirror, canonical SQL, contracts, or the SDK's own types.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');

const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

function jsonSchemaPropertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => jsonSchemaPropertyNames(n, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'properties' && value && typeof value === 'object')
        Object.keys(value as object).forEach((name) => out.add(name));
      jsonSchemaPropertyNames(value, out);
    }
  }
  return out;
}

describe('the matcher itself', () => {
  it('flags the names it must flag (after camelCase → snake_case)', () => {
    for (const bad of [
      'pan',
      'cardPan',
      'cardNumber',
      'card_number',
      'primaryAccountNumber',
      'cvv',
      'cvv2',
      'cvc',
      'cardSecurityCode',
      'track1',
      'track2Data',
      'magstripe',
      'cardExpiry',
      'expiryMonth',
      'expYear',
      'expirationDate',
      'pinBlock',
      'iccData',
    ])
      expect(isForbiddenFieldName(snake(bad)), bad).toBe(true);
    expect(FORBIDDEN_FIELD_PATTERNS.length).toBeGreaterThan(5);
  });

  it('does not flag the scheme-permitted receipt fields', () => {
    for (const ok of [
      'last4',
      'cardBrand',
      'entryMode',
      'authCode',
      'aid',
      'applicationLabel',
      'tokenRef',
      'schemeReference',
      'cardholderVerification',
      'issuerBank',
      'terminalReceiptText',
      'offlineExpiresAt',
      'expiresAt',
      'requestRedacted',
    ])
      expect(isForbiddenFieldName(snake(ok)), ok).toBe(false);
  });
});

describe('Drizzle mirror of the payments schema', () => {
  const tables = mirroredTables().filter((t) => t.schema === 'payments');

  it('mirrors every payments table', () => {
    expect(tables.map((t) => t.name).sort()).toEqual(
      [
        'card_payment_details',
        'disputes',
        'payment_attempts',
        'payment_events',
        'payment_intents',
        'payment_provider_accounts',
        'payment_terminals',
        'reconciliation_exceptions',
        'refunds',
        'settlement_lines',
        'settlements',
        'webhook_inbox',
      ].sort(),
    );
  });

  it('has no column whose name matches PAN / CVV / track / expiry patterns', () => {
    const offending = tables.flatMap((t) =>
      t.columns
        .filter((c) => isForbiddenFieldName(c.name))
        .map((c) => `${t.schema}.${t.name}.${c.name}`),
    );
    expect(offending).toEqual([]);
  });

  it('card_payment_details holds exactly the scheme-permitted receipt columns', () => {
    const card = tables.find((t) => t.name === 'card_payment_details')!;
    expect(card.columns.map((c) => c.name).sort()).toEqual(
      [
        'aid',
        'application_label',
        'auth_code',
        'card_brand',
        'cardholder_verification',
        'entry_mode',
        'intent_id',
        'issuer_bank',
        'last4',
        'receipt_fields',
        'scheme_reference',
        'tenant_id',
        'terminal_receipt_text',
        'token_ref',
      ].sort(),
    );
  });
});

describe('canonical SQL (db/schema_part3.sql, payments schema)', () => {
  const sql = readFileSync(resolve(repoRoot, 'db/schema_part3.sql'), 'utf8');
  const blocks = [...sql.matchAll(/CREATE TABLE payments\.(\w+) \(([\s\S]*?)\n\)[^;]*;/g)];

  it('finds the payments tables', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(12);
  });

  it('declares no column whose name matches PAN / CVV / track / expiry patterns', () => {
    const offending: string[] = [];
    for (const [, table, body] of blocks) {
      for (const line of body!.split('\n')) {
        const column =
          /^\s{2}([a-z_][a-z0-9_]*)\s+(?!REFERENCES|UNIQUE|PRIMARY|FOREIGN|CHECK)[a-z]/i.exec(line);
        if (column && isForbiddenFieldName(column[1]!))
          offending.push(`payments.${table}.${column[1]}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

describe('contracts (packages/contracts/src/payments.ts)', () => {
  const schemas = Object.entries(contracts).filter(
    ([name, value]) =>
      /Schema$/.test(name) && value && typeof value === 'object' && '_zod' in (value as object),
  ) as [string, ZodType][];

  it('exports the payment schemas (the scan is not vacuous)', () => {
    const names = schemas.map(([n]) => n);
    for (const expected of [
      'PaymentIntentSchema',
      'CardPaymentDetailsSchema',
      'CreatePaymentIntentSchema',
      'RefundSchema',
      'CashTenderSchema',
      'OfflineCollectionSchema',
      'SettlementLineSchema',
    ])
      expect(names).toContain(expected);
  });

  it('no payments contract field matches PAN / CVV / track / expiry patterns', () => {
    const offending: string[] = [];
    for (const [name, schema] of schemas) {
      if (
        !/Payment|Card|Refund|Cash|Offline|Settlement|Webhook|Terminal|Provider|Exception|Forward|Capture|Reverse|Cancel|Submit|Pair/.test(
          name,
        )
      )
        continue;
      let json: unknown;
      try {
        json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      } catch {
        continue;
      }
      for (const field of jsonSchemaPropertyNames(json))
        if (isForbiddenFieldName(snake(field))) offending.push(`${name}.${field}`);
    }
    expect(offending).toEqual([]);
  });

  it('the intent and card contracts expose only masked card fields', () => {
    const card = z.toJSONSchema(contracts.CardPaymentDetailsSchema) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(card.properties).sort()).toEqual(
      [
        'aid',
        'applicationLabel',
        'authCode',
        'cardBrand',
        'cardholderVerification',
        'entryMode',
        'intentId',
        'issuerBank',
        'last4',
        'schemeReference',
        'terminalReceiptText',
        'tokenRef',
      ].sort(),
    );
    expect(
      contracts.CardPaymentDetailsSchema.safeParse({
        intentId: '0190f8a0-0000-7000-8000-000000000001',
        cardBrand: 'visa',
        last4: '4242424242424242',
      }).success,
    ).toBe(false);
  });
});

describe('SDK types', () => {
  it('MaskedCard and adapter source files declare no forbidden field names', () => {
    const source = readFileSync(resolve(repoRoot, 'packages/payments-sdk/src/adapter.ts'), 'utf8');
    const fields = [...source.matchAll(/^\s+readonly (\w+)\??:/gm)].map((m) => m[1]!);
    expect(fields.length).toBeGreaterThan(20);
    expect(fields.filter((f) => isForbiddenFieldName(snake(f)))).toEqual([]);
  });
});
