import type { PeripheralManager, Scale } from '@pos/hardware';

import { toProduct, type PosProduct } from '../catalog/placeholder.js';
import type { ReplicaStore } from '../store/stores.js';
import type { AddResult, CartService } from './cart.js';

export type ScanOutcome =
  | (Extract<AddResult, { ok: true }> & { readonly elapsedMs: number })
  | { readonly ok: false; readonly reason: 'not_found' | 'needs_weight'; readonly code: string };

/**
 * Scan → line. Local only: replica lookup by barcode index, then a durable command. The acceptance
 * budget is < 100 ms from scan to line (docs/03 §5 F6); `elapsedMs` is measured here so the UI and
 * tests can assert it.
 */
export class ScanService {
  constructor(
    private readonly replicas: ReplicaStore,
    private readonly cart: CartService,
    private readonly hardware: PeripheralManager,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async lookup(code: string): Promise<PosProduct | null> {
    const record = await this.replicas.findByBarcode(code.trim());
    return record ? toProduct(record) : null;
  }

  async handleScan(code: string): Promise<ScanOutcome> {
    const started = this.now();
    const product = await this.lookup(code);
    if (!product) return { ok: false, reason: 'not_found', code };
    return this.add(product, started);
  }

  async add(product: PosProduct, started = this.now()): Promise<ScanOutcome> {
    let quantity = '1';
    if (product.soldBy === 'weight') {
      const scale = this.hardware.first<Scale>('scale');
      let weight: string | null = null;
      try {
        const reading = scale ? await scale.read() : null;
        if (reading?.stable && Number(reading.weight) > 0) weight = reading.weight;
      } catch {
        weight = null;
      }
      if (!weight)
        return {
          ok: false,
          reason: 'needs_weight',
          code: product.barcodes[0] ?? product.variantId,
        };
      quantity = weight;
    }
    const line = await this.cart.addProduct(product, quantity);
    return { ok: true, line, elapsedMs: this.now() - started };
  }
}
