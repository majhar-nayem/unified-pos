/** Public surface of the identity module. Other modules and the app shell import ONLY from here. */
export { IdentityModule } from '../identity.module.js';
export { JwtAuthenticator } from '../authn/jwt-authenticator.js';
export { IdentityFirstAdminProvisioner } from '../first-admin.provisioner.js';
export { UsersService } from '../users/users.service.js';
export { RolesService } from '../access/roles.service.js';
export { AssignmentsService } from '../access/assignments.service.js';
export { EffectivePermissionsService } from '../access/effective-permissions.service.js';
export { PrincipalResolver } from '../access/principal-resolver.js';
export { ApprovalsService, payloadHash } from '../approvals/approvals.service.js';
export { TokenService, TOKEN_TTL_SECONDS } from '../crypto/tokens.js';
export { SessionsService } from '../sessions/sessions.service.js';
export { seedAccessCatalog } from '../access/seed.service.js';
export { deviceChallengeMessage, toSpkiDer } from '../authn/device-auth.service.js';
