import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = {
    write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  };
  return { lines, logger: createLogger({ service: 'test', level: 'debug', stream }) };
}

describe('createLogger', () => {
  it('writes structured JSON with the service name', () => {
    const { lines, logger } = capture();
    logger.info({ orderId: 'o1' }, 'order created');
    expect(lines[0]).toMatchObject({
      service: 'test',
      orderId: 'o1',
      msg: 'order created',
      level: 30,
    });
  });

  it('redacts credentials, personal data and card numbers anywhere in the object', () => {
    const { lines, logger } = capture();
    logger.info({
      user: {
        email: 'owner@acme.example',
        password: 'hunter2',
        profile: { phone: '0400 000 000' },
      },
      refreshToken: 'abc',
      note: 'customer paid with 4242 4242 4242 4242',
      attempt: 2,
    });
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('owner@acme.example');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('0400 000 000');
    expect(line).not.toContain('4242 4242');
    expect(lines[0]).toMatchObject({ attempt: 2, refreshToken: '[redacted]' });
    expect((lines[0] as { note: string }).note).toBe('customer paid with [pan]');
  });

  it('scrubs the message text and error messages', () => {
    const { lines, logger } = capture();
    logger.warn('login failed for owner@acme.example');
    logger.error({ err: new Error('bad token Bearer abcdef0123456789') }, 'request failed');
    expect(lines[0]!.msg).toBe('login failed for [email]');
    const err = lines[1]!.err as { message: string; stack: string };
    expect(err.message).toBe('bad token Bearer [redacted]');
    expect(err.stack).not.toContain('abcdef0123456789');
  });

  it('accepts err values that are not Error instances (strings, plain objects, null)', () => {
    const { lines, logger } = capture();
    logger.warn({ err: 'broker down for owner@acme.example' }, 'publish failed');
    logger.warn({ err: { code: 'E1', message: 'plain object for owner@acme.example' } }, 'plain');
    logger.warn({ err: null }, 'nothing');
    expect(lines[0]!.err).toBe('broker down for [email]');
    expect(lines[1]!.err).toMatchObject({ code: 'E1', message: 'plain object for [email]' });
    expect(lines[2]!.err).toBeNull();
  });

  it('merges the caller mixin and respects the level', () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      service: 'test',
      level: 'warn',
      mixin: () => ({ correlationId: 'c-1' }),
      stream: { write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
    });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ correlationId: 'c-1', msg: 'kept' });
  });
});
