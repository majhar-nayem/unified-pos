import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { z, type ZodType } from 'zod';

import { CONTRACT_KEY, type RouteContract } from '../contract/contract.js';

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  tags?: string[];
  parameters: Array<Record<string, unknown>>;
  requestBody?: Record<string, unknown>;
  responses: Record<string, unknown>;
  [extension: `x-${string}`]: unknown;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

/**
 * OpenAPI 3.1 built from the @Contract() registry with zod 4's native JSON Schema export.
 * Extensions: x-permission, x-scope, x-public, x-operator, x-idempotent, x-concurrency,
 * x-fixture on every path parameter, and `$fixture:` placeholders in examples (harness input).
 */
export function buildOpenApiDocument(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
  info: { title: string; version: string; prefix?: string },
): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const controllerPath =
      (reflector.get(PATH_METADATA, metatype) as string | string[] | undefined) ?? '';
    const prototype = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const contract = reflector.get(CONTRACT_KEY, handler) as RouteContract | undefined;
      const method = reflector.get(METHOD_METADATA, handler) as RequestMethod | undefined;
      const methodPath = reflector.get(PATH_METADATA, handler) as string | string[] | undefined;
      if (!contract || method === undefined) continue;
      const verb = METHOD_NAMES[method];
      if (!verb) continue;
      const fullPath = toOpenApiPath(
        info.prefix ?? '',
        first(controllerPath),
        first(methodPath ?? ''),
      );
      paths[fullPath] ??= {};
      paths[fullPath][verb] = operationFor(contract, fullPath, verb);
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: info.title, version: info.version },
    paths: sortKeys(paths),
  };
}

function operationFor(contract: RouteContract, path: string, verb: string): OpenApiOperation {
  const parameters: Array<Record<string, unknown>> = [];
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  const paramsSchema = contract.params ? jsonSchema(contract.params, 'input') : undefined;
  for (const name of pathParams) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: propertySchema(paramsSchema, name) ?? { type: 'string' },
      'x-fixture': contract.examples?.params?.[name] ?? name,
    });
  }
  if (contract.query) {
    const querySchema = jsonSchema(contract.query, 'input');
    const required = new Set((querySchema.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(
      (querySchema.properties as Record<string, unknown> | undefined) ?? {},
    )) {
      parameters.push({
        name,
        in: 'query',
        required: required.has(name),
        schema,
        ...(contract.examples?.query?.[name] !== undefined
          ? { example: contract.examples.query[name] }
          : {}),
      });
    }
  }
  const status = String(contract.status ?? (verb === 'post' ? 201 : 200));
  const operation: OpenApiOperation = {
    operationId: contract.operationId,
    ...(contract.summary ? { summary: contract.summary } : {}),
    ...(contract.tags ? { tags: [...contract.tags] } : {}),
    parameters,
    responses: {
      [status]: contract.response
        ? {
            description: 'Success',
            content: { 'application/json': { schema: jsonSchema(contract.response, 'output') } },
          }
        : { description: 'Success' },
    },
    'x-public': contract.public === true,
    'x-operator': contract.operator === true,
    'x-idempotent': contract.idempotent === true,
  };
  if (contract.body) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: jsonSchema(contract.body, 'input'),
          ...(contract.examples?.body !== undefined ? { example: contract.examples.body } : {}),
        },
      },
    };
  }
  if (contract.permission) operation['x-permission'] = contract.permission;
  if (contract.scope) operation['x-scope'] = contract.scope;
  if (contract.concurrency) operation['x-concurrency'] = contract.concurrency;
  return operation;
}

function jsonSchema(schema: ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

function propertySchema(schema: Record<string, unknown> | undefined, name: string): unknown {
  return (schema?.properties as Record<string, unknown> | undefined)?.[name];
}

function toOpenApiPath(prefix: string, controller: string, method: string): string {
  const joined = [prefix, controller, method]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/');
  return `/${joined}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function first(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}

function sortKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) as T;
}
