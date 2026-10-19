import { describe, expect, it } from 'vitest';

import {
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
  ConfigResolvedSchema,
  CreateLocationSchema,
  OpenBusinessDaySchema,
  ProvisionTenantRequestSchema,
  ReparentOrgUnitSchema,
} from './index.js';

const id = '0190f8a0-0000-7000-8000-000000000001';

describe('tenancy contracts', () => {
  it('CONFIG_KEYS defaults validate against their own schemas', () => {
    expect(CONFIG_KEY_NAMES.length).toBeGreaterThanOrEqual(5);
    for (const key of CONFIG_KEY_NAMES) {
      const def = CONFIG_KEYS[key];
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
      expect(def.scopes.length).toBeGreaterThan(0);
    }
    expect(CONFIG_KEYS['cash.rounding.enabled'].default).toBe(true);
    expect(CONFIG_KEYS['identity.pin.max_attempts'].default).toBe(5);
    expect(CONFIG_KEYS['identity.pin.window_seconds'].default).toBe(900);
    expect(CONFIG_KEYS['identity.pin.lock_seconds'].default).toBe(900);
    expect(CONFIG_KEYS['identity.pin.max_attempts'].schema.safeParse(2.5).success).toBe(false);
  });

  it('ConfigResolved accepts a scope ref or the default marker', () => {
    expect(
      ConfigResolvedSchema.safeParse({
        key: 'receipt.header',
        value: 'Hi',
        resolvedScope: { kind: 'location', id },
        version: 3,
      }).success,
    ).toBe(true);
    expect(
      ConfigResolvedSchema.safeParse({
        key: 'receipt.header',
        value: '',
        resolvedScope: 'default',
        version: null,
      }).success,
    ).toBe(true);
  });

  it('CreateLocation enforces kind, currency and the HH:MM boundary', () => {
    const body = {
      orgUnitId: id,
      code: 'SYD-01',
      name: 'Sydney CBD',
      kind: 'store',
      timezone: 'Australia/Sydney',
      currency: 'AUD',
      businessDayBoundary: '04:00',
    };
    expect(CreateLocationSchema.safeParse(body).success).toBe(true);
    expect(CreateLocationSchema.safeParse({ ...body, kind: 'office' }).success).toBe(false);
    expect(CreateLocationSchema.safeParse({ ...body, currency: 'aud' }).success).toBe(false);
    expect(CreateLocationSchema.safeParse({ ...body, businessDayBoundary: '4:00' }).success).toBe(
      false,
    );
    expect(CreateLocationSchema.safeParse({ ...body, businessDayBoundary: '24:00' }).success).toBe(
      false,
    );
  });

  it('ReparentOrgUnit allows null (move to root)', () => {
    expect(ReparentOrgUnitSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(ReparentOrgUnitSchema.safeParse({ parentId: id }).success).toBe(true);
    expect(ReparentOrgUnitSchema.safeParse({}).success).toBe(false);
  });

  it('OpenBusinessDay takes an optional YYYY-MM-DD', () => {
    expect(OpenBusinessDaySchema.safeParse({}).success).toBe(true);
    expect(OpenBusinessDaySchema.safeParse({ businessDate: '2026-10-18' }).success).toBe(true);
    expect(OpenBusinessDaySchema.safeParse({ businessDate: '18/10/2026' }).success).toBe(false);
  });

  it('ProvisionTenantRequest requires a slug and an admin', () => {
    expect(
      ProvisionTenantRequestSchema.safeParse({
        slug: 'acme-cafe',
        name: 'Acme Cafe',
        admin: { email: 'owner@acme.test', displayName: 'Owner' },
      }).success,
    ).toBe(true);
    expect(
      ProvisionTenantRequestSchema.safeParse({
        slug: 'Acme Cafe',
        name: 'Acme Cafe',
        admin: { email: 'owner@acme.test', displayName: 'Owner' },
      }).success,
    ).toBe(false);
  });
});
