import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@pos/db';

import { isOperator, RequestContextService } from '../kernel/public/index.js';
import { PRICING_PORT } from './ports.js';
import type { CommandContext } from './domain.js';
import type { EventMeta } from './order.repository.js';
import type { orders } from '@pos/domain-core';

/** Per-command context for the reducers: clock, actor, UUIDv7 ids and the pricing port. */
@Injectable()
export class CommandContextFactory {
  constructor(
    private readonly context: RequestContextService,
    @Inject(PRICING_PORT) private readonly pricing: orders.PricingPort,
  ) {}

  make(): CommandContext {
    const actor = this.actor();
    return {
      now: new Date().toISOString(),
      actorId: actor.userId,
      deviceId: actor.deviceId,
      newId,
      pricing: this.pricing,
    };
  }

  actor(): { userId: string | null; deviceId: string | null } {
    const principal = this.context.current()?.principal;
    if (!principal || isOperator(principal)) return { userId: null, deviceId: null };
    return {
      userId: principal.kind === 'user' ? principal.subjectId : null,
      deviceId: principal.deviceId ?? null,
    };
  }

  eventMeta(cc: CommandContext, clientCommandId: string | null = null): EventMeta {
    return { actorUserId: cc.actorId, deviceId: cc.deviceId ?? null, clientCommandId, now: cc.now };
  }
}
