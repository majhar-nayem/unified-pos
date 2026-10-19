import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * Minimal software WebAuthn authenticator for integration tests: one P-256 key, attestation
 * format `none`, flags UP|UV, a monotonic signature counter the test can move backwards to
 * exercise the clone-detection path. Only what @simplewebauthn/server 13 needs to verify a
 * ceremony is implemented; nothing here is meant to be a general CBOR or WebAuthn library.
 */

const AAGUID_ZERO = Buffer.alloc(16);
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

/** CBOR (RFC 8949) encoder for the subset WebAuthn attestation objects and COSE keys use. */
export function encodeCbor(value: CborValue): Buffer {
  const parts: Buffer[] = [];
  write(value, parts);
  return Buffer.concat(parts);
}

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(length, 1);
  return b;
}

function write(value: CborValue, out: Buffer[]): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('CBOR: only integers are supported');
    out.push(value >= 0 ? head(0, value) : head(1, -1 - value));
  } else if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    out.push(head(3, bytes.length), bytes);
  } else if (value instanceof Uint8Array) {
    out.push(head(2, value.length), Buffer.from(value));
  } else if (Array.isArray(value)) {
    out.push(head(4, value.length));
    for (const item of value) write(item, out);
  } else {
    out.push(head(5, value.size));
    for (const [k, v] of value) {
      write(k, out);
      write(v, out);
    }
  }
}

function b64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64url');
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Uncompressed P-256 point → COSE_Key (kty EC2, alg ES256, crv P-256). */
function coseKey(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  const map = new Map<CborValue, CborValue>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  return encodeCbor(map);
}

export interface RegistrationOptionsLike {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}

export interface AuthenticationOptionsLike {
  challenge: string;
  rpId?: string;
}

export interface SoftwareAuthenticatorOptions {
  readonly rpId: string;
  readonly origin: string;
  /** Counter reported at registration; defaults to 0 like most platform authenticators. */
  readonly initialCounter?: number;
}

export class SoftwareAuthenticator {
  readonly credentialId: Buffer;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  counter: number;
  private userHandle: Buffer | undefined;

  constructor(private readonly options: SoftwareAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.credentialId = randomBytes(32);
    this.counter = options.initialCounter ?? 0;
  }

  get credentialIdBase64Url(): string {
    return b64url(this.credentialId);
  }

  private rpIdHash(rpId?: string): Buffer {
    return sha256(rpId ?? this.options.rpId);
  }

  private clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.options.origin, crossOrigin: false }),
      'utf8',
    );
  }

  private counterBytes(counter: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(counter >>> 0, 0);
    return b;
  }

  /** Answer `generateRegistrationOptions()` output with a `none` attestation. */
  register(options: RegistrationOptionsLike): Record<string, unknown> {
    this.userHandle = Buffer.from(options.user.id, 'base64url');
    const credIdLength = Buffer.alloc(2);
    credIdLength.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      this.rpIdHash(options.rp.id),
      Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
      this.counterBytes(this.counter),
      AAGUID_ZERO,
      credIdLength,
      this.credentialId,
      coseKey(this.publicKey),
    ]);
    const attestationObject = encodeCbor(
      new Map<CborValue, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = this.clientDataJSON('webauthn.create', options.challenge);
    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /**
   * Answer `generateAuthenticationOptions()` output. The counter increments by one per assertion
   * unless `counter` is given, which lets a test replay a stale (cloned) value.
   */
  assert(
    options: AuthenticationOptionsLike,
    override: { counter?: number } = {},
  ): Record<string, unknown> {
    const counter = override.counter ?? this.counter + 1;
    if (override.counter === undefined) this.counter = counter;
    const authenticatorData = Buffer.concat([
      this.rpIdHash(options.rpId),
      Buffer.from([FLAG_UP | FLAG_UV]),
      this.counterBytes(counter),
    ]);
    const clientDataJSON = this.clientDataJSON('webauthn.get', options.challenge);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), {
      key: this.privateKey,
      dsaEncoding: 'der',
    });
    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: b64url(this.userHandle) } : {}),
      },
    };
  }
}
