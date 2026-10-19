import { Inject, Injectable } from '@nestjs/common';
import {
  type ImportSettlement,
  PAYMENT_PERMISSIONS,
  type Page,
  type ReconciliationExceptionDto,
  type ResolveException,
  type SettlementDto,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';
import type { SettlementLine } from '@pos/payments-sdk';
import type { Scope } from '@pos/auth';

import { AuthorizationService, NotFoundError, UnitOfWork } from '../kernel/public/index.js';
import { PaymentsLedger } from './ledger.service.js';
import { PaymentsRunner } from './payments-runner.js';
import { PROVIDER_REGISTRY, ProviderRegistry } from './providers/provider-registry.js';
import {
  type ExceptionRow,
  type IntentRow,
  type ProviderAccountRow,
  type RefundRow,
  type SettlementLineRow,
  type SettlementRow,
  toExceptionDto,
  toSettlementDto,
  toSettlementLineDto,
} from './rows.js';

export interface ImportResult {
  settlement: SettlementDto | null;
  alreadyImported: boolean;
  exceptionsRaised: number;
}

/**
 * Settlement import and reconciliation (docs/01 §7.3: settlement is tracked separately from
 * capture and never inferred from it). A provider's settlement lines are matched to captures and
 * refunds by provider reference; whatever does not match becomes a reconciliation exception for the
 * finance queue instead of being "fixed" silently.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly runner: PaymentsRunner,
    private readonly ledger: PaymentsLedger,
    @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}

  async import(input: ImportSettlement): Promise<ImportResult> {
    const { tenantId, actor } = this.runner.request();
    const account = await this.uow.read((db) =>
      db.maybeOne<ProviderAccountRow>(
        'SELECT * FROM payments.payment_provider_accounts WHERE tenant_id = $1 AND id = $2',
        [db.tenantId, input.providerAccountId],
      ),
    );
    if (!account) throw new NotFoundError();
    await this.authz.assert(PAYMENT_PERMISSIONS.settlementManage, this.scopeOf(tenantId, account));
    const adapter = this.registry.adapter(account.provider);
    const period = {
      account: {
        id: account.id,
        provider: adapter.key,
        currency: account.currencies[0]?.trim() ?? 'AUD',
        credentialsRef: account.credentials_ref,
      },
      from: new Date(input.from),
      to: new Date(input.to),
    };
    const batch = await adapter.settlementBatch(period);
    if (!batch) return { settlement: null, alreadyImported: false, exceptionsRaised: 0 };
    const lines: SettlementLine[] = [];
    for await (const line of adapter.importSettlement(period)) lines.push(line);

    return this.runner.run(tenantId, actor, async (uow) => {
      const existing = await uow.db.maybeOne<SettlementRow>(
        'SELECT * FROM payments.settlements WHERE tenant_id = $1 AND provider_account_id = $2 AND external_id = $3',
        [uow.tenantId, account.id, batch.externalId],
      );
      if (existing)
        return {
          settlement: toSettlementDto(existing),
          alreadyImported: true,
          exceptionsRaised: 0,
        };

      let gross = 0n;
      let fees = 0n;
      let refunds = 0n;
      let chargebacks = 0n;
      let adjustments = 0n;
      for (const line of lines) {
        const amount = line.amount.amountMinor;
        fees += line.feeMinor;
        if (line.kind === 'capture') gross += amount;
        else if (line.kind === 'refund') refunds += amount < 0n ? -amount : amount;
        else if (line.kind === 'chargeback') chargebacks += amount < 0n ? -amount : amount;
        else if (line.kind === 'fee') fees += amount < 0n ? -amount : amount;
        else adjustments += amount;
      }
      const settlementId = newId();
      const inserted = await uow.db.query<SettlementRow>(
        `INSERT INTO payments.settlements
           (id, tenant_id, provider_account_id, external_id, period_start, period_end, currency, gross_minor, fees_minor,
            refunds_minor, chargebacks_minor, net_minor, paid_out_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'reconciling')
         ON CONFLICT (provider_account_id, external_id) DO NOTHING RETURNING *`,
        [
          settlementId,
          uow.tenantId,
          account.id,
          batch.externalId,
          batch.periodStart,
          batch.periodEnd,
          batch.currency,
          gross,
          fees,
          refunds,
          chargebacks,
          gross - fees - refunds - chargebacks + adjustments,
          batch.paidOutAt,
        ],
      );
      if (!inserted[0]) {
        const raced = await uow.db.one<SettlementRow>(
          'SELECT * FROM payments.settlements WHERE tenant_id = $1 AND provider_account_id = $2 AND external_id = $3',
          [uow.tenantId, account.id, batch.externalId],
        );
        return { settlement: toSettlementDto(raced), alreadyImported: true, exceptionsRaised: 0 };
      }

      let exceptions = 0;
      const seenCaptureRefs = new Set<string>();
      const referencedIntentIds = new Set<string>(); // any intent a capture line points at, matched or not
      for (const line of lines) {
        const lineId = newId();
        const refId = line.ref?.providerPaymentId ?? null;
        let matched = false;
        let intentId: string | null = null;
        let refundId: string | null = null;

        if (line.kind === 'capture' && refId) {
          const intent = await uow.db.maybeOne<IntentRow>(
            `SELECT * FROM payments.payment_intents
              WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_reference = $3 FOR UPDATE`,
            [uow.tenantId, account.id, refId],
          );
          if (!intent) {
            exceptions += (await this.raise(
              uow.db,
              'missing_in_platform',
              'high',
              'settlement_line',
              lineId,
              {
                externalRef: line.externalRef,
                amountMinor: line.amount.amountMinor.toString(),
                settlementId,
              },
            ))
              ? 1
              : 0;
          } else {
            intentId = intent.id;
            referencedIntentIds.add(intent.id);
            const duplicate = seenCaptureRefs.has(refId) || intent.settlement_status === 'settled';
            seenCaptureRefs.add(refId);
            if (duplicate) {
              exceptions += (await this.raise(
                uow.db,
                'duplicate_capture_suspected',
                'critical',
                'payment_intent',
                intent.id,
                {
                  externalRef: line.externalRef,
                  settlementId,
                },
              ))
                ? 1
                : 0;
            } else if (line.amount.amountMinor !== intent.captured_minor || !isCaptured(intent)) {
              exceptions += (await this.raise(
                uow.db,
                'amount_mismatch',
                'high',
                'payment_intent',
                intent.id,
                {
                  settlementMinor: line.amount.amountMinor.toString(),
                  platformCapturedMinor: intent.captured_minor.toString(),
                  platformStatus: intent.status,
                  settlementId,
                },
              ))
                ? 1
                : 0;
            } else {
              matched = true;
              await this.ledger.annotate(
                uow,
                intent,
                { source: 'reconciliation' },
                {
                  kind: 'reconciled',
                  amountMinor: line.amount.amountMinor,
                  payload: {
                    settlementId,
                    externalRef: line.externalRef,
                    feeMinor: line.feeMinor.toString(),
                  },
                },
                { settlementStatus: 'settled', settlementPending: false },
              );
            }
          }
        } else if (line.kind === 'refund' && refId) {
          const refund = await uow.db.maybeOne<RefundRow>(
            `SELECT r.* FROM payments.refunds r
               JOIN payments.payment_intents i ON i.tenant_id = r.tenant_id AND i.id = r.intent_id
              WHERE r.tenant_id = $1 AND i.provider_account_id = $2 AND r.provider_reference = $3`,
            [uow.tenantId, account.id, refId],
          );
          if (!refund) {
            exceptions += (await this.raise(
              uow.db,
              'missing_in_platform',
              'high',
              'settlement_line',
              lineId,
              {
                externalRef: line.externalRef,
                amountMinor: line.amount.amountMinor.toString(),
                settlementId,
              },
            ))
              ? 1
              : 0;
          } else {
            refundId = refund.id;
            intentId = refund.intent_id;
            const abs =
              line.amount.amountMinor < 0n ? -line.amount.amountMinor : line.amount.amountMinor;
            if (abs !== refund.amount_minor || refund.status !== 'succeeded') {
              exceptions += (await this.raise(
                uow.db,
                'amount_mismatch',
                'high',
                'refund',
                refund.id,
                {
                  settlementMinor: line.amount.amountMinor.toString(),
                  platformRefundMinor: refund.amount_minor.toString(),
                  platformStatus: refund.status,
                  settlementId,
                },
              ))
                ? 1
                : 0;
            } else matched = true;
          }
        } else if (line.kind === 'chargeback' && refId) {
          const intent = await uow.db.maybeOne<IntentRow>(
            `SELECT * FROM payments.payment_intents
              WHERE tenant_id = $1 AND provider_account_id = $2 AND provider_reference = $3 FOR UPDATE`,
            [uow.tenantId, account.id, refId],
          );
          if (intent) {
            intentId = intent.id;
            await this.ledger.annotate(
              uow,
              intent,
              { source: 'reconciliation' },
              { kind: 'reconciled', payload: { settlementId, chargeback: true } },
              { settlementStatus: 'disputed' },
            );
          }
          matched = true;
        } else {
          // fees and adjustments have no platform counterpart: recorded, informational
          matched = line.kind === 'fee' || line.kind === 'adjustment';
        }

        await uow.db.query(
          `INSERT INTO payments.settlement_lines
             (id, tenant_id, settlement_id, intent_id, refund_id, external_ref, kind, amount_minor, fee_minor, occurred_at, matched)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            lineId,
            uow.tenantId,
            settlementId,
            intentId,
            refundId,
            line.externalRef,
            line.kind,
            line.amount.amountMinor,
            line.feeMinor,
            line.occurredAt,
            matched,
          ],
        );
      }

      // Captures the platform recorded in this window that the provider did not settle.
      const missing = await uow.db.query<IntentRow>(
        `SELECT i.* FROM payments.payment_intents i
          WHERE i.tenant_id = $1 AND i.provider_account_id = $2 AND i.settlement_status = 'unsettled'
            AND i.status IN ('captured','partially_refunded','refunded') AND i.provider_reference IS NOT NULL
            AND NOT i.offline
            AND EXISTS (SELECT 1 FROM payments.payment_events e
                         WHERE e.tenant_id = i.tenant_id AND e.intent_id = i.id AND e.to_status = 'captured'
                           AND e.occurred_at >= $3 AND e.occurred_at < $4)`,
        [uow.tenantId, account.id, new Date(input.from), new Date(input.to)],
      );
      for (const intent of missing) {
        if (referencedIntentIds.has(intent.id)) continue;
        exceptions += (await this.raise(
          uow.db,
          'missing_in_settlement',
          'medium',
          'payment_intent',
          intent.id,
          {
            providerReference: intent.provider_reference,
            capturedMinor: intent.captured_minor.toString(),
            settlementId,
          },
        ))
          ? 1
          : 0;
      }

      const unmatched = await uow.db.one<{ n: bigint }>(
        'SELECT COUNT(*)::bigint AS n FROM payments.settlement_lines WHERE tenant_id = $1 AND settlement_id = $2 AND NOT matched',
        [uow.tenantId, settlementId],
      );
      const final = await uow.db.one<SettlementRow>(
        `UPDATE payments.settlements SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [
          uow.tenantId,
          settlementId,
          exceptions === 0 && unmatched.n === 0n ? 'reconciled' : 'exceptions',
        ],
      );
      uow.audit({
        action: 'payments.settlement.imported',
        resourceKind: 'settlement',
        resourceId: settlementId,
        after: {
          externalId: batch.externalId,
          lines: lines.length,
          exceptions,
          status: final.status,
        },
      });
      return {
        settlement: {
          ...toSettlementDto(final),
          lineCount: lines.length,
          unmatchedCount: Number(unmatched.n),
        },
        alreadyImported: false,
        exceptionsRaised: exceptions,
      };
    });
  }

  private async raise(
    db: TenantScopedDb,
    kind: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    subjectKind: string,
    subjectId: string,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    return this.ledger.raiseException(db, { kind, severity, subjectKind, subjectId, details });
  }

  // --- reads ------------------------------------------------------------------------------------

  async list(query: {
    providerAccountId?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<Page<SettlementDto>> {
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.settlementManage);
    const rows = await this.uow.read((db) => {
      const params: unknown[] = [db.tenantId];
      const where = ['s.tenant_id = $1'];
      if (query.providerAccountId) {
        params.push(query.providerAccountId);
        where.push(`s.provider_account_id = $${params.length}`);
      }
      if (query.cursor) {
        params.push(query.cursor);
        where.push(`s.id > $${params.length}`);
      }
      return db.query<SettlementRow>(
        `SELECT s.*,
                (SELECT COUNT(*) FROM payments.settlement_lines l WHERE l.tenant_id = s.tenant_id AND l.settlement_id = s.id) AS line_count,
                (SELECT COUNT(*) FROM payments.settlement_lines l WHERE l.tenant_id = s.tenant_id AND l.settlement_id = s.id AND NOT l.matched) AS unmatched_count
           FROM payments.settlements s WHERE ${where.join(' AND ')} ORDER BY s.id LIMIT ${query.limit + 1}`,
        params,
      );
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toSettlementDto),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async get(id: string) {
    // A missing (or foreign) id is a 404 before any permission answer, so permissions never reveal what exists.
    const { settlement, lines } = await this.uow.read(async (db) => ({
      settlement: await db.maybeOne<SettlementRow>(
        'SELECT * FROM payments.settlements WHERE tenant_id = $1 AND id = $2',
        [db.tenantId, id],
      ),
      lines: await db.query<SettlementLineRow>(
        'SELECT * FROM payments.settlement_lines WHERE tenant_id = $1 AND settlement_id = $2 ORDER BY id',
        [db.tenantId, id],
      ),
    }));
    if (!settlement) throw new NotFoundError();
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.settlementManage);
    return { ...toSettlementDto(settlement), lines: lines.map(toSettlementLineDto) };
  }

  async listExceptions(query: {
    status?: string | undefined;
    kind?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  }): Promise<Page<ReconciliationExceptionDto>> {
    this.authz.assertAnywhere(PAYMENT_PERMISSIONS.reconcile);
    const rows = await this.uow.read((db) => {
      const params: unknown[] = [db.tenantId];
      const where = ['tenant_id = $1', "domain = 'payments'"];
      if (query.status) {
        params.push(query.status);
        where.push(`status = $${params.length}`);
      }
      if (query.kind) {
        params.push(query.kind);
        where.push(`kind = $${params.length}`);
      }
      if (query.cursor) {
        params.push(query.cursor);
        where.push(`id > $${params.length}`);
      }
      return db.query<ExceptionRow>(
        `SELECT * FROM payments.reconciliation_exceptions WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${query.limit + 1}`,
        params,
      );
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toExceptionDto),
      nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async resolveException(id: string, input: ResolveException): Promise<ReconciliationExceptionDto> {
    const { caller } = this.runner.request();
    return this.uow.run(async (uow) => {
      const exists = await uow.db.maybeOne<{ id: string }>(
        "SELECT id FROM payments.reconciliation_exceptions WHERE tenant_id = $1 AND id = $2 AND domain = 'payments'",
        [uow.tenantId, id],
      );
      if (!exists) throw new NotFoundError();
      this.authz.assertAnywhere(PAYMENT_PERMISSIONS.reconcile);
      const final = input.status !== 'investigating';
      const rows = await uow.db.query<ExceptionRow>(
        `UPDATE payments.reconciliation_exceptions
            SET status = $3, resolution_note = COALESCE($4, resolution_note),
                resolved_by = CASE WHEN $5 THEN $6::uuid ELSE resolved_by END,
                resolved_at = CASE WHEN $5 THEN now() ELSE resolved_at END
          WHERE tenant_id = $1 AND id = $2 AND domain = 'payments' RETURNING *`,
        [uow.tenantId, id, input.status, input.note ?? null, final, caller.actorUserId ?? null],
      );
      if (!rows[0]) throw new NotFoundError();
      uow.audit({
        action: 'payments.exception.resolved',
        resourceKind: 'reconciliation_exception',
        resourceId: id,
        after: { status: input.status, note: input.note ?? null },
      });
      return toExceptionDto(rows[0]);
    });
  }

  private scopeOf(tenantId: string, account: ProviderAccountRow): Scope {
    return account.scope_kind === 'tenant' || !account.scope_id
      ? { kind: 'tenant', id: tenantId }
      : { kind: account.scope_kind, id: account.scope_id };
  }
}

function isCaptured(intent: IntentRow): boolean {
  return ['captured', 'partially_refunded', 'refunded'].includes(intent.status);
}
