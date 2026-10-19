/**
 * DI tokens for the pricing and catalog ports (declared in @pos/domain-core). OrdersModule binds
 * the STUBS (list price from the submitted line, GST 10 % inclusive, no promotions); the
 * integration slice replaces them with adapters over S-F3's price engine and S-F2's catalog:
 *
 *   Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PRICING_PORT).useValue(...)
 *   or change the two providers in orders.module.ts.
 */
export const PRICING_PORT = Symbol('ORDERS_PRICING_PORT');
export const CATALOG_PORT = Symbol('ORDERS_CATALOG_PORT');
