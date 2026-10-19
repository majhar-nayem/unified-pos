import http from 'k6/http';

import { BASE_URL } from './config.js';

function uuid() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.random() * 4) | 8];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

export { uuid };

/**
 * One request against /v1. `kind` tags the sample so thresholds can target an SLO:
 * lookup (scan), api (standard request), commit (order placement), auth, setup.
 */
export function call(method, path, { token, body, kind = 'api', name, headers = {} } = {}) {
  const requestHeaders = Object.assign({ accept: 'application/json' }, headers);
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (method === 'POST')
    requestHeaders['idempotency-key'] = requestHeaders['idempotency-key'] || uuid();
  const response = http.request(
    method,
    `${BASE_URL}/v1${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers: requestHeaders,
      // Group by route template rather than raw URL so the report stays readable.
      tags: {
        kind,
        name: name || `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id').split('?')[0]}`,
      },
    },
  );
  return response;
}

export function json(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

let reported = 0;

/** Log the first few unexpected responses of a VU so a failing run explains itself (status and a body excerpt). */
export function explain(response, what) {
  if (reported >= 3) return;
  reported += 1;
  console.error(
    `${what}: ${response.request.method} ${response.request.url} → ${response.status} ${String(response.body).slice(0, 300)}`,
  );
}
