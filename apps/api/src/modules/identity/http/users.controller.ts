import { Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import {
  AcceptInviteSchema,
  CreateUserSchema,
  CredentialSchema,
  InviteUserSchema,
  PasskeyRegisterOptionsRequestSchema,
  PasskeyRegisterOptionsResponseSchema,
  PasskeyRegisterVerifyRequestSchema,
  SetPasswordRequestSchema,
  SetPinRequestSchema,
  TotpEnrollResponseSchema,
  TotpVerifyRequestSchema,
  UpdateUserSchema,
  UserSchema,
} from '@pos/contracts';
import { z } from 'zod';

import {
  AllowKinds,
  AuthorizationService,
  Contract,
  Public,
  UnitOfWork,
  ValidBody,
  ValidParams,
} from '../../kernel/public/index.js';
import { CredentialsRepository, toCredentialDto } from '../credentials/credentials.repository.js';
import { PasskeyService } from '../credentials/passkey.service.js';
import { PasswordService } from '../credentials/password.service.js';
import { PinService } from '../credentials/pin.service.js';
import { TotpService } from '../credentials/totp.service.js';
import { UsersService } from '../users/users.service.js';

const TAGS = ['identity'] as const;
const uuid = z.string().uuid();
const userParams = z.object({ userId: uuid });
const userExample = { params: { userId: 'userId' } };

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly totp: TotpService,
    private readonly passkeys: PasskeyService,
    private readonly pins: PinService,
    private readonly credentials: CredentialsRepository,
    private readonly authz: AuthorizationService,
    private readonly uow: UnitOfWork,
  ) {}

  @Get()
  @Contract({
    operationId: 'identity.user.list',
    tags: TAGS,
    response: z.array(UserSchema),
    permission: 'identity.user.view',
  })
  list() {
    return this.users.list();
  }

  @Post()
  @Contract({
    operationId: 'identity.user.create',
    tags: TAGS,
    body: CreateUserSchema,
    response: UserSchema,
    permission: 'identity.user.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { body: { email: 'new@acme.test', displayName: 'New User' } },
  })
  create(@ValidBody() body: z.infer<typeof CreateUserSchema>) {
    return this.users.create(body);
  }

  @Post('invite')
  @Contract({
    operationId: 'identity.user.invite',
    tags: TAGS,
    body: InviteUserSchema,
    response: z.object({ user: UserSchema, inviteToken: z.string() }),
    permission: 'identity.user.invite',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { body: { email: 'invitee@acme.test', displayName: 'Invitee' } },
  })
  invite(@ValidBody() body: z.infer<typeof InviteUserSchema>) {
    return this.users.invite(body);
  }

  @Post('accept-invite')
  @Public()
  @HttpCode(200)
  @Contract({
    operationId: 'identity.user.accept_invite',
    tags: TAGS,
    body: AcceptInviteSchema,
    response: z.object({ tenantId: uuid, userId: uuid }),
    status: 200,
    public: true,
    examples: { body: { token: 'AAAA', password: 'correct horse battery staple' } },
  })
  acceptInvite(@ValidBody() body: z.infer<typeof AcceptInviteSchema>) {
    return this.users.acceptInvite(body.token, body.password);
  }

  @Get('me')
  @AllowKinds('web', 'pos', 'preauth')
  @Contract({ operationId: 'identity.user.me', tags: TAGS, response: UserSchema })
  me() {
    return this.users.me();
  }

  @Put('me/password')
  @HttpCode(204)
  @Contract({
    operationId: 'identity.me.password',
    summary: 'Change own password',
    tags: TAGS,
    body: SetPasswordRequestSchema,
    status: 204,
    idempotent: true,
    examples: { body: { currentPassword: 'old password 123', newPassword: 'new password 1234' } },
  })
  changeOwnPassword(@ValidBody() body: z.infer<typeof SetPasswordRequestSchema>) {
    return this.passwords.setPassword(this.users.currentUserId(), body);
  }

  @Post('me/totp/enroll')
  @AllowKinds('web', 'pos', 'preauth')
  @HttpCode(200)
  @Contract({
    operationId: 'identity.me.totp.enroll',
    tags: TAGS,
    response: TotpEnrollResponseSchema,
    status: 200,
  })
  totpEnroll() {
    return this.totp.beginEnrollment();
  }

  @Post('me/totp/confirm')
  @AllowKinds('web', 'pos', 'preauth')
  @HttpCode(204)
  @Contract({
    operationId: 'identity.me.totp.confirm',
    tags: TAGS,
    body: TotpVerifyRequestSchema,
    status: 204,
    examples: { body: { code: '123456' } },
  })
  totpConfirm(@ValidBody() body: z.infer<typeof TotpVerifyRequestSchema>) {
    return this.totp.confirmEnrollment(body.code);
  }

  @Post('me/passkeys/options')
  @AllowKinds('web', 'pos', 'preauth')
  @HttpCode(200)
  @Contract({
    operationId: 'identity.me.passkey.options',
    tags: TAGS,
    body: PasskeyRegisterOptionsRequestSchema,
    response: PasskeyRegisterOptionsResponseSchema,
    status: 200,
    examples: { body: {} },
  })
  passkeyOptions() {
    return this.passkeys.registrationOptions();
  }

  @Post('me/passkeys')
  @AllowKinds('web', 'pos', 'preauth')
  @Contract({
    operationId: 'identity.me.passkey.register',
    tags: TAGS,
    body: PasskeyRegisterVerifyRequestSchema,
    response: z.object({ credentialId: uuid }),
    examples: { body: { response: {} } },
  })
  passkeyRegister(@ValidBody() body: z.infer<typeof PasskeyRegisterVerifyRequestSchema>) {
    return this.passkeys.verifyRegistration(body.response, body.label);
  }

  @Get(':userId')
  @Contract({
    operationId: 'identity.user.get',
    tags: TAGS,
    params: userParams,
    response: UserSchema,
    permission: 'identity.user.view',
    scope: { kind: 'tenant' },
    examples: userExample,
  })
  get(@ValidParams() params: { userId: string }) {
    return this.users.get(params.userId);
  }

  @Patch(':userId')
  @Contract({
    operationId: 'identity.user.update',
    tags: TAGS,
    params: userParams,
    body: UpdateUserSchema,
    response: UserSchema,
    permission: 'identity.user.manage',
    scope: { kind: 'tenant' },
    examples: { ...userExample, body: { displayName: 'Renamed' } },
  })
  update(
    @ValidParams() params: { userId: string },
    @ValidBody() body: z.infer<typeof UpdateUserSchema>,
  ) {
    return this.users.update(params.userId, body);
  }

  @Get(':userId/credentials')
  @Contract({
    operationId: 'identity.user.credentials',
    tags: TAGS,
    params: userParams,
    response: z.array(CredentialSchema),
    permission: 'identity.credential.manage',
    scope: { kind: 'tenant' },
    examples: userExample,
  })
  async listCredentials(@ValidParams() params: { userId: string }) {
    if (!this.users.isSelf(params.userId)) await this.authz.assert('identity.credential.manage');
    return this.uow.read(async (db) => {
      await this.users.require(db, params.userId);
      return (await this.credentials.listForUser(db, params.userId)).map(toCredentialDto);
    });
  }

  @Put(':userId/password')
  @HttpCode(204)
  @Contract({
    operationId: 'identity.user.password.reset',
    summary: 'Admin password reset (revokes sessions)',
    tags: TAGS,
    params: userParams,
    body: SetPasswordRequestSchema,
    status: 204,
    permission: 'identity.credential.manage',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { ...userExample, body: { newPassword: 'new password 1234' } },
  })
  resetPassword(
    @ValidParams() params: { userId: string },
    @ValidBody() body: z.infer<typeof SetPasswordRequestSchema>,
  ) {
    return this.passwords.setPassword(params.userId, body);
  }

  @Put(':userId/pin')
  @HttpCode(204)
  @Contract({
    operationId: 'identity.user.pin.set',
    summary: 'Set a per-location POS PIN',
    tags: TAGS,
    params: userParams,
    body: SetPinRequestSchema,
    status: 204,
    permission: 'identity.pin.set',
    scope: { kind: 'dynamic', from: 'body', scopeKind: 'location', idField: 'locationId' },
    idempotent: true,
    examples: { ...userExample, body: { locationId: '$fixture:locationId', pin: '1234' } },
  })
  setPin(
    @ValidParams() params: { userId: string },
    @ValidBody() body: z.infer<typeof SetPinRequestSchema>,
  ) {
    return this.pins.setPin(params.userId, body.locationId, body.pin);
  }

  @Delete(':userId/sessions')
  @HttpCode(200)
  @Contract({
    operationId: 'identity.user.sessions.revoke',
    tags: TAGS,
    params: userParams,
    response: z.object({ revoked: z.number().int() }),
    status: 200,
    permission: 'identity.session.revoke',
    scope: { kind: 'tenant' },
    examples: userExample,
  })
  revokeSessions(@ValidParams() params: { userId: string }) {
    return this.users.revokeSessions(params.userId);
  }
}
