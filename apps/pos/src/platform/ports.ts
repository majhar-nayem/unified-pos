/** Ports for everything the OS provides. Real adapters talk to Tauri; simulated ones run in a browser or tests. */

/**
 * The device key pair. The private key never leaves the keystore: callers only get the public key
 * and signatures (docs/01 §11: device-bound sessions, Ed25519 enrolment).
 */
export interface DeviceKeys {
  /** Create the key pair if missing; returns the raw 32-byte Ed25519 public key, base64. */
  ensure(): Promise<string>;
  /** Sign a UTF-8 message; returns the signature, base64. */
  sign(message: string): Promise<string>;
  /** Delete the key pair (device wipe / re-enrolment). */
  destroy(): Promise<void>;
  readonly kind: 'os_keychain' | 'simulated';
}

/** Small secrets such as the staff refresh token. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  readonly kind: 'os_keychain' | 'simulated';
}

/** Non-secret device configuration (server URL, tenant/device ids, last staff). */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  get(key: string) {
    return this.data.get(key) ?? null;
  }
  set(key: string, value: string) {
    this.data.set(key, value);
  }
  delete(key: string) {
    this.data.delete(key);
  }
}

export class LocalStorageKeyValueStore implements KeyValueStore {
  constructor(private readonly prefix = 'pos.') {}
  get(key: string) {
    try {
      return localStorage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }
  set(key: string, value: string) {
    try {
      localStorage.setItem(this.prefix + key, value);
    } catch {
      /* storage unavailable: the device simply re-asks next start */
    }
  }
  delete(key: string) {
    try {
      localStorage.removeItem(this.prefix + key);
    } catch {
      /* ignore */
    }
  }
}
