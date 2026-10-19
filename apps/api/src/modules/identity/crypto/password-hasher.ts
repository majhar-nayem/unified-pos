import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** Argon2id with the OWASP minimum (m=19456 KiB, t=2, p=1) for passwords, PINs and client secrets. */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: Algorithm.Argon2id };

@Injectable()
export class PasswordHasher {
  private dummy: Promise<string> | undefined;

  hash(secret: string): Promise<string> {
    return hash(secret, OPTIONS);
  }

  async verify(hashed: string | null | undefined, secret: string): Promise<boolean> {
    if (!hashed) {
      await this.dummyVerify();
      return false;
    }
    try {
      return await verify(hashed, secret, OPTIONS);
    } catch {
      return false;
    }
  }

  /** Burn the same time as a real verification so unknown users are not distinguishable by timing. */
  async dummyVerify(): Promise<void> {
    this.dummy ??= hash('dummy-password-for-timing-only', OPTIONS);
    await verify(await this.dummy, 'not-the-password', OPTIONS).catch(() => false);
  }
}
