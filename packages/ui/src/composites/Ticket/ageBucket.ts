/** KDS ticket age buckets, drawn from the colour-vision-safe `kds-age-*` palette (docs/04-design-plan.md 4.5). */
export type KdsAgeBucket = 'fresh' | 'aging' | 'late' | 'critical';

export interface AgeThresholds {
  /** Seconds at which a ticket turns from fresh to aging. */
  readonly agingSeconds: number;
  /** Seconds at which a ticket turns from aging to late. */
  readonly lateSeconds: number;
  /** Seconds at which a ticket turns from late to critical. */
  readonly criticalSeconds: number;
}

export const defaultAgeThresholds: AgeThresholds = {
  agingSeconds: 300,
  lateSeconds: 480,
  criticalSeconds: 600,
};

/**
 * Pure bucketing. A threshold is inclusive: a ticket exactly `agingSeconds` old is already aging.
 * Thresholds are configurable per station; missing fields fall back to the 300/480/600 defaults.
 */
export function ageBucket(
  ageSeconds: number,
  thresholds: Partial<AgeThresholds> = defaultAgeThresholds,
): KdsAgeBucket {
  const { agingSeconds, lateSeconds, criticalSeconds } = { ...defaultAgeThresholds, ...thresholds };
  if (ageSeconds >= criticalSeconds) return 'critical';
  if (ageSeconds >= lateSeconds) return 'late';
  if (ageSeconds >= agingSeconds) return 'aging';
  return 'fresh';
}
