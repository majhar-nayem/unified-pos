import { type Money, money, roundForCash } from '@pos/domain-core';

export interface CashTenderCalculation {
  /** Cash the customer owes against the check after currency rounding. */
  readonly dueMinor: bigint;
  readonly tenderedMinor: bigint;
  readonly changeMinor: bigint;
  /** dueMinor − outstanding when the tender settles the balance; recorded as rounding_minor on order and check. */
  readonly roundingMinor: bigint;
  /** True when this tender settles the whole outstanding balance (rounding applies only then). */
  readonly settlesBalance: boolean;
}

export class CashTenderError extends Error {
  constructor(
    public readonly code:
      | 'AMOUNT_EXCEEDS_OUTSTANDING'
      | 'TENDERED_BELOW_DUE'
      | 'NOTHING_OUTSTANDING'
      | 'NOTHING_DUE_AFTER_ROUNDING',
    message: string,
  ) {
    super(message);
    this.name = 'CashTenderError';
  }
}

/**
 * Cash tender maths. Cash rounding (AUD: nearest 5 c, RBA guideline, docs/01 §7.2 step 7) applies to
 * the tender that settles the whole outstanding balance; a partial cash payment is taken exactly and
 * the rounding falls on the final cash tender. Card and other tenders are never rounded.
 */
export function calculateCashTender(input: {
  readonly outstandingMinor: bigint;
  readonly currency: string;
  readonly requestedMinor?: bigint | undefined;
  readonly tenderedMinor?: bigint | undefined;
}): CashTenderCalculation {
  const { outstandingMinor, currency } = input;
  if (outstandingMinor <= 0n)
    throw new CashTenderError('NOTHING_OUTSTANDING', 'The check has nothing outstanding');
  const requested = input.requestedMinor ?? outstandingMinor;
  if (requested > outstandingMinor)
    throw new CashTenderError(
      'AMOUNT_EXCEEDS_OUTSTANDING',
      'Cash amount exceeds the outstanding balance',
    );
  const settlesBalance = requested === outstandingMinor;
  let dueMinor = requested;
  let roundingMinor = 0n;
  if (settlesBalance) {
    const rounded = roundForCash(money(outstandingMinor, currency));
    dueMinor = rounded.roundedMinor;
    roundingMinor = rounded.roundingMinor;
  }
  if (dueMinor <= 0n)
    throw new CashTenderError(
      'NOTHING_DUE_AFTER_ROUNDING',
      'The balance rounds to nothing in cash; adjust the order total instead',
    );
  const tenderedMinor = input.tenderedMinor ?? dueMinor;
  if (tenderedMinor < dueMinor)
    throw new CashTenderError('TENDERED_BELOW_DUE', 'Cash tendered is less than the amount due');
  return {
    dueMinor,
    tenderedMinor,
    changeMinor: tenderedMinor - dueMinor,
    roundingMinor,
    settlesBalance,
  };
}

export const asMoney = (amountMinor: bigint, currency: string): Money =>
  money(amountMinor, currency);
