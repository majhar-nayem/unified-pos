import { createServer } from 'node:http';
import { hostname } from 'node:os';

import { HealthResponseSchema } from '@pos/contracts';
import { createLogger } from '@pos/observability';
import { HybridLogicalClock, SYNC_PROTOCOL_VERSION, formatHlc } from '@pos/sync-protocol';

/**
 * Store Hub stub (docs/01-system-architecture.md §3, profile C). Sprint 0 scope: boots, answers
 * /health, owns an HLC. SQLite state, mDNS advertisement and the WebSocket check-authority protocol
 * are Phase 2 slice M8.
 */
const logger = createLogger({ service: 'store-hub' });
const clock = new HybridLogicalClock(
  `hub-${hostname()}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64),
);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    const body = HealthResponseSchema.parse({
      status: 'ok',
      service: 'store-hub',
      version: `sync-v${SYNC_PROTOCOL_VERSION}`,
      time: new Date().toISOString(),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'x-hlc': formatHlc(clock.tick()) });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end();
});

const port = Number(process.env.STORE_HUB_PORT ?? 3100);
server.listen(port, () => logger.info({ port }, 'store hub listening'));
