import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { type ObjectStorePort, type StoredObject, assertSafeKey } from './object-store.js';

/**
 * STUB for MinIO/S3: objects are files under `root` (default `$OBJECT_STORE_LOCAL_DIR` or the OS
 * temp directory), with the content type kept in a `.meta` sidecar. URIs look like `local://<key>`.
 */
export class LocalDiskObjectStore implements ObjectStorePort {
  constructor(
    private readonly root: string = process.env.OBJECT_STORE_LOCAL_DIR ??
      join(tmpdir(), 'pos-object-store'),
  ) {}

  uriFor(key: string): string {
    assertSafeKey(key);
    return `local://${key}`;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(`${path}.meta`, JSON.stringify({ contentType }));
    return { uri: this.uriFor(key), bytes: body.byteLength };
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    assertSafeKey(key);
    const path = join(this.root, key);
    try {
      const [body, meta] = await Promise.all([
        readFile(path),
        readFile(`${path}.meta`, 'utf8').catch(() => '{}'),
      ]);
      const parsed = JSON.parse(meta) as { contentType?: string };
      return {
        body: new Uint8Array(body),
        contentType: parsed.contentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
