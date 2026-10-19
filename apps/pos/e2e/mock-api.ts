/**
 * Stand-alone mock of the F1 auth API for the Playwright e2e run (no Docker needed). It wraps the same
 * FakeApi the unit tests use, so signatures are verified for real. Run with `node e2e/mock-api.ts`
 * (Node strips the types).
 */
import { createServer } from 'node:http';

import { FakeApi } from '../src/test/fake-api.ts';

const port = Number(process.env.MOCK_API_PORT ?? 3100);
export const SEED = {
  code: 'e2e.ENROLLCODE01',
  userId: '0190f2a0-0000-7000-8000-000000000001',
  pin: '1234',
  displayName: 'Priya Patel',
};

function freshApi() {
  const next = new FakeApi();
  next.maxAttempts = 3;
  next.lockSeconds = 120;
  next.addUser(SEED.pin, SEED.displayName, SEED.userId);
  return next;
}
// Each /__test/seed starts a clean server state (lockout counters, devices, tokens) so tests are independent.
let api = freshApi();
let counter = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString();

  if (url.pathname === '/__test/seed') {
    // A fresh code per call so every test can enrol its own register.
    api = freshApi();
    const code = `e2e.ENROLLCODE${String(++counter).padStart(2, '0')}`;
    api.addCode(code);
    res.setHeader('content-type', 'application/json').end(JSON.stringify({ ...SEED, code }));
    return;
  }
  if (url.pathname === '/__test/revoke') {
    for (const d of api.devices.values()) d.revoked = true;
    res.statusCode = 204;
    res.end();
    return;
  }
  const response = await api.fetch(`${url.pathname}${url.search}`, {
    method: req.method ?? 'GET',
    headers: { authorization: req.headers.authorization ?? '' },
    ...(body ? { body } : {}),
  });
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => console.log(`mock api listening on ${port}`));
