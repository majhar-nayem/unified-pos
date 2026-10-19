import { Controller, Get, Post } from '@nestjs/common';
import { CreateEnrollmentCodeSchema, DeviceSchema } from '@pos/contracts';
import { z } from 'zod';

import { Contract, ValidBody, ValidParams } from '../kernel/public/index.js';
import { DevicesService } from './devices.service.js';

const uuid = z.string().uuid();
const TAGS = ['devices'] as const;

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @Contract({
    operationId: 'devices.list',
    tags: TAGS,
    response: z.array(DeviceSchema),
    permission: 'devices.view',
  })
  list() {
    return this.devices.list();
  }

  @Post('enrollment-codes')
  @Contract({
    operationId: 'devices.enrollment_code.create',
    summary: 'Issue a one-time enrollment code for a location',
    tags: TAGS,
    body: CreateEnrollmentCodeSchema,
    response: z.object({ code: z.string(), expiresAt: z.string() }),
    permission: 'devices.enroll',
    scope: { kind: 'dynamic', from: 'body', scopeKind: 'location', idField: 'locationId' },
    idempotent: true,
    examples: { body: { locationId: '$fixture:locationId', kind: 'pos' } },
  })
  issueCode(@ValidBody() body: z.infer<typeof CreateEnrollmentCodeSchema>) {
    return this.devices.issueEnrollmentCode(body);
  }

  @Get(':deviceId')
  @Contract({
    operationId: 'devices.get',
    tags: TAGS,
    params: z.object({ deviceId: uuid }),
    response: DeviceSchema,
    permission: 'devices.view',
    scope: { kind: 'tenant' },
    examples: { params: { deviceId: 'deviceId' } },
  })
  get(@ValidParams() params: { deviceId: string }) {
    return this.devices.get(params.deviceId);
  }

  @Post(':deviceId/revoke')
  @Contract({
    operationId: 'devices.revoke',
    tags: TAGS,
    params: z.object({ deviceId: uuid }),
    body: z.object({ reason: z.string().max(500).optional() }),
    response: DeviceSchema,
    permission: 'devices.revoke',
    scope: { kind: 'tenant' },
    idempotent: true,
    examples: { params: { deviceId: 'deviceId' }, body: { reason: 'lost' } },
  })
  revoke(@ValidParams() params: { deviceId: string }, @ValidBody() body: { reason?: string }) {
    return this.devices.revoke(params.deviceId, body.reason);
  }
}
