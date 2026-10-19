import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgresWithSchema, type TestPostgres } from '@pos/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestApp,
  operatorPrincipal,
  stubFirstAdmin,
  type TestApp,
  userPrincipal,
} from '../testing/test-app.js';

const golden = (name: string) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'modules',
      'catalog',
      'import',
      'golden',
      name,
    ),
    'utf8',
  );

/** F2 acceptance over HTTP: provisioning seed, CRUD, concurrency, lookups, search, menus, modifiers, 86 list, import. */
describe('catalog and tax (F2)', () => {
  let db: TestPostgres;
  let t: TestApp;
  let tenantId: string;
  let rootOrgUnitId: string;
  let locA: string;
  let locB: string;
  let owner: string;
  let managerA: string;
  let cashier: string;
  let foreignOwner: string;

  const api = () => supertest(t.server);
  const auth = (token = owner) => ({ Authorization: `Bearer ${token}` });
  const post = (url: string, body: unknown, token = owner) =>
    api()
      .post(url)
      .set(auth(token))
      .set('Idempotency-Key', randomUUID())
      .send(body as object);
  const get = (url: string, token = owner) => api().get(url).set(auth(token));
  const patch = (url: string, body: unknown, version: number, token = owner) =>
    api()
      .patch(url)
      .set(auth(token))
      .set('If-Match', `"${version}"`)
      .send(body as object);
  const outbox = async (type: string, where = '') =>
    (
      await db.admin.query<{ payload: Record<string, unknown>; location_id: string | null }>(
        `SELECT payload, location_id FROM audit.outbox_events WHERE tenant_id = $1 AND event_type = $2 ${where} ORDER BY occurred_at, id`,
        [tenantId, type],
      )
    ).rows;
  const audits = async (action: string) =>
    (
      await db.admin.query(`SELECT 1 FROM audit.audit_log WHERE tenant_id = $1 AND action = $2`, [
        tenantId,
        action,
      ])
    ).rowCount;

  beforeAll(async () => {
    db = await startPostgresWithSchema();
    t = await createTestApp({ databaseUrl: db.appUrl, firstAdmin: stubFirstAdmin });
    const operator = t.auth.register('op', operatorPrincipal());
    const provisioned = await api()
      .post('/v1/tenants')
      .set(auth(operator))
      .set('Idempotency-Key', randomUUID())
      .send({
        slug: 'catalog-co',
        name: 'Catalog Co',
        admin: { email: 'owner@catalog.test', displayName: 'Owner' },
      })
      .expect(201);
    tenantId = provisioned.body.tenant.id;
    rootOrgUnitId = provisioned.body.rootOrgUnitId;
    locA = randomUUID();
    locB = randomUUID();
    await db.admin.query(
      `INSERT INTO tenancy.locations (id, tenant_id, org_unit_id, code, name, kind, timezone, currency)
       VALUES ($1, $3, $4, 'syd', 'Sydney', 'restaurant', 'Australia/Sydney', 'AUD'),
              ($2, $3, $4, 'mel', 'Melbourne', 'restaurant', 'Australia/Melbourne', 'AUD')`,
      [locA, locB, tenantId, rootOrgUnitId],
    );
    owner = t.auth.register('owner', userPrincipal(tenantId, { kind: 'tenant', id: tenantId }));
    managerA = t.auth.register('mgr-a', userPrincipal(tenantId, { kind: 'location', id: locA }));
    cashier = t.auth.register(
      'cashier',
      userPrincipal(tenantId, { kind: 'tenant', id: tenantId }, ['catalog.view']),
    );
    const other = await db.admin.query<{ id: string }>(
      "INSERT INTO platform.tenants (id, slug, name) VALUES (gen_random_uuid(), 'foreign-co', 'Foreign') RETURNING id",
    );
    foreignOwner = t.auth.register(
      'foreign',
      userPrincipal(other.rows[0]!.id, { kind: 'tenant', id: other.rows[0]!.id }),
    );
  });

  afterAll(async () => {
    await t?.close();
    await db?.stop();
  });

  // ------------------------------------------------------------------ seed and tax

  it('tenant provisioning seeds the AU GST classes, rules (data, not code) and units', async () => {
    const classes = (await get('/v1/tax-classes').expect(200)).body.items as Array<{
      id: string;
      code: string;
    }>;
    expect(classes.map((c) => c.code).sort()).toEqual(['gst_free', 'input_taxed', 'standard']);

    const rules = (await get('/v1/tax-rules').expect(200)).body.items as Array<
      Record<string, unknown>
    >;
    expect(rules).toHaveLength(3);
    const byClass = new Map(classes.map((c) => [c.id, c.code]));
    expect(
      rules
        .map((r) => [
          byClass.get(r.taxClassId as string),
          r.rate,
          r.inclusiveDefault,
          r.validFrom,
          r.validTo,
          r.jurisdictionCountry,
          r.kind,
        ])
        .sort(),
    ).toEqual([
      ['gst_free', '0.000000', true, '2000-07-01', null, 'AU', 'vat_gst'],
      ['input_taxed', '0.000000', true, '2000-07-01', null, 'AU', 'vat_gst'],
      ['standard', '0.100000', true, '2000-07-01', null, 'AU', 'vat_gst'],
    ]);

    const units = (await get('/v1/units').expect(200)).body as Array<{ code: string }>;
    expect(units.map((u) => u.code)).toEqual(['cm', 'each', 'g', 'kg', 'l', 'm', 'ml']);
    const conversions = (await get('/v1/unit-conversions').expect(200)).body.items as Array<{
      fromUnit: string;
      factor: string;
    }>;
    expect(conversions.map((c) => [c.fromUnit, c.factor]).sort()).toEqual([
      ['kg', '1000.00000000'],
      ['l', '1000.00000000'],
      ['m', '100.00000000'],
    ]);
    // the baseline is recorded once, by the provisioning entry itself: no per-row audit or outbox noise
    expect(await audits('platform.tenant.provisioned')).toBe(1);
    expect(await audits('catalog.tax_class.created')).toBe(0);
    expect(await audits('pricing.tax_rule.created')).toBe(0);
    expect(await audits('catalog.unit.created')).toBe(0);
    expect((await outbox('catalog.item.changed')).length).toBe(0);
  });

  it('the tax resolver picks by class and date and falls back to rate 0 / inclusive when nothing applies', async () => {
    const classes = (await get('/v1/tax-classes').expect(200)).body.items as Array<{
      id: string;
      code: string;
    }>;
    const id = (code: string) => classes.find((c) => c.code === code)!.id;
    const resolve = (query: Record<string, string>) =>
      get('/v1/tax/resolve')
        .query(query)
        .expect(200)
        .then((r) => r.body);

    const standard = await resolve({ country: 'AU', taxClassId: id('standard'), on: '2026-10-18' });
    expect(standard).toMatchObject({ rate: '0.100000', inclusive: true, candidates: 1 });
    expect(standard.rule.name).toBe('GST 10%');
    expect(
      await resolve({ country: 'AU', taxClassId: id('gst_free'), on: '2026-10-18' }),
    ).toMatchObject({ rate: '0.000000', inclusive: true });
    expect(
      await resolve({ country: 'AU', taxClassId: id('standard'), on: '1999-12-31' }),
    ).toMatchObject({ rule: null, rate: '0.000000', candidates: 0 });
    expect(await resolve({ country: 'NZ', on: '2026-10-18' })).toMatchObject({ rule: null });
    await get('/v1/tax/resolve').query({ country: 'AU', taxClassId: randomUUID() }).expect(404);
  });

  it('tax rules: CRUD with If-Match, region/priority overrides take effect, bad dates and classes are rejected', async () => {
    const classes = (await get('/v1/tax-classes').expect(200)).body.items as Array<{
      id: string;
      code: string;
    }>;
    const standard = classes.find((c) => c.code === 'standard')!.id;
    const created = await post('/v1/tax-rules', {
      name: 'Holiday zero rate',
      jurisdictionCountry: 'AU',
      taxClassId: standard,
      kind: 'vat_gst',
      rate: '0.000000',
      priority: 500,
      validFrom: '2026-12-25',
      validTo: '2026-12-25',
    }).expect(201);
    expect(created.body).toMatchObject({ rate: '0.000000', validTo: '2026-12-25', version: 1 });
    const christmas = await get('/v1/tax/resolve')
      .query({ country: 'AU', taxClassId: standard, on: '2026-12-25' })
      .expect(200);
    expect(christmas.body.rule.id).toBe(created.body.id);
    const boxing = await get('/v1/tax/resolve')
      .query({ country: 'AU', taxClassId: standard, on: '2026-12-26' })
      .expect(200);
    expect(boxing.body.rate).toBe('0.100000');

    await api()
      .patch(`/v1/tax-rules/${created.body.id}`)
      .set(auth())
      .send({ priority: 1 })
      .expect(428);
    const updated = await patch(`/v1/tax-rules/${created.body.id}`, { priority: 1 }, 1).expect(200);
    expect(updated.body).toMatchObject({ priority: 1, version: 2 });
    await patch(`/v1/tax-rules/${created.body.id}`, { priority: 2 }, 1).expect(412);
    await patch(`/v1/tax-rules/${created.body.id}`, { validTo: '2026-01-01' }, 2).expect(409);
    await post('/v1/tax-rules', {
      name: 'x',
      jurisdictionCountry: 'AU',
      taxClassId: randomUUID(),
      kind: 'levy',
      rate: '0.01',
      validFrom: '2026-01-01',
    }).expect(404);
    await post('/v1/tax-rules', {
      name: 'x',
      jurisdictionCountry: 'AUS',
      kind: 'levy',
      rate: '0.01',
      validFrom: '2026-01-01',
    }).expect(422);
    await api().delete(`/v1/tax-rules/${created.body.id}`).set(auth()).expect(204);
    await get(`/v1/tax-rules/${created.body.id}`).expect(404);
    expect(await audits('pricing.tax_rule.deleted')).toBe(1);
  });

  // ------------------------------------------------------------------ categories

  it('categories keep a materialised path; moving a category rewrites its subtree; cycles and clashes are refused', async () => {
    const food = (
      await post('/v1/categories', { kind: 'menu', code: 'food', name: 'Food' }).expect(201)
    ).body;
    const burgers = (
      await post('/v1/categories', { parentId: food.id, kind: 'menu', name: 'Burgers' }).expect(201)
    ).body;
    const classic = (
      await post('/v1/categories', {
        parentId: burgers.id,
        kind: 'menu',
        name: 'Classic Beef',
      }).expect(201)
    ).body;
    expect([food.path, burgers.path, classic.path]).toEqual([
      '/food',
      '/food/burgers',
      '/food/burgers/classic-beef',
    ]);
    await post('/v1/categories', { parentId: food.id, kind: 'menu', name: 'Burgers' }).expect(409);

    const subtree = await get('/v1/categories').query({ under: food.id }).expect(200);
    expect(subtree.body.items.map((c: { path: string }) => c.path).sort()).toEqual([
      '/food/burgers',
      '/food/burgers/classic-beef',
    ]);

    const drinks = (
      await post('/v1/categories', { kind: 'menu', code: 'drinks', name: 'Drinks' }).expect(201)
    ).body;
    const moved = await patch(
      `/v1/categories/${burgers.id}`,
      { parentId: drinks.id, name: 'Shakes' },
      1,
    ).expect(200);
    expect(moved.body).toMatchObject({ path: '/drinks/shakes', version: 2 });
    const child = await get(`/v1/categories/${classic.id}`).expect(200);
    expect(child.body.path).toBe('/drinks/shakes/classic-beef');
    expect(child.headers.etag).toBe('"2"');

    await patch(`/v1/categories/${drinks.id}`, { parentId: classic.id }, 1).expect(409);
    await patch(`/v1/categories/${drinks.id}`, { parentId: drinks.id }, 1).expect(409);
    await patch(`/v1/categories/${drinks.id}`, { name: 'Beverages' }, 1).expect(200);
    await post('/v1/categories', { parentId: randomUUID(), kind: 'menu', name: 'Orphan' }).expect(
      404,
    );

    // keyset pagination in id (creation) order, two per page
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = (
        await get('/v1/categories')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200)
      ).body;
      seen.push(...page.items.map((c: { id: string }) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(4);
  });

  // ------------------------------------------------------------------ items

  let itemId: string;
  let variantId: string;
  let taxStandard: string;
  let taxFree: string;

  it('items with variants and barcodes: create, ETag, If-Match, lists, filters, defaults and uniqueness', async () => {
    const classes = (await get('/v1/tax-classes').expect(200)).body.items as Array<{
      id: string;
      code: string;
    }>;
    taxStandard = classes.find((c) => c.code === 'standard')!.id;
    taxFree = classes.find((c) => c.code === 'gst_free')!.id;
    const created = await post('/v1/items', {
      kind: 'product',
      name: 'Logo T-shirt',
      brandName: 'Acme',
      taxClassId: taxStandard,
      attributes: { size: ['S', 'M'] },
      allergens: [],
      variants: [
        {
          sku: 'SHIRT-S',
          name: 'Small',
          optionValues: { size: 'S' },
          defaultPriceMinor: '2995',
          costMinor: '1200',
          barcodes: [{ code: '9301000000017' }],
        },
        {
          sku: 'SHIRT-M',
          name: 'Medium',
          optionValues: { size: 'M' },
          defaultPriceMinor: '2995',
          barcodes: [
            { code: '9301000000024', packQuantity: '1' },
            { code: '9301000000048', kind: 'code128', packQuantity: '12' },
          ],
        },
      ],
    }).expect(201);
    itemId = created.body.id;
    expect(created.body).toMatchObject({
      version: 1,
      kind: 'product',
      status: 'active',
      soldBy: 'unit',
      unitOfMeasure: 'each',
      trackInventory: true,
    });
    expect(created.body.variants).toHaveLength(2);
    const [small, medium] = created.body.variants;
    expect(small).toMatchObject({
      sku: 'SHIRT-S',
      isDefault: true,
      defaultPriceMinor: '2995',
      costMinor: '1200',
    });
    expect(medium.isDefault).toBe(false);
    expect(medium.barcodes.map((b: { code: string }) => b.code).sort()).toEqual([
      '9301000000024',
      '9301000000048',
    ]);
    variantId = small.id;

    const read = await get(`/v1/items/${itemId}`).expect(200);
    expect(read.headers.etag).toBe('"1"');
    await api().patch(`/v1/items/${itemId}`).set(auth()).send({ shortName: 'Tee' }).expect(428);
    const updated = await patch(
      `/v1/items/${itemId}`,
      { shortName: 'Tee', images: [{ uri: 'https://img.test/t.png', isPrimary: true }] },
      1,
    ).expect(200);
    expect(updated.body).toMatchObject({ shortName: 'Tee', version: 2 });
    await patch(`/v1/items/${itemId}`, { shortName: 'Stale' }, 1).expect(412);
    await patch(`/v1/items/${itemId}`, { kind: 'gadget' }, 2).expect(422);
    await patch(`/v1/items/${itemId}`, { categoryId: randomUUID() }, 2).expect(404);
    await patch(`/v1/items/${randomUUID()}`, { shortName: 'x' }, 1).expect(404);

    // uniqueness: SKU per tenant, barcode per tenant
    await post(`/v1/items/${itemId}/variants`, { sku: 'SHIRT-S' }).expect(409);
    const clash = await post(`/v1/variants/${variantId}/barcodes`, {
      code: '9301000000024',
    }).expect(409);
    expect(clash.body.error.code).toBe('BARCODE_IN_USE');

    // a new default variant demotes the old one; the item version follows every child change
    const xl = await post(`/v1/items/${itemId}/variants`, {
      sku: 'SHIRT-XL',
      isDefault: true,
      optionValues: { size: 'XL' },
    }).expect(201);
    const variants = (await get(`/v1/items/${itemId}/variants`).expect(200)).body as Array<{
      sku: string;
      isDefault: boolean;
    }>;
    expect(variants.filter((v) => v.isDefault).map((v) => v.sku)).toEqual(['SHIRT-XL']);
    expect((await get(`/v1/items/${itemId}`).expect(200)).body.version).toBeGreaterThan(2);
    const patched = await patch(
      `/v1/variants/${xl.body.id}`,
      { defaultPriceMinor: '3495' },
      1,
    ).expect(200);
    expect(patched.body).toMatchObject({ defaultPriceMinor: '3495', version: 2 });
    await patch(`/v1/variants/${xl.body.id}`, { defaultPriceMinor: '1.5' }, 2).expect(422);
    await patch(`/v1/variants/${xl.body.id}`, { defaultPriceMinor: '99' }, 1).expect(412);

    // lists, filters, pagination
    await post('/v1/items', { kind: 'service', name: 'Alteration', taxClassId: taxFree }).expect(
      201,
    );
    await post('/v1/items', { kind: 'product', name: 'Draft thing', status: 'draft' }).expect(201);
    const services = (await get('/v1/items').query({ kind: 'service' }).expect(200)).body.items;
    expect(services.map((i: { name: string }) => i.name)).toEqual(['Alteration']);
    expect((await get('/v1/items').query({ status: 'draft' }).expect(200)).body.items).toHaveLength(
      1,
    );
    const page1 = (await get('/v1/items').query({ limit: 2 }).expect(200)).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.items[1].id);
    const page2 = (await get('/v1/items').query({ limit: 2, cursor: page1.nextCursor }).expect(200))
      .body;
    expect(page2.items.every((i: { id: string }) => i.id > page1.nextCursor)).toBe(true);
    await get('/v1/items').query({ limit: 500 }).expect(422);

    // every write emitted catalog.item.changed and an audit entry
    expect(await audits('catalog.item.created')).toBeGreaterThanOrEqual(3);
    expect(await audits('catalog.variant.updated')).toBe(1);
    const events = await outbox('catalog.item.changed', `AND aggregate_id = '${itemId}'`);
    expect(events.map((e) => e.payload.change)).toContain('created');
    expect(events.map((e) => e.payload.change)).toContain('updated');
  });

  it('barcode and SKU lookups resolve to the variant, pack quantity and item; unknown codes are 404', async () => {
    const scan = await get('/v1/variants/by-barcode').query({ code: '9301000000048' }).expect(200);
    expect(scan.body.barcode).toMatchObject({
      code: '9301000000048',
      kind: 'code128',
      packQuantity: '12.0000',
    });
    expect(scan.body.variant.sku).toBe('SHIRT-M');
    expect(scan.body.item.id).toBe(itemId);
    const bySku = await get('/v1/variants/by-sku').query({ sku: 'SHIRT-S' }).expect(200);
    expect(bySku.body.variant.id).toBe(variantId);
    expect(bySku.body.barcode).toBeNull();
    await get('/v1/variants/by-barcode').query({ code: '0000' }).expect(404);
    await get('/v1/variants/by-sku').query({ sku: 'NOPE' }).expect(404);
    await get('/v1/variants/by-barcode')
      .query({ code: '9301000000048' })
      .set(auth(foreignOwner))
      .expect(404);
    await get('/v1/variants/by-barcode').expect(422);

    const extra = await post(`/v1/variants/${variantId}/barcodes`, {
      code: 'PLU-1234',
      kind: 'plu',
      isPrimary: true,
    }).expect(201);
    const variant = (await get(`/v1/variants/${variantId}`).expect(200)).body;
    expect(variant.barcodes.find((b: { isPrimary: boolean }) => b.isPrimary).code).toBe('PLU-1234');
    await api().delete(`/v1/barcodes/${extra.body.id}`).set(auth()).expect(204);
    await get('/v1/variants/by-barcode').query({ code: 'PLU-1234' }).expect(404);
  });

  it('bundles and combos: components of a parent variant, self-reference refused, recipes stub is read-only', async () => {
    const combo = await post('/v1/items', {
      kind: 'combo',
      name: 'Tee twin pack',
      variants: [{ sku: 'SHIRT-2PK', defaultPriceMinor: '5000' }],
    }).expect(201);
    const parent = combo.body.variants[0].id as string;
    const c1 = await post(`/v1/variants/${parent}/components`, {
      childVariantId: variantId,
      quantity: '2',
      componentGroup: 'tee',
      priceDeltaMinor: '-495',
    }).expect(201);
    expect(c1.body).toMatchObject({
      quantity: '2.0000',
      componentGroup: 'tee',
      priceDeltaMinor: '-495',
      isOptional: false,
    });
    await post(`/v1/variants/${parent}/components`, { childVariantId: parent }).expect(409);
    await post(`/v1/variants/${parent}/components`, { childVariantId: randomUUID() }).expect(404);
    const changed = await api()
      .patch(`/v1/item-components/${c1.body.id}`)
      .set(auth())
      .send({ quantity: '3', isOptional: true })
      .expect(200);
    expect(changed.body).toMatchObject({ quantity: '3.0000', isOptional: true });
    expect((await get(`/v1/variants/${parent}/components`).expect(200)).body).toHaveLength(1);
    await api().delete(`/v1/item-components/${c1.body.id}`).set(auth()).expect(204);
    expect((await get(`/v1/variants/${parent}/components`).expect(200)).body).toEqual([]);
    expect((await get(`/v1/variants/${parent}/recipes`).expect(200)).body).toEqual([]);
  });

  it('units and conversions: create, rename, duplicates and unknown units are refused', async () => {
    const unit = await post('/v1/units', { code: 'case', name: 'Case', dimension: 'count' }).expect(
      201,
    );
    expect(unit.body.code).toBe('case');
    await post('/v1/units', { code: 'case', name: 'Dup', dimension: 'count' }).expect(409);
    await post('/v1/units', { code: 'Bad Code', name: 'x', dimension: 'count' }).expect(422);
    await api().patch('/v1/units/case').set(auth()).send({ name: 'Carton' }).expect(200);
    await api().patch('/v1/units/nope').set(auth()).send({ name: 'x' }).expect(404);
    const conv = await post('/v1/unit-conversions', {
      variantId,
      fromUnit: 'case',
      toUnit: 'each',
      factor: '12',
    }).expect(201);
    expect(conv.body.factor).toBe('12.00000000');
    await post('/v1/unit-conversions', {
      variantId,
      fromUnit: 'case',
      toUnit: 'each',
      factor: '24',
    }).expect(409);
    await post('/v1/unit-conversions', { fromUnit: 'case', toUnit: 'case', factor: '1' }).expect(
      409,
    );
    await post('/v1/unit-conversions', { fromUnit: 'case', toUnit: 'furlong', factor: '1' }).expect(
      404,
    );
    await post('/v1/unit-conversions', { fromUnit: 'case', toUnit: 'each', factor: '0' }).expect(
      422,
    );
    expect(
      (await get('/v1/unit-conversions').query({ variantId }).expect(200)).body.items,
    ).toHaveLength(1);
    await api().delete(`/v1/unit-conversions/${conv.body.id}`).set(auth()).expect(204);
    await api().delete(`/v1/unit-conversions/${conv.body.id}`).set(auth()).expect(404);
  });

  // ------------------------------------------------------------------ search

  it('fuzzy search finds the right product in the top 3 for misspellings, SKUs and barcodes', async () => {
    const names = [
      'Cappuccino',
      'Cafe latte',
      'Flat white',
      'Sourdough loaf',
      'Chocolate croissant',
      'Chicken burger',
      'Coca-Cola 375 ml',
      'Orange juice',
      'Beef burger',
      'Blueberry muffin',
    ];
    for (const name of names)
      await post('/v1/items', {
        kind: 'product',
        name,
        variants: [{ sku: `S-${name.replace(/\W/g, '').toUpperCase().slice(0, 8)}` }],
      }).expect(201);
    const top3 = async (q: string) =>
      (await get('/v1/items/search').query({ q, limit: 3 }).expect(200)).body.hits.map(
        (h: { item: { name: string } }) => h.item.name,
      );
    expect(await top3('capuccino')).toContain('Cappuccino');
    expect((await top3('capuccino'))[0]).toBe('Cappuccino');
    expect(await top3('sourdogh loaf')).toContain('Sourdough loaf');
    expect(await top3('chiken burger')).toContain('Chicken burger');
    expect(await top3('croisant')).toContain('Chocolate croissant');
    expect(await top3('blubery muffin')).toContain('Blueberry muffin');
    expect(await top3('coca cola')).toContain('Coca-Cola 375 ml');
    expect((await top3('burger')).sort()).toEqual(['Beef burger', 'Chicken burger']);
    // exact signals: SKU and barcode are part of the search vector
    expect(await top3('SHIRT-M')).toContain('Logo T-shirt');
    expect(await top3('9301000000048')).toEqual(['Logo T-shirt']);
    const result = (await get('/v1/items/search').query({ q: 'cafe latte', limit: 1 }).expect(200))
      .body;
    expect(result.hits[0]).toMatchObject({ matchedBy: 'both' });
    expect(result.hits[0].item.name).toBe('Cafe latte');
    expect((await get('/v1/items/search').query({ q: 'zzzzqqqq' }).expect(200)).body.hits).toEqual(
      [],
    );
    await get('/v1/items/search')
      .query({ q: 'cappuccino' })
      .set(auth(foreignOwner))
      .expect(200)
      .then((r) => expect(r.body.hits).toEqual([]));
  });

  // ------------------------------------------------------------------ modifiers

  it('modifier groups, item links and selection validation (min/max, repeat, status, overrides)', async () => {
    const burger = await post('/v1/items', {
      kind: 'menu_item',
      name: 'Smash burger',
      variants: [{ defaultPriceMinor: '1600' }],
    }).expect(201);
    const size = (
      await post('/v1/modifier-groups', {
        name: 'Size',
        selectionMin: 1,
        selectionMax: 1,
        modifiers: [
          { name: 'Regular', isDefault: true },
          { name: 'Large', priceDeltaMinor: '300' },
        ],
      }).expect(201)
    ).body;
    const extras = (
      await post('/v1/modifier-groups', {
        name: 'Extras',
        selectionMin: 0,
        selectionMax: 3,
        allowRepeat: true,
        modifiers: [
          { name: 'Cheese', priceDeltaMinor: '100', maxQuantity: 2 },
          { name: 'Bacon', priceDeltaMinor: '250' },
        ],
      }).expect(201)
    ).body;
    await post('/v1/modifier-groups', { name: 'Bad', selectionMin: 3, selectionMax: 1 }).expect(
      422,
    );
    const [regular, large] = size.modifiers;
    const [cheese, bacon] = extras.modifiers;
    expect(size).toMatchObject({
      selectionMin: 1,
      selectionMax: 1,
      allowRepeat: false,
      version: 1,
    });

    for (const [groupId, order] of [
      [size.id, 1],
      [extras.id, 2],
    ] as const)
      await api()
        .put(`/v1/items/${burger.body.id}/modifier-groups/${groupId}`)
        .set(auth())
        .send({ displayOrder: order })
        .expect(200);
    expect(
      (await get(`/v1/items/${burger.body.id}/modifier-groups`).expect(200)).body.map(
        (g: { name: string }) => g.name,
      ),
    ).toEqual(['Size', 'Extras']);
    expect((await get(`/v1/items/${burger.body.id}`).expect(200)).body.modifierGroups).toHaveLength(
      2,
    );

    const validate = (selections: unknown[]) =>
      post(`/v1/items/${burger.body.id}/modifier-selection/validate`, { selections })
        .expect(200)
        .then((r) => r.body);
    const ok = await validate([
      { groupId: size.id, modifierId: large.id },
      { groupId: extras.id, modifierId: cheese.id, quantity: 2 },
      { groupId: extras.id, modifierId: bacon.id },
    ]);
    expect(ok).toMatchObject({ valid: true, priceDeltaMinor: '750', issues: [] });
    expect((await validate([])).issues.map((i: { code: string }) => i.code)).toEqual([
      'GROUP_BELOW_MIN',
    ]);
    expect(
      (
        await validate([
          { groupId: size.id, modifierId: large.id },
          { groupId: size.id, modifierId: regular.id },
        ])
      ).issues.map((i: { code: string }) => i.code),
    ).toEqual(['GROUP_ABOVE_MAX']);
    expect(
      (await validate([{ groupId: size.id, modifierId: regular.id, quantity: 2 }])).issues.map(
        (i: { code: string }) => i.code,
      ),
    ).toEqual(['REPEAT_NOT_ALLOWED', 'GROUP_BELOW_MIN']);
    expect(
      (
        await validate([
          { groupId: size.id, modifierId: regular.id },
          { groupId: extras.id, modifierId: cheese.id, quantity: 3 },
        ])
      ).issues.map((i: { code: string }) => i.code),
    ).toEqual(['QUANTITY_ABOVE_MAX']);
    expect(
      (
        await validate([
          { groupId: size.id, modifierId: regular.id },
          { groupId: randomUUID(), modifierId: randomUUID() },
        ])
      ).issues.map((i: { code: string }) => i.code),
    ).toEqual(['GROUP_NOT_LINKED']);

    // per-item override: size becomes optional and Large is free for this item only
    await api()
      .put(`/v1/items/${burger.body.id}/modifier-groups/${size.id}`)
      .set(auth())
      .send({ overrides: { selectionMin: 0, modifierPrices: { [large.id]: '0' } } })
      .expect(200);
    expect(await validate([])).toMatchObject({ valid: true });
    expect(await validate([{ groupId: size.id, modifierId: large.id }])).toMatchObject({
      valid: true,
      priceDeltaMinor: '0',
    });

    // archiving a modifier / group is honoured
    await api()
      .patch(`/v1/modifiers/${large.id}`)
      .set(auth())
      .send({ status: 'archived' })
      .expect(200);
    expect(
      (await validate([{ groupId: size.id, modifierId: large.id }])).issues.map(
        (i: { code: string }) => i.code,
      ),
    ).toEqual(['MODIFIER_ARCHIVED']);
    const archived = await patch(
      `/v1/modifier-groups/${extras.id}`,
      { status: 'archived' },
      (await get(`/v1/modifier-groups/${extras.id}`)).body.version,
    ).expect(200);
    expect(archived.body.status).toBe('archived');
    expect(
      (await validate([{ groupId: extras.id, modifierId: bacon.id }])).issues.map(
        (i: { code: string }) => i.code,
      ),
    ).toEqual(['GROUP_ARCHIVED']);

    await patch(`/v1/modifier-groups/${size.id}`, { selectionMax: 0, selectionMin: 2 }, 1).expect(
      422,
    );
    await patch(`/v1/modifier-groups/${size.id}`, { prompt: 'Pick' }, 99).expect(412);
    const added = await post(`/v1/modifier-groups/${size.id}/modifiers`, {
      name: 'Kids',
      priceDeltaMinor: '-200',
    }).expect(201);
    await api().delete(`/v1/modifiers/${added.body.id}`).set(auth()).expect(204);
    await api()
      .delete(`/v1/items/${burger.body.id}/modifier-groups/${extras.id}`)
      .set(auth())
      .expect(204);
    await api()
      .delete(`/v1/items/${burger.body.id}/modifier-groups/${extras.id}`)
      .set(auth())
      .expect(404);
    expect((await get(`/v1/modifier-groups`).expect(200)).body.items.length).toBeGreaterThanOrEqual(
      2,
    );
  });

  // ------------------------------------------------------------------ menus

  it('menus: sections, items, publish bumps the version and emits menu.published', async () => {
    const item = (await post('/v1/items', { kind: 'menu_item', name: 'Menu pie' }).expect(201)).body
      .id as string;
    const menu = (await post('/v1/menus', { name: 'Pies' }).expect(201)).body;
    expect(menu).toMatchObject({ status: 'draft', version: 1, publishedAt: null });
    const section = (
      await post(`/v1/menus/${menu.id}/sections`, {
        name: 'Savoury',
        layout: { columns: 3, colour: '#aa0000' },
      }).expect(201)
    ).body;
    const child = (
      await post(`/v1/menus/${menu.id}/sections`, {
        name: 'Vegetarian',
        parentSectionId: section.id,
      }).expect(201)
    ).body;
    await post(`/v1/menus/${menu.id}/sections`, {
      name: 'x',
      parentSectionId: randomUUID(),
    }).expect(404);
    const line = await api()
      .put(`/v1/menu-sections/${section.id}/items/${item}`)
      .set(auth())
      .send({ priceOverrideMinor: '950', labelOverride: 'Pie of the day' })
      .expect(200);
    expect(line.body).toMatchObject({ priceOverrideMinor: '950', labelOverride: 'Pie of the day' });
    await api()
      .put(`/v1/menu-sections/${section.id}/items/${randomUUID()}`)
      .set(auth())
      .send({})
      .expect(404);
    const tree = (await get(`/v1/menus/${menu.id}`).expect(200)).body;
    expect(tree.sections.map((s: { name: string }) => s.name)).toEqual(['Savoury', 'Vegetarian']);
    expect(tree.sections[0].items[0].itemId).toBe(item);
    await api().delete(`/v1/menu-sections/${section.id}`).set(auth()).expect(409);
    await api().delete(`/v1/menu-sections/${child.id}`).set(auth()).expect(204);

    await api()
      .post(`/v1/menus/${menu.id}/publish`)
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .expect(428);
    const published = await api()
      .post(`/v1/menus/${menu.id}/publish`)
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"')
      .expect(200);
    expect(published.body).toMatchObject({ status: 'published', version: 2 });
    expect(published.body.publishedAt).toBeTruthy();
    await api()
      .post(`/v1/menus/${menu.id}/publish`)
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"')
      .expect(412);
    const events = await outbox('menu.published', `AND aggregate_id = '${menu.id}'`);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ menuId: menu.id, version: 2 });

    const archived = await patch(`/v1/menus/${menu.id}`, { status: 'archived' }, 2).expect(200);
    expect(archived.body.status).toBe('archived');
    await api()
      .post(`/v1/menus/${menu.id}/publish`)
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"3"')
      .expect(409);
    // a viewer cannot publish
    await api()
      .post(`/v1/menus/${menu.id}/publish`)
      .set(auth(cashier))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"3"')
      .expect(403);
  });

  it('menu resolution picks the menu for (location, channel, local time) by priority, schedule and validity', async () => {
    const mk = async (name: string, publish = true) => {
      const m = (await post('/v1/menus', { name }).expect(201)).body;
      const s = (await post(`/v1/menus/${m.id}/sections`, { name: `${name} section` }).expect(201))
        .body;
      expect(s.menuId).toBe(m.id);
      if (publish)
        await api()
          .post(`/v1/menus/${m.id}/publish`)
          .set(auth())
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '"1"')
          .expect(200);
      return m.id as string;
    };
    const allDay = await mk('All day');
    const breakfast = await mk('Breakfast');
    const dinner = await mk('Dinner', false);
    const assign = (menuId: string, body: unknown, token = owner) =>
      post(`/v1/menus/${menuId}/assignments`, body, token);
    await assign(allDay, { scopeKind: 'tenant', scopeId: tenantId, priority: 100 }).expect(201);
    await assign(breakfast, {
      scopeKind: 'location',
      scopeId: locA,
      priority: 200,
      schedule: { windows: [{ from: '06:00', to: '11:00' }] },
    }).expect(201);
    const dinnerAssignment = (
      await assign(dinner, {
        scopeKind: 'location',
        scopeId: locA,
        channel: 'dine_in',
        priority: 300,
        schedule: { windows: [{ from: '17:00', to: '22:00' }] },
      }).expect(201)
    ).body;
    await assign(breakfast, { scopeKind: 'location', scopeId: locB, priority: 999 }).expect(201);

    const resolve = async (at: string, channel = 'dine_in', location = locA) =>
      (await get('/v1/menus/resolve').query({ locationId: location, channel, at }).expect(200))
        .body;
    const at = (hhmm: string, day = '2026-10-20') => `${day}T${hhmm}:00+11:00`; // Tuesday, AEDT

    const morning = await resolve(at('08:00'));
    expect(morning).toMatchObject({
      timezone: 'Australia/Sydney',
      localDate: '2026-10-20',
      localTime: '08:00',
      weekday: 2,
      candidates: 2,
    });
    expect(morning.menu.id).toBe(breakfast);
    expect(morning.menu.sections[0].name).toBe('Breakfast section');
    expect((await resolve(at('11:00'))).menu.id).toBe(allDay);
    // the dinner menu is a draft: it does not resolve even at the highest priority
    expect((await resolve(at('18:00'))).menu.id).toBe(allDay);
    await api()
      .post(`/v1/menus/${dinner}/publish`)
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', '"1"')
      .expect(200);
    expect((await resolve(at('18:00'))).menu.id).toBe(dinner);
    expect((await resolve(at('18:00'), 'takeaway')).menu.id).toBe(allDay);
    // the instant is read in the location's zone: 08:00 AEDT is 07:00 in Brisbane-like offsets, 08:00 here
    expect((await resolve('2026-10-19T21:00:00Z')).menu.id).toBe(breakfast); // 08:00 AEDT on Tuesday
    // another location sees its own assignment
    expect((await resolve(at('12:00'), 'dine_in', locB)).menu.id).toBe(breakfast);
    // no assignment reachable → null menu, not an error
    await api().delete(`/v1/menu-assignments/${dinnerAssignment.id}`).set(auth()).expect(204);
    expect((await resolve(at('18:00'))).menu.id).toBe(allDay);
    const list = (await get(`/v1/menus/${dinner}/assignments`).expect(200)).body;
    expect(list).toEqual([]);
    await get('/v1/menus/resolve').query({ locationId: locA, channel: 'all' }).expect(422);
    await get('/v1/menus/resolve')
      .query({ locationId: randomUUID(), channel: 'dine_in' })
      .expect(404);
    await get('/v1/menus/resolve')
      .query({ locationId: locA, registerId: randomUUID(), channel: 'dine_in' })
      .expect(404);

    // scope: a manager of location A resolves at A and may assign there, but not at B or the tenant
    expect(
      (
        await get('/v1/menus/resolve', managerA)
          .query({ locationId: locA, channel: 'dine_in', at: at('08:00') })
          .expect(200)
      ).body.menu.id,
    ).toBe(breakfast);
    await get('/v1/menus/resolve', managerA)
      .query({ locationId: locB, channel: 'dine_in' })
      .expect(404);
    await assign(allDay, { scopeKind: 'location', scopeId: locA, priority: 5 }, managerA).expect(
      201,
    );
    await assign(allDay, { scopeKind: 'location', scopeId: locB, priority: 5 }, managerA).expect(
      404,
    );
    await assign(allDay, { scopeKind: 'tenant', scopeId: tenantId, priority: 5 }, managerA).expect(
      404,
    );
    await assign(allDay, { scopeKind: 'location', scopeId: randomUUID(), priority: 5 }).expect(404);
    await assign(allDay, {
      scopeKind: 'location',
      scopeId: locA,
      schedule: { windows: [{ from: '25:00', to: '26:00' }] },
    }).expect(422);
  });

  // ------------------------------------------------------------------ availability

  it('the 86 list: per location, upsert, scope-checked, emits item.availability.changed', async () => {
    const item = (
      await post('/v1/items', {
        kind: 'menu_item',
        name: 'Daily special',
        variants: [{ sku: 'SPECIAL-1' }],
      }).expect(201)
    ).body;
    const variant = item.variants[0].id as string;
    const put = (location: string, body: unknown, token = owner) =>
      api()
        .put(`/v1/locations/${location}/availability`)
        .set(auth(token))
        .send(body as object);
    const off = await put(locA, {
      itemId: item.id,
      isAvailable: false,
      reason: 'sold out',
      snoozedUntil: '2026-10-20T14:00:00+11:00',
    }).expect(200);
    expect(off.body).toMatchObject({
      locationId: locA,
      itemId: item.id,
      isAvailable: false,
      reason: 'sold out',
      variantId: null,
    });
    expect(off.body.snoozedUntil).toBe('2026-10-20T03:00:00.000Z');
    expect(off.body.updatedBy).toBeTruthy();
    const again = await put(locA, {
      itemId: item.id,
      isAvailable: false,
      reason: 'still out',
    }).expect(200);
    expect(again.body.id).toBe(off.body.id);
    expect(again.body.snoozedUntil).toBeNull();
    await put(locA, { variantId: variant, isAvailable: false }).expect(200);
    await put(locB, { itemId: item.id, isAvailable: false }).expect(200);
    await put(locA, { itemId: item.id, variantId: variant, isAvailable: false }).expect(422);
    await put(locA, { isAvailable: false }).expect(422);
    await put(locA, { itemId: randomUUID(), isAvailable: false }).expect(404);
    await put(randomUUID(), { itemId: item.id, isAvailable: false }).expect(404);

    const list = (
      await get(`/v1/locations/${locA}/availability`).query({ onlyUnavailable: 'true' }).expect(200)
    ).body;
    expect(
      list.items
        .map((r: { itemId: string | null; variantId: string | null }) => r.itemId ?? r.variantId)
        .sort(),
    ).toEqual([item.id, variant].sort());
    expect(list.items.every((r: { locationId: string }) => r.locationId === locA)).toBe(true);

    // scope: the location A manager manages A and is invisible to B
    await put(locA, { itemId: item.id, isAvailable: true }, managerA).expect(200);
    await put(locB, { itemId: item.id, isAvailable: true }, managerA).expect(404);
    await get(`/v1/locations/${locB}/availability`, managerA).expect(404);
    expect(
      (await get(`/v1/locations/${locA}/availability`, managerA).expect(200)).body.items.length,
    ).toBeGreaterThan(0);
    await put(locA, { itemId: item.id, isAvailable: false }, cashier).expect(403);

    const events = await outbox('item.availability.changed', `AND location_id = '${locA}'`);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.map((e) => e.payload.isAvailable)).toContain(true);
    expect(events.find((e) => e.payload.itemId === item.id)).toBeDefined();
    expect(await audits('catalog.availability.changed')).toBeGreaterThanOrEqual(5);

    const row = list.items.find((r: { itemId: string | null }) => r.itemId === item.id);
    await api().delete(`/v1/locations/${locA}/availability/${row.id}`).set(auth()).expect(204);
    await api().delete(`/v1/locations/${locA}/availability/${row.id}`).set(auth()).expect(404);
    await api()
      .delete(`/v1/locations/${locB}/availability/${row.id}`)
      .set(auth(managerA))
      .expect(404);
  });

  // ------------------------------------------------------------------ suppliers

  it('suppliers and supplier items: CRUD with If-Match, uniqueness and validation', async () => {
    const supplier = (
      await post('/v1/suppliers', {
        code: 'ACME',
        name: 'Acme Wholesale',
        currency: 'AUD',
        leadTimeDays: 3,
        minOrderMinor: '20000',
        contacts: [{ name: 'Sam', email: 'sam@acme.test' }],
      }).expect(201)
    ).body;
    expect(supplier).toMatchObject({
      code: 'ACME',
      currency: 'AUD',
      minOrderMinor: '20000',
      version: 1,
    });
    await post('/v1/suppliers', { code: 'ACME', name: 'Dup' }).expect(409);
    await post('/v1/suppliers', { name: 'Bad', contacts: [{ email: 'not-an-email' }] }).expect(422);
    const updated = await patch(
      `/v1/suppliers/${supplier.id}`,
      { paymentTerms: 'Net 30' },
      1,
    ).expect(200);
    expect(updated.body).toMatchObject({ paymentTerms: 'Net 30', version: 2 });
    await patch(`/v1/suppliers/${supplier.id}`, { paymentTerms: 'x' }, 1).expect(412);
    const line = (
      await post(`/v1/suppliers/${supplier.id}/items`, {
        variantId,
        supplierSku: 'AC-SHIRT',
        costMinor: '1100',
        currency: 'AUD',
        packSize: '12',
        purchaseUnit: 'case',
        moq: '2',
        validFrom: '2026-07-01',
      }).expect(201)
    ).body;
    expect(line).toMatchObject({
      costMinor: '1100',
      packSize: '12.0000',
      moq: '2.0000',
      purchaseUnit: 'case',
      validFrom: '2026-07-01',
      validTo: null,
    });
    await post(`/v1/suppliers/${supplier.id}/items`, {
      variantId,
      costMinor: '1',
      currency: 'AUD',
    }).expect(409);
    await post(`/v1/suppliers/${supplier.id}/items`, {
      variantId: randomUUID(),
      costMinor: '1',
      currency: 'AUD',
    }).expect(404);
    const changed = await api()
      .patch(`/v1/supplier-items/${line.id}`)
      .set(auth())
      .send({ isPreferred: true, costMinor: '1050' })
      .expect(200);
    expect(changed.body).toMatchObject({ isPreferred: true, costMinor: '1050' });
    expect((await get(`/v1/suppliers/${supplier.id}/items`).expect(200)).body).toHaveLength(1);
    expect(
      (await get('/v1/suppliers').query({ status: 'active' }).expect(200)).body.items.length,
    ).toBeGreaterThanOrEqual(1);
    await api().delete(`/v1/supplier-items/${line.id}`).set(auth()).expect(204);
    await get(`/v1/suppliers/${supplier.id}`).set(auth(foreignOwner)).expect(404);
  });

  // ------------------------------------------------------------------ import

  it('CSV import: valid file applies everything and the report downloads; invalid files write nothing', async () => {
    await post('/v1/categories', { kind: 'retail', code: 'apparel', name: 'Apparel' }).expect(201);
    await post('/v1/categories', { kind: 'retail', code: 'produce', name: 'Produce' }).expect(201);
    const before = (
      await db.admin.query('SELECT count(*)::int AS n FROM catalog.items WHERE tenant_id = $1', [
        tenantId,
      ])
    ).rows[0].n as number;

    const dry = (
      await post('/v1/catalog/imports', {
        fileName: 'valid.csv',
        content: golden('valid.csv'),
        dryRun: true,
      }).expect(201)
    ).body;
    expect(dry).toMatchObject({
      status: 'validated',
      dryRun: true,
      summary: { rows: 5, items: 3, variants: 4, barcodes: 4, errors: 0 },
    });
    expect(
      (
        await db.admin.query('SELECT count(*)::int AS n FROM catalog.items WHERE tenant_id = $1', [
          tenantId,
        ])
      ).rows[0].n,
    ).toBe(before);

    const applied = (
      await post('/v1/catalog/imports', {
        fileName: 'valid.csv',
        content: golden('valid.csv'),
      }).expect(201)
    ).body;
    expect(applied).toMatchObject({
      status: 'applied',
      summary: { items: 3, variants: 4, barcodes: 4, errors: 0 },
    });
    expect(
      (
        await db.admin.query('SELECT count(*)::int AS n FROM catalog.items WHERE tenant_id = $1', [
          tenantId,
        ])
      ).rows[0].n,
    ).toBe(before + 3);
    const banana = await get('/v1/variants/by-sku').query({ sku: 'BAN-KG' }).expect(200);
    expect(banana.body.item).toMatchObject({
      name: 'Bananas, loose',
      soldBy: 'weight',
      unitOfMeasure: 'kg',
      taxClassId: taxFree,
    });
    expect(banana.body.variant.defaultPriceMinor).toBe('499');
    expect(banana.body.variant.costMinor).toBe('250');
    expect(banana.body.barcode).toBeNull();
    expect(
      (await get('/v1/variants/by-barcode').query({ code: '9300000000031' }).expect(200)).body
        .barcode.kind,
    ).toBe('plu');
    const espresso = await get('/v1/items/search').query({ q: 'espresso' }).expect(200);
    expect(espresso.body.hits[0].item).toMatchObject({ kind: 'menu_item', trackInventory: false });

    // the same file again is rejected: SKUs and barcodes already exist (create-only)
    const again = (await post('/v1/catalog/imports', { content: golden('valid.csv') }).expect(201))
      .body;
    expect(again.status).toBe('rejected');
    expect(again.errors.map((e: { code: string }) => e.code)).toContain('DUPLICATE_SKU');
    expect(again.errors.map((e: { code: string }) => e.code)).toContain('BARCODE_IN_USE');

    for (const [file, code, line] of [
      ['duplicate-barcode.csv', 'DUPLICATE_BARCODE', 3],
      ['bad-tax-class.csv', 'UNKNOWN_TAX_CLASS', 3],
      ['bad-unit.csv', 'UNKNOWN_UNIT', 2],
    ] as const) {
      const rejected = (
        await post('/v1/catalog/imports', { fileName: file, content: golden(file) }).expect(201)
      ).body;
      expect(rejected.status, file).toBe('rejected');
      expect(
        rejected.errors.map((e: { code: string; line: number }) => [e.line, e.code]),
      ).toContainEqual([line, code]);
      const report = await get(rejected.reportUrl).expect(200);
      expect(report.headers['content-type']).toMatch(/^text\/csv/);
      expect(report.headers['content-disposition']).toContain(`import-${rejected.id}-report.csv`);
      expect(report.text.split('\r\n')[0]).toBe('line,column,code,message');
      expect(report.text).toContain(code);
    }
    // nothing from the rejected files exists
    expect(
      (
        await db.admin.query(
          "SELECT count(*)::int AS n FROM catalog.items WHERE tenant_id = $1 AND name IN ('Widget A','Mystery box','Rope')",
          [tenantId],
        )
      ).rows[0].n,
    ).toBe(0);
    const jobs = (await get('/v1/catalog/imports').expect(200)).body.items;
    expect(jobs.length).toBeGreaterThanOrEqual(6);
    // newest first, keyset cursor walks the older jobs without repeats
    const firstPage = (await get('/v1/catalog/imports').query({ limit: 2 }).expect(200)).body;
    expect(firstPage.items.map((j: { id: string }) => j.id)).toEqual(
      jobs.slice(0, 2).map((j: { id: string }) => j.id),
    );
    const nextPage = (
      await get('/v1/catalog/imports').query({ limit: 2, cursor: firstPage.nextCursor }).expect(200)
    ).body;
    expect(nextPage.items.map((j: { id: string }) => j.id)).toEqual(
      jobs.slice(2, 4).map((j: { id: string }) => j.id),
    );
    expect(await audits('catalog.import.applied')).toBe(1);
    expect(await audits('catalog.import.rejected')).toBeGreaterThanOrEqual(4);
    expect((await get(`/v1/catalog/imports/${applied.id}`).expect(200)).body.status).toBe(
      'applied',
    );
    const empty = (await get(`/v1/catalog/imports/${applied.id}/report`).expect(200)).text;
    expect(empty).toBe('line,column,code,message\r\n');
    await get(`/v1/catalog/imports/${applied.id}`).set(auth(foreignOwner)).expect(404);
    await post('/v1/catalog/imports', { content: '' }).expect(422);
    await post('/v1/catalog/imports', { content: golden('valid.csv') }, cashier).expect(403);
    const garbage = (await post('/v1/catalog/imports', { content: 'name\r\n"oops' }).expect(201))
      .body;
    expect(garbage.status).toBe('rejected');
  });

  // ------------------------------------------------------------------ authorization, tenancy and audit

  it('read-only principals can read but never write; another tenant sees nothing; the audit chain stays intact', async () => {
    await get(`/v1/items/${itemId}`, cashier).expect(200);
    await post('/v1/items', { kind: 'product', name: 'Nope' }, cashier).expect(403);
    await patch(`/v1/items/${itemId}`, { shortName: 'x' }, 1, cashier).expect(403);
    await post(
      '/v1/tax-rules',
      { name: 'x', jurisdictionCountry: 'AU', kind: 'levy', rate: '0.01', validFrom: '2026-01-01' },
      cashier,
    ).expect(403);
    await post('/v1/suppliers', { name: 'x' }, cashier).expect(403);
    await api().get('/v1/items').expect(401);
    // a location-scoped manager has no tenant-wide catalog write
    await post('/v1/items', { kind: 'product', name: 'Nope' }, managerA).expect(404);
    await get(`/v1/items/${itemId}`, managerA).expect(200);

    expect((await get('/v1/items', foreignOwner).expect(200)).body.items).toEqual([]);
    expect((await get('/v1/tax-rules', foreignOwner).expect(200)).body.items).toEqual([]);
    await get(`/v1/items/${itemId}`, foreignOwner).expect(404);
    await get(`/v1/variants/${variantId}`, foreignOwner).expect(404);

    const verify = await api()
      .post('/v1/audit/verify')
      .set(auth())
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    expect(verify.body).toMatchObject({ ok: true, headMatches: true });
    const types = (
      await db.admin.query<{ event_type: string }>(
        'SELECT DISTINCT event_type FROM audit.outbox_events WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows.map((r) => r.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'catalog.item.changed',
        'menu.published',
        'item.availability.changed',
        'tenant.provisioned',
      ]),
    );
  });
});
