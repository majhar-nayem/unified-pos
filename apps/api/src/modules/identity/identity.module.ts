import { Module } from '@nestjs/common';

import { DevicesModule } from '../devices/public/index.js';
import { TenancyModule } from '../tenancy/public/index.js';
import { AssignmentsService } from './access/assignments.service.js';
import { EffectivePermissionsService } from './access/effective-permissions.service.js';
import { PrincipalResolver } from './access/principal-resolver.js';
import { RolesService } from './access/roles.service.js';
import { SeedService } from './access/seed.service.js';
import { ApprovalsService } from './approvals/approvals.service.js';
import { ClientAuthService } from './authn/client-auth.service.js';
import { DeviceAuthService } from './authn/device-auth.service.js';
import { JwtAuthenticator } from './authn/jwt-authenticator.js';
import { LockoutService } from './authn/lockout.service.js';
import { LoginEventsRepository } from './authn/login-events.repository.js';
import { LoginService } from './authn/login.service.js';
import { MfaService } from './authn/mfa.service.js';
import { PinAuthService } from './authn/pin-auth.service.js';
import { CredentialsRepository } from './credentials/credentials.repository.js';
import {
  PasskeyService,
  WEBAUTHN_CONFIG,
  webAuthnConfigFromEnv,
} from './credentials/passkey.service.js';
import { PasswordService } from './credentials/password.service.js';
import { PinService } from './credentials/pin.service.js';
import { TotpService } from './credentials/totp.service.js';
import { PasswordHasher } from './crypto/password-hasher.js';
import { SecretBox } from './crypto/secret-box.js';
import { TokenService } from './crypto/tokens.js';
import { IdentityFirstAdminProvisioner } from './first-admin.provisioner.js';
import {
  ApiClientsController,
  ApprovalsController,
  RoleAssignmentsController,
  RolesController,
} from './http/access.controllers.js';
import { AuthController } from './http/auth.controller.js';
import { UsersController } from './http/users.controller.js';
import { SessionsService } from './sessions/sessions.service.js';
import { UsersService } from './users/users.service.js';

@Module({
  imports: [TenancyModule, DevicesModule],
  controllers: [
    AuthController,
    UsersController,
    RolesController,
    RoleAssignmentsController,
    ApiClientsController,
    ApprovalsController,
  ],
  providers: [
    PasswordHasher,
    { provide: SecretBox, useFactory: () => new SecretBox() },
    { provide: TokenService, useFactory: () => TokenService.fromEnv() },
    { provide: WEBAUTHN_CONFIG, useFactory: () => webAuthnConfigFromEnv() },
    LockoutService,
    LoginEventsRepository,
    CredentialsRepository,
    UsersService,
    PasswordService,
    TotpService,
    PasskeyService,
    PinService,
    SeedService,
    RolesService,
    AssignmentsService,
    EffectivePermissionsService,
    PrincipalResolver,
    SessionsService,
    LoginService,
    MfaService,
    DeviceAuthService,
    PinAuthService,
    ClientAuthService,
    ApprovalsService,
    JwtAuthenticator,
    IdentityFirstAdminProvisioner,
  ],
  exports: [
    JwtAuthenticator,
    IdentityFirstAdminProvisioner,
    UsersService,
    RolesService,
    AssignmentsService,
    EffectivePermissionsService,
    PrincipalResolver,
    ApprovalsService,
    TokenService,
    SessionsService,
  ],
})
export class IdentityModule {}
