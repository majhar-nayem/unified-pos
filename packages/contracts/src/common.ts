/**
 * Shared wire primitives for Phase 1 F2 onwards: cursor pagination, decimal strings, minor units.
 */
import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoInstant = z.string().datetime({ offset: true });

/** Money in minor units travels as an integer string (bigint-safe). */
export const MinorAmountSchema = z.string().regex(/^-?\d{1,18}$/, 'integer string in minor units');
/** Non-negative decimal with up to `scale` fractional digits (numeric columns, never floats). */
export const decimalString = (scale: number, maxIntegerDigits = 14) =>
  z
    .string()
    .regex(
      new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,${scale}})?$`),
      `decimal with at most ${scale} fractional digits`,
    );
export const PositiveDecimalSchema = decimalString(4).refine(
  (v) => Number(v) > 0,
  'must be greater than zero',
);

/**
 * Cursor pagination: `cursor` is the last id of the previous page (ids are UUIDv7, so id order
 * is creation order); `limit` caps the page.
 */
export const CursorQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: uuid.nullable() });
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
