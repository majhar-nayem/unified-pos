import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller.js';
import { AuditQueryService, AuditVerificationService } from './audit.service.js';

@Module({
  controllers: [AuditController],
  providers: [AuditQueryService, AuditVerificationService],
  exports: [AuditQueryService, AuditVerificationService],
})
export class AuditModule {}
