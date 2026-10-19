import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ExceptionListQuerySchema,
  ExceptionPageSchema,
  ImportSettlementResultSchema,
  ImportSettlementSchema,
  PAYMENT_PERMISSIONS,
  ReconciliationExceptionSchema,
  ResolveExceptionSchema,
  SettlementDetailSchema,
  SettlementListQuerySchema,
  SettlementPageSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, ValidBody, ValidParams, ValidQuery } from '../../kernel/public/index.js';
import { SettlementService } from '../settlement.service.js';

const uuid = z.string().uuid();
const TAGS = ['payments'] as const;

@Controller('payments')
export class SettlementController {
  constructor(private readonly settlements: SettlementService) {}

  @Post('settlements/import')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.settlements.import',
    summary:
      'Import a provider settlement batch and reconcile it against captures and refunds (idempotent)',
    tags: TAGS,
    body: ImportSettlementSchema,
    response: ImportSettlementResultSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.settlementManage,
    scope: { kind: 'tenant' },
    examples: {
      body: {
        providerAccountId: '00000000-0000-4000-8000-000000000001',
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
      },
    },
  })
  import(@ValidBody() body: z.infer<typeof ImportSettlementSchema>) {
    return this.settlements.import(body);
  }

  @Get('settlements')
  @Contract({
    operationId: 'payments.settlements.list',
    tags: TAGS,
    query: SettlementListQuerySchema,
    response: SettlementPageSchema,
    permission: PAYMENT_PERMISSIONS.settlementManage,
  })
  list(@ValidQuery() query: z.infer<typeof SettlementListQuerySchema>) {
    return this.settlements.list(query);
  }

  @Get('settlements/:settlementId')
  @Contract({
    operationId: 'payments.settlements.get',
    tags: TAGS,
    params: z.object({ settlementId: uuid }),
    response: SettlementDetailSchema,
    permission: PAYMENT_PERMISSIONS.settlementManage,
    scope: { kind: 'tenant' },
    examples: { params: { settlementId: 'deviceId' } },
  })
  get(@ValidParams() p: { settlementId: string }) {
    return this.settlements.get(p.settlementId);
  }

  @Get('reconciliation-exceptions')
  @Contract({
    operationId: 'payments.exceptions.list',
    tags: TAGS,
    query: ExceptionListQuerySchema,
    response: ExceptionPageSchema,
    permission: PAYMENT_PERMISSIONS.reconcile,
  })
  exceptions(@ValidQuery() query: z.infer<typeof ExceptionListQuerySchema>) {
    return this.settlements.listExceptions(query);
  }

  @Post('reconciliation-exceptions/:exceptionId/resolve')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.exceptions.resolve',
    tags: TAGS,
    params: z.object({ exceptionId: uuid }),
    body: ResolveExceptionSchema,
    response: ReconciliationExceptionSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.reconcile,
    scope: { kind: 'tenant' },
    examples: {
      params: { exceptionId: 'deviceId' },
      body: { status: 'resolved', note: 'checked' },
    },
  })
  resolve(
    @ValidParams() p: { exceptionId: string },
    @ValidBody() body: z.infer<typeof ResolveExceptionSchema>,
  ) {
    return this.settlements.resolveException(p.exceptionId, body);
  }
}
