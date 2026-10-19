import { z } from 'zod';

/** Shared bits for the catalog controllers. */
export const uuid = z.string().uuid();
export const TAGS = ['catalog'] as const;
export const TENANT = { kind: 'tenant' } as const;

/** Path-parameter schema for one uuid; the name doubles as the harness fixture name. */
export const idParam = <K extends string>(name: K) =>
  z.object({ [name]: uuid } as Record<K, typeof uuid>);
export const fixtureParam = (name: string) => ({ params: { [name]: name } });
