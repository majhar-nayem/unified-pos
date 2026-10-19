import type { Translate } from '../../i18n/translate.js';

import type { PaymentPanelState } from './PaymentStatusPanel.js';

/**
 * Receipt wording for a card payment (docs/04-design-plan.md section 5): offline-collected card payments
 * read "pending" and only a captured payment reads "settled".
 */
export function receiptPaymentLabel(state: Pick<PaymentPanelState, 'kind'>, t: Translate): string {
  switch (state.kind) {
    case 'approved':
    case 'forwarded-approved':
      return t('receipt.payment.settled');
    case 'approved-offline':
      return t('receipt.payment.pending');
    case 'uncertain':
      return t('receipt.payment.pendingConfirmation');
    case 'processing':
      return t('receipt.payment.inProgress');
    case 'declined':
    case 'declined-after-reconnect':
    case 'expired':
    case 'caps-reached':
      return t('receipt.payment.notCollected');
  }
}
