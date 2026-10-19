import { Injectable } from '@nestjs/common';
import type { TenantScopedDb } from '@pos/db';

export interface LocationFacts {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  /** 'HH:MM' local time the business day starts. */
  readonly businessDayBoundary: string;
  readonly currency: string;
  readonly addressLines: readonly string[];
  readonly legalName: string | null;
  readonly taxRegistrationNumber: string | null;
  readonly receiptLegalText: string | null;
}

interface Row {
  id: string;
  code: string;
  name: string;
  timezone: string;
  boundary: string;
  currency: string;
  address: Record<string, string> | null;
  legal_name: string | null;
  tax_registration_number: string | null;
  receipt_legal_text: string | null;
}

/**
 * Read-only view of what orders need to know about a location: time zone and day boundary (business
 * date), currency, and the legal entity printed on receipts. The tenancy module exposes no public
 * query for this yet, so this is a deliberate narrow cross-module read (same precedent as
 * devices.service), to be replaced by a tenancy port; it never writes.
 */
@Injectable()
export class LocationReadModel {
  async find(db: TenantScopedDb, locationId: string): Promise<LocationFacts | null> {
    const row = await db.maybeOne<Row>(
      `SELECT l.id, l.code, l.name, l.timezone, to_char(l.business_day_boundary, 'HH24:MI') AS boundary, l.currency, l.address,
              le.name AS legal_name, le.tax_registration_number, le.receipt_legal_text
       FROM tenancy.locations l
       LEFT JOIN tenancy.org_units ou ON ou.tenant_id = l.tenant_id AND ou.id = l.org_unit_id
       LEFT JOIN tenancy.legal_entities le ON le.tenant_id = l.tenant_id AND le.id = COALESCE(l.legal_entity_id, ou.legal_entity_id)
       WHERE l.tenant_id = $1 AND l.id = $2`,
      [db.tenantId, locationId],
    );
    if (!row) return null;
    const a = row.address ?? {};
    const cityLine = [a.city, a.region, a.postcode].filter(Boolean).join(' ');
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      timezone: row.timezone,
      businessDayBoundary: row.boundary,
      currency: row.currency.trim(),
      addressLines: [a.line1, a.line2, cityLine].filter((x): x is string => !!x),
      legalName: row.legal_name,
      taxRegistrationNumber: row.tax_registration_number,
      receiptLegalText: row.receipt_legal_text,
    };
  }

  /** The composite FK only proves a register is the tenant's; an order must also sit at the register's own location. */
  async registerAt(db: TenantScopedDb, registerId: string, locationId: string): Promise<boolean> {
    const row = await db.maybeOne<{ ok: boolean }>(
      'SELECT true AS ok FROM tenancy.registers WHERE tenant_id = $1 AND id = $2 AND location_id = $3',
      [db.tenantId, registerId, locationId],
    );
    return row !== null;
  }
}
