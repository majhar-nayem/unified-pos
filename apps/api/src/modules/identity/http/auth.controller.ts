import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ClientCredentialsRequestSchema,
  DeviceChallengeResponseSchema,
  DeviceEnrollRequestSchema,
  DeviceEnrollResponseSchema,
  DeviceLoginRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  PasskeyAuthOptionsResponseSchema,
  PasskeyAuthVerifyRequestSchema,
  PinLoginRequestSchema,
  PrincipalDtoSchema,
  RefreshRequestSchema,
  TokenPairSchema,
  TotpVerifyRequestSchema,
} from '@pos/contracts';
import { z } from 'zod';

import {
  AllowKinds,
  Contract,
  Public,
  RequestContextService,
  UnauthorizedError,
  ValidBody,
  ValidQuery,
  isOperator,
} from '../../kernel/public/index.js';
import { EffectivePermissionsService } from '../access/effective-permissions.service.js';
import { ClientAuthService } from '../authn/client-auth.service.js';
import { DeviceAuthService } from '../authn/device-auth.service.js';
import { LoginService } from '../authn/login.service.js';
import { MfaService } from '../authn/mfa.service.js';
import { PinAuthService } from '../authn/pin-auth.service.js';
import { TokenService } from '../crypto/tokens.js';
import { SessionsService } from '../sessions/sessions.service.js';

const TAGS = ['auth'] as const;
const uuid = z.string().uuid();

@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: LoginService,
    private readonly mfa: MfaService,
    private readonly deviceAuth: DeviceAuthService,
    private readonly pinAuth: PinAuthService,
    private readonly clientAuth: ClientAuthService,
    private readonly sessions: SessionsService,
    private readonly tokens: TokenService,
    private readonly effective: EffectivePermissionsService,
    private readonly context: RequestContextService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Contract({
    operationId: 'auth.login',
    summary: 'Password login (tenant slug + email)',
    tags: TAGS,
    body: LoginRequestSchema,
    response: LoginResponseSchema,
    status: 200,
    public: true,
    examples: {
      body: {
        tenantSlug: 'acme',
        email: 'owner@acme.test',
        password: 'correct horse battery staple',
      },
    },
  })
  password(@ValidBody() body: z.infer<typeof LoginRequestSchema>) {
    return this.login.login(body);
  }

  @Post('mfa/totp')
  @AllowKinds('preauth', 'web', 'pos')
  @HttpCode(200)
  @Contract({
    operationId: 'auth.mfa.totp',
    summary: 'Second factor: TOTP',
    tags: TAGS,
    body: TotpVerifyRequestSchema,
    response: LoginResponseSchema,
    status: 200,
    examples: { body: { code: '123456' } },
  })
  totp(@ValidBody() body: z.infer<typeof TotpVerifyRequestSchema>) {
    return this.mfa.verifyTotp(body.code);
  }

  @Post('mfa/passkey/options')
  @AllowKinds('preauth', 'web', 'pos')
  @HttpCode(200)
  @Contract({
    operationId: 'auth.mfa.passkey.options',
    tags: TAGS,
    response: PasskeyAuthOptionsResponseSchema,
    status: 200,
  })
  passkeyOptions() {
    return this.mfa.passkeyOptions();
  }

  @Post('mfa/passkey/verify')
  @AllowKinds('preauth', 'web', 'pos')
  @HttpCode(200)
  @Contract({
    operationId: 'auth.mfa.passkey.verify',
    tags: TAGS,
    body: PasskeyAuthVerifyRequestSchema,
    response: LoginResponseSchema,
    status: 200,
    examples: { body: { response: {} } },
  })
  passkeyVerify(@ValidBody() body: z.infer<typeof PasskeyAuthVerifyRequestSchema>) {
    return this.mfa.verifyPasskey(body.response);
  }

  @Post('pin')
  @AllowKinds('device')
  @HttpCode(200)
  @Contract({
    operationId: 'auth.pin',
    summary: 'Staff sign-in on an enrolled device',
    tags: TAGS,
    body: PinLoginRequestSchema,
    response: TokenPairSchema,
    status: 200,
    examples: { body: { userId: '$fixture:userId', pin: '1234' } },
  })
  pin(@ValidBody() body: z.infer<typeof PinLoginRequestSchema>) {
    return this.pinAuth.login(body);
  }

  @Post('device/enroll')
  @Public()
  @Contract({
    operationId: 'auth.device.enroll',
    tags: TAGS,
    body: DeviceEnrollRequestSchema,
    response: DeviceEnrollResponseSchema,
    public: true,
    examples: {
      body: {
        enrollmentCode: 'acme.ABCDEFGHJKMN',
        publicKey: 'AAAA',
        name: 'Register 1',
        platform: 'android',
        appVersion: '1.0.0',
      },
    },
  })
  enroll(@ValidBody() body: z.infer<typeof DeviceEnrollRequestSchema>) {
    return this.deviceAuth.enroll(body);
  }

  @Get('device/challenge')
  @Public()
  @Contract({
    operationId: 'auth.device.challenge',
    tags: TAGS,
    query: z.object({ tenantId: uuid, deviceId: uuid }),
    response: DeviceChallengeResponseSchema,
    public: true,
  })
  challenge(@ValidQuery() query: { tenantId: string; deviceId: string }) {
    return this.deviceAuth.challenge(query.tenantId, query.deviceId);
  }

  @Post('device/login')
  @Public()
  @HttpCode(200)
  @Contract({
    operationId: 'auth.device.login',
    tags: TAGS,
    body: DeviceLoginRequestSchema,
    response: TokenPairSchema,
    status: 200,
    public: true,
    examples: {
      body: {
        tenantId: '$fixture:tenantId',
        deviceId: '$fixture:deviceId',
        nonce: 'AAAA',
        signature: 'AAAA',
      },
    },
  })
  deviceLogin(@ValidBody() body: z.infer<typeof DeviceLoginRequestSchema>) {
    return this.deviceAuth.login(body);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @Contract({
    operationId: 'auth.refresh',
    summary: 'Rotate a refresh token',
    tags: TAGS,
    body: RefreshRequestSchema,
    response: TokenPairSchema,
    status: 200,
    public: true,
    examples: { body: { refreshToken: 'AAAA' } },
  })
  refresh(@ValidBody() body: z.infer<typeof RefreshRequestSchema>) {
    const ctx = this.context.current();
    return this.sessions.rotate(body.refreshToken, {
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    });
  }

  @Post('logout')
  @AllowKinds('web', 'pos')
  @HttpCode(204)
  @Contract({ operationId: 'auth.logout', tags: TAGS, status: 204 })
  async logout(): Promise<void> {
    const principal = this.context.require().principal;
    if (!principal || isOperator(principal) || !principal.sessionId) throw new UnauthorizedError();
    await this.sessions.revoke(principal.tenantId, principal.sessionId, 'logout');
  }

  @Post('client')
  @Public()
  @HttpCode(200)
  @Contract({
    operationId: 'auth.client',
    summary: 'Client credentials → API token',
    tags: TAGS,
    body: ClientCredentialsRequestSchema,
    response: TokenPairSchema,
    status: 200,
    public: true,
    examples: { body: { tenantSlug: 'acme', clientId: 'c_x', clientSecret: 'sk_x' } },
  })
  client(@ValidBody() body: z.infer<typeof ClientCredentialsRequestSchema>) {
    return this.clientAuth.token(body);
  }

  @Get('me')
  @AllowKinds('web', 'pos', 'device', 'api', 'preauth')
  @Contract({
    operationId: 'auth.me',
    summary: 'The caller’s principal',
    tags: TAGS,
    response: PrincipalDtoSchema,
  })
  async me() {
    const principal = this.context.require().principal;
    if (!principal || isOperator(principal)) throw new UnauthorizedError();
    const mfaRequired =
      principal.kind === 'user'
        ? (await this.effective.build(principal.tenantId, principal.subjectId)).mfaRequired
        : false;
    const { tokenKind: _kind, ...rest } = principal;
    return {
      ...rest,
      mfaRequired,
      permissions: [...new Set(principal.assignments.flatMap((a) => a.permissions))],
    };
  }

  @Get('jwks')
  @Public()
  @Contract({ operationId: 'auth.jwks', tags: TAGS, public: true })
  jwks() {
    return this.tokens.jwks();
  }
}

void Body;
void Query;
