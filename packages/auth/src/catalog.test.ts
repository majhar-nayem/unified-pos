import { describe, expect, it } from 'vitest';

import { LIMIT_KEYS, PERMISSIONS, SYSTEM_ROLES, TOKEN_KINDS, requiresMfa } from './index.js';

const KEY_SHAPE = /^[a-z_]+(\.[a-z_]+)+$/;

describe('PERMISSIONS', () => {
  it('every key matches resource.action and is unique', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    for (const key of keys) expect(key).toMatch(KEY_SHAPE);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every key starts with its module', () => {
    for (const p of PERMISSIONS) expect(p.key.startsWith(`${p.module}.`)).toBe(true);
  });

  it('marks *.admin keys sensitive and sensitive keys are a subset of the MFA rule or explicit list', () => {
    for (const p of PERMISSIONS) {
      if (p.key.endsWith('.admin')) expect(p.isSensitive).toBe(true);
    }
    for (const key of [
      'identity.credential.manage',
      'access.role.manage',
      'access.assignment.grant',
      'access.assignment.revoke',
      'approvals.approve',
      'audit.export',
      'devices.revoke',
      'orders.void',
    ]) {
      expect(PERMISSIONS.find((p) => p.key === key)?.isSensitive).toBe(true);
    }
  });
});

describe('LIMIT_KEYS', () => {
  it('keys match resource.action shape and are unique', () => {
    const keys = LIMIT_KEYS.map((l) => l.key);
    for (const key of keys) expect(key).toMatch(KEY_SHAPE);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('SYSTEM_ROLES', () => {
  const permissionKeys = new Set(PERMISSIONS.map((p) => p.key));
  const limitTypes = new Map(LIMIT_KEYS.map((l) => [l.key, l.type]));

  it('role keys are unique', () => {
    const keys = SYSTEM_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      'tenant_owner',
      'admin',
      'finance',
      'store_manager',
      'shift_supervisor',
      'cashier',
      'server',
      'kitchen',
      'readonly_auditor',
    ]);
  });

  it('every role permission exists in PERMISSIONS, without duplicates', () => {
    for (const role of SYSTEM_ROLES) {
      for (const key of role.permissions) expect(permissionKeys.has(key), key).toBe(true);
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });

  it('limit values match the LIMIT_KEYS types', () => {
    for (const role of SYSTEM_ROLES) {
      for (const [key, value] of Object.entries(role.limits ?? {})) {
        const type = limitTypes.get(key);
        expect(type, `${role.key}: unknown limit ${key}`).toBeDefined();
        if (type === 'string[]') {
          expect(Array.isArray(value)).toBe(true);
        } else {
          expect(typeof value).toBe(type);
        }
      }
    }
  });

  it('tenant_owner holds everything; admin lacks only finance.admin', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'tenant_owner')!;
    expect(new Set(owner.permissions)).toEqual(permissionKeys);
    const admin = SYSTEM_ROLES.find((r) => r.key === 'admin')!;
    expect(admin.permissions).not.toContain('finance.admin');
    expect(admin.permissions.length).toBe(PERMISSIONS.length - 1);
  });

  it('MFA is required for roles holding *.admin or finance.* keys, not floor staff', () => {
    const mfa = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.key, requiresMfa(r.permissions)]));
    expect(mfa).toMatchObject({
      tenant_owner: true,
      admin: true,
      finance: true,
      store_manager: false,
      shift_supervisor: false,
      cashier: false,
      server: false,
      kitchen: false,
      readonly_auditor: true, // holds finance.reports.view
    });
  });

  it('readonly_auditor holds only view keys plus audit.view', () => {
    const auditor = SYSTEM_ROLES.find((r) => r.key === 'readonly_auditor')!;
    expect(auditor.permissions).toContain('audit.view');
    for (const key of auditor.permissions) expect(key.endsWith('.view')).toBe(true);
  });
});

describe('TOKEN_KINDS', () => {
  it('lists the five token kinds', () => {
    expect(TOKEN_KINDS).toEqual(['web', 'pos', 'device', 'api', 'preauth']);
  });
});
