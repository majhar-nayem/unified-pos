import { Controller, Get } from '@nestjs/common';
import { type HealthResponse, HealthResponseSchema } from '@pos/contracts';

import { Contract, Public } from '../kernel/public/index.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Public()
  @Contract({
    operationId: 'platform.health',
    summary: 'Liveness',
    tags: ['platform'],
    response: HealthResponseSchema,
    public: true,
  })
  get(): HealthResponse {
    return this.health.health();
  }
}
