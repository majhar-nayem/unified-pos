import { fail } from 'k6';

import { call, json } from './api.js';
import { LOAD, OPERATOR_TOKEN, PASSWORD } from './config.js';
import { secretFromOtpauthUri, totp } from './totp.js';

function must(response, expected, what) {
  const ok = Array.isArray(expected)
    ? expected.indexOf(response.status) >= 0
    : response.status === expected;
  if (!ok) fail(`setup: ${what} → ${response.status} ${String(response.body).slice(0, 300)}`);
  return json(response);
}

/**
 * Provision a throwaway tenant the way the admin console does: operator creates it, the first admin accepts the
 * invitation, enrols TOTP and signs in. Then create a location, a catalog, and cashier accounts.
 * The tenant is left in place; slugs start with `load-` so an operator can purge them.
 */
export function seed() {
  if (!OPERATOR_TOKEN)
    fail('setup: OPERATOR_TOKEN is required (a platform operator token from AUTH_OPERATOR_TOKENS)');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const slug = `load-${suffix}`;
  const ownerEmail = `owner@${slug}.test`;

  const tenant = must(
    call('POST', '/tenants', {
      token: OPERATOR_TOKEN,
      kind: 'setup',
      body: { slug, name: `Load ${slug}`, admin: { email: ownerEmail, displayName: 'Load Owner' } },
    }),
    [200, 201],
    'provision tenant',
  );
  must(
    call('POST', '/users/accept-invite', {
      kind: 'setup',
      body: { token: tenant.admin.inviteToken, password: PASSWORD },
    }),
    [200, 201, 204],
    'accept invite',
  );

  const login = () =>
    must(
      call('POST', '/auth/login', {
        kind: 'setup',
        body: { tenantSlug: slug, email: ownerEmail, password: PASSWORD },
      }),
      200,
      'owner login',
    );
  const preauth = login().preauthToken;
  const enrol = must(
    call('POST', '/users/me/totp/enroll', { token: preauth, kind: 'setup' }),
    [200, 201],
    'enrol TOTP',
  );
  const secret = secretFromOtpauthUri(enrol.otpauthUri);
  must(
    call('POST', '/users/me/totp/confirm', {
      token: preauth,
      kind: 'setup',
      body: { code: totp(secret, -1) },
    }),
    [200, 201, 204],
    'confirm TOTP',
  );
  const verified = must(
    call('POST', '/auth/mfa/totp', {
      token: login().preauthToken,
      kind: 'setup',
      body: { code: totp(secret, -1) },
    }),
    200,
    'verify TOTP',
  );
  const owner = verified.tokens.accessToken;

  const location = must(
    call('POST', '/locations', {
      token: owner,
      kind: 'setup',
      body: {
        orgUnitId: tenant.rootOrgUnitId,
        code: 'LOAD1',
        name: 'Load store',
        kind: 'store',
        timezone: 'Australia/Sydney',
        currency: 'AUD',
      },
    }),
    [200, 201],
    'create location',
  );

  // Catalog: LOAD.items products with one variant and one barcode each.
  const variants = [];
  for (let i = 0; i < LOAD.items; i += 1) {
    const code = `93${suffix
      .replace(/[^0-9]/g, '')
      .padEnd(6, '0')
      .slice(0, 6)}${String(i).padStart(5, '0')}`;
    const item = must(
      call('POST', '/items', {
        token: owner,
        kind: 'setup',
        body: {
          kind: 'product',
          name: `Load item ${i}`,
          variants: [
            {
              sku: `LOAD-${suffix}-${i}`,
              defaultPriceMinor: String(250 + (i % 20) * 50),
              barcodes: [{ code }],
            },
          ],
        },
      }),
      [200, 201],
      `create item ${i}`,
    );
    const variant = (item.variants && item.variants[0]) || null;
    if (!variant) fail(`setup: item ${i} came back without a variant`);
    // The snapshot and list price keep order lines valid while the order service still prices from the request
    // (docs/releases/s-f4.md: catalog port not wired); they are ignored once it resolves the variant itself.
    variants.push({
      id: variant.id,
      barcode: code,
      name: `Load item ${i}`,
      sku: variant.sku || `LOAD-${suffix}-${i}`,
      priceMinor: String(250 + (i % 20) * 50),
    });
  }

  // Register operators: no MFA, scoped to the location. The system `cashier` role has no catalog.view, so a real
  // register could not scan a product (finding in docs/releases/s-infra.md); the profile uses a custom role that adds it.
  const register = must(
    call('POST', '/roles', {
      token: owner,
      kind: 'setup',
      body: {
        key: 'load_register',
        name: 'Load register',
        permissions: [
          'catalog.view',
          'orders.view',
          'orders.create',
          'orders.discount.apply',
          'payments.view',
          'payments.intent.create',
        ],
      },
    }),
    [200, 201],
    'create register role',
  );
  const cashierRole = register;
  const users = [];
  for (let i = 0; i < LOAD.users; i += 1) {
    const email = `cashier${i}@${slug}.test`;
    const user = must(
      call('POST', '/users', {
        token: owner,
        kind: 'setup',
        body: { email, displayName: `Cashier ${i}`, password: PASSWORD },
      }),
      [200, 201],
      `create cashier ${i}`,
    );
    must(
      call('POST', '/role-assignments', {
        token: owner,
        kind: 'setup',
        body: {
          userId: user.id,
          roleId: cashierRole.id,
          scope: { kind: 'location', id: location.id },
        },
      }),
      [200, 201],
      `assign cashier ${i}`,
    );
    users.push(email);
  }

  return { slug, locationId: location.id, variants, users };
}
