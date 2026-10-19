import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/public/index.js';
import { TenancyModule } from '../tenancy/public/index.js';
import { LocalDiskObjectStore } from './local-disk-object-store.js';
import { OBJECT_STORE } from './object-store.js';
import { ReceiptsController } from './receipts.controller.js';
import { ReceiptsService } from './receipts.service.js';

@Module({
  imports: [OrdersModule, TenancyModule],
  controllers: [ReceiptsController],
  providers: [
    // STUB until the S3/MinIO client lands: files on local disk (OBJECT_STORE_LOCAL_DIR), same port
    { provide: OBJECT_STORE, useFactory: () => new LocalDiskObjectStore() },
    ReceiptsService,
  ],
  exports: [ReceiptsService, OBJECT_STORE],
})
export class ReceiptsModule {}
