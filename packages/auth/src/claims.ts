/**
 * Access token claims issued by the platform (platform-native authentication; no external IdP yet).
 * Field names are deliberately short: the token travels on every request.
 */

export const TOKEN_KINDS = ['web', 'pos', 'device', 'api', 'preauth'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface AccessTokenClaims {
  /** Issuer. */
  readonly iss: string;
  /** Audience. */
  readonly aud: string;
  /** Subject id (user, device or API client). */
  readonly sub: string;
  /** Tenant id. */
  readonly tid: string;
  /** Token kind. */
  readonly knd: TokenKind;
  /** Session id (user sessions). */
  readonly sid?: string;
  /** Device id (device-bound sessions). */
  readonly did?: string;
  /** Location id the session is pinned to (POS sessions). */
  readonly loc?: string;
  /** Authentication methods references, e.g. ['pwd', 'otp']. */
  readonly amr: string[];
  /** True once a second factor was verified for this session. */
  readonly mfa: boolean;
  /** Assignments version at issue time; compared against the subject's current version. */
  readonly av: number;
  /** OAuth-style scopes (API clients). */
  readonly scp?: string[];
  /** Token id (for revocation). */
  readonly jti: string;
  /** Issued at (seconds since epoch). */
  readonly iat: number;
  /** Expiry (seconds since epoch). */
  readonly exp: number;
}
