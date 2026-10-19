import { Controller, Get } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { Public } from '../auth/decorators.js';
import { Contract } from '../contract/contract.js';
import { API_PREFIX } from '../kernel.constants.js';
import { buildOpenApiDocument, type OpenApiDocument } from './openapi.builder.js';

@Controller('openapi.json')
export class OpenApiController {
  private cached: OpenApiDocument | undefined;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  @Get()
  @Public()
  @Contract({
    operationId: 'openapi.get',
    summary: 'OpenAPI 3.1 document',
    public: true,
    tags: ['platform'],
  })
  document(): OpenApiDocument {
    this.cached ??= buildOpenApiDocument(this.discovery, this.scanner, this.reflector, {
      title: 'POS platform API',
      version: '0.0.0',
      prefix: API_PREFIX,
    });
    return this.cached;
  }
}
