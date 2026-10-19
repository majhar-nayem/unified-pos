import { domain, type OrderState, type ReceiptKind } from '../orders/public/index.js';

export type { ReceiptKind };

export interface ExistingReceipt {
  readonly kind: string;
  readonly checkId: string | null;
}

export interface ReceiptDecision {
  readonly kind: ReceiptKind;
  /** What a reprint reprints (sale, refund or void); equals `kind` otherwise. */
  readonly baseKind: ReceiptKind;
  readonly isReprint: boolean;
  /** 1 for the original, 2 for the first reprint, … */
  readonly copyNumber: number;
  readonly number: string;
}

export class ReceiptNotAvailable extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The kind a receipt takes when the client does not ask for one. */
export function naturalKind(order: Pick<OrderState, 'status' | 'kind'>): ReceiptKind {
  if (order.status === 'completed') return domain.isReturnKind(order.kind) ? 'refund' : 'sale';
  if (order.status === 'voided' || order.status === 'cancelled') return 'void';
  return 'proforma';
}

const SUFFIX: Record<ReceiptKind, string> = {
  sale: '',
  refund: '',
  reprint: '',
  gift: '-G',
  proforma: '-P',
  void: '-V',
};

/**
 * Which receipt this request produces and what it is called.
 *
 * - sale: completed non-return order; refund: completed return or exchange; void: voided or
 *   cancelled; gift: completed; proforma: anything not voided or cancelled.
 * - Asking again for a sale, refund or void already issued for the same check (or the whole order)
 *   is a REPRINT: it gets its own row (reprints are logged, docs/02 §3.6), the number gains `-R<n>`
 *   and the copy number goes up.
 * - Numbers are the order's business date plus canonical number ("20261018-0042"), `-C<n>` for a
 *   single check; an unplaced order has no number yet, so a proforma uses `PF-<id tail>`.
 */
export function decideReceipt(
  order: OrderState,
  requested: ReceiptKind | undefined,
  checkId: string | null,
  existing: readonly ExistingReceipt[],
): ReceiptDecision {
  if (checkId && !order.checks.some((c) => c.id === checkId))
    throw new domain.OrderRuleError(
      'invalid',
      'CHECK_NOT_FOUND',
      'The check does not exist on this order',
    );
  const isReturn = domain.isReturnKind(order.kind);
  const wanted = requested ?? naturalKind(order);
  const fail = (message: string) => {
    throw new ReceiptNotAvailable('RECEIPT_NOT_AVAILABLE', message);
  };
  switch (wanted) {
    case 'sale':
      if (order.status !== 'completed' || isReturn)
        fail('A sale receipt needs a completed sale; use proforma before completion');
      break;
    case 'refund':
      if (order.status !== 'completed' || !isReturn)
        fail('A refund receipt needs a completed return or exchange');
      break;
    case 'void':
      if (order.status !== 'voided' && order.status !== 'cancelled')
        fail('A void receipt needs a voided or cancelled order');
      break;
    case 'gift':
      if (order.status !== 'completed') fail('A gift receipt needs a completed order');
      break;
    case 'proforma':
      if (order.status === 'voided' || order.status === 'cancelled')
        fail('A voided order has no proforma');
      break;
    case 'reprint':
      fail(
        'Ask for the kind to reprint (sale, refund or void); a repeat request is recorded as a reprint',
      );
  }
  const sameScope = existing.filter((e) => e.checkId === checkId);
  const reprintable = wanted === 'sale' || wanted === 'refund' || wanted === 'void';
  const issuedBefore = sameScope.some((e) => e.kind === wanted || e.kind === 'reprint');
  const base =
    order.orderNumber !== null ? domain.receiptBaseNumber(order) : `PF-${order.id.slice(-8)}`;
  const checkPart = checkId ? `-C${order.checks.find((c) => c.id === checkId)?.number ?? 0}` : '';
  if (reprintable && issuedBefore) {
    const reprints = sameScope.filter((e) => e.kind === 'reprint').length;
    return {
      kind: 'reprint',
      baseKind: wanted,
      isReprint: true,
      copyNumber: reprints + 2,
      number: `${base}${checkPart}-R${reprints + 1}`,
    };
  }
  return {
    kind: wanted,
    baseKind: wanted,
    isReprint: false,
    copyNumber: 1,
    number: `${base}${checkPart}${SUFFIX[wanted]}`,
  };
}
