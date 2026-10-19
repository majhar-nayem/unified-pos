import { Injectable } from '@nestjs/common';
import { type HealthResponse, HealthResponseSchema } from '@pos/contracts';
import { DOMAIN_CORE_VERSION } from '@pos/domain-core';

@Injectable()
export class HealthService {
  health(): HealthResponse {
    return HealthResponseSchema.parse({
      status: 'ok',
      service: 'api',
      version: DOMAIN_CORE_VERSION,
      time: new Date().toISOString(),
    });
  }
}
