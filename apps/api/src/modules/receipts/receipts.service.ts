import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateReceipt,
  ReceiptDto,
  ReceiptRenderDto,
  RenderReceiptQuery,
} from '@pos/contracts';
import { newId, type TenantScopedDb } from '@pos/db';

import {
  AuthorizationService,
  ConflictError,
  DomainError,
  NotFoundError,
  UnitOfWork,
} from '../kernel/public/index.js';
import { ConfigService } from '../tenancy/public/index.js';
import {
  CommandContextFactory,
  LocationReadModel,
  OrderRepository,
  domain,
  rules,
  type OrderState,
} from '../orders/public/index.js';
import { parseModel, serializeModel } from './model-json.js';
import { OBJECT_STORE, type ObjectStorePort } from './object-store.js';
import { renderReceiptHtml } from './receipt.html.js';
import { renderReceiptPdf } from './receipt.pdf.js';
import { ReceiptNotAvailable, decideReceipt } from './receipt-policy.js';

export const DEFAULT_TEMPLATE_KEY = 'receipt.standard';
const SUPPORTED_TEMPLATES = new Set([DEFAULT_TEMPLATE_KEY]);

interface ReceiptRow {
  id: string;
  order_id: string;
  check_id: string | null;
  number: string;
  kind: ReceiptDto['kind'];
  template_key: string;
  rendered_uri: string | null;
  delivered_via: ReceiptDto['deliveredVia'];
  printed_by: string | null;
  device_id: string | null;
  created_at: Date;
}

const toDto = (r: ReceiptRow): ReceiptDto => ({
  id: r.id,
  orderId: r.order_id,
  checkId: r.check_id,
  number: r.number,
  kind: r.kind,
  templateKey: r.template_key,
  renderedUri: r.rendered_uri,
  deliveredVia: r.delivered_via,
  printedBy: r.printed_by,
  deviceId: r.device_id,
  createdAt: r.created_at.toISOString(),
});

const EXT = {
  json: 'application/json',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  escpos: 'application/octet-stream',
} as const;
const key = (tenantId: string, orderId: string, receiptId: string, ext: keyof typeof EXT) =>
  `receipts/${tenantId}/${orderId}/${receiptId}.${ext}`;

/**
 * Receipts for orders: the standard template rendered to HTML, PDF, plain text and ESC/POS from one
 * frozen model, stored in the object store, one orders.receipts row per issue. A repeat request for
 * a receipt already issued is a logged REPRINT (needs orders.receipt.reprint).
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly authz: AuthorizationService,
    private readonly orders: OrderRepository,
    private readonly locations: LocationReadModel,
    private readonly config: ConfigService,
    private readonly commands: CommandContextFactory,
    @Inject(OBJECT_STORE) private readonly store: ObjectStorePort,
  ) {}

  async create(orderId: string, body: CreateReceipt): Promise<ReceiptDto> {
    const loc = await this.uow.read((db) => this.orders.locate(db, orderId));
    if (!loc) throw new NotFoundError();
    const scope = { kind: 'location' as const, id: loc.locationId };
    await this.authz.assert('orders.view', scope);
    const templateKey = body.templateKey ?? DEFAULT_TEMPLATE_KEY;
    if (!SUPPORTED_TEMPLATES.has(templateKey))
      throw new DomainError(422, 'TEMPLATE_UNKNOWN', `Unknown receipt template ${templateKey}`, {
        supported: [...SUPPORTED_TEMPLATES],
      });

    // Permissions need their own connections, so a reprint is recognised and authorised before the transaction opens.
    const preview = await this.uow.read(async (db) => {
      const order = await this.orders.find(db, orderId);
      return order ? { order, existing: await this.existing(db, orderId) } : null;
    });
    if (!preview) throw new NotFoundError();
    const probe = this.decide(preview.order, body, preview.existing);
    if (probe.isReprint) await this.authz.assert('orders.receipt.reprint', scope);

    return this.uow.run(async (tx) => {
      const order = await this.orders.find(tx.db, orderId, { lock: true });
      if (!order) throw new NotFoundError();
      const existing = await this.existing(tx.db, orderId);
      const decision = this.decide(order, body, existing);
      if (decision.isReprint && !probe.isReprint)
        throw new ConflictError(
          'RETRY',
          'Another receipt was issued at the same moment; ask again to record a reprint',
        );
      const facts = await this.locations.find(tx.db, order.locationId);
      if (!facts) throw new NotFoundError();
      const headerConfig = await this.config.effectiveIn(
        tx.db,
        'receipt.header',
        'location',
        order.locationId,
      );
      const cc = this.commands.make();
      const model = await rules(() =>
        domain.buildReceiptModel(order, {
          kind: decision.kind,
          baseKind: decision.baseKind,
          number: decision.number,
          copyNumber: decision.isReprint ? decision.copyNumber : null,
          businessName: facts.legalName ?? facts.name,
          locationName: facts.name,
          addressLines: facts.addressLines,
          taxRegistration: facts.taxRegistrationNumber,
          header:
            typeof headerConfig.value === 'string' && headerConfig.value
              ? headerConfig.value
              : null,
          legalText: facts.receiptLegalText,
          timezone: facts.timezone,
          issuedAt: new Date(cc.now),
          checkId: body.checkId ?? null,
        }),
      );
      const layout = domain.layoutReceipt(model);
      const id = newId();
      const put = (ext: keyof typeof EXT, bytes: Uint8Array | string) =>
        this.store.put(
          key(tx.tenantId, orderId, id, ext),
          typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes,
          EXT[ext],
        );
      const pdf = await put('pdf', renderReceiptPdf(layout));
      await Promise.all([
        put('html', renderReceiptHtml(model)),
        put('txt', domain.renderPlainText(layout)),
        put('escpos', domain.renderEscPos(layout)),
        put('json', serializeModel(model)),
      ]);
      const row = await tx.db.one<ReceiptRow>(
        `INSERT INTO orders.receipts (id, tenant_id, order_id, check_id, number, kind, template_key, rendered_uri, delivered_via, printed_by, device_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          tx.tenantId,
          orderId,
          body.checkId ?? null,
          decision.number,
          decision.kind,
          templateKey,
          pdf.uri,
          body.deliveredVia ?? [],
          cc.actorId,
          cc.deviceId ?? null,
        ],
      );
      await this.orders.appendEvents(
        tx.db,
        orderId,
        [
          {
            kind: decision.isReprint ? 'receipt_reprinted' : 'receipt_issued',
            payload: {
              receiptId: id,
              number: decision.number,
              kind: decision.kind,
              checkId: body.checkId ?? null,
              copyNumber: decision.copyNumber,
              deliveredVia: body.deliveredVia ?? [],
            },
          },
        ],
        this.commands.eventMeta(cc),
      );
      tx.audit({
        action: decision.isReprint ? 'orders.receipt.reprinted' : 'orders.receipt.issued',
        resourceKind: 'receipt',
        resourceId: id,
        locationId: order.locationId,
        after: {
          orderId,
          number: decision.number,
          kind: decision.kind,
          copyNumber: decision.copyNumber,
          checkId: body.checkId ?? null,
        },
      });
      return toDto(row);
    });
  }

  async list(orderId: string): Promise<ReceiptDto[]> {
    await this.authorizeView(orderId);
    const rows = await this.uow.read((db) =>
      db.query<ReceiptRow>(
        'SELECT * FROM orders.receipts WHERE tenant_id = $1 AND order_id = $2 ORDER BY id',
        [db.tenantId, orderId],
      ),
    );
    return rows.map(toDto);
  }

  async get(orderId: string, receiptId: string): Promise<ReceiptDto> {
    await this.authorizeView(orderId);
    return toDto(await this.row(orderId, receiptId));
  }

  /** The frozen content as issued. Text and ESC/POS can be laid out again at another paper width from the stored model. */
  async render(
    orderId: string,
    receiptId: string,
    query: RenderReceiptQuery,
  ): Promise<ReceiptRenderDto> {
    await this.authorizeView(orderId);
    const row = await this.row(orderId, receiptId);
    const tenantId = this.tenantOf(row);
    const gone = () =>
      new DomainError(
        410,
        'RECEIPT_CONTENT_GONE',
        'The stored receipt content is no longer available',
      );
    const read = async (ext: keyof typeof EXT) => {
      const stored = await this.store.get(key(tenantId, orderId, receiptId, ext));
      if (!stored) throw gone();
      return stored.body;
    };
    const base = { receiptId, format: query.format };
    switch (query.format) {
      case 'html':
        return {
          ...base,
          contentType: EXT.html,
          encoding: 'utf8',
          content: Buffer.from(await read('html')).toString('utf8'),
        };
      case 'pdf':
        return {
          ...base,
          contentType: EXT.pdf,
          encoding: 'base64',
          content: Buffer.from(await read('pdf')).toString('base64'),
        };
      case 'text':
      case 'escpos': {
        const columns = query.columns;
        if (columns === undefined || columns === domain.DEFAULT_COLUMNS) {
          const ext = query.format === 'text' ? 'txt' : 'escpos';
          const bytes = await read(ext);
          return query.format === 'text'
            ? {
                ...base,
                contentType: EXT.txt,
                encoding: 'utf8',
                content: Buffer.from(bytes).toString('utf8'),
              }
            : {
                ...base,
                contentType: EXT.escpos,
                encoding: 'base64',
                content: Buffer.from(bytes).toString('base64'),
              };
        }
        const layout = domain.layoutReceipt(
          parseModel(Buffer.from(await read('json')).toString('utf8')),
          columns,
        );
        return query.format === 'text'
          ? {
              ...base,
              contentType: EXT.txt,
              encoding: 'utf8',
              content: domain.renderPlainText(layout, columns),
            }
          : {
              ...base,
              contentType: EXT.escpos,
              encoding: 'base64',
              content: Buffer.from(domain.renderEscPos(layout, columns)).toString('base64'),
            };
      }
    }
  }

  // -------------------------------------------------------------------------

  private decide(
    order: OrderState,
    body: CreateReceipt,
    existing: Awaited<ReturnType<ReceiptsService['existing']>>,
  ) {
    try {
      return decideReceipt(order, body.kind, body.checkId ?? null, existing);
    } catch (error) {
      if (error instanceof ReceiptNotAvailable) throw new ConflictError(error.code, error.message);
      if (error instanceof domain.OrderRuleError)
        throw new DomainError(422, error.code, error.message);
      throw error;
    }
  }

  private existing(db: TenantScopedDb, orderId: string) {
    return db
      .query<{ kind: string; check_id: string | null }>(
        'SELECT kind, check_id FROM orders.receipts WHERE tenant_id = $1 AND order_id = $2',
        [db.tenantId, orderId],
      )
      .then((rows) => rows.map((r) => ({ kind: r.kind, checkId: r.check_id })));
  }

  private async authorizeView(orderId: string): Promise<void> {
    const loc = await this.uow.read((db) => this.orders.locate(db, orderId));
    if (!loc) throw new NotFoundError();
    await this.authz.assert('orders.view', { kind: 'location', id: loc.locationId });
  }

  private async row(
    orderId: string,
    receiptId: string,
  ): Promise<ReceiptRow & { tenant_id: string }> {
    const row = await this.uow.read((db) =>
      db.maybeOne<ReceiptRow & { tenant_id: string }>(
        'SELECT * FROM orders.receipts WHERE tenant_id = $1 AND order_id = $2 AND id = $3',
        [db.tenantId, orderId, receiptId],
      ),
    );
    if (!row) throw new NotFoundError();
    return row;
  }

  private tenantOf(row: ReceiptRow & { tenant_id: string }): string {
    return row.tenant_id;
  }
}
