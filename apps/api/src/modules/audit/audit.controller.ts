import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { Contract, ValidQuery } from '../kernel/public/index.js';
import {
  AuditListQuerySchema,
  type AuditListQuery,
  AuditPageSchema,
  ChainHeadSchema,
  ChainVerificationSchema,
} from './audit.contracts.js';
import { AuditQueryService, AuditVerificationService } from './audit.service.js';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly queries: AuditQueryService,
    private readonly verification: AuditVerificationService,
  ) {}

  @Get()
  @Contract({
    operationId: 'audit.list',
    summary: 'Audit log (hash-chained, append-only)',
    tags: ['audit'],
    query: AuditListQuerySchema,
    response: AuditPageSchema,
    permission: 'audit.view',
    scope: { kind: 'tenant' },
  })
  list(@ValidQuery() query: AuditListQuery) {
    return this.queries.list(query);
  }

  @Get('head')
  @Contract({
    operationId: 'audit.head',
    tags: ['audit'],
    response: ChainHeadSchema,
    permission: 'audit.view',
    scope: { kind: 'tenant' },
  })
  head() {
    return this.queries.head();
  }

  @Post('verify')
  @HttpCode(200)
  @Contract({
    operationId: 'audit.verify',
    summary: 'Recompute the chain and compare with stored hashes and the head',
    tags: ['audit'],
    response: ChainVerificationSchema,
    status: 200,
    permission: 'audit.verify',
    scope: { kind: 'tenant' },
    idempotent: true,
  })
  verify() {
    return this.verification.verifyChain();
  }
}
