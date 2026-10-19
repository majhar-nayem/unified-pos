import { Injectable } from '@nestjs/common';
import type {
  CashTender,
  CashTenderResultDto,
  CreatePaymentIntent,
  CreateRefund,
  PaymentIntentDto,
  RefundDto,
  SubmitIntent,
} from '@pos/contracts';

import { UnitOfWork } from '../kernel/public/index.js';
import { ExecutionService } from './execution.service.js';
import { IntentsService } from './intents.service.js';
import { RefundsService } from './refunds.service.js';

export interface CheckPaymentSummary {
  readonly checkId: string;
  readonly totalMinor: bigint;
  /** Σ captured − refunded over the check's captured intents (docs/01 §7.3 "paid" rule). */
  readonly collectedMinor: bigint;
  readonly outstandingMinor: bigint;
  readonly paid: boolean;
}

/**
 * What the rest of the platform may ask of payments (plan §15.1: S-F5 provides `PaymentsPort`).
 * Calls run as the current request's caller, with the same permission checks as the HTTP routes.
 */
export interface PaymentsPort {
  payCash(input: CashTender): Promise<CashTenderResultDto>;
  createIntent(input: CreatePaymentIntent): Promise<PaymentIntentDto>;
  submitIntent(intentId: string, input?: SubmitIntent): Promise<PaymentIntentDto>;
  refund(intentId: string, input: CreateRefund): Promise<RefundDto>;
  getIntent(intentId: string): Promise<PaymentIntentDto>;
  checkSummary(checkId: string): Promise<CheckPaymentSummary | null>;
}

export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');

@Injectable()
export class PaymentsFacade implements PaymentsPort {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly intents: IntentsService,
    private readonly execution: ExecutionService,
    private readonly refunds: RefundsService,
  ) {}

  payCash(input: CashTender) {
    return this.intents.cashTender(input);
  }
  createIntent(input: CreatePaymentIntent) {
    return this.intents.create(input);
  }
  submitIntent(intentId: string, input: SubmitIntent = {}) {
    return this.execution.submit(intentId, input);
  }
  refund(intentId: string, input: CreateRefund) {
    return this.refunds.create(intentId, input);
  }
  getIntent(intentId: string) {
    return this.intents.get(intentId);
  }
  checkSummary(checkId: string): Promise<CheckPaymentSummary | null> {
    return this.uow.read((db) => this.intents.checkSummary(db, checkId));
  }
}
