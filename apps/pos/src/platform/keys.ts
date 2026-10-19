import { invoke, isTauri } from './runtime.js';
import type { DeviceKeys, SecretStore } from './ports.js';

// --- base64 helpers (WebView and Node both provide btoa/atob) ---------------------------------

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary);
}

// --- Tauri: OS keychain through Rust commands --------------------------------------------------

/**
 * Keychain-backed keys. The Rust side (`src-tauri/src/keychain.rs`) generates an Ed25519 key, stores
 * the seed in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service) and signs
 * on request, so the private key is never visible to the webview.
 */
export class TauriDeviceKeys implements DeviceKeys {
  readonly kind = 'os_keychain' as const;
  ensure(): Promise<string> {
    return invoke<string>('device_key_ensure');
  }
  sign(message: string): Promise<string> {
    return invoke<string>('device_key_sign', { message });
  }
  destroy(): Promise<void> {
    return invoke<void>('device_key_destroy');
  }
}

export class TauriSecretStore implements SecretStore {
  readonly kind = 'os_keychain' as const;
  get(name: string) {
    return invoke<string | null>('secret_get', { name });
  }
  set(name: string, value: string) {
    return invoke<void>('secret_set', { name, value });
  }
  delete(name: string) {
    return invoke<void>('secret_delete', { name });
  }
}

// --- Simulated: WebCrypto Ed25519, key held in memory (and IndexedDB when available) -----------

const DB_NAME = 'pos-simulated-keychain';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function idbGet(key: string): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction('keys').objectStore('keys').get(key);
    request.onsuccess = () => resolve((request.result as CryptoKeyPair | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
}

async function idbPut(key: string, value: CryptoKeyPair | null): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction('keys', 'readwrite');
    if (value) tx.objectStore('keys').put(value, key);
    else tx.objectStore('keys').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Browser/dev adapter: non-extractable Ed25519 key pair via WebCrypto. **Simulated** keychain: the
 * key lives in IndexedDB of the dev profile, not in the OS keychain.
 */
export class WebCryptoDeviceKeys implements DeviceKeys {
  readonly kind = 'simulated' as const;
  private pair: CryptoKeyPair | null = null;
  constructor(private readonly persistKey: string | null = 'device') {}

  async ensure(): Promise<string> {
    if (!this.pair && this.persistKey) this.pair = await idbGet(this.persistKey);
    if (!this.pair) {
      this.pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      if (this.persistKey) await idbPut(this.persistKey, this.pair);
    }
    return toBase64(await crypto.subtle.exportKey('raw', this.pair.publicKey));
  }

  async sign(message: string): Promise<string> {
    await this.ensure();
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      this.pair!.privateKey,
      new TextEncoder().encode(message),
    );
    return toBase64(signature);
  }

  async destroy(): Promise<void> {
    this.pair = null;
    if (this.persistKey) await idbPut(this.persistKey, null);
  }
}

/** Simulated secret store (localStorage, plain text). Dev and tests only. */
export class SimulatedSecretStore implements SecretStore {
  readonly kind = 'simulated' as const;
  private readonly memory = new Map<string, string>();
  async get(name: string) {
    try {
      return localStorage.getItem(`pos.secret.${name}`);
    } catch {
      return this.memory.get(name) ?? null;
    }
  }
  async set(name: string, value: string) {
    try {
      localStorage.setItem(`pos.secret.${name}`, value);
    } catch {
      this.memory.set(name, value);
    }
  }
  async delete(name: string) {
    try {
      localStorage.removeItem(`pos.secret.${name}`);
    } catch {
      this.memory.delete(name);
    }
  }
}

export class MemorySecretStore implements SecretStore {
  readonly kind = 'simulated' as const;
  readonly data = new Map<string, string>();
  async get(name: string) {
    return this.data.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.data.set(name, value);
  }
  async delete(name: string) {
    this.data.delete(name);
  }
}

export function createDeviceKeys(): DeviceKeys {
  return isTauri() ? new TauriDeviceKeys() : new WebCryptoDeviceKeys();
}

export function createSecretStore(): SecretStore {
  return isTauri() ? new TauriSecretStore() : new SimulatedSecretStore();
}
