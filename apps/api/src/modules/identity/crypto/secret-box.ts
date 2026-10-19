import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { createLogger } from '@pos/observability';

/**
 * AES-256-GCM sealing for secrets at rest (TOTP seeds). Format `v1.<kid>.<iv>.<ct>.<tag>` (base64url),
 * AAD binds the ciphertext to its owner so a sealed value cannot be moved between users.
 */
@Injectable()
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKid: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const kid = env.AUTH_SECRETS_KID ?? 'k1';
    const encoded = env.AUTH_SECRETS_KEY;
    if (encoded) {
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) throw new Error('AUTH_SECRETS_KEY must decode to 32 bytes');
      this.keys.set(kid, key);
    } else {
      if (env.NODE_ENV === 'production')
        throw new Error('AUTH_SECRETS_KEY is required in production');
      createLogger({ service: 'identity.secret-box' }).warn(
        'AUTH_SECRETS_KEY unset: using an ephemeral key (sealed secrets will not survive a restart)',
      );
      this.keys.set(kid, randomBytes(32));
    }
    const previous = env.AUTH_SECRETS_KEY_PREVIOUS;
    if (previous) this.keys.set(`${kid}-prev`, Buffer.from(previous, 'base64'));
    this.currentKid = kid;
  }

  seal(plain: string, aad: string): string {
    const key = this.keys.get(this.currentKid)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.currentKid, b64(iv), b64(ct), b64(tag)].join('.');
  }

  open(sealed: string, aad: string): string {
    const [version, kid, iv, ct, tag] = sealed.split('.');
    if (version !== 'v1' || !kid || !iv || !ct || !tag) throw new Error('Malformed sealed secret');
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Unknown secret key id ${kid}`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}
