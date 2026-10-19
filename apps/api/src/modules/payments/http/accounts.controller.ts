import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateProviderAccountSchema,
  CreateTerminalSchema,
  PAYMENT_PERMISSIONS,
  PairTerminalSchema,
  PaymentTerminalSchema,
  ProviderAccountSchema,
  UpdateProviderAccountSchema,
  UpdateTerminalSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, ValidBody, ValidParams } from '../../kernel/public/index.js';
import { ProviderAccountsService } from '../provider-accounts.service.js';
import { TerminalsService } from '../terminals.service.js';

const uuid = z.string().uuid();
const TAGS = ['payments'] as const;
// Path-parameter examples reuse fixture names the shared cross-tenant registry already knows, so
// the integration lead's harness runs these routes without extra fixtures (docs/releases/s-f5.md).
const ACCOUNT_EXAMPLE = { accountId: 'deviceId' } as const;
const TERMINAL_EXAMPLE = { terminalId: 'deviceId' } as const;

@Controller('payments/provider-accounts')
export class ProviderAccountsController {
  constructor(private readonly accounts: ProviderAccountsService) {}

  @Post()
  @Contract({
    operationId: 'payments.provider_accounts.create',
    summary: 'Register a payment provider account (credentials by reference only)',
    tags: TAGS,
    body: CreateProviderAccountSchema,
    response: ProviderAccountSchema,
    permission: PAYMENT_PERMISSIONS.providerManage,
    scope: { kind: 'tenant' },
    examples: { body: { provider: 'mock', name: 'Mock acquirer', credentialsRef: 'mock/main' } },
  })
  create(@ValidBody() body: z.infer<typeof CreateProviderAccountSchema>) {
    return this.accounts.create(body);
  }

  @Get()
  @Contract({
    operationId: 'payments.provider_accounts.list',
    tags: TAGS,
    response: z.array(ProviderAccountSchema),
    permission: PAYMENT_PERMISSIONS.view,
  })
  list() {
    return this.accounts.list();
  }

  @Get(':accountId')
  @Contract({
    operationId: 'payments.provider_accounts.get',
    tags: TAGS,
    params: z.object({ accountId: uuid }),
    response: ProviderAccountSchema,
    permission: PAYMENT_PERMISSIONS.view,
    scope: { kind: 'tenant' },
    examples: { params: ACCOUNT_EXAMPLE },
  })
  get(@ValidParams() params: { accountId: string }) {
    return this.accounts.get(params.accountId);
  }

  @Patch(':accountId')
  @Contract({
    operationId: 'payments.provider_accounts.update',
    tags: TAGS,
    params: z.object({ accountId: uuid }),
    body: UpdateProviderAccountSchema,
    response: ProviderAccountSchema,
    permission: PAYMENT_PERMISSIONS.providerManage,
    scope: { kind: 'tenant' },
    examples: { params: ACCOUNT_EXAMPLE, body: { name: 'Renamed' } },
  })
  update(
    @ValidParams() params: { accountId: string },
    @ValidBody() body: z.infer<typeof UpdateProviderAccountSchema>,
  ) {
    return this.accounts.update(params.accountId, body);
  }
}

@Controller('payments/terminals')
export class TerminalsController {
  constructor(private readonly terminals: TerminalsService) {}

  @Post()
  @Contract({
    operationId: 'payments.terminals.create',
    tags: TAGS,
    body: CreateTerminalSchema,
    response: PaymentTerminalSchema,
    permission: PAYMENT_PERMISSIONS.terminalManage,
    scope: { kind: 'dynamic', from: 'body', scopeKind: 'location', idField: 'locationId' },
    examples: {
      body: {
        locationId: '$fixture:locationId',
        providerAccountId: '00000000-0000-4000-8000-000000000001',
        serialNumber: 'SN-0001',
        connectionMode: 'lan',
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateTerminalSchema>) {
    return this.terminals.create(body);
  }

  @Get()
  @Contract({
    operationId: 'payments.terminals.list',
    tags: TAGS,
    response: z.array(PaymentTerminalSchema),
    permission: PAYMENT_PERMISSIONS.view,
  })
  list() {
    return this.terminals.list();
  }

  @Get(':terminalId')
  @Contract({
    operationId: 'payments.terminals.get',
    tags: TAGS,
    params: z.object({ terminalId: uuid }),
    response: PaymentTerminalSchema,
    permission: PAYMENT_PERMISSIONS.view,
    scope: { kind: 'tenant' },
    examples: { params: TERMINAL_EXAMPLE },
  })
  get(@ValidParams() params: { terminalId: string }) {
    return this.terminals.get(params.terminalId);
  }

  @Patch(':terminalId')
  @Contract({
    operationId: 'payments.terminals.update',
    tags: TAGS,
    params: z.object({ terminalId: uuid }),
    body: UpdateTerminalSchema,
    response: PaymentTerminalSchema,
    permission: PAYMENT_PERMISSIONS.terminalManage,
    scope: { kind: 'tenant' },
    examples: { params: TERMINAL_EXAMPLE, body: { address: '10.0.0.5' } },
  })
  update(
    @ValidParams() params: { terminalId: string },
    @ValidBody() body: z.infer<typeof UpdateTerminalSchema>,
  ) {
    return this.terminals.update(params.terminalId, body);
  }

  @Post(':terminalId/pair')
  @HttpCode(200)
  @Contract({
    operationId: 'payments.terminals.pair',
    summary: 'Pair a terminal with its provider using the on-screen code',
    tags: TAGS,
    params: z.object({ terminalId: uuid }),
    body: PairTerminalSchema,
    response: PaymentTerminalSchema,
    status: 200,
    permission: PAYMENT_PERMISSIONS.terminalManage,
    scope: { kind: 'tenant' },
    examples: { params: TERMINAL_EXAMPLE, body: { code: '123456' } },
  })
  pair(
    @ValidParams() params: { terminalId: string },
    @ValidBody() body: z.infer<typeof PairTerminalSchema>,
  ) {
    return this.terminals.pair(params.terminalId, body.code);
  }
}
