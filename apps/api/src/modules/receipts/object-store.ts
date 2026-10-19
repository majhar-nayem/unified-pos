/**
 * Object storage port (docs/01 §4: receipts, exports and documents live in S3-compatible storage;
 * MinIO in docker compose, bucket `pos-local`). The S3 client is not a dependency yet, so the only
 * implementation is `LocalDiskObjectStore`, a STUB with the same contract. An S3/MinIO adapter is
 * a drop-in provider for `OBJECT_STORE` (env S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET).
 */
export interface StoredObject {
  readonly uri: string;
  readonly bytes: number;
}

export interface ObjectStorePort {
  /** Write (or overwrite) an object under a relative key like `receipts/<tenant>/<order>/<id>.pdf`. */
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  /** null when the object does not exist. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** The URI a key is stored at (what orders.receipts.rendered_uri holds). */
  uriFor(key: string): string;
}

export const OBJECT_STORE = Symbol('OBJECT_STORE');

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Keys are relative, slash separated, and never climb out of the store. */
export function assertSafeKey(key: string): void {
  if (
    !SAFE_KEY.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new TypeError(`Unsafe object key "${key}"`);
}
