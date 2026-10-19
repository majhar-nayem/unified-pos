/**
 * Thin typed client for the F1 identity/devices API (`/v1/auth/*`). Responses are validated with the
 * zod schemas from @pos/contracts so a server change fails loudly at the boundary.
 */
import {
  DeviceChallengeResponseSchema,
  DeviceEnrollResponseSchema,
  PrincipalDtoSchema,
  UserSchema,
  TokenPairSchema,
  type DeviceEnrollRequest,
  type DeviceEnrollResponse,
  type PrincipalDto,
  type UserDto,
  type TokenPair,
} from '@pos/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Seconds the server asked us to wait (423 PIN lockout, 429 rate limit). */
  get retryAfterSeconds(): number | null {
    const d = this.details as { retryAfterSeconds?: unknown } | undefined;
    return typeof d?.retryAfterSeconds === 'number' ? d.retryAfterSeconds : null;
  }
}

/** The server could not be reached at all (offline, DNS, refused). Distinct from an HTTP error. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Network error');
    this.name = 'NetworkError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  readonly body?: unknown;
  readonly token?: string;
  readonly query?: Record<string, string>;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  get origin(): string {
    return this.baseUrl;
  }

  private url(path: string, query?: Record<string, string>): string {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${this.baseUrl.replace(/\/+$/, '')}/v1${path}${qs}`;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new NetworkError(error);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const err = (
        json as { error?: { code?: string; message?: string; details?: unknown } } | undefined
      )?.error;
      throw new ApiError(
        response.status,
        err?.code ?? `HTTP_${response.status}`,
        err?.message ?? response.statusText,
        err?.details,
      );
    }
    return json;
  }

  async enrollDevice(input: DeviceEnrollRequest): Promise<DeviceEnrollResponse> {
    return DeviceEnrollResponseSchema.parse(
      await this.request('POST', '/auth/device/enroll', { body: input }),
    );
  }

  async deviceChallenge(tenantId: string, deviceId: string): Promise<string> {
    return DeviceChallengeResponseSchema.parse(
      await this.request('GET', '/auth/device/challenge', { query: { tenantId, deviceId } }),
    ).nonce;
  }

  async deviceLogin(input: {
    tenantId: string;
    deviceId: string;
    nonce: string;
    signature: string;
  }): Promise<TokenPair> {
    return TokenPairSchema.parse(await this.request('POST', '/auth/device/login', { body: input }));
  }

  async pinLogin(deviceToken: string, userId: string, pin: string): Promise<TokenPair> {
    return TokenPairSchema.parse(
      await this.request('POST', '/auth/pin', { token: deviceToken, body: { userId, pin } }),
    );
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    return TokenPairSchema.parse(
      await this.request('POST', '/auth/refresh', { body: { refreshToken } }),
    );
  }

  async me(token: string): Promise<PrincipalDto> {
    return PrincipalDtoSchema.parse(await this.request('GET', '/auth/me', { token }));
  }

  async userMe(token: string): Promise<UserDto> {
    return UserSchema.parse(await this.request('GET', '/users/me', { token }));
  }

  async health(): Promise<boolean> {
    try {
      await this.request('GET', '/health');
      return true;
    } catch (error) {
      if (error instanceof ApiError) return true; // the server answered: it is reachable
      return false;
    }
  }

  async logout(token: string): Promise<void> {
    await this.request('POST', '/auth/logout', { token });
  }
}
