import { describe, expect, it } from 'vitest';

import {
  CreateRoleAssignmentSchema,
  DeviceEnrollRequestSchema,
  EVENT_CATALOG,
  LoginResponseSchema,
  PinLoginRequestSchema,
  SetPinRequestSchema,
  TotpVerifyRequestSchema,
} from './index.js';

const id = '0190f8a0-0000-7000-8000-000000000001';

describe('identity contracts', () => {
  it('PIN accepts 4-8 digits and rejects non-digits', () => {
    expect(PinLoginRequestSchema.safeParse({ userId: id, pin: '1234' }).success).toBe(true);
    expect(PinLoginRequestSchema.safeParse({ userId: id, pin: '12345678' }).success).toBe(true);
    expect(PinLoginRequestSchema.safeParse({ userId: id, pin: '12a4' }).success).toBe(false);
    expect(PinLoginRequestSchema.safeParse({ userId: id, pin: '123' }).success).toBe(false);
    expect(PinLoginRequestSchema.safeParse({ userId: id, pin: '123456789' }).success).toBe(false);
    expect(SetPinRequestSchema.safeParse({ locationId: id, pin: '12 34' }).success).toBe(false);
  });

  it('TOTP code is exactly six digits', () => {
    expect(TotpVerifyRequestSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(TotpVerifyRequestSchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(TotpVerifyRequestSchema.safeParse({ code: 'abcdef' }).success).toBe(false);
  });

  it('LoginResponse discriminates on status', () => {
    const authenticated = LoginResponseSchema.parse({
      status: 'authenticated',
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 900 },
    });
    expect(authenticated.status).toBe('authenticated');
    if (authenticated.status === 'authenticated') {
      expect(authenticated.tokens.expiresIn).toBe(900);
    }

    const mfa = LoginResponseSchema.parse({
      status: 'mfa_required',
      preauthToken: 'p',
      methods: ['totp'],
    });
    expect(mfa.status).toBe('mfa_required');

    expect(
      LoginResponseSchema.safeParse({ status: 'mfa_enrollment_required', preauthToken: 'p' })
        .success,
    ).toBe(true);
    // Wrong payload for the discriminator value.
    expect(
      LoginResponseSchema.safeParse({ status: 'authenticated', preauthToken: 'p' }).success,
    ).toBe(false);
    expect(LoginResponseSchema.safeParse({ status: 'nope' }).success).toBe(false);
  });

  it('enrollment code is <slug>.<code>', () => {
    const body = {
      enrollmentCode: 'acme-cafe.A1B2C3D4',
      publicKey: 'MCowBQYDK2VwAyEA' + 'a'.repeat(43) + '=',
      name: 'Front counter iPad',
      platform: 'ios',
      appVersion: '1.0.0',
    };
    expect(DeviceEnrollRequestSchema.safeParse(body).success).toBe(true);
    expect(
      DeviceEnrollRequestSchema.safeParse({ ...body, enrollmentCode: 'A1B2C3D4' }).success,
    ).toBe(false);
  });

  it('role assignment rejects validTo before validFrom and department scope', () => {
    const base = { userId: id, roleId: id, scope: { kind: 'location', id } };
    expect(CreateRoleAssignmentSchema.safeParse(base).success).toBe(true);
    expect(
      CreateRoleAssignmentSchema.safeParse({
        ...base,
        validFrom: '2026-01-02T00:00:00Z',
        validTo: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      CreateRoleAssignmentSchema.safeParse({ ...base, scope: { kind: 'department', id } }).success,
    ).toBe(false);
  });

  it('every EVENT_CATALOG entry is unique and includes the F1 events', () => {
    expect(new Set(EVENT_CATALOG).size).toBe(EVENT_CATALOG.length);
    for (const event of [
      'user.invited',
      'user.activated',
      'role_assignment.granted',
      'role_assignment.revoked',
      'approval.decided',
      'org_unit.reparented',
      'business_day.opened',
      'device.revoked',
    ]) {
      expect(EVENT_CATALOG).toContain(event);
    }
  });
});
