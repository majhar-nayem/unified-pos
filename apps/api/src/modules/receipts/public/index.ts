/** Public surface of the receipts module. Other modules and the app shell import ONLY from here. */
export { ReceiptsModule } from '../receipts.module.js';
export { ReceiptsService } from '../receipts.service.js';
export { OBJECT_STORE } from '../object-store.js';
export type { ObjectStorePort, StoredObject } from '../object-store.js';
export { LocalDiskObjectStore } from '../local-disk-object-store.js';
